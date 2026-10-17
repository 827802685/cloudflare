/**
 * 直连模式：App 自己打 api.cloudflare.com，不经网关。
 *
 * 为什么成立：浏览器不能直连，是因为 CF 不发 CORS 头（预检 `OPTIONS` 直接 400）；
 * Capacitor 的原生 HTTP 走原生网络栈、**不参与同源策略**（见 capacitor.config.ts 里的 CapacitorHttp），
 * 所以 APK 里可以直连。这条也让「开源」成立：别人 clone 后装包即用，不必先部署一套网关。
 *
 * 代价：网关替前端做的事要在这里复刻 —— 拆包（CF 有 4 种信封）、错误归类（63 次实测的码表）、
 * 只读缓存与并发合并。本文件是 `app/gateway/src/{cf,catalog}.ts` 的移植，**口径与网关故意一字不差**，
 * 免得同一个错误在两条路上有两种说法。
 *
 * 未覆盖的路由抛 `DirectError("unknown", …, "直连未实现：…")`，**不做静默降级** ——
 * 界面上宁可明说这条不行，也别给半份数据。
 */
import type { ErrKind } from "./api";

export const DIRECT_BASE = "https://api.cloudflare.com/client/v4";

/* ============================================================================
 * 错误：与网关的 GwError 同形（kind/http/code/message）
 * ========================================================================== */
export class DirectError extends Error {
  constructor(readonly kind: ErrKind, readonly http: number, readonly code: string | null, message: string) {
    super(message);
  }
}

/**
 * 错误码 → 结论。表照抄网关 `cf.ts` 的 classify（63 次实测攒的），**别看门牌猜语义**：
 * `403` 不一定是"没权限"，`10405` 是"动词不支持"，`10003` 是"这个 phase 没配过规则"而不是权限。
 */
export function classify(http: number, code: string | null, message: string): ErrKind {
  if (http === 401 && code === "1000") return "auth";
  if (code === "10000" || code === "10001") return "permission";
  if (code === "10042") return "serviceDisabled";
  if (code === "1404") return "planLimit";
  if (code === "7003" || code === "7000") return "notFound";
  if (code === "10007" || code === "8000007") return "notFound";
  if (code === "10003" || code === "10336") return "notFound";
  if (code === "100146") return "notFound";
  if (code === "10405") return "badQuery";
  if (http === 410) return "serviceDisabled";
  if (http === 422) return "badQuery";
  if (http === 429) return "rate";
  if (http >= 500) return "upstreamBroken";
  if (http >= 400) return "unknown";
  return "unknown";
}

/** CF 的"列表"有 4 种信封（result / result.items / result.deployments / result.data），这里一次性拉平 */
export function listify(result: any, envelope?: any): { items: any[]; total?: number } {
  if (Array.isArray(result)) return { items: result };
  const nested = result?.items ?? result?.deployments ?? result?.schedules ?? result?.data;
  const items = Array.isArray(nested) ? nested : [];
  // 分页总数有两种位置：多数在顶层 result_info.total_count，少数在 result.total_count
  const ri = envelope?.result_info ?? result?.result_info;
  const total = ri?.total_count ?? result?.total_count;
  return { items, total: typeof total === "number" ? total : undefined };
}

/* ============================================================================
 * 只读缓存 + 并发合并（网关那层的等价物；TTL 与网关对齐 5 分钟）
 * ========================================================================== */
export const TTL_MS = 300_000;
type Entry = { at: number; status: number; text: string };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();

/** FNV-1a：只给缓存键分区用，不把令牌原文留在 Map 的键里 */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** 清掉直连缓存里匹配前缀的键（写完之后用，跟 api.ts 的 dropMem 一个道理） */
export function dropDirect(prefix: string): void {
  for (const k of Array.from(cache.keys())) if (k.includes(prefix)) cache.delete(k);
}

