/**
 * 网关路由表：手机 App 唯一能碰的东西。
 *
 * 三条硬规则（来自 docs/06、docs/09 的实测结论）：
 *  1. 没有 CF API 通用透传：路径全部写死，账号 ID 默认从 env 取；客户端可以用 `?account=`
 *     切账号，但值必须先通过 `GET /accounts` 的可见集合校验（见下面的 accountGate），
 *     不合法一律 422 —— 所以客户端仍然传不进任意"路径片段"；
 *  2. 写只有 catalog.WRITE_ROUTES 那四条（DNS 增删改 + 按 URL 清缓存），前面压着三道闸门：
 *     `WRITE_ENABLED` → method/path 命中白名单 → 服务端逐字段校验（校验不过连 CF 都不碰）。
 *     白名单之外的任何非 GET 仍然落到最后那条 501；
 *  3. 每个错误响应都带 kind，前端靠它区分「你令牌不对」/「这个功能套餐不支持」/「接口本身坏了」，
 *     这直接来自 63 次实测的错误码语义（docs/05、docs/06）。
 */
import { Hono, type Context } from "hono";
import { CfClient, CfError, cacheStats, type Kind } from "./cf";
import {
  reads,
  traffic,
  overview,
  parseRange,
  RANGES,
  waf,
  visibleAccountIds,
  visibleZones,
  WRITE_ROUTES,
  writes,
  dnsNameInZone,
  dnsPayload,
  validateDnsBody,
  validatePurgeBody,
  validateDeployBody,
  validateCronBody,
  validateSecretBody,
  validateSecretName,
  validateBindingsBody,
  validateWorkerObjId,
  validateD1WriteSql,
  validateKvKey,
  validateKvValue,
  assertPurgeHostsInZone,
  noteCreatedRecord,
  canDeleteRecord,
  forgetCreatedRecord,
  type VisibleZone,
} from "./catalog";

type Ctx = Context<{ Bindings: Env; Variables: { acctEnv: Env; cfClient: CfClient } }>;
const app = new Hono<{ Bindings: Env; Variables: { acctEnv: Env; cfClient: CfClient } }>();

const CORS = {
  "access-control-allow-origin": "*",
  // 必须列全前端会带的每一个自定义头：Allow-Origin: * 时，没进这个列表的头会让预检直接失败。
  // x-cf-token 是自带令牌（多账号）模式的核心头 —— 漏了它，APK 的跨域请求连门都进不来
  // （网页版同源访问不触发预检，所以这个坑一直没暴露）。
  "access-control-allow-headers": "authorization, content-type, x-device-token, x-cf-token",
  // 写路由上线后必须一起放开，否则手机上的预检会把 PUT/DELETE 挡在网关之外
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-max-age": "600",
};

app.options("*", () => new Response(null, { status: 204, headers: CORS }));

/* ============================================================================
 * 展示部署（demo）登录门。只在网关配了 DEMO_PASS 时启用；没配 = 整段等于不存在，
 * 自用部署行为与老版本完全一致。启用后：静态资源与 API 全部要求先 POST /login
 * （用户名 DEMO_USER、密码 DEMO_PASS），通过后发一枚 HttpOnly cookie（SHA-256 摘要，
 * 不落明文密码）；未登录的任何请求 302 到 /login。
 * 放在所有中间件最前面：run_worker_first=["/*"] 时静态资源也走这里，门才能真"全"。
 * ========================================================================== */
async function demoCookieValue(user: string, pass: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cf-console-demo:${user}:${pass}`));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function isDemoAuthed(c: Ctx, cv: string): boolean {
  return (c.req.header("cookie") || "").includes(`demo_auth=${cv}`);
}

function loginPage(incorrect: boolean): string {
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CF 控制台 · 登录</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1419;color:#e6edf3;font-family:system-ui,sans-serif}
.box{width:min(340px,88vw);background:#1b2129;border:1px solid #2d3742;border-radius:14px;padding:28px}
h1{font-size:17px;margin:0 0 4px}p{font-size:12px;color:#8b98a5;margin:0 0 18px}
label{display:block;font-size:12px;color:#8b98a5;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2d3742;background:#232a33;color:#e6edf3;font-size:14px}
button{width:100%;margin-top:18px;padding:11px;border:0;border-radius:8px;background:#2f9e5f;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
.err{color:#ff7b72;font-size:12px;margin:10px 0 0}
</style><div class="box"><h1>CF 控制台</h1><p>演示部署 · 请先登录</p>
<form method="post" action="/login"><label>用户名</label><input name="user" autocomplete="username" required>
<label>密码</label><input name="pass" type="password" autocomplete="current-password" required>
${incorrect ? '<div class="err">用户名或密码不对</div>' : ""}
<button>进入</button></form></div></html>`;
}

app.use("*", async (c, next) => {
  const pass = c.env.DEMO_PASS;
  const p = new URL(c.req.url).pathname;
  /**
   * OAuth 回调中继必须**无条件公开**：授权完成时浏览器还没带任何 cookie，
   * 若被登录门 302 到 /login，链条就断在这里，App 永远收不到 code。
   * 它本身不读数据、不写库，放行的只是"把 code 转成自定义 scheme"这一件事。
   */
  if (p === "/oauth/callback") return next();
  if (!pass) return next();
  const cv = await demoCookieValue(c.env.DEMO_USER || "", pass);
  if (isDemoAuthed(c, cv)) return next();
  if (p === "/login") {
    if (c.req.method === "POST") {
      const form = await c.req.parseBody();
      if (String(form.user || "") === (c.env.DEMO_USER || "") && String(form.pass || "") === pass) {
        const res = c.redirect("/", 302);
        res.headers.set(
          "set-cookie",
          `demo_auth=${cv}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600`,
        );
        return res;
      }
      return c.html(loginPage(true), 401);
    }
    return c.html(loginPage(false));
  }
  return c.redirect("/login", 302);
});

