/**
 * Cloudflare OAuth 2.0（Authorization Code + PKCE，公共客户端，无 client secret）。
 *
 * 只在 APK 直连模式可用，原因见 docs/16 §1：浏览器直连 api.cloudflare.com 会被 CORS
 * 挡死，而 OAuth 换到的 access token 也只有直连才用得上。
 *
 * 三件必须守住的事：
 *  1. access token **只留内存**；refresh token 进系统钥匙串（secure-store.ts）。
 *  2. 公共客户端不使用 secret，`token_endpoint_auth_method=none`，PKCE 固定 S256。
 *  3. 刷新按 credRef **串行化**：CF 若轮换 refresh token，并发刷新会互相把对方刷失效。
 *
 * 端点与参数来自 Cloudflare 官方文档（2026-10-21 核对）：
 *   authorize https://dash.cloudflare.com/oauth2/auth
 *   token     https://dash.cloudflare.com/oauth2/token
 *   revoke    https://dash.cloudflare.com/oauth2/revoke
 */
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { secureGet, secureRemove, secureSet } from "./secure-store";

const AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN = "https://dash.cloudflare.com/oauth2/token";
const REVOKE = "https://dash.cloudflare.com/oauth2/revoke";

/** 本地覆盖键：client_id / redirect_uri / scope 都不是凭据，放 localStorage 便于装机后改 */
const CFG_KEY = "cfconsole.oauth.client.v1";

export interface OAuthClientCfg {
  clientId: string;
  redirect: string;
  /** 留空 = 不带 scope 参数，由 OAuth client 注册时勾选的 scope 决定 */
  scope: string;
}

const BUILD_CFG: OAuthClientCfg = {
  clientId: String(import.meta.env.VITE_CF_OAUTH_CLIENT_ID ?? "").trim(),
  redirect: String(import.meta.env.VITE_CF_OAUTH_REDIRECT ?? "").trim(),
  scope: String(import.meta.env.VITE_CF_OAUTH_SCOPE ?? "").trim(),
};

/** 默认回调走自定义 scheme —— 必须在 OAuth client 的 redirect_uris 里原样注册 */
export const DEFAULT_REDIRECT = "cfconsole://oauth/callback";

export function oauthClientCfg(): OAuthClientCfg {
  let local: Partial<OAuthClientCfg> = {};
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) local = JSON.parse(raw) as Partial<OAuthClientCfg>;
  } catch {
    /* 存储坏了就用构建默认值 */
  }
  const pick = (k: keyof OAuthClientCfg): string => {
    const v = String(local[k] ?? "").trim();
    return v || BUILD_CFG[k];
  };
  return { clientId: pick("clientId"), redirect: pick("redirect") || DEFAULT_REDIRECT, scope: pick("scope") };
}

export function saveOAuthClientCfg(cfg: OAuthClientCfg): OAuthClientCfg {
  const next: OAuthClientCfg = {
    clientId: cfg.clientId.trim(),
    redirect: cfg.redirect.trim() || DEFAULT_REDIRECT,
    scope: cfg.scope.trim(),
  };
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式：内存里仍然生效 */
  }
  return next;
}