/**
 * 超时自己控，不用 `AbortSignal.timeout` —— 原生 fetch（CapacitorHttp 代理后）对 AbortSignal 支持有限，
 * 靠它会在真机上静默不超时。
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DirectError("timeout", 0, null, `直连 ${Math.round(ms / 1000)} 秒没响应`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }).catch((e) => { clearTimeout(t); reject(e); });
  });
}

interface Spec {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** 请求体是裸 SQL 文本（analytics_engine/sql 那一族），不是 JSON */
  rawText?: boolean;
  unwrap?: "result" | "items" | "list" | "text";
}

async function send(token: string, path: string, spec: Spec, fresh: boolean): Promise<{ status: number; text: string; json: any }> {
  const method = spec.method || "GET";
  const bodyStr = spec.body === undefined ? "" : spec.rawText ? String(spec.body) : JSON.stringify(spec.body);
  const readable = method === "GET" || path === "/graphql" || path.endsWith("/analytics/sql") || path.endsWith("/analytics_engine/sql");
  const key = readable ? `${fnv(token)}|${method}|${path}|${fnv(bodyStr)}` : "";

  const run = async (): Promise<Entry> => {
    const headers: Record<string, string> = {
      authorization: "Bearer " + token,
      "content-type": spec.rawText ? "text/plain;charset=UTF-8" : "application/json",
    };
    let res: Response;
    try {
      res = await withTimeout(
        fetch(DIRECT_BASE + path, {
          method,
          headers,
          body: spec.body === undefined ? undefined : spec.rawText ? String(spec.body) : JSON.stringify(spec.body),
        }),
        30_000,
      );
    } catch (e) {
      if (e instanceof DirectError) throw e;
      // 连接层失败（DNS / TLS / 原生层拒绝）—— 与网关的 network 归一类
      throw new DirectError("network", 0, null, String((e as Error)?.message || e));
    }
    const e: Entry = { at: Date.now(), status: res.status, text: await res.text() };
    if (key) cache.set(key, e);
    return e;
  };

  let e: Entry;
  const hit = key && !fresh ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < TTL_MS) {
    e = hit;
  } else if (!key) {
    e = await run();
  } else {
    const pending = inflight.get(key);
    if (pending) e = await pending;
    else {
      const p = run().finally(() => inflight.delete(key));
      inflight.set(key, p);
      e = await p;
    }
  }
  let json: any = null;
  try { json = JSON.parse(e.text); } catch { /* 文本类响应：DNS 导出、multipart 代码包 */ }
  return { status: e.status, text: e.text, json };
}

/** REST：`{ success, result }` 或 `{ success, result:{items} }` */
async function rest<T = any>(token: string, path: string, spec: Spec = {}, fresh = false): Promise<{ data: T; total?: number }> {
  const { status, text, json } = await send(token, path, spec, fresh);
  if (!json) {
    if (status < 200 || status >= 300) throw new DirectError(classify(status, null, text), status, null, text.slice(0, 200));
    return { data: text as unknown as T };
  }
  const err = json.errors?.[0];
  const code = err ? String(err.code) : json.code ? String(json.code) : null;
  const message = err?.message || json.error || json.message || "";
  if (json.success === false || status < 200 || status >= 300) {
    throw new DirectError(classify(status, code, message), status, code, message || `HTTP ${status}`);
  }
  if (spec.unwrap === "items" || spec.unwrap === "list") {
    const { items, total } = listify(json.result, json);
    return { data: (spec.unwrap === "items" ? (json.result?.items ?? json.result) : items) as T, total };
  }
  return { data: json.result as T };
}

/** GraphQL：错误没有 code，只有 message，只能按文案判 */
async function graphql<T = any>(token: string, query: string, vars?: Record<string, unknown>, fresh = false): Promise<T> {
  const { status, text, json } = await send(token, "/graphql", { method: "POST", body: { query, variables: vars } }, fresh);
  const gqlErr = json?.errors?.[0]?.message as string | undefined;
  if (gqlErr && /does not have access to the path/i.test(gqlErr)) throw new DirectError("planLimit", status, "GQL_PATH", gqlErr);
  if (gqlErr) throw new DirectError("badQuery", status, "GQL", gqlErr);
  if (status < 200 || status >= 300 || !json) throw new DirectError(classify(status, null, text), status, null, text.slice(0, 200));
  return json.data as T;
}