/**
 * 同源部署的第二种配法：静态壳和 API 挂在同一个域名上时，前端默认值 `effectiveBase()="/api"`
 * （见 console/src/lib/config.ts 的兜底）会打到这里。剥掉 `/api` 前缀再交给下面的路由表，
 * 这样"打包时注入绝对地址"和"装机后什么都不填"两种情况都能出数。
 *
 * 只影响路径前缀，不改动词、不改查询参数、也不放宽任何鉴权 —— 剥完之后走的还是同一套
 * 设备令牌闸门与 `?account=` 校验。递归调 app.fetch 会重跑一遍 CORS 中间件，无害（只是重设同样的头）。
 */
app.use("*", async (c, next) => {
  const p = new URL(c.req.url).pathname;
  if (p === "/api" || p.startsWith("/api/")) {
    const u = new URL(c.req.url);
    u.pathname = p.replace(/^\/api/, "") || "/";
    return app.fetch(new Request(u.toString(), c.req.raw), c.env, c.executionCtx);
  }
  return next();
});

app.use("*", async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(CORS)) c.res.headers.set(k, v);
  if (!c.res.headers.get("cache-control")) c.res.headers.set("cache-control", "no-store");
});

/**
 * /health 不需要设备令牌：设置页要靠它判断「地址填对了吗」。
 * `cache` 段是"网关到底打了多少次 CF"的唯一实测口径 —— 注意它是**当前这个 isolate** 的计数，
 * 线上多 isolate 时各自分格，所以这个数字是 CF 出网次数的**下界**，不是上界。
 */
app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "cf-console-gateway",
    writes: c.env.WRITE_ENABLED === "true" ? "enabled" : "disabled",
    // 前端靠它认出展示部署：冷启动探测到 demo=true 就免配置直接出数（用网关兜底令牌）
    demo: !!c.env.DEMO_PASS,
    ranges: Object.keys(RANGES),
    cache: { ...cacheStats(), scope: "isolate" },
  }),
);

/**
 * OAuth 回调中继（公开、无状态）。
 *
 * Cloudflare 只接受 https 的 `redirect_uri`，浏览器授权完必须落到一个 https 地址；
 * 再由这里 302 到 `cfconsole://oauth/callback`，系统才会拉起 App。没有这一跳，
 * 自定义 scheme 在授权页就会被拒（`invalid_request: Invalid redirect URI`）。
 *
 * 安全性：中继只做地址翻译 —— 不存 code、不换 token（换 token 必须带 `code_verifier`，
 * 它只在手机内存里）、不写日志、不落 cookie。哪怕 code 被旁人看到也换不出令牌。
 */
app.get("/oauth/callback", (c) => {
  const u = new URL(c.req.url);
  const to = new URL("cfconsole://oauth/callback");
  for (const k of ["code", "state", "error", "error_description"]) {
    const v = u.searchParams.get(k);
    if (v) to.searchParams.set(k, v);
  }
  const res = c.redirect(to.toString(), 302);
  res.headers.set("cache-control", "no-store");
  res.headers.set("referrer-policy", "no-referrer");
  return res;
});

/**
 * 鉴权：两种凭证取其一。
 *  1. **自带 CF 令牌**（`x-cf-token`）—— 令牌由客户端持有、经 HTTPS 带来，它本身就是账号凭证，
 *     也是"多账号"的实现方式（每个账号一条记录，切账号 = 换令牌）。带了就通过，不再问设备令牌。
 *  2. **设备令牌**（`x-device-token`）—— 旧模式，用于没在客户端存 CF 令牌的部署。
 * 两者都没有、或设备令牌不在名单里 → 401。设备名单没配时只认 CF 令牌。
 * 注意：带了 CF 令牌不等于"能看所有账号"——权限仍然由那把令牌自己决定，网关只是转交。
 */