/* ============================================================================
 * PKCE
 * ========================================================================== */

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function rand(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  // 43–128 字符的 base64url，32 字节正好落在这个区间的安全位置
  const verifier = b64url(rand(32));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

/* ============================================================================
 * 错误：与 api.ts 的 ErrKind 同语义，但**不 import 它** —— 否则 api ↔ oauth 循环引用
 * ========================================================================== */
export class OAuthError extends Error {
  constructor(readonly kind: "auth" | "badQuery" | "network" | "unknown", readonly http: number, message: string) {
    super(message);
  }
}

/* ============================================================================
 * 凭据存储
 * ========================================================================== */

interface StoredGrant {
  v: 1;
  clientId: string;
  redirect: string;
  scope: string;
  refresh_token?: string;
  /** 上次刷新时间，仅用于界面展示，不参与判定 */
  at: number;
}

const grantKey = (credRef: string) => "oauth." + credRef;

async function readGrant(credRef: string): Promise<StoredGrant | null> {
  const raw = await secureGet(grantKey(credRef));
  if (!raw) return null;
  try {
    const g = JSON.parse(raw) as StoredGrant;
    return g && g.v === 1 ? g : null;
  } catch {
    return null;
  }
}

/** access token 缓存：只在内存，进程结束即消失 */
const accessCache = new Map<string, { token: string; exp: number }>();
/** 刷新串行化：同一个 credRef 同时只允许一条刷新请求 */
const refreshing = new Map<string, Promise<string>>();

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; json: TokenResponse | null; text: string }> {
  const body = new URLSearchParams(form).toString();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (e) {
    throw new OAuthError("network", 0, "连不上 Cloudflare 授权服务器：" + String((e as Error)?.message || e));
  }
  const text = await res.text();
  let json: TokenResponse | null = null;
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function tokenError(status: number, json: TokenResponse | null, text: string): OAuthError {
  const msg = json?.error_description || json?.error || text.slice(0, 160) || `HTTP ${status}`;
  // invalid_grant = refresh token 已失效（被撤销/过期）：必须重新授权，不能当成网络错误重试
  return new OAuthError("auth", status, msg);
}

/**
 * 用 refresh token 换 access token。返回新的 access token；若上游轮换了 refresh token，
 * 新值立刻写回钥匙串（旧的随即失效，晚写就等于丢授权）。
 */
async function refreshAccess(credRef: string, grant: StoredGrant): Promise<string> {
  if (!grant.refresh_token) throw new OAuthError("auth", 401, "这条授权没有 refresh token，请重新用 Cloudflare 登录");
  const { status, json, text } = await postForm(TOKEN, {
    grant_type: "refresh_token",
    refresh_token: grant.refresh_token,
    client_id: grant.clientId,
  });
  if (status >= 400 || !json?.access_token) {
    // 刷新失败就把凭据清掉：留着一条刷不动的 refresh token 只会每次请求都重试一次
    await secureRemove(grantKey(credRef));
    accessCache.delete(credRef);
    throw tokenError(status, json, text);
  }
  const expiresIn = Number(json.expires_in ?? 3600);
  accessCache.set(credRef, { token: json.access_token, exp: Date.now() + expiresIn * 1000 });
  if (json.refresh_token && json.refresh_token !== grant.refresh_token) {
    await secureSet(grantKey(credRef), JSON.stringify({ ...grant, refresh_token: json.refresh_token, at: Date.now() } satisfies StoredGrant));
  }
  return json.access_token;
}

/** 给请求层用：拿一个当前可用的 access token（过期前 60 秒就提前换） */
export async function ensureAccessToken(credRef: string): Promise<string> {
  const hit = accessCache.get(credRef);
  if (hit && hit.exp - 60_000 > Date.now()) return hit.token;

  const running = refreshing.get(credRef);
  if (running) return running;

  const task = (async () => {
    const grant = await readGrant(credRef);
    if (!grant) throw new OAuthError("auth", 401, "这台设备上没有这条 OAuth 授权，请重新用 Cloudflare 登录");
    return refreshAccess(credRef, grant);
  })().finally(() => refreshing.delete(credRef));

  refreshing.set(credRef, task);
  return task;
}

/* ============================================================================
 * 授权流程
 * ========================================================================== */

export interface LoginResult {
  credRef: string;
  accessToken: string;
  expiresIn: number;
  /** 有 refresh token 才能长期免登录；没有就要每次重开浏览器授权 */
  hasRefresh: boolean;
}

/**
 * 打开系统浏览器完成授权，回调通过自定义 scheme 回到 App。
 *
 * 为什么要用系统浏览器而不是应用内 WebView：应用内 WebView 里登录等于把 CF 密码
 * 交给本应用；系统浏览器有独立的地址栏与登录态，用户能看清域名再输入。
 */
export async function beginOAuthLogin(): Promise<LoginResult> {
  const cfg = oauthClientCfg();
  if (!cfg.clientId) throw new OAuthError("badQuery", 422, "还没填 OAuth client_id（设置页「Cloudflare OAuth」）");

  const { verifier, challenge } = await pkce();
  const state = b64url(rand(16));

  const url = new URL(AUTHORIZE);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirect);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (cfg.scope) url.searchParams.set("scope", cfg.scope);

  const callback = new Promise<string>((resolve, reject) => {
    let handle: { remove: () => Promise<void> } | null = null;
    const timer = setTimeout(() => {
      void handle?.remove();
      reject(new OAuthError("auth", 0, "授权等待超过 5 分钟，已取消"));
    }, 5 * 60_000);

    void App.addListener("appUrlOpen", ({ url: back }) => {
      try {
        const u = new URL(back);
        if (!u.href.startsWith(cfg.redirect.split("?")[0].replace(/\/?$/, ""))) return;
        const err = u.searchParams.get("error");
        if (err) {
          clearTimeout(timer);
          void handle?.remove();
          reject(new OAuthError("auth", 400, u.searchParams.get("error_description") || err));
          return;
        }
        if (u.searchParams.get("state") !== state) {
          // state 不匹配 = 不是这次授权的回调，直接忽略，不结束等待
          return;
        }
        const code = u.searchParams.get("code");
        if (!code) return;
        clearTimeout(timer);
        void handle?.remove();
        resolve(code);
      } catch {
        /* 不是合法 URL：忽略 */
      }
    }).then((h) => {
      handle = h;
    });
  });

  await Browser.open({ url: url.toString() });

  let code: string;
  try {
    code = await callback;
  } finally {
    // 无论成功失败都关掉浏览器页，别把授权页留在后台
    void Browser.close().catch(() => undefined);
  }

  const { status, json, text } = await postForm(TOKEN, {
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirect,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });
  if (status >= 400 || !json?.access_token) throw tokenError(status, json, text);

  const credRef = "c_" + b64url(rand(12));
  const expiresIn = Number(json.expires_in ?? 3600);
  const grant: StoredGrant = {
    v: 1,
    clientId: cfg.clientId,
    redirect: cfg.redirect,
    scope: cfg.scope,
    refresh_token: json.refresh_token,
    at: Date.now(),
  };
  await secureSet(grantKey(credRef), JSON.stringify(grant));
  accessCache.set(credRef, { token: json.access_token, exp: Date.now() + expiresIn * 1000 });

  return { credRef, accessToken: json.access_token, expiresIn, hasRefresh: !!json.refresh_token };
}

/** 退出/删账号：先撤销再删本地凭据。撤销失败也照样删本地（不能因为网络问题留个删不掉的账号） */
export async function revokeOAuth(credRef: string): Promise<void> {
  const grant = await readGrant(credRef);
  if (grant?.refresh_token) {
    try {
      await postForm(REVOKE, { token: grant.refresh_token, token_type_hint: "refresh_token", client_id: grant.clientId });
    } catch {
      /* 网络不通就跳过撤销，本地凭据仍要清掉 */
    }
  }
  accessCache.delete(credRef);
  await secureRemove(grantKey(credRef));
}