/** 分析 SQL：path 由调用方给全（三种 SQL 端点的形状不同） */
async function sql<T = any>(token: string, path: string, query: string, extra: Record<string, unknown> = {}, opts: { rawText?: boolean; fresh?: boolean } = {}): Promise<{ rows: T[]; stats?: any; rowsRead?: number }> {
  const body: unknown = opts.rawText ? query : { query, ...extra };
  const { status, text, json } = await send(token, path, { method: "POST", body, rawText: !!opts.rawText }, !!opts.fresh);
  if (status < 200 || status >= 300 || !json) {
    const msg = (json && (json.message || (json.errors && json.errors[0]?.message))) || text;
    const code = json?.errors?.[0] ? String(json.errors[0].code) : null;
    throw new DirectError(classify(status, code, msg), status, code, String(msg).slice(0, 240));
  }
  return { rows: (json.data || []) as T[], stats: json.statistics, rowsRead: json.rows };
}

/* ============================================================================
 * REST 路由映射：网关路径 → CF 调用
 * 对照来源：app/gateway/src/catalog.ts 的 `reads` 表（一条一条抄，不凭记忆）
 * ========================================================================== */
const enc = encodeURIComponent;
const A = (account: string) => `/accounts/${enc(account)}`;

/** 网关路径里的 `:id` / `:s` / `:zone` / `:ns` / `:p` / `:v` 用 PathSpec 正则抓出来 */
type Hit = { path: string; spec: Spec } | null;