app.use("/v1/*", async (c, next) => {
  const cfTok = (c.req.header("x-cf-token") || "").trim();
  if (cfTok) return next();
  // 展示部署：能走到这里说明最外层的 demo 登录门已经放行（cookie 有效），
  // 数据出口就是网关 env 的兜底 CF_API_TOKEN，访客无需自带令牌。
  if (c.env.DEMO_PASS) return next();
  const list = (c.env.DEVICE_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const got = (c.req.header("x-device-token") || (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "")).trim();
  if (!list.length) {
    return c.json({ error: { kind: "auth", message: "请求没带 CF 令牌（x-cf-token），网关也没配设备令牌兜底" } }, 401);
  }
  if (!got || !list.includes(got)) return c.json({ error: { kind: "auth", message: "设备令牌不对" } }, 401);
  await next();
});

/**
 * 多账号（读侧）：`?account=<32 位 hex>` 在这把令牌可见的账号集合里 → 用该账号 ID 覆盖 env；
 * 不在 → 422。放在设备令牌闸门**之后**，所以未鉴权的请求连不到 CF 那一步。
 *
 * 为什么这样是安全的：路径里的账号片段只能取自 `GET /accounts` 的返回集合，
 * 客户端传不进任意字符串，第 1 条硬规则没被削弱。
 *
 * 诚实提示：**当前令牌只有 1 个可见账号（`bai account`），所以这条链路是拿假 id 和真 id
 * 各打一次验出来的，"切到第二个账号后数据真的变了"仍未实测（docs/09 §F）**。
 */
app.use("/v1/*", async (c, next) => {
  const want = (c.req.query("account") || "").trim();
  if (!want) return next();
  // /v1/accounts 豁免：存储里的账号 id 一旦失效（后台改了令牌作用域），带着它连账号列表都取不到，
  // 设置页就死锁成"只能清 localStorage"。自救路径必须无条件可达。
  if (new URL(c.req.url).pathname === "/v1/accounts") return next();
  if (!/^[0-9a-f]{32}$/.test(want)) {
    return c.json({ error: { kind: "badQuery", message: "account 得是 32 位账号 id" } }, 422);
  }
  try {
    const ids = await visibleAccountIds(cfClient(c), reqToken(c));
    if (!ids.includes(want)) {
      return c.json({ error: { kind: "badQuery", message: "这个账号不在当前令牌可见的账号列表里" } }, 422);
    }
  } catch (e) {
    return bail(c, e);
  }
  c.set("acctEnv", { ...c.env, CF_ACCOUNT_ID: want });
  return next();
});

/** 当前请求该用哪个 env：设备传了合法 account 就用覆盖后的，否则用网关默认账号 */
const E = (c: Ctx): Env => c.get("acctEnv") ?? c.env;

/**
 * 每个请求一个 CfClient 实例（挂在 Hono 的 context 上），因为出网账本 `trace` 是按请求记的：
 * 响应头 `x-gw-cf-calls` 要能说清「这一条响应打了几次 CF」。
 * `?fresh=1` 让这个实例绕过缓存 —— 界面上的「刷新」按钮靠它，否则主动刷新会变成假动作。
 */
/**
 * 当前请求该用哪把 CF 令牌：客户端经 `x-cf-token` 带来的**优先**（自带令牌 / 多账号模式），
 * 没带才回落网关 env 的 `CF_API_TOKEN`（只在单账号自用部署里才有意义）。
 * 令牌只在这一次请求里用，网关不留副本 —— 它由客户端持有，这条是"多账号"能成立的前提。
 */
function reqToken(c: Ctx): string {
  return (c.req.header("x-cf-token") || "").trim() || c.env.CF_API_TOKEN || "";
}

/**
 * 只要令牌、不要账号 id 的 client，给路径里**不含账号片段**的调用用：
 * 列账号（`GET /accounts`）、列 zone（`GET /zones`）—— 拿令牌直接查就行。
 *
 * 单独拆出来是为了让 `/v1/accounts` 这条**自救路径不依赖云端配没配 `CF_ACCOUNT_ID`**：
 * 客户端存的那个账号 id 一旦失效（后台改了令牌作用域），用户必须还能进设置页把令牌换掉。
 */
function cfClient(c: Ctx): CfClient {
  const tok = reqToken(c);
  if (!tok) {
    throw new CfError(
      "misconfigured", 500, null,
      "本次请求没带 CF 令牌：客户端要经 x-cf-token 带来，或网关配 CF_API_TOKEN 兜底",
    );
  }
  let cli = c.get("cfClient");
  if (!cli) {
    cli = new CfClient(tok, c.env.CF_BASE || undefined, c.req.query("fresh") === "1");
    c.set("cfClient", cli);
  }
  return cli;
}

/**
 * 需要账号 id 的调用（路径要拼 `/accounts/{id}/…`）。账号从哪来：
 * 客户端 `?account=`（多账号 / 纯自带令牌）**优先**，没带才用网关默认 `CF_ACCOUNT_ID`。
 *
 * ⚠ 这里必须用 `E(c)` 而不是 `c.env` —— 用 `c.env` 的话，云端一旦没配 `CF_ACCOUNT_ID`，
 * 哪怕客户端已经把账号 id 带来了也照样 500，等于强迫云端持有账号信息，
 * 跟「凭据全在本地、云端只转发」的架构直接冲突（上面那个 `?account=` 覆盖就白做了）。
 */
function cf(c: Ctx) {
  if (!E(c).CF_ACCOUNT_ID) {
    throw new CfError(
      "misconfigured", 500, null,
      "本次请求没有账号 id：客户端没带 ?account=，网关也没配 CF_ACCOUNT_ID",
    );
  }
  return cfClient(c);
}

/** 把 CfError 翻译成前端能分支的结构 */
function bail(c: Ctx, e: unknown) {
  if (e instanceof CfError) {
    const status =
      e.kind === "misconfigured" ? 500
      : e.kind === "auth" ? 401
      : e.kind === "permission" || e.kind === "planLimit" || e.kind === "serviceDisabled" ? 403
      : e.kind === "notFound" ? 404
      : e.kind === "rate" ? 429
      : e.kind === "badQuery" || e.kind === "verb" ? 422
      : e.http >= 500 ? 502
      : 400;
    return c.json({ error: { kind: e.kind, upstream: e.http, code: e.code, message: e.message } }, status as 400);
  }
  return c.json({ error: { kind: "unknown", message: String((e as Error)?.message || e) } }, 500);
}

/** Hono 4 的 param() 返回 string|undefined；这里集中兜住，避免每个路由写一遍 ?? "" */
function param(c: Ctx, name: "s" | "v" | "zone" | "p" | "id" | "ns" | "key"): string {
  const v = c.req.param(name);
  if (!v) throw new CfError("badQuery", 422, null, "缺少路径参数 " + name);
  return v;
}

/**
 * 统一包装：所有路由都 async，因为 CfClient 的每一层都是网络调用。
 * 响应头三个字段是给前端和实测脚本用的（界面上「这条数据是缓存的」不能靠猜）：
 *   x-gw-cache      hit=全部命中缓存 / miss=全部出网 / mixed=一部分 / fresh=这次是强制刷新
 *   x-gw-fetched-at 数据在 CF 侧被真正取到的时刻（毫秒），缓存命中时它仍是老时刻 —— 前端据此显示真实年龄
 *   x-gw-cf-calls   这一条响应到底打了几次 api.cloudflare.com
 */
function withCacheHeaders(c: Ctx, res: Response): Response {
  const t = c.get("cfClient")?.trace;
  if (!t) {
    // CfClient 没被构造过 = 这条请求一次 CF 都没打。写侧的 422 全走这条路，头也要给，
    // 冒烟脚本才能断言 "x-gw-cf-calls: 0"，而不是靠"没这个头"去猜"应该没出网吧"。
    res.headers.set("x-gw-cf-calls", "0");
    return res;
  }
  const fresh = c.req.query("fresh") === "1";
  const state = fresh ? "fresh" : t.upstream === 0 ? "hit" : t.hits + t.coalesced > 0 ? "mixed" : "miss";
  res.headers.set("x-gw-cache", state);
  res.headers.set("x-gw-fetched-at", String(t.fetchedAt || Date.now()));
  res.headers.set("x-gw-cf-calls", String(t.upstream));
  return res;
}

function route<T>(fn: (c: Ctx) => Promise<T>) {
  return async (c: Ctx) => {
    try {
      return withCacheHeaders(c, c.json(await fn(c)));
    } catch (e) {
      return withCacheHeaders(c, bail(c, e));
    }
  };
}

const rangeOf = (c: Ctx) => parseRange(c.req.query("range"));

/** Workers 用量接口最多回溯 90 天（超了 CF 直接 400「from cannot be more than 90 days in the past」） */
const USAGE_MAX_LOOKBACK_MS = 90 * 86_400_000;

/**
 * Workers 用量的时间窗：默认「UTC 今日 00:00 → 现在」，因为免费额度就是按 UTC 午夜重置的。
 * 只接受 epoch 毫秒；非法值退回默认，太旧/倒挂直接 422 —— 这些校验都排在出网之前。
 */
function usageWindow(c: Ctx) {
  const now = Date.now();
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const num = (k: string, d: number) => {
    const raw = c.req.query(k);
    if (raw === undefined || raw === "") return d;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) throw new CfError("badQuery", 422, null, `${k} 得是 epoch 毫秒（这个接口只认这个格式）`);
    return Math.floor(v);
  };
  const from = num("from", dayStart);
  const to = num("to", now);
  if (now - from > USAGE_MAX_LOOKBACK_MS) throw new CfError("badQuery", 422, null, "from 太旧：用量接口最多回溯 90 天");
  if (to < from) throw new CfError("badQuery", 422, null, "to 不能早于 from");
  return { from, to };
}

/**
 * 闸门一：写总闸。`WRITE_ENABLED !== "true"` 时任何非 GET 一律 501，白名单不查、CF 不碰。
 * 现网默认就是这个状态（那个 secret 没设），所以回滚 = 删 secret，不用重新部署。
 *
 * 注册位置在设备令牌与 `?account=` 校验之后、所有写路由之前 —— 未鉴权的请求仍然是先 401。
 */
app.use("/v1/*", async (c, next) => {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  if (c.env.WRITE_ENABLED === "true") return next();
  return c.json({ error: { kind: "writesDisabled" satisfies Kind, message: "网关的写开关没打开（WRITE_ENABLED ≠ true），这条请求没有出网" } }, 501);
});

const MAX_WRITE_BODY = 32_768;

/** 写请求的 JSON 体：先卡大小再解析再判形状，这些分支全都排在任何 CF 调用前面 */
async function jsonBody(c: Ctx): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (raw.length > MAX_WRITE_BODY) throw new CfError("badQuery", 422, null, "请求体超过 32 KB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CfError("badQuery", 422, null, "请求体不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CfError("badQuery", 422, null, "请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/**
 * 闸门三之二：路径里的 `:zone` 必须落在这把令牌可见的 zone 集合里，并且属于当前账号。
 * 这是 `?account=` 那套校验的照抄（见 catalog.visibleZones）—— 客户端传不进任意路径片段这条硬规则
 * 对写同样成立，而且这里还要多带一个 zone 域名回来给记录名/清缓存 URL 归属校验用。
 *
 * 顺序上的讲究：可见集合要读一次 `GET /zones`，所以格式校验（零出网那条）必须在它前面跑完。
 */
async function writeZone(c: Ctx): Promise<VisibleZone> {
  const zone = param(c, "zone");
  if (!/^[0-9a-f]{32}$/.test(zone)) throw new CfError("badQuery", 422, null, "zone 得是 32 位 zone id");
  const list = await visibleZones(cf(c), reqToken(c));
  const z = list.find((x) => x.id === zone);
  if (!z) throw new CfError("badQuery", 422, null, "这个 zone 不在当前令牌可见的站点列表里");
  if (z.accountId && z.accountId !== E(c).CF_ACCOUNT_ID) throw new CfError("badQuery", 422, null, "这个 zone 不属于当前账号");
  return z;
}

const HEX32 = /^[0-9a-f]{32}$/;
const recordId = (c: Ctx): string => {
  const id = param(c, "id");
  if (!HEX32.test(id)) throw new CfError("badQuery", 422, null, "record id 得是 32 位十六进制");
  return id;
};

// ---------- 账号 / 资源发现 ----------
// 令牌可见的账号全量列表 + 本次请求实际用的账号，设置页靠它决定"要不要给切换器"。
// 三个字段各有用途，缺一个就会撒谎：
//   active    = 这份响应用的是哪个账号 id（本路由豁免 ?account=，所以它只能来自网关的默认账号；
//               纯客户端凭据部署下网关不配默认账号，这里就是 null —— 界面按 null 处理，别当错误）
//   requested = 设备存储里选的是哪个（原样回显，不校验、不拼进任何 CF 路径）
//   applied   = requested 是否还在可见集合里。false 时界面上要明说"这个选择已经失效"，
//               不能一边显示旧账号名一边让其它屏全部 422（同一类错见 docs/09 §E17）
app.get(
  "/v1/accounts",
  route(async (c) => {
    const list = ((await reads.account(cfClient(c), E(c))).data as any[]) || [];
    const requested = (c.req.query("account") || "").trim();
    return {
      result: list,
      active: E(c).CF_ACCOUNT_ID ?? null,
      requested: requested || null,
      applied: requested ? list.some((a) => String(a?.id) === requested) : true,
    };
  }),
);
app.get("/v1/account", route(async (c) => ({ result: (await reads.account(cf(c), E(c))).data })));
// 订阅列表：界面只要套餐标识。CF 这条原始返回里带 client_secrets（应用密钥）和整包价格字段，
// 那些不该往设备发 —— 白名单管"能要什么"，字段减法管"能看见什么"。实测 result 是数组，套餐在 rate_plan.id。
app.get(
  "/v1/subscriptions",
  route(async (c) => {
    const list = (await reads.subscriptions(cf(c), E(c))).data;
    const arr = Array.isArray(list) ? list : [];
    return { result: arr.map((s: any) => ({ plan: s?.rate_plan?.id ?? null, state: s?.state ?? null })) };
  }),
);
// Zone 列表按当前账号本地过滤：CF 在 /zones 的每条结果里都返回了 account.id（实测字段，
// 见 docs/evidence/responses.sample.json 的 zones 一节），所以不引入没实测过的 ?account_id= 查询参数。
// account.id 缺失的条目保留下来，别把"接口没返回这个字段"当成"不属于这个账号"（同一类错见 docs/09 §E16）。
app.get(
  "/v1/zones",
  route(async (c) => {
    const all = ((await reads.zones(cf(c), E(c))).data as any[]) || [];
    const id = E(c).CF_ACCOUNT_ID;
    return { result: all.filter((z) => !z?.account?.id || String(z.account.id) === id) };
  }),
);

// ---------- 流量 ----------
/**
 * 看板（含 `prev` 环比）注册两个名字：`/v1/overview` 是 console/src/lib/api.ts 一直在用的那条，
 * `/v1/traffic/overview` 是这次写侧需求里给的路径。同一个 handler，降级与出网口径一份代码，不抄两遍。
 */
const overviewRoute = route(async (c) => await overview(cf(c), E(c), c.req.query("range")));
app.get("/v1/overview", overviewRoute);
app.get("/v1/traffic/overview", overviewRoute);
app.get("/v1/traffic/series", route(async (c) => await traffic.series(cf(c), E(c), rangeOf(c))));
app.get("/v1/traffic/status", route(async (c) => await traffic.status(cf(c), E(c), rangeOf(c))));
app.get("/v1/traffic/origin", route(async (c) => await traffic.origin(cf(c), E(c), rangeOf(c))));
app.get("/v1/traffic/totals", route(async (c) => ({ result: await traffic.consoleTotals(cf(c), E(c), rangeOf(c)) })));
app.get("/v1/traffic/countries", route(async (c) => ({ result: await traffic.countries(cf(c), E(c), rangeOf(c)) })));
app.get(
  "/v1/traffic/top",
  route(async (c) => {
    const dim = (c.req.query("dim") || "host") as "host" | "path" | "bot";
    // 枚举校验放在这里，SQL 模板里只会出现固定列名，用户输入永远进不了 query
    if (dim !== "host" && dim !== "path" && dim !== "bot") throw new CfError("badQuery", 422, null, "dim 只能是 host/path/bot");
    return await traffic.top(cf(c), E(c), rangeOf(c), dim);
  }),
);
// 缓存命中 / 设备类型走的是另一个数据面（GraphQL adaptive），返回形状由 catalog 拉平成 {rows:[{k,reqs}]}
app.get(
  "/v1/traffic/adaptive",
  route(async (c) => {
    const dim = (c.req.query("dim") || "cache") as "cache" | "device";
    if (dim !== "cache" && dim !== "device") throw new CfError("badQuery", 422, null, "dim 只能是 cache/device");
    return await traffic.adaptiveDim(cf(c), E(c), rangeOf(c), dim);
  }),
);

// ---------- Workers 版本与部署 ----------
app.get("/v1/workers", route(async (c) => ({ result: (await reads.workerScripts(cf(c), E(c))).data })));
// 账户级 workers.dev 前缀。注册在 /v1/workers/:s/... 之前：这条是固定三段路径，
// 和脚本级那条（四段）本来不冲突，但先注册静态路由更稳，读起来也不用去想匹配顺序。
app.get("/v1/workers/subdomain", route(async (c) => ({ result: (await reads.accountSubdomain(cf(c), E(c))).data })));
/**
 * 账户级 Workers 今日用量（计算页那块）。注册在 `/v1/workers/:s/...` 之前，和 subdomain 同一个理由。
 * 返回的是 CF 原样形状 `{events, breakdown:[{bin,dataset,service,count,eventSize}]}`，
 * 再把这次的时间窗回带给界面 —— 「今日」按 UTC 算，不写清楚的话用户会以为按本地零点重置。
 * 额度上限（100,000 请求/日、200,000 事件/日）**接口不返回**，是 Cloudflare 免费套餐的公开文档值，
 * 由前端写死并注明来源；请求数这一头实测取不到，见 docs/11 §14。
 */
app.get(
  "/v1/workers/usage",
  route(async (c) => {
    const { from, to } = usageWindow(c);
    // 事件数是硬依赖：observability/usage 挂了整块就该进错误态。
    const r = await reads.workersUsage(cf(c), E(c), from, to);
    // 请求数是 best-effort：GraphQL 那条失败只把 requests 留成 null（界面继续显示"没取到"），不拖垮事件数。
    let requests: number | null = null;
    let reqErrors: number | null = null;
    let requestsErr: string | null = null;
    try {
      const rq = await reads.workersRequests(cf(c), E(c), from, to);
      requests = rq.requests;
      reqErrors = rq.errors;
    } catch (e) {
      requestsErr = String((e as { message?: string })?.message || e);
    }
    return { result: { ...(r.data as object), requests, reqErrors, requestsErr, from, to } };
  }),
);
app.get(
  "/v1/workers/:s/versions",
  route(async (c) => {
    const page = Math.min(1000, Math.max(1, Number(c.req.query("page") || 1) || 1));
    const per = Math.min(50, Math.max(1, Number(c.req.query("per_page") || 25) || 25));
    const r = await reads.workerVersions(cf(c), E(c), param(c, "s"), per, page);
    return { result: r.data, total: r.total };
  }),
);
app.get(
  "/v1/workers/:s/versions/:v",
  route(async (c) => ({ result: (await reads.workerVersion(cf(c), E(c), param(c, "s"), param(c, "v"))).data })),
);
app.get("/v1/workers/:s/deployments", route(async (c) => ({ result: (await reads.workerDeployments(cf(c), E(c), param(c, "s"))).data })));
app.get("/v1/workers/:s/settings", route(async (c) => ({ result: (await reads.workerSettings(cf(c), E(c), param(c, "s"))).data })));
// script-settings 与 settings 是两条路由、字段不同（observability 只在这里返回），前端要分别拿
app.get("/v1/workers/:s/script-settings", route(async (c) => ({ result: (await reads.workerScriptSettings(cf(c), E(c), param(c, "s"))).data })));
// workers.dev 脚本级开关：能读到 ≠ 本机网络能访问（docs/00）
app.get("/v1/workers/:s/subdomain", route(async (c) => ({ result: (await reads.workerSubdomain(cf(c), E(c), param(c, "s"))).data })));
app.get("/v1/workers/:s/secrets", route(async (c) => ({ result: (await reads.workerSecrets(cf(c), E(c), param(c, "s"))).data })));
app.get("/v1/workers/:s/crons", route(async (c) => ({ result: (await reads.workerCrons(cf(c), E(c), param(c, "s"))).data })));

// ---------- 自定义域名 / DNS ----------
app.get("/v1/domains", route(async (c) => ({ result: (await reads.workerDomains(cf(c), E(c))).data })));
app.get(
  "/v1/zones/:zone/dns_records",
  route(async (c) => {
    const r = await reads.dnsRecords(cf(c), E(c), param(c, "zone"));
    return { result: r.data, total: r.total };
  }),
);
app.get("/v1/zones/:zone/routes", route(async (c) => ({ result: (await reads.zoneRoutes(cf(c), E(c), param(c, "zone"))).data })));
// WAF/Rulesets 只读：三个 phase 一次拿全，空态与"套餐不认"分开返回（catalog.waf）
app.get("/v1/zones/:zone/waf", route(async (c) => await waf(cf(c), E(c), param(c, "zone"))));

// ---------- Pages ----------
app.get("/v1/pages", route(async (c) => ({ result: (await reads.pagesProjects(cf(c), E(c))).data })));
app.get("/v1/pages/:p/deployments", route(async (c) => ({ result: (await reads.pagesDeployments(cf(c), E(c), param(c, "p"))).data })));

// ---------- 写路由（catalog.WRITE_ROUTES 那四条，路径与前端契约一字不差） ----------
/*
 * 每条都是同一个顺序：① 路径参数形状 → ② 请求体逐字段校验（不依赖 zone，所以 422 时一次 CF 都没打）
 * → ③ zone 必须在可见集合里 → ④ 才真的出网。写响应一律 no-store（CORS 中间件已经加了）。
 */

app.post(
  "/v1/zones/:zone/dns_records",
  route(async (c) => {
    const draft = validateDnsBody(await jsonBody(c));
    const z = await writeZone(c);
    const r = await writes.dnsCreate(cf(c), z.id, dnsPayload(dnsNameInZone(draft, z.name)));
    const id = String((r.data as any)?.id || "");
    // 只有 CF 真的回了 id 才记账 —— 这本账是下面 DELETE 的唯一依据，宁可漏记也不能错记
    if (id) noteCreatedRecord(id);
    return { result: r.data };
  }),
);

app.put(
  "/v1/zones/:zone/dns_records/:id",
  route(async (c) => {
    const id = recordId(c);
    const draft = validateDnsBody(await jsonBody(c));
    const z = await writeZone(c);
    const r = await writes.dnsUpdate(cf(c), z.id, id, dnsPayload(dnsNameInZone(draft, z.name)));
    return { result: r.data };
  }),
);

app.delete(
  "/v1/zones/:zone/dns_records/:id",
  route(async (c) => {
    const id = recordId(c);
    /**
     * 红线（docs/12 §3 P3）：现有 15 条记录一条都不能删 —— 那条名为 `cf` 的 AAAA 是绑自定义域名
     * `cf.acct.example.com` 时 Cloudflare 自建的，删掉线上入口就没了，而 CF 对"删对了"和"删错了"
     * 都只回 200 success。所以 DELETE 只认本 isolate 里由本网关 POST 建过的 id（账本见 catalog）。
     */
    if (!canDeleteRecord(id)) {
      throw new CfError("badQuery", 422, null, "网关只允许删除自己创建的记录：这条 id 不在创建账本里（isolate 重启后账本会清空）。现有 15 条记录请在 Cloudflare 后台处理");
    }
    const z = await writeZone(c);
    const r = await writes.dnsDelete(cf(c), z.id, id);
    forgetCreatedRecord(id);
    return { result: r.data ?? { id, deleted: true } };
  }),
);

app.post(
  "/v1/zones/:zone/purge_cache",
  route(async (c) => {
    // 这道闸门一条都不能松：docs/09 §B5 实测过 `files:[123]` 被 CF 当成合法请求**真的执行了**。
    // "填个非法值赌它被拒"这个范式在 purge 上不成立，只能从源头只放过完整 https URL。
    const files = validatePurgeBody(await jsonBody(c));
    const z = await writeZone(c);
    assertPurgeHostsInZone(files, z.name);
    const r = await writes.purge(cf(c), z.id, files);
    return { result: r.data };
  }),
);

// ---------- 版本切换 / 回滚 / 灰度（2026-10-19 实测接通，docs/14 §7） ----------
/*
 * 顺序与 DNS 写一致：① 请求体逐字段校验（version_id 形状/占比/annotations，不依赖 CF）
 * → ② 目标版本存在性检查（GET versions/{id}，404 就是 422，一次写都不发）
 * → ③ 才真的 POST deployments。切到正在跑的版本是合法的 no-op（CF 会记一条新部署），不拦。
 */
app.post(
  "/v1/workers/:s/deployments",
  route(async (c) => {
    const s = param(c, "s");
    const draft = validateDeployBody(await jsonBody(c));
    // 版本存在性：GET versions/{id}，404 就是 422，一次写都不发（灰度形状两个都要验）
    const ids = draft.versions ? draft.versions.map((v) => v.version_id) : [draft.version_id as string];
    for (const vid of ids) await reads.workerVersion(cf(c), E(c), s, vid);
    const r = await writes.workerDeploy(cf(c), E(c), s, draft.payload);
    return { result: r.data };
  }),
);

// ---------- 闸门二之外的 Worker 设置写路由（形状 2026-10-19 真机实测，见 catalog.ts 注释） ----------

/** cron 保存：客户端 {schedules:[{cron}]} → 上游 PUT schedules 裸数组（包信封 400，实测） */
app.put(
  "/v1/workers/:s/crons",
  route(async (c) => {
    const s = param(c, "s");
    const schedules = validateCronBody(await jsonBody(c));
    const r = await writes.cronPut(cf(c), E(c), s, schedules);
    return { result: r.data };
  }),
);

/** Secret 增改：客户端 POST → 上游 PUT（201，实测自清理验证） */
app.post(
  "/v1/workers/:s/secrets",
  route(async (c) => {
    const s = param(c, "s");
    const body = validateSecretBody(await jsonBody(c));
    const r = await writes.secretPut(cf(c), E(c), s, body);
    return { result: r.data };
  }),
);

app.delete(
  "/v1/workers/:s/secrets/:id",
  route(async (c) => {
    const s = param(c, "s");
    const name = validateSecretName(param(c, "id"));
    const r = await writes.secretDelete(cf(c), E(c), s, name);
    return { result: r.data };
  }),
);

/** 绑定/变量保存：客户端 PUT {bindings} → 上游 PATCH settings 且 multipart（JSON 415，实测） */
app.put(
  "/v1/workers/:s/settings",
  route(async (c) => {
    const s = param(c, "s");
    const bindings = validateBindingsBody(await jsonBody(c));
    const r = await writes.settingsPatch(cf(c), E(c), s, bindings);
    return { result: r.data };
  }),
);

/** 删版本：API Token 会被 CF 拒 405（只认 Global Key），照实透传 —— 用什么令牌是用户的选择 */
app.delete(
  "/v1/workers/:s/versions/:id",
  route(async (c) => {
    const s = param(c, "s");
    const id = validateWorkerObjId(param(c, "id"), "version id");
    const r = await writes.versionDelete(cf(c), E(c), s, id);
    return { result: r.data };
  }),
);

/** 删部署记录：API Token 可用（实测 200），清理面板的「不碰版本本体」瘦身 */
app.delete(
  "/v1/workers/:s/deployments/:id",
  route(async (c) => {
    const s = param(c, "s");
    const id = validateWorkerObjId(param(c, "id"), "deployment id");
    const r = await writes.deploymentDelete(cf(c), E(c), s, id);
    return { result: r.data };
  }),
);

/** D1 写 SQL：写闸门管住的通道；GET 只读通道已收紧（见上） */
app.post(
  "/v1/d1/:id/query",
  route(async (c) => {
    const sql = validateD1WriteSql(await jsonBody(c));
    const r = await writes.d1WriteQuery(cf(c), E(c), param(c, "id"), sql);
    return { result: r.data };
  }),
);

/** KV 键值写/删：客户端 {value} → 上游裸文本 PUT（实测 GET 读回逐字节一致） */
app.put(
  "/v1/kv/:ns/values/:key",
  route(async (c) => {
    const ns = param(c, "ns");
    const key = validateKvKey(param(c, "key"));
    const value = validateKvValue(await jsonBody(c));
    const r = await writes.kvPut(cf(c), E(c), ns, key, value);
    return { result: r.data };
  }),
);

app.delete(
  "/v1/kv/:ns/values/:key",
  route(async (c) => {
    const ns = param(c, "ns");
    const key = validateKvKey(param(c, "key"));
    const r = await writes.kvDelete(cf(c), E(c), ns, key);
    return { result: r.data };
  }),
);

// ---------- 闸门二：白名单之外的非 GET 继续 501 ----------
/*
 * 走到这里说明上面四条具体写路由都没匹配上（Hono 按注册顺序跑，命中的已经被 route() 处理完了）。
 * 白名单只有 catalog.WRITE_ROUTES 那四条，其余 method/path 组合一条都不放行 ——
 * 开写没有把"不做 CF API 通用透传"变成"随便透传"。
 * GET 到不存在的路径仍然 404（"网关没这条路由"），不该被误报成"写操作未开放"。
 */

// ---------- 数据库（D1 + KV）----------
app.get("/v1/d1", route(async (c) => ({ result: (await reads.d1Databases(cf(c), E(c))).data })));
app.get("/v1/d1/:id", route(async (c) => ({ result: (await reads.d1Database(cf(c), E(c), param(c, "id"))).data })));
/**
 * D1 SQL 查询：网关侧是**只读**语义，所以注册成 GET（对 CF 那一头仍然是 POST，见 catalog.d1Query）。
 * 10-11 之前这条写的是 app.post，而前端 api.ts 只会发 GET，于是界面点「执行」必 404
 * 「网关没有这条路由」；check:routes 只比路径不比方法，所以静态检查看不见（§11 记过）。
 * 改成 POST + 开写闸也能通，但那是为了让一条只读查询出网而放开写开关，不划算。
 *
 * 信封必须自己包 `{ result: … }`：`reads.d1Query` 出来的是 CF 响应体放在 `.data` 里，
 * 直接 return 会把 `{data:[{results,meta}]}` 甩给界面，界面读 `result[0].results` 就是空 ——
 * 方法改对之后实测过这一步，查询"成功"却一行都不显示，就是这里漏的。
 */
app.get(
  "/v1/d1/:id/query",
  route(async (c) => {
    const sql = String(c.req.query("sql") || "");
    if (!sql) throw new CfError("badQuery", 422, null, "缺少 sql 参数");
    // SQL 长度限制：免费 Worker CPU 10ms/请求，超过一定长度会拖垮网关
    if (sql.length > 2000) throw new CfError("badQuery", 422, null, "SQL 太长（上限 2000 字符）");
    // 只读闸门（2026-10-20）：GET 这条以前放行任意 SQL —— 写语句（UPDATE/DELETE/DROP…）会
    // 绕过写闸门直接改库，公开部署（演示站）等于人人可写。这里只放行读语句，写语句 422
    // 指路 POST 通道（那条归写闸门管）。WRITE 开头覆盖 WITH-SELECT（保守归为写）。
    if (!/^\s*(select|pragma|explain)\b/i.test(sql)) {
      throw new CfError("badQuery", 422, null, "GET 通道只放行 SELECT / PRAGMA / EXPLAIN；改数据的语句请开写闸门后走 POST /v1/d1/{id}/query");
    }
    return { result: (await reads.d1Query(cf(c), E(c), param(c, "id"), sql)).data };
  }),
);
app.get("/v1/kv", route(async (c) => ({ result: (await reads.kvNamespaces(cf(c), E(c))).data })));
app.get(
  "/v1/kv/:ns/keys",
  route(async (c) => {
    // CF 要求 limit ≥ 10（实测 10028 "limit argument must be at least 10"），catalog 里还会再夹一次
    const limit = Math.min(1000, Math.max(10, Number(c.req.query("limit") || 100) || 100));
    const cursor = c.req.query("cursor") || undefined;
    const r = await reads.kvKeys(cf(c), E(c), param(c, "ns"), limit, cursor);
    // 信封必须是 { result, cursor }：KvPanel 读 r.result 渲染、r.cursor 判断"加载下一页"。
    // 以前这里返回裸数组，网关模式下 Key 列表整个是空的（直连层反而是对的）。
    return { result: r.data, ...(r.cursor ? { cursor: r.cursor } : {}) };
  }),
);
/**
 * R2 桶列表。这个账号当前 404 10015（没开通，见 catalog 那条注释），但错误必须原样透传：
 * 界面要靠 CF 的报错说"读不到"，而不是把 404 兜成"0 个桶"。
 */
app.get("/v1/r2", route(async (c) => ({ result: (await reads.r2Buckets(cf(c), E(c))).data })));

// ---------- Zero Trust（Access）只读四件套 ----------
// 组织信息是对象、其余三条是列表，信封保持一致由界面各自判空态。
app.get("/v1/zt/organization", route(async (c) => ({ result: (await reads.ztOrganization(cf(c), E(c))).data })));
app.get("/v1/zt/apps", route(async (c) => ({ result: (await reads.ztApps(cf(c), E(c))).data })));
app.get("/v1/zt/groups", route(async (c) => ({ result: (await reads.ztGroups(cf(c), E(c))).data })));
app.get("/v1/zt/policies", route(async (c) => ({ result: (await reads.ztPolicies(cf(c), E(c))).data })));

// ---------- 写操作兜底：本版本一律拒绝 ----------
// 只对非 GET 生效：GET 到不存在的路径应该 404（"网关没这条路由"），而不是被误报成"写操作未开放"。
app.use("/v1/*", async (c, next) => {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD") return next();
  const allowed = WRITE_ROUTES.map((r) => `${r.method} ${r.path}`).join("、");
  return c.json({ error: { kind: "writesDisabled" satisfies Kind, message: `这条写路由不在白名单里。白名单只有：${allowed}` } }, 501);
});

/**
 * 静态资源代发：run_worker_first=["/*"] 时，没被上面 API 路由吃掉的请求（/, /assets/*,
 * 深链）落到这里交给 ASSETS 绑定 —— SPA 兜底（not_found_handling）由 assets 配置自己负责。
 * 登录门在最外层已经拦过未登录请求，所以走到这里的都已有会话。
 * 没配 ASSETS 绑定（理论上不会）退回原来的 404。
 */
app.all("*", async (c) => {
  if (c.env.ASSETS) {
    // ASSETS 返回的 Response 头是只读的，CORS 中间件会对 c.res.headers.set → 直接 500。
    // 这里重包一层可变 Response（流式透传 body）。
    const r = await c.env.ASSETS.fetch(c.req.raw);
    return new Response(r.body, r);
  }
  return c.notFound();
});

app.notFound((c) => c.json({ error: { kind: "notFound", message: "网关没有这条路由（白名单见 app/gateway/src/catalog.ts）" } }, 404));

export default app;