/** 把 `/v1/workers/rin-server/versions/abc?page=2` 这类拆到段，供映射用 */
function seg(path: string): string[] {
  return path.replace(/^\/v1\//, "").split("/").map(decodeURIComponent);
}

function routeREST(path: string, q: Record<string, string | number | undefined>, account: string): Hit {
  const s = seg(path);
  const n = (v: string | number | undefined) => (v === undefined ? 0 : Number(v));
  const per50 = "?per_page=50";
  switch (s[0]) {
    case "accounts":
      return { path: "/accounts", spec: {} };
    case "account":
      return { path: "/accounts", spec: {} };
    case "subscriptions":
      return { path: `${A(account)}/subscriptions`, spec: {} };
    case "zones":
      if (s.length === 1) return { path: `/zones${per50}`, spec: {} };
      if (s.length === 3 && s[2] === "dns_records") return { path: `/zones/${enc(s[1])}/dns_records?per_page=100`, spec: { unwrap: "list" } };
      if (s.length === 3 && s[2] === "routes") return { path: `/zones/${enc(s[1])}/workers/routes?per_page=100`, spec: { unwrap: "list" } };
      return null;
    case "workers":
      if (s.length === 1) return { path: `${A(account)}/workers/scripts?per_page=100`, spec: {} };
      if (s.length === 2 && s[1] === "subdomain") return { path: `${A(account)}/workers/subdomain`, spec: {} };
      if (s.length >= 3) {
        const svc = enc(s[2]);
        const base = `${A(account)}/workers/scripts/${svc}`;
        if (s.length === 4 && s[3] === "versions") {
          const per = Math.min(50, Math.max(1, n(q.per_page) || 25));
          const page = Math.min(1000, Math.max(1, n(q.page) || 1));
          return { path: `${base}/versions?per_page=${per}&page=${page}`, spec: { unwrap: "list" } };
        }
        if (s.length === 5 && s[3] === "versions") return { path: `${base}/versions/${enc(s[4])}`, spec: {} };
        if (s.length === 4 && s[3] === "deployments") return { path: `${base}/deployments?environment=production&per_page=50`, spec: { unwrap: "list" } };
        if (s.length === 4 && s[3] === "settings") return { path: `${base}/settings`, spec: {} };
        if (s.length === 4 && s[3] === "script-settings") return { path: `${base}/script-settings`, spec: {} };
        if (s.length === 4 && s[3] === "subdomain") return { path: `${base}/subdomain`, spec: {} };
        if (s.length === 4 && s[3] === "secrets") return { path: `${base}/secrets`, spec: {} };
        if (s.length === 4 && s[3] === "crons") return { path: `${base}/schedules`, spec: {} };
      }
      return null;
    case "domains":
      return { path: `${A(account)}/workers/domains?per_page=100`, spec: { unwrap: "list" } };
    case "pages":
      if (s.length === 1) return { path: `${A(account)}/pages/projects?page=1&per_page=10`, spec: { unwrap: "list" } };
      if (s.length === 3 && s[2] === "deployments") return { path: `${A(account)}/pages/projects/${enc(s[1])}/deployments?page=1&per_page=10`, spec: { unwrap: "list" } };
      return null;
    case "d1":
      if (s.length === 1) return { path: `${A(account)}/d1/database?per_page=100`, spec: { unwrap: "list" } };
      if (s.length === 2) return { path: `${A(account)}/d1/database/${enc(s[1])}`, spec: {} };
      if (s.length === 3 && s[2] === "query") return null; // 走 POST，见 routeWrite/queryD1
      return null;
    case "kv":
      if (s.length === 1) return { path: `${A(account)}/storage/kv/namespaces?per_page=100`, spec: { unwrap: "list" } };
      if (s.length === 3 && s[2] === "keys") {
        const qs = new URLSearchParams({ limit: String(Math.min(500, Math.max(1, n(q.limit) || 100))) });
        if (q.cursor) qs.set("cursor", String(q.cursor));
        return { path: `${A(account)}/storage/kv/namespaces/${enc(s[1])}/keys?${qs.toString()}`, spec: { unwrap: "list" } };
      }
      return null;
    case "r2":
      return { path: `${A(account)}/r2/bucket?per_page=100`, spec: { unwrap: "list" } };
    case "zt":
      if (s.length === 2 && s[1] === "organization") return { path: `${A(account)}/access/organizations`, spec: {} };
      if (s.length === 2 && s[1] === "apps") return { path: `${A(account)}/access/apps?per_page=100`, spec: { unwrap: "list" } };
      if (s.length === 2 && s[1] === "groups") return { path: `${A(account)}/access/groups?per_page=100`, spec: { unwrap: "list" } };
      if (s.length === 2 && s[1] === "policies") return { path: `${A(account)}/access/policies?per_page=100`, spec: { unwrap: "list" } };
      return null;
    default:
      return null;
  }
}

/* ============================================================================
 * 对外：gwDirect —— 与网关的 gw() 同形（path + query → 拆好的数据）
 * ========================================================================== */
export interface DirectCtx {
  token: string;
  account: string;
  fresh: boolean;
}

/**
 * 直连入口。**只覆盖 REST 路由**；流量屏（overview / traffic/*）、WAF、Workers 用量这些
 * 需要 SQL/GraphQL 模板与多请求合并的路由，在这条分支上仍是未实现 —— 会抛一条说清楚原因的错，
 * 不做静默降级。
 */
export async function gwDirect<T = any>(path: string, query: Record<string, string | number | undefined>, ctx: DirectCtx): Promise<T> {
  const direct = routeREST(path, query, ctx.account);
  if (!direct) {
    throw new DirectError(
      "unknown",
      0,
      "DIRECT_UNSUPPORTED",
      `直连模式还没实现这条路由：${path}。流量/WAF/用量这几屏要复刻网关的 SQL·GraphQL 模板，正在补；暂时可以在「设置」里把网关地址填上走网关模式。`,
    );
  }
  const r = await rest<any>(ctx.token, direct.path, direct.spec, ctx.fresh);
  // 网关对 /v1/workers/versions 这类会额外包一层 { result, total }，这里保持同形
  if (direct.spec.unwrap === "list" && r.total !== undefined) {
    return { result: r.data, total: r.total } as unknown as T;
  }
  return { result: r.data } as unknown as T;
}

/** D1 SQL 查询（POST，单独出来是因为它不是 GET 语义） */
export async function d1QueryDirect(id: string, sqlText: string, ctx: DirectCtx) {
  const r = await rest<any>(ctx.token, `${A(ctx.account)}/d1/database/${enc(id)}/query`, { method: "POST", body: { sql: sqlText }, unwrap: "list" }, ctx.fresh);
  return { result: r.data };
}
