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
export function listify(result: any, envelope?: any): { items: any[]; total?: number; cursor?: string } {
  if (Array.isArray(result)) return { items: result };
  const nested = result?.items ?? result?.deployments ?? result?.schedules ?? result?.data;
  const items = Array.isArray(nested) ? nested : [];
  // 分页总数有两种位置：多数在顶层 result_info.total_count，少数在 result.total_count
  const ri = envelope?.result_info ?? result?.result_info;
  const total = ri?.total_count ?? result?.total_count;
  // 游标同层：KV keys 的 result_info 里是 cursor 不是 total_count，丢了它"加载下一页"就是死的（与网关 cf.ts 逐字同口径）
  const cursor = ri?.cursor ?? result?.cursor;
  return { items, total: typeof total === "number" ? total : undefined, cursor: typeof cursor === "string" && cursor ? cursor : undefined };
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
 * 自上次读取以来，直连真出网的次数（设置页账本与看板"数据来源"文案用）。
 * 并发请求之间只能做到大致归属 —— 和网关模式读响应头 x-gw-cf-calls 一样是近似账，
 * 不是逐条精确计数，所以界面上说的是"本次出网 N 次"这种量级口径。
 */
let directCalls = 0;
export function takeDirectCalls(): number {
  const n = directCalls;
  directCalls = 0;
  return n;
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
  /** multipart/form-data 请求体（PATCH settings 更新 bindings 必须，JSON 415）。content-type 交给 fetch 生成 */
  formData?: FormData;
  unwrap?: "result" | "items" | "list" | "text";
}

async function send(token: string, path: string, spec: Spec, fresh: boolean): Promise<{ status: number; text: string; json: any }> {
  const method = spec.method || "GET";
  const bodyStr = spec.body === undefined ? "" : spec.rawText ? String(spec.body) : JSON.stringify(spec.body);
  const readable = method === "GET" || path === "/graphql" || path.endsWith("/analytics/sql") || path.endsWith("/analytics_engine/sql");
  const key = readable ? `${fnv(token)}|${method}|${path}|${fnv(bodyStr)}` : "";

  const run = async (): Promise<Entry> => {
    directCalls++; // 记账：只有真的出网才 +1（缓存命中与 inflight 合并不走这里）
    const headers: Record<string, string> = { authorization: "Bearer " + token };
    if (!spec.formData) headers["content-type"] = spec.rawText ? "text/plain;charset=UTF-8" : "application/json";
    let res: Response;
    try {
      res = await withTimeout(
        fetch(DIRECT_BASE + path, {
          method,
          headers,
          body: spec.formData ?? (spec.body === undefined ? undefined : spec.rawText ? String(spec.body) : JSON.stringify(spec.body)),
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
async function rest<T = any>(token: string, path: string, spec: Spec = {}, fresh = false): Promise<{ data: T; total?: number; cursor?: string }> {
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
    const { items, total, cursor } = listify(json.result, json);
    return { data: (spec.unwrap === "items" ? (json.result?.items ?? json.result) : items) as T, total, cursor };
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
  switch (s[0]) {
    case "workers":
      // /v1/workers/usage（账户级）与 /v1/workers/subdomain（账户级前缀）在更早的分支接掉；
      // 这里只剩脚本级：/v1/workers/{s}/{action}（3 段）与 /v1/workers/{s}/versions/{v}（4 段）。
      // 段位曾经错位（把 s[2] 当脚本名、要求 4 段），导致详情页全部子接口 DIRECT_UNSUPPORTED 好几个版本。
      if (s.length === 2 && s[1] === "subdomain") return { path: `${A(account)}/workers/subdomain`, spec: {} };
      if (s.length >= 3 && s[1] !== "usage" && s[1] !== "subdomain") {
        const svc = enc(s[1]);
        const base = `${A(account)}/workers/scripts/${svc}`;
        const act = s[2];
        if (s.length === 3) {
          if (act === "versions") {
            const per = Math.min(50, Math.max(1, n(q.per_page) || 25));
            const page = Math.min(1000, Math.max(1, n(q.page) || 1));
            return { path: `${base}/versions?per_page=${per}&page=${page}`, spec: { unwrap: "list" } };
          }
          if (act === "deployments") return { path: `${base}/deployments?environment=production&per_page=50`, spec: { unwrap: "list" } };
          if (act === "settings") return { path: `${base}/settings`, spec: {} };
          if (act === "script-settings") return { path: `${base}/script-settings`, spec: {} };
          if (act === "subdomain") return { path: `${base}/subdomain`, spec: {} };
          if (act === "secrets") return { path: `${base}/secrets`, spec: {} };
          if (act === "crons") return { path: `${base}/schedules`, spec: {} };
        }
        if (s.length === 4 && act === "versions") return { path: `${base}/versions/${enc(s[3])}`, spec: {} };
      }
      return null;
    case "zones":
      if (s.length === 3 && s[2] === "routes") return { path: `/zones/${enc(s[1])}/workers/routes?per_page=100`, spec: { unwrap: "list" } };
      return null;
    case "kv":
      if (s.length === 3 && s[2] === "keys") {
        // CF 要求 limit ≥ 10（实测 10028），这里夹紧
        const qs = new URLSearchParams({ limit: String(Math.min(1000, Math.max(10, n(q.limit) || 100))) });
        if (q.cursor) qs.set("cursor", String(q.cursor));
        return { path: `${A(account)}/storage/kv/namespaces/${enc(s[1])}/keys?${qs.toString()}`, spec: { unwrap: "list" } };
      }
      return null;
    case "d1":
      if (s.length === 2) return { path: `${A(account)}/d1/database/${enc(s[1])}`, spec: {} };
      if (s.length === 3 && s[2] === "query") return null; // 走 POST，见 routeWrite/queryD1
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
 * 时间窗（移植网关 catalog.parseRange，口径一字不差）：
 * 按缓存 TTL 对齐到 5 分钟整格，不取"此刻" —— 否则每条 query 的时间戳都不同，
 * 缓存键永远不同、TTL 形同虚设（网关实测过的坑，docs/09）。
 */
const RANGE_TTL_MS = 300_000;
export const RANGES: Record<string, { days: number; label: string }> = {
  "24h": { days: 1, label: "最近 24 小时" },
  "7d": { days: 7, label: "最近 7 天" },
  "30d": { days: 30, label: "最近 30 天" },
};
export function parseRangeDirect(v: string | number | undefined): { key: string; days: number; start: string; end: string; dateGeq: string; dateLt: string } {
  const key = v === "24h" || v === "30d" ? String(v) : "7d";
  const { days } = RANGES[key];
  const bucket = Math.floor(Date.now() / RANGE_TTL_MS) * RANGE_TTL_MS;
  const end = new Date(bucket);
  const start = new Date(end.getTime() - days * 86400000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    key,
    days,
    start: iso(start),
    end: iso(new Date(end.getTime() + 3600000)),
    dateGeq: start.toISOString().slice(0, 10),
    dateLt: new Date(end.getTime() + 86400000).toISOString().slice(0, 10),
  };
}

/* ============================================================================
 * 流量：命名模板（移植网关 catalog.traffic，参数只有时间窗）
 * ========================================================================== */
const ACC = (account: string) => account;
const SCOPE = (account: string) => ({ scope: { accountTag: ACC(account) } });

/** 首页大数字：1dGroups(requests/bytes/threats) + adaptiveGroups(visits/edgeResponseBytes) */
async function consoleTotals(token: string, account: string, r: ReturnType<typeof parseRangeDirect>) {
  const q = `{ viewer { accounts(filter:{accountTag:"${account}"}) {
    g: httpRequests1dGroups(limit:${r.days}, filter:{date_geq:"${r.dateGeq}", date_lt:"${r.dateLt}"}, orderBy:["date_ASC"]) {
      dimensions { date }
      sum { requests bytes encryptedRequests threats }
    }
    v: httpRequestsAdaptiveGroups(limit:1, filter:{datetime_geq:"${r.start}", datetime_lt:"${r.end}"}) {
      sum { visits edgeResponseBytes }
    }
  } } }`;
  return graphql<any>(token, q);
}

/** 国家分布：SQL 面没有国家列，只有 GraphQL adaptive 有（看板里它并进 dashboard 的 a alias，这条是单独取） */
async function countriesDirect(token: string, account: string, r: ReturnType<typeof parseRangeDirect>) {
  const q = `{ viewer { accounts(filter:{accountTag:"${account}"}) {
    a: httpRequestsAdaptiveGroups(limit:8, filter:{datetime_geq:"${r.start}", datetime_lt:"${r.end}"}, orderBy:["count_DESC"]) {
      count dimensions { clientCountryName }
    }
  } } }`;
  return graphql<any>(token, q);
}

/** 看板三块合成一条 GraphQL（g/v/a 三个 alias），响应形状与分开查一致 */
async function dashboard(token: string, account: string, r: ReturnType<typeof parseRangeDirect>) {
  const q = `{ viewer { accounts(filter:{accountTag:"${account}"}) {
    g: httpRequests1dGroups(limit:${r.days}, filter:{date_geq:"${r.dateGeq}", date_lt:"${r.dateLt}"}, orderBy:["date_ASC"]) {
      dimensions { date }
      sum { requests bytes encryptedRequests threats }
    }
    v: httpRequestsAdaptiveGroups(limit:1, filter:{datetime_geq:"${r.start}", datetime_lt:"${r.end}"}) {
      sum { visits edgeResponseBytes }
    }
    a: httpRequestsAdaptiveGroups(limit:8, filter:{datetime_geq:"${r.start}", datetime_lt:"${r.end}"}, orderBy:["count_DESC"]) {
      count dimensions { clientCountryName }
    }
  } } }`;
  return graphql<any>(token, q);
}

async function trafficSeries(token: string, account: string, r: ReturnType<typeof parseRangeDirect>) {
  const fn = r.days <= 1 ? "toStartOfHour(timestamp)" : "toStartOfDay(timestamp)";
  const limit = r.days <= 1 ? 24 : Math.min(r.days + 1, 31);
  return sql(token, "/analytics/sql",
    `SELECT ${fn} AS t, count() AS reqs, sum(edgeResponseBytes) AS bytes FROM events.httpRequests GROUP BY t ORDER BY t ASC LIMIT ${limit}`,
    { time_range: { start: r.start, end: r.end }, ...SCOPE(account) });
}
async function trafficStatus(token: string, account: string, r: ReturnType<typeof parseRangeDirect>) {
  return sql(token, "/analytics/sql",
    "SELECT edgeResponseStatus AS code, count() AS reqs FROM events.httpRequests GROUP BY code ORDER BY reqs DESC LIMIT 12",
    { time_range: { start: r.start, end: r.end }, ...SCOPE(account) });
}
async function trafficOrigin(token: string, account: string, r: ReturnType<typeof parseRangeDirect>) {
  return sql(token, "/analytics/sql",
    "SELECT originResponseStatus AS code, count() AS reqs, round(avg(originResponseDurationMs)) AS avg_ms FROM events.httpRequests WHERE originResponseStatus > 0 GROUP BY code ORDER BY reqs DESC LIMIT 12",
    { time_range: { start: r.start, end: r.end }, ...SCOPE(account) });
}
async function trafficTop(token: string, account: string, r: ReturnType<typeof parseRangeDirect>, dim: "host" | "path" | "bot") {
  const col = dim === "host" ? "clientRequestHttpHost" : dim === "path" ? "clientRequestPath" : "verifiedBotCategory";
  return sql(token, "/analytics/sql",
    `SELECT ${col} AS k, count() AS reqs FROM events.httpRequests GROUP BY k ORDER BY reqs DESC LIMIT 20`,
    { time_range: { start: r.start, end: r.end }, ...SCOPE(account) });
}
/** 缓存命中 / 设备类型：SQL 面没有这两列（实测 422），只有 GraphQL adaptive 有 */
async function trafficAdaptive(token: string, account: string, r: ReturnType<typeof parseRangeDirect>, dim: "cache" | "device") {
  const col = dim === "cache" ? "cacheStatus" : "clientDeviceType";
  const q = `{ viewer { accounts(filter:{accountTag:"${account}"}) {
    x: httpRequestsAdaptiveGroups(limit:8, filter:{datetime_geq:"${r.start}", datetime_lt:"${r.end}"}, orderBy:["count_DESC"]) {
      count dimensions { ${col} }
    }
  } } }`;
  const j = await graphql<any>(token, q);
  const rows = (j?.viewer?.accounts?.[0]?.x ?? []).map((g: any) => ({ k: g.dimensions?.[col] ?? "未知", reqs: g.count }));
  return { rows, source: "graphql-adaptive", sampled: true };
}

/* ---------- 上一窗环比（移植 catalog.prevWindow/prevTotals） ---------- */
function prevWindow(r: ReturnType<typeof parseRangeDirect>): ReturnType<typeof parseRangeDirect> {
  const shift = r.days * 86400000;
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const start = new Date(Date.parse(r.start) - shift);
  const end = new Date(Date.parse(r.end) - shift);
  return {
    key: r.key, days: r.days, start: iso(start), end: iso(end),
    dateGeq: start.toISOString().slice(0, 10),
    dateLt: new Date(end.getTime() + 86400000).toISOString().slice(0, 10),
  };
}

/** CF 免费档分析数据保留期实测 32 天；上一窗整段在保留期外就一条请求都不发 */
const RETENTION_DAYS = 32;
const beyondRetention = (startIso: string) => Date.parse(startIso) < Date.now() - RETENTION_DAYS * 86400_000;
const retentionSkip = () => `CF 只保留最近 ${RETENTION_DAYS} 天的分析数据，上一窗整段在保留期外`;
const isRetentionError = (msg: string) => /older than\s+\d+[wd]/i.test(msg);

async function prevTotalsDirect(token: string, account: string, r: ReturnType<typeof parseRangeDirect>) {
  const p = prevWindow(r);
  const label = `上一窗 ${RANGES[r.key]?.label ?? r.key}（${p.start} → ${p.end}）`;
  const base = { reqs: null as number | null, bytes: null as number | null, visits: null as number | null, threats: null as number | null, range: label };
  if (beyondRetention(p.start)) return { ...base, skipped: retentionSkip() };
  try {
    const j = await consoleTotals(token, account, p);
    const acc = (j as any)?.viewer?.accounts?.[0];
    const days = Array.isArray(acc?.g) ? acc.g : [];
    const sum = (f: string) => days.reduce((a: number, d: any) => a + (Number(d?.sum?.[f]) || 0), 0);
    const visits = Array.isArray(acc?.v) ? acc.v : [];
    return {
      ...base,
      reqs: sum("requests"),
      bytes: sum("bytes"),
      threats: sum("threats"),
      visits: visits.reduce((a: number, x: any) => a + (Number(x?.sum?.visits) || 0), 0),
    };
  } catch (e) {
    const msg = e instanceof DirectError ? e.message : String((e as Error)?.message || e);
    if (isRetentionError(msg)) return { ...base, skipped: retentionSkip() };
    return { ...base, error: msg };
  }
}

/**
 * 首页看板：与网关 overview() 同一套组装 —— 3 次 CF 请求出全部卡片
 * （dashboard 一条 GraphQL + series + status），外加 prevTotals 环比。
 * allSettled：一块坏不影响其它卡片，每张卡各自带 error/kind。
 */
export async function overviewDirect(ctx: DirectCtx, range?: string | number) {
  const r = parseRangeDirect(range);
  const settled = await Promise.allSettled([
    dashboard(ctx.token, ctx.account, r),
    trafficSeries(ctx.token, ctx.account, r),
    trafficStatus(ctx.token, ctx.account, r),
    prevTotalsDirect(ctx.token, ctx.account, r),
  ]);
  const pick = <T,>(i: number, fallback: T): { value: T; error?: string; kind?: string } => {
    const s = settled[i];
    if (s.status === "fulfilled") return { value: s.value as T };
    const e = s.reason;
    return { value: fallback, error: e instanceof DirectError ? e.message : String(e), kind: e instanceof DirectError ? e.kind : "unknown" };
  };
  const merged = pick<any>(0, null) as { value: any; error?: string; kind?: string };
  const acc = merged.value?.viewer?.accounts?.[0];
  const split = (fields: Record<string, any>) =>
    merged.error
      ? { value: null, error: merged.error, kind: merged.kind }
      : { value: { viewer: { accounts: [fields] } } };
  return {
    range: r.key,
    days: r.days,
    consoleTotals: split({ g: acc?.g, v: acc?.v }),
    series: pick(1, { rows: [] as any[] }),
    status: pick(2, { rows: [] as any[] }),
    countries: split({ a: acc?.a }),
    prev:
      settled[3].status === "fulfilled"
        ? settled[3].value
        : { reqs: null, bytes: null, visits: null, threats: null, range: `上一窗 ${RANGES[r.key]?.label ?? r.key}`, error: String((settled[3] as PromiseRejectedResult).reason?.message ?? "上一窗统计失败") },
  };
}

/**
 * Workers 今日用量：事件数（observability/usage，硬依赖）+ 请求数
 * （GraphQL workersInvocationsAdaptive，best-effort 失败只置 null）。
 * 时间窗默认 UTC 今日 00:00 → 现在；参数只认 epoch 毫秒。
 */
export async function workersUsageDirect(ctx: DirectCtx, from?: number, to?: number) {
  const now = Date.now();
  const dayStart = Math.floor(now / 86400000) * 86400000;
  const f = from && from > 0 ? Math.floor(from) : dayStart;
  const t = to && to > 0 ? Math.floor(to) : now;
  if (now - f > 90 * 86400000) throw new DirectError("badQuery", 422, null, "from 太旧：用量接口最多回溯 90 天");
  if (t < f) throw new DirectError("badQuery", 422, null, "to 不能早于 from");
  const usage = await rest<any>(ctx.token, `${A(ctx.account)}/workers/observability/usage?from=${f}&to=${t}`, {}, ctx.fresh);
  let requests: number | null = null;
  let reqErrors: number | null = null;
  let requestsErr: string | null = null;
  try {
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const q = `{ viewer { accounts(filter:{accountTag:"${ctx.account}"}) { workersInvocationsAdaptive(limit:1, filter:{datetime_geq:"${iso(f)}", datetime_lt:"${iso(t)}"}) { sum { requests errors } } } } }`;
    const d = await graphql<any>(ctx.token, q);
    const sum = d?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0]?.sum;
    requests = typeof sum?.requests === "number" ? sum.requests : null;
    reqErrors = typeof sum?.errors === "number" ? sum.errors : null;
  } catch (e) {
    requestsErr = e instanceof DirectError ? e.message : String((e as Error)?.message || e);
  }
  return { result: { ...(usage.data as object), requests, reqErrors, requestsErr, from: f, to: t } };
}

/* ---------- WAF / Rulesets（移植 catalog.waf） ---------- */
const WAF_PHASES = [
  { phase: "http_request_firewall_custom", label: "自定义规则" },
  { phase: "http_request_firewall_managed", label: "托管规则集" },
  { phase: "http_ratelimit", label: "限流规则" },
] as const;

function slimRule(r: any) {
  return {
    id: r?.id,
    action: r?.action,
    enabled: r?.enabled === true,
    description: r?.description || "",
    expression: r?.expression || "",
    last_updated: r?.last_updated || "",
    ref: r?.ref || "",
    version: r?.version || "",
  };
}

/**
 * 三种"没拿到规则"的形状必须分开（网关同款）：
 *   200          → 有规则集（rules 仍可能空）
 *   404 code 10003 → 这个 phase 从没配过规则 = 正常空态
 *   400 unknown phase → 本套餐不认这个 phase 名（错误对象没有 code，只能按文案）
 */
export async function wafDirect(ctx: DirectCtx, zone: string) {
  const phases = await Promise.all(
    WAF_PHASES.map(async ({ phase, label }) => {
      try {
        const r = await rest<any>(ctx.token, `/zones/${enc(zone)}/rulesets/phases/${phase}/entrypoint`, {}, ctx.fresh);
        const res = r.data ?? {};
        const rules = Array.isArray(res.rules) ? res.rules.map(slimRule) : [];
        return { phase, label, state: "ok" as const, name: res.name || "", last_updated: res.last_updated || "", version: res.version || "", rules, note: "" };
      } catch (e) {
        if (e instanceof DirectError) {
          if (e.kind === "permission") return { phase, label, state: "denied" as const, rules: [], note: "令牌缺 Zone:Rules:Read / Zone WAF:Read，见 docs/05 §3" };
          if (e.code === "10003") return { phase, label, state: "empty" as const, rules: [], note: "这个 phase 没配过规则（正常空态，不是权限问题）" };
          if (/unknown phase/i.test(e.message)) return { phase, label, state: "unsupported" as const, rules: [], note: "本套餐不认这个 phase 名" };
          return { phase, label, state: "error" as const, rules: [], note: `${e.kind}：${e.message}`.slice(0, 200) };
        }
        return { phase, label, state: "error" as const, rules: [], note: String((e as Error)?.message || e).slice(0, 200) };
      }
    }),
  );
  return { zone, phases, ruleCount: phases.reduce((n, p) => n + p.rules.length, 0) };
}

/* ---------- 账号 / 订阅 / zones（网关同款的字段处理） ---------- */

/**
 * 通用逐页拉取（网关 catalog.pagedList 的逐字移植）：CF 的列表端点都有每页上限
 * （/accounts 默认 20、/zones 50、dns_records 100…），单页取法在条数超限时**静默截断**。
 * 按每页上限逐页拿满（在哪页断就停），total 照 result_info 透传。
 */
async function pagedListDirect(ctx: DirectCtx, base: string, perPage: number, maxPages = 10): Promise<{ data: any[]; total?: number }> {
  const out: any[] = [];
  let total: number | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const r = await rest<any[]>(ctx.token, `${base}${base.includes("?") ? "&" : "?"}per_page=${perPage}&page=${page}`, { unwrap: "list" }, ctx.fresh);
    const items = r.data || [];
    out.push(...items);
    if (typeof r.total === "number") total = r.total;
    if (items.length < perPage) break;
  }
  return { data: out, total };
}

/**
 * Pages 的列表分页跟 REST 其它接口不是一套（网关 catalog.pagesList 的逐字移植）：
 * 实测 `per_page>10` 直接 400 `code 8000024 Invalid list options`，所以固定每页 10 条、
 * 逐页循环拿满（上限 10 页），在哪页断了就停。参数顺序也是 page 在前，与网关逐字一致
 * （否则 tools/check-direct-parity.mjs 的 URL 断言会红）。
 */
async function pagesListDirect(ctx: DirectCtx, base: string, maxPages = 10): Promise<{ data: any[]; total?: number }> {
  const out: any[] = [];
  let total: number | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const r = await rest<any[]>(ctx.token, `${base}?page=${page}&per_page=10`, { unwrap: "list" }, ctx.fresh);
    const items = r.data || [];
    out.push(...items);
    if (typeof r.total === "number") total = r.total;
    if (items.length < 10) break;
  }
  return { data: out, total };
}

/**
 * 账号列表 + 三个状态字段的直连版合成：
 *   active    —— 直连模式没有"网关默认账号"，就是当前选中的账号（没选 = null）
 *   requested —— 设备存储里选的（原样回显）
 *   applied   —— 那个选择是否还在令牌可见集合里
 */
export async function accountsDirect(ctx: DirectCtx, requested?: string) {
  const r = await pagedListDirect(ctx, "/accounts", 50);
  const list = Array.isArray(r.data) ? r.data : [];
  const req = (requested || "").trim();
  return {
    result: list,
    active: ctx.account || null,
    requested: req || null,
    applied: req ? list.some((a) => String(a?.id) === req) : true,
  };
}

/** 订阅列表：CF 原始返回带 client_secrets 和价格字段，只留套餐标识（网关同款减法） */
export async function subscriptionsDirect(ctx: DirectCtx) {
  const r = await rest<any>(ctx.token, `${A(ctx.account)}/subscriptions`, {}, ctx.fresh);
  const arr = Array.isArray(r.data) ? r.data : [];
  return { result: arr.map((s: any) => ({ plan: s?.rate_plan?.id ?? null, state: s?.state ?? null })) };
}

/** Zone 列表按当前账号过滤：CF 每条都带 account.id，缺失的保留（"没返回"≠"不属于"） */
export async function zonesDirect(ctx: DirectCtx) {
  const r = await pagedListDirect(ctx, "/zones", 50);
  const all = Array.isArray(r.data) ? r.data : [];
  return { result: all.filter((z: any) => !z?.account?.id || String(z.account.id) === ctx.account) };
}

/**
 * 直连入口。路由分三类，一条一条对照网关 `app/gateway/src/index.ts` 的注册表：
 *  - 需要 SQL/GraphQL 模板或多请求合并的（流量屏 / WAF / Workers 用量 / D1 查询）：形状与网关逐字一致；
 *  - 普通 REST：走 routeREST 映射表（对照网关 catalog.ts 的 reads 表）；
 *  - 没覆盖的：抛一条说清楚原因的错，**不做静默降级** —— 界面上宁可明说这条不行，也别给半份数据。
 */
export async function gwDirect<T = any>(path: string, query: Record<string, string | number | undefined>, ctx: DirectCtx): Promise<T> {
  // 需要 SQL/GraphQL 模板或多请求合并的路由：一条一条对齐全，形状与网关逐字一致
  // overview 在网关上注册了两个名字（/v1/overview 与 /v1/traffic/overview），这里同样都接
  if (path === "/v1/overview" || path === "/v1/traffic/overview") return overviewDirect(ctx, query.range) as unknown as T;
  if (path === "/v1/traffic/series") return trafficSeries(ctx.token, ctx.account, parseRangeDirect(query.range)) as unknown as T;
  if (path === "/v1/traffic/status") return trafficStatus(ctx.token, ctx.account, parseRangeDirect(query.range)) as unknown as T;
  if (path === "/v1/traffic/origin") return trafficOrigin(ctx.token, ctx.account, parseRangeDirect(query.range)) as unknown as T;
  if (path === "/v1/traffic/countries") return { result: await countriesDirect(ctx.token, ctx.account, parseRangeDirect(query.range)) } as unknown as T;
  if (path === "/v1/traffic/totals") return { result: await consoleTotals(ctx.token, ctx.account, parseRangeDirect(query.range)) } as unknown as T;
  if (path === "/v1/traffic/top") {
    const dim = query.dim;
    if (dim !== "host" && dim !== "path" && dim !== "bot") throw new DirectError("badQuery", 422, null, "dim 只能是 host/path/bot");
    return trafficTop(ctx.token, ctx.account, parseRangeDirect(query.range), dim) as unknown as T;
  }
  if (path === "/v1/traffic/adaptive") {
    const dim = query.dim;
    if (dim !== "cache" && dim !== "device") throw new DirectError("badQuery", 422, null, "dim 只能是 cache/device");
    return trafficAdaptive(ctx.token, ctx.account, parseRangeDirect(query.range), dim) as unknown as T;
  }
  if (path === "/v1/workers/usage") return workersUsageDirect(ctx, query.from as number | undefined, query.to as number | undefined) as unknown as T;
  if (path === "/v1/zones") return zonesDirect(ctx) as unknown as T;
  if (path === "/v1/accounts") return accountsDirect(ctx, query.account as string | undefined) as unknown as T;
  if (path === "/v1/subscriptions") return subscriptionsDirect(ctx) as unknown as T;

  // 带段的路由，routeREST 覆盖不到，单独接（api.ts 把 ?sql= 拼在 path 上，所以先切开再匹配）
  const [purePath, qsPart] = path.split("?");
  const wafHit = /^\/v1\/zones\/([0-9a-f]{32})\/waf$/i.exec(purePath);
  if (wafHit) return wafDirect(ctx, wafHit[1]) as unknown as T;
  const d1q = /^\/v1\/d1\/([^/]+)\/query$/i.exec(purePath);
  if (d1q) return d1QueryDirect(d1q[1], new URLSearchParams(qsPart || "").get("sql") || "", ctx) as unknown as T;
  // Pages 项目详情 / 自定义域名（2026-10-21 临时项目实测 200）—— 必须在下面列表匹配之前
  const pageOne = /^\/v1\/pages\/([^/]+)(\/domains)?$/i.exec(purePath);
  if (pageOne) {
    const base = `${A(ctx.account)}/pages/projects/${enc(pageOne[1])}`;
    if (pageOne[2]) {
      // 这条列表不能带 per_page=100（实测 400 8000024），与网关 catalog.pageDomains 同口径
      const r = await rest<any[]>(ctx.token, `${base}/domains`, { unwrap: "list" }, ctx.fresh);
      return { result: r.data } as unknown as T;
    }
    const r = await rest<any>(ctx.token, base, {}, ctx.fresh);
    return { result: r.data } as unknown as T;
  }
  // Pages 两条走多页循环（per_page 硬限 10），与网关 catalog.pagesList 同口径
  const pagesHit = /^\/v1\/pages(?:\/([^/]+)\/deployments)?$/i.exec(purePath);
  if (pagesHit) {
    const base = pagesHit[1]
      ? `${A(ctx.account)}/pages/projects/${enc(pagesHit[1])}/deployments`
      : `${A(ctx.account)}/pages/projects`;
    return { result: (await pagesListDirect(ctx, base)).data } as unknown as T;
  }
  // ZT 组织信息：result 是对象不是列表，不能走 unwrap（网关 catalog.ztOrganization 同口径）
  if (path === "/v1/zt/organization") {
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/access/organizations`, {}, ctx.fresh);
    return { result: r.data } as unknown as T;
  }
  // Pages 构建日志（只读）。上游 2026-10-21 实测：result = {total, includes_container_logs, data:[{ts,line}]}
  const pgLogs = /^\/v1\/pages\/([^/]+)\/deployments\/([^/]+)\/logs$/i.exec(purePath);
  if (pgLogs) {
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/pages/projects/${enc(pgLogs[1])}/deployments/${enc(pgLogs[2])}/history/logs`, {}, ctx.fresh);
    return { result: r.data } as unknown as T;
  }
  // 其余列表端点：单页有硬上限（/accounts 默认 20、/zones 50、其余 100），全部逐页拿满，
  // 与网关 catalog.pagedList 同口径 —— 不然条数超限就静默截断
  const LIST_ROUTES: Array<{ re: RegExp; base: (m: RegExpMatchArray) => string; per: number; pages?: number }> = [
    { re: /^\/v1\/account$/, base: () => "/accounts", per: 50 },
    { re: /^\/v1\/zones\/([0-9a-f]{32})\/dns_records$/i, base: (m) => `/zones/${enc(m[1])}/dns_records`, per: 100, pages: 50 },
    { re: /^\/v1\/workers$/, base: () => `${A(ctx.account)}/workers/scripts`, per: 100 },
    { re: /^\/v1\/domains$/, base: () => `${A(ctx.account)}/workers/domains`, per: 100 },
    { re: /^\/v1\/d1$/, base: () => `${A(ctx.account)}/d1/database`, per: 100 },
    { re: /^\/v1\/kv$/, base: () => `${A(ctx.account)}/storage/kv/namespaces`, per: 100 },
    { re: /^\/v1\/r2$/, base: () => `${A(ctx.account)}/r2/bucket`, per: 100 },
    { re: /^\/v1\/zt\/apps$/, base: () => `${A(ctx.account)}/access/apps`, per: 100 },
    { re: /^\/v1\/zt\/groups$/, base: () => `${A(ctx.account)}/access/groups`, per: 100 },
    { re: /^\/v1\/zt\/policies$/, base: () => `${A(ctx.account)}/access/policies`, per: 100 },
  ];
  for (const lr of LIST_ROUTES) {
    const m = purePath.match(lr.re);
    if (m) return { result: (await pagedListDirect(ctx, lr.base(m), lr.per, lr.pages ?? 10)).data } as unknown as T;
  }

  const direct = routeREST(path, query, ctx.account);
  if (!direct) {
    throw new DirectError(
      "unknown",
      0,
      "DIRECT_UNSUPPORTED",
      `直连模式还没实现这条路由：${path}。`,
    );
  }
  const r = await rest<any>(ctx.token, direct.path, direct.spec, ctx.fresh);
  // 网关对 unwrap 列表额外包 { result, total, cursor? }，这里保持同形：
  // total 是 versions/domains 的"共 N 条"，cursor 是 KV keys 的"加载下一页"凭据
  if (direct.spec.unwrap === "list") {
    return {
      result: r.data,
      ...(r.total !== undefined ? { total: r.total } : {}),
      ...(r.cursor ? { cursor: r.cursor } : {}),
    } as unknown as T;
  }
  return { result: r.data } as unknown as T;
}

/**
 * D1 SQL 查询（POST，单独出来是因为它不是 GET 语义）。
 * 两条校验照抄网关 /v1/d1/:id/query：缺 sql 直接 422（别打一次 CF 才说），
 * 超 2000 字符也 422（免费 Worker CPU 10ms/请求那条限制对直连同样成立 ——
 * 它在手机主线程里跑，长 SQL 会直接把界面卡住）。
 */
export async function d1QueryDirect(id: string, sqlText: string, ctx: DirectCtx) {
  const sql = String(sqlText || "");
  if (!sql.trim()) throw new DirectError("badQuery", 422, null, "缺少 sql 参数");
  if (sql.length > 2000) throw new DirectError("badQuery", 422, null, "SQL 太长（上限 2000 字符）");
  const r = await rest<any>(ctx.token, `${A(ctx.account)}/d1/database/${enc(id)}/query`, { method: "POST", body: { sql }, unwrap: "list" }, ctx.fresh);
  return { result: r.data };
}

/**
 * 添加账号前的令牌验证：拿一把**还没保存**的令牌直接问 CF「你能看见哪些账号」。
 * 与 api.ts probeToken() 是同一件事，只是这条路不经过网关（APK 里本来就没有网关）。
 */
export async function probeTokenDirect(token: string): Promise<{ result: any[] }> {
  const r = await rest<any[]>(token, "/accounts", {});
  return { result: Array.isArray(r.data) ? r.data : [] };
}

/** 直连写侧与网关 catalog 同一套形状校验（域名 / Worker 脚本名 / 环境变量名） */
const HOSTNAME_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 写侧直连：DNS 增删改 + 按 URL 清缓存 + 版本切换/回滚/灰度 + 自定义域名/路由/环境变量/子域开关
 * （与网关 WRITE_ROUTES 同一张白名单，一条不多）。
 * 校验在 api.ts 的 gwWrite() 里已经做过（validateDns / validatePurgeFiles），
 * 这里只负责按白名单发出去；写完由调用方 dropDirect 作废相关缓存。
 */
export async function writeDirect(ctx: DirectCtx, method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<any> {
  const s = seg(path);
  // ---- 版本切换 / 回滚 / 灰度：两种形状都经 rin-server 实测（docs/14 §7）----
  // 直连没有网关挡着，网关 validateDeployBody 的那套校验在这里逐字复刻，一条都不能少。
  // ① 单版本（回滚/全量）：{version_id, percentage?(=100), annotations?}
  // ② 灰度分流：{versions: [两项，占比合计 100], annotations?}
  if (method === "POST" && s[0] === "workers" && s[2] === "deployments") {
    const raw = (body ?? {}) as Record<string, unknown>;
    const bad = (m: string): never => { throw new DirectError("badQuery", 422, null, m); };
    const cleanAnn = (): Record<string, string> | undefined => {
      if (raw.annotations === undefined) return undefined;
      if (typeof raw.annotations !== "object" || raw.annotations === null || Array.isArray(raw.annotations)) bad("annotations 必须是对象");
      const entries = Object.entries(raw.annotations as Record<string, unknown>);
      if (entries.length > 5) bad("annotations 最多 5 个键");
      const out: Record<string, string> = {};
      for (const [k, v] of entries) {
        if (typeof v !== "string" || v.length > 200) bad("annotations 的值必须是 ≤200 字符的字符串");
        out[k] = v as string;
      }
      return out;
    };
    const annotations = cleanAnn();
    let payload: Record<string, unknown>;
    if (raw.versions !== undefined) {
      const unknown = Object.keys(raw).filter((k) => !["versions", "annotations"].includes(k));
      if (unknown.length) bad(`不支持的字段：${unknown.join(",")}。灰度请只传 versions / annotations`);
      if (!Array.isArray(raw.versions) || raw.versions.length !== 2) bad("versions 必须恰好两项（灰度分流是两个版本合计 100；单项回滚请用 version_id 字段）");
      const versions = (raw.versions as unknown[]).map((v, i) => {
        if (typeof v !== "object" || v === null) bad(`versions[${i}] 必须是对象`);
        const o = v as Record<string, unknown>;
        const vid = String(o.version_id ?? "").trim();
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(vid)) bad(`versions[${i}].version_id 得是 36 位 UUID`);
        const p = Number(o.percentage);
        if (!Number.isInteger(p) || p < 0 || p > 100) bad(`versions[${i}].percentage 得是 0–100 的整数`);
        return { version_id: vid, percentage: p };
      });
      if (versions[0].percentage + versions[1].percentage !== 100) bad("两个版本的占比必须合计 100");
      payload = { strategy: "percentage", versions, ...(annotations ? { annotations } : {}) };
    } else {
      const allowed = ["version_id", "percentage", "annotations"];
      const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
      if (unknown.length) bad(`不支持的字段：${unknown.join(",")}。这条路由只认 ${allowed.join(" / ")}（灰度请传 versions 数组）`);
      const versionId = String(raw.version_id ?? "").trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId)) bad(`version_id 得是 36 位 UUID（现在是 ${versionId || "空"}）`);
      let percentage = 100;
      if (raw.percentage !== undefined) {
        percentage = Number(raw.percentage);
        if (percentage !== 100) bad("单版本占比只允许 100；想灰度请传 versions 数组（两个版本合计 100）");
      }
      payload = { strategy: "percentage", versions: [{ version_id: versionId, percentage }], ...(annotations ? { annotations } : {}) };
    }
    const svc = s[1];
    if (!svc) bad("缺少脚本名");
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/workers/scripts/${enc(svc)}/deployments`, { method: "POST", body: payload }, false);
    return r.data;
  }
  // ---- cron 保存（PUT 全量覆盖）。上游实测：PUT …/schedules 要**裸数组 [{cron}]**，
  // 包一层 {schedules:…} 直接 400 "Could not parse request body"；客户端体与网关一致，这里拆包。
  if (method === "PUT" && s[0] === "workers" && s[2] === "crons") {
    const raw = (body ?? {}) as Record<string, unknown>;
    const bad = (m: string): never => { throw new DirectError("badQuery", 422, null, m); };
    const unknown = Object.keys(raw).filter((k) => k !== "schedules");
    if (unknown.length) bad(`不支持的字段：${unknown.join(",")}。cron 保存只接受 {schedules:[{cron}]}`);
    const schedulesIn = raw.schedules as unknown[];
    if (!Array.isArray(schedulesIn)) bad("schedules 必须是数组（空数组 = 清空全部定时触发）");
    if (schedulesIn.length > 50) bad(`一次最多 50 条 cron（现在是 ${schedulesIn.length} 条）`);
    const schedules = schedulesIn.map((item, i) => {
      if (typeof item !== "object" || item === null) bad(`schedules[${i}] 必须是对象`);
      const cron = String((item as Record<string, unknown>).cron ?? "").trim();
      const fields = cron.split(/\s+/);
      if (fields.length !== 5 || fields.some((f) => !f.length || f.length > 32 || !/^[0-9*/,-]+$|^[A-Za-z][A-Za-z0-9-]*$/.test(f))) {
        bad(`schedules[${i}] 得是标准 5 字段 cron，例如 "0 1 * * *"（现在是 ${cron || "空"}）`);
      }
      return { cron };
    });
    const svc = s[1];
    if (!svc) bad("缺少脚本名");
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/workers/scripts/${enc(svc)}/schedules`, { method: "PUT", body: schedules }, false);
    return r.data;
  }

  // ---- Secret 增改（客户端 POST → 上游 PUT，201 实测）/ 删除（DELETE 200 实测）----
  if (method === "POST" && s[0] === "workers" && s[2] === "secrets" && !s[3]) {
    const raw = (body ?? {}) as Record<string, unknown>;
    const bad = (m: string): never => { throw new DirectError("badQuery", 422, null, m); };
    const allowed = ["name", "text", "type"];
    const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
    if (unknown.length) bad(`不支持的字段：${unknown.join(",")}。这条路由只认 ${allowed.join(" / ")}`);
    const name = String(raw.name ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > 64) bad("Secret 名得是环境变量形状（字母/数字/下划线、数字不打头、≤64 字符）");
    const text = raw.text as string;
    if (typeof text !== "string" || !text.length) bad("text 不能为空（要清空请删除这个 Secret）");
    if (text.length > 32768) bad(`text 超过 32768 字符（现在是 ${text.length}）`);
    if (raw.type !== "secret_text") bad('type 只支持 "secret_text"（其他绑定类型走「变量/绑定」面板）');
    const svc = s[1];
    if (!svc) bad("缺少脚本名");
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/workers/scripts/${enc(svc)}/secrets`, { method: "PUT", body: { name, text, type: "secret_text" } }, false);
    return r.data;
  }
  if (method === "DELETE" && s[0] === "workers" && s[2] === "secrets" && s[3]) {
    const name = s[3];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > 64) throw new DirectError("badQuery", 422, null, "Secret 名得是环境变量形状");
    const svc = s[1];
    if (!svc) throw new DirectError("badQuery", 422, null, "缺少脚本名");
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/workers/scripts/${enc(svc)}/secrets/${enc(name)}`, { method: "DELETE" }, false);
    return r.data;
  }

  // ---- 绑定/变量保存。上游实测：PATCH …/settings 必须 multipart/form-data（JSON 415），
  // part 名 `settings`、值 JSON {"bindings":[…]}（part 名不对 400 "Missing settings part"）。
  // 客户端动词 PUT（与面板文案一致），这里转 PATCH + multipart；只做结构校验，绑定原样透传。
  if (method === "PUT" && s[0] === "workers" && s[2] === "settings") {
    const raw = (body ?? {}) as Record<string, unknown>;
    const bad = (m: string): never => { throw new DirectError("badQuery", 422, null, m); };
    const unknown = Object.keys(raw).filter((k) => k !== "bindings");
    if (unknown.length) bad(`不支持的字段：${unknown.join(",")}。这条路由只接受 {bindings:[…]}（PUT 全量覆盖，漏掉的绑定会被删）`);
    const list = raw.bindings as unknown[];
    if (!Array.isArray(list)) bad("bindings 必须是数组");
    if (list.length > 64) bad(`bindings 最多 64 项（现在是 ${list.length} 项）`);
    for (const [i, b] of list.entries()) {
      if (typeof b !== "object" || b === null) bad(`bindings[${i}] 必须是对象`);
      const o = b as Record<string, unknown>;
      if (typeof o.type !== "string" || !o.type) bad(`bindings[${i}].type 缺失`);
      if (typeof o.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.name) || o.name.length > 64) bad(`bindings[${i}].name 得是环境变量形状`);
      if (o.type === "plain_text" && typeof o.text !== "string") bad(`bindings[${i}] 是 plain_text，必须有 text 字段`);
    }
    const svc = s[1];
    if (!svc) bad("缺少脚本名");
    const fd = new FormData();
    fd.append("settings", JSON.stringify({ bindings: list }));
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/workers/scripts/${enc(svc)}/settings`, { method: "PATCH", formData: fd }, false);
    return r.data;
  }

  // ---- 删版本 / 删部署记录。删版本 ⚠️ CF 对 API Token 一律 405（只认 Global Key，实测 3 次），
  // 照实透传把 405 上屏；删部署记录 API Token 可用（实测 200），清理面板走这条。
  if (method === "DELETE" && s[0] === "workers" && (s[2] === "versions" || s[2] === "deployments") && s[3]) {
    const kind = s[2];
    const id = s[3];
    if (!/^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new DirectError("badQuery", 422, null, `${kind === "versions" ? "version" : "deployment"} id 得是 32 位 hex 或 36 位 UUID`);
    }
    const svc = s[1];
    if (!svc) throw new DirectError("badQuery", 422, null, "缺少脚本名");
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/workers/scripts/${enc(svc)}/${kind}/${enc(id)}`, { method: "DELETE" }, false);
    return r.data;
  }

  // ---- D1 写 SQL（写闸门通道；读语句仍走 GET 只读路径）。上游实测：POST database/{id}/query
  // {sql} 对 CREATE/INSERT/UPDATE/DELETE/DROP 全 200（临时库全链路自清理验证）。
  if (method === "POST" && s[0] === "d1" && s[2] === "query") {
    const raw = (body ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(raw).filter((k) => k !== "sql");
    if (unknown.length) throw new DirectError("badQuery", 422, null, `不支持的字段：${unknown.join(",")}。这条路由只接受 {sql:"…"}`);
    const sql = typeof raw.sql === "string" ? raw.sql.trim() : "";
    if (!sql) throw new DirectError("badQuery", 422, null, "sql 不能为空");
    if (sql.length > 20000) throw new DirectError("badQuery", 422, null, `SQL 太长（写通道上限 20000 字符，现在是 ${sql.length}）`);
    const id = s[1];
    if (!id) throw new DirectError("badQuery", 422, null, "缺少数据库 id");
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/d1/database/${enc(id)}/query`, { method: "POST", body: { sql } }, false);
    return r.data;
  }

  // ---- KV 键值写/删。上游实测：PUT values/{key} body 是**裸文本**（JSON 会把引号存进去），
  // GET 读回逐字节一致；DELETE 200、删后 GET 404（临时命名空间自清理验证）。
  // 客户端发 {value:"…"}（与 ConfirmSheet 全量回显一致），这里取出裸文本再发。
  if (method === "PUT" && s[0] === "kv" && s[2] === "values" && s[3]) {
    const raw = (body ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(raw).filter((k) => k !== "value");
    if (unknown.length) throw new DirectError("badQuery", 422, null, `不支持的字段：${unknown.join(",")}。写键值只接受 {value:"…"}`);
    const value = raw.value;
    if (typeof value !== "string" || !value.length) throw new DirectError("badQuery", 422, null, "value 必须是非空字符串（要清掉这个键请用删除）");
    const bytes = new TextEncoder().encode(value).length;
    if (bytes > 65536) throw new DirectError("badQuery", 422, null, `value 超过 64KB（这条通道的上限）`);
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/storage/kv/namespaces/${enc(s[1])}/values/${enc(s[3])}`, { method: "PUT", body: value, rawText: true }, false);
    return r.data;
  }
  if (method === "DELETE" && s[0] === "kv" && s[2] === "values" && s[3]) {
    const key = s[3];
    if (!key.length || new TextEncoder().encode(key).length > 512) throw new DirectError("badQuery", 422, null, "key 得是 1–512 字节");
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/storage/kv/namespaces/${enc(s[1])}/values/${enc(key)}`, { method: "DELETE" }, false);
    return r.data;
  }

  // ---- 脚本级 workers.dev 开关：客户端 PUT {enabled, previews_enabled} → 上游 POST 同体（2026-10-22 实测）
  if (method === "PUT" && s[0] === "workers" && s[2] === "subdomain" && !s[3]) {
    const raw = (body ?? {}) as Record<string, unknown>;
    const bad = (m: string): never => { throw new DirectError("badQuery", 422, null, m); };
    const allowed = ["enabled", "previews_enabled"];
    const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
    if (unknown.length) bad(`不支持的字段：${unknown.join(",")}。这条路由只认 ${allowed.join(" / ")}`);
    for (const k of allowed) if (typeof raw[k] !== "boolean") bad(`${k} 必须是布尔值（两个都要传，缺一个会被上游当成 reset）`);
    const svc = s[1];
    if (!svc) bad("缺少脚本名");
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/workers/scripts/${enc(svc)}/subdomain`, {
      method: "POST",
      body: { enabled: raw.enabled, previews_enabled: raw.previews_enabled },
    }, false);
    return r.data;
  }

  // ---- Workers 自定义域名。上游 2026-10-22 实测：**PUT** /accounts/{a}/workers/domains（POST 405），
  // body {hostname, zone_id, service, environment:"production"}；解绑 DELETE …/domains/{id} 空 200。
  if (method === "POST" && s[0] === "domains" && !s[1]) {
    const raw = (body ?? {}) as Record<string, unknown>;
    const bad = (m: string): never => { throw new DirectError("badQuery", 422, null, m); };
    const allowed = ["hostname", "zone_id", "service", "environment"];
    const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
    if (unknown.length) bad(`不支持的字段：${unknown.join(",")}。这条路由只认 ${allowed.join(" / ")}`);
    const hostname = String(raw.hostname ?? "").trim().toLowerCase().replace(/\.+$/, "");
    if (!hostname || hostname.includes("/") || hostname.includes(":") || hostname.includes("*") || hostname.length > 253 || !HOSTNAME_RE.test(hostname)) {
      bad(`hostname 不是合法域名：${hostname || "空"}`);
    }
    const zone_id = String(raw.zone_id ?? "").trim();
    if (!/^[0-9a-f]{32}$/i.test(zone_id)) bad("zone_id 得是 32 位 zone id");
    const service = String(raw.service ?? "").trim();
    if (!SCRIPT_NAME_RE.test(service)) bad(`service 得是 Worker 脚本名：${service || "空"}`);
    const environment = raw.environment === undefined ? "production" : String(raw.environment);
    if (environment !== "production") bad('environment 只支持 "production"（这条上游端点没有 preview 写法）');
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/workers/domains`, {
      method: "PUT",
      body: { hostname, zone_id, service, environment },
    }, false);
    return r.data;
  }
  if (method === "DELETE" && s[0] === "domains" && s[1]) {
    const id = s[1];
    if (!/^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new DirectError("badQuery", 422, null, "domain id 得是 32 位 hex 或 36 位 UUID");
    }
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/workers/domains/${enc(id)}`, { method: "DELETE" }, false);
    return r.data;
  }

  // ---- Pages 自定义域名。上游 2026-10-22 临时项目实测：POST …/projects/{p}/domains {name}；
  // DELETE …/domains/{name}；列表不能带 per_page=100（400 8000024）。
  if (method === "POST" && s[0] === "pages" && s[2] === "domains" && !s[3]) {
    const raw = (body ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(raw).filter((k) => k !== "name");
    if (unknown.length) throw new DirectError("badQuery", 422, null, `不支持的字段：${unknown.join(",")}。这条路由只接受 {name}`);
    const name = String(raw.name ?? "").trim().toLowerCase().replace(/\.+$/, "");
    if (!name || name.includes("/") || name.includes(":") || name.includes("*") || name.length > 253 || !HOSTNAME_RE.test(name)) {
      throw new DirectError("badQuery", 422, null, `name 不是合法域名：${name || "空"}`);
    }
    const proj = s[1];
    if (!proj) throw new DirectError("badQuery", 422, null, "缺少 Pages 项目名");
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/pages/projects/${enc(proj)}/domains`, { method: "POST", body: { name } }, false);
    return r.data;
  }
  if (method === "DELETE" && s[0] === "pages" && s[2] === "domains" && s[3]) {
    const name = s[3].trim().toLowerCase().replace(/\.+$/, "");
    if (!name || name.includes("/") || name.includes(":") || name.includes("*") || name.length > 253 || !HOSTNAME_RE.test(name)) {
      throw new DirectError("badQuery", 422, null, `name 不是合法域名：${name || "空"}`);
    }
    const proj = s[1];
    if (!proj) throw new DirectError("badQuery", 422, null, "缺少 Pages 项目名");
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/pages/projects/${enc(proj)}/domains/${enc(name)}`, { method: "DELETE" }, false);
    return r.data;
  }

  // ---- Pages 环境变量。上游 2026-10-22 临时项目实测：PATCH 项目对象
  // {deployment_configs:{production|preview:{env_vars:{KEY:{value,type}}}}}；删除 = 不传这个键。
  if (method === "PUT" && s[0] === "pages" && s[2] === "env_vars") {
    const raw = (body ?? {}) as Record<string, unknown>;
    const bad = (m: string): never => { throw new DirectError("badQuery", 422, null, m); };
    const unknown = Object.keys(raw).filter((k) => !["environment", "vars"].includes(k));
    if (unknown.length) bad(`不支持的字段：${unknown.join(",")}。这条路由只认 environment / vars`);
    const environment = String(raw.environment ?? "").trim();
    if (environment !== "production" && environment !== "preview") bad('environment 只能是 "production" 或 "preview"');
    const varsRaw = raw.vars as unknown;
    if (!varsRaw || typeof varsRaw !== "object" || Array.isArray(varsRaw)) bad("vars 必须是 {KEY:{value,type}} 对象（空对象 = 这个环境没有变量）");
    const entries = Object.entries(varsRaw as Record<string, unknown>);
    if (entries.length > 64) bad(`一次最多 64 个环境变量（现在是 ${entries.length} 个）`);
    const vars: Record<string, { value: string; type: string }> = {};
    for (const [name, item] of entries) {
      if (!ENV_NAME_RE.test(name) || name.length > 64) bad(`环境变量名得是字母/数字/下划线、数字不打头、≤64 字符：${name || "空"}`);
      if (typeof item !== "object" || item === null || Array.isArray(item)) bad(`vars.${name} 必须是 {value,type} 对象`);
      const o = item as Record<string, unknown>;
      const extra = Object.keys(o).filter((k) => !["value", "type"].includes(k));
      if (extra.length) bad(`vars.${name} 不支持的字段：${extra.join(",")}`);
      if (typeof o.value !== "string") bad(`vars.${name}.value 必须是字符串（删除变量请把它从表里去掉，别传 null）`);
      if (new TextEncoder().encode(o.value as string).length > 8192) bad(`vars.${name}.value 超过 8192 字节`);
      const type = o.type === undefined ? "plain_text" : String(o.type);
      if (type !== "plain_text" && type !== "secret_text") bad(`vars.${name}.type 只能是 plain_text 或 secret_text`);
      vars[name] = { value: o.value as string, type };
    }
    const proj = s[1];
    if (!proj) bad("缺少 Pages 项目名");
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/pages/projects/${enc(proj)}`, {
      method: "PATCH",
      body: { deployment_configs: { [environment]: { env_vars: vars } } },
    }, false);
    return r.data;
  }

  // ---- 站点 Workers 路由。上游形状来自官方 OpenAPI 实读条目（POST/PUT/DELETE 同路径），
  // ⚠️ 当前令牌缺 Workers Routes Write，增删改尚未真机验证（需要临时令牌，见 docs/05）。
  if (s[0] === "zones" && s[2] === "routes" && /^[0-9a-f]{32}$/i.test(s[1] || "")) {
    const zone = s[1];
    const routeBody = (): { pattern: string; script: string | null } => {
      const raw = (body ?? {}) as Record<string, unknown>;
      const bad = (m: string): never => { throw new DirectError("badQuery", 422, null, m); };
      const unknown = Object.keys(raw).filter((k) => !["pattern", "script"].includes(k));
      if (unknown.length) bad(`不支持的字段：${unknown.join(",")}。这条路由只认 pattern / script`);
      const pattern = String(raw.pattern ?? "").trim().toLowerCase();
      if (!pattern) bad("pattern 不能为空");
      if (pattern.includes("://") || /\s/.test(pattern)) bad("pattern 是「主机名/路径」形状，不带协议、不带空格");
      if (!/^(\*\.)?[a-z0-9.-]+\/\S*$/.test(pattern)) bad(`pattern 得是 example.com/* 或 *.example.com/* 这种形状（现在是 ${pattern}）`);
      if (!pattern.endsWith("*")) bad("pattern 要以 * 结尾（CF 的路由靠末尾通配匹配路径）");
      if (!raw.script && raw.script !== null) bad("script 必须是 Worker 脚本名，或 null（表示这条路由只跳过 Worker）");
      const script = raw.script === null ? null : String(raw.script).trim();
      if (script !== null && !SCRIPT_NAME_RE.test(script)) bad(`script 得是 Worker 脚本名：${script || "空"}`);
      return { pattern, script };
    };
    if (method === "POST" && !s[3]) {
      const r = await rest<any>(ctx.token, `/zones/${enc(zone)}/workers/routes`, { method: "POST", body: routeBody() }, false);
      return r.data;
    }
    if (method === "PUT" && s[3]) {
      if (!/^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s[3])) {
        throw new DirectError("badQuery", 422, null, "route id 得是 32 位 hex 或 36 位 UUID");
      }
      const r = await rest<any>(ctx.token, `/zones/${enc(zone)}/workers/routes/${enc(s[3])}`, { method: "PUT", body: routeBody() }, false);
      return r.data;
    }
    if (method === "DELETE" && s[3]) {
      if (!/^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s[3])) {
        throw new DirectError("badQuery", 422, null, "route id 得是 32 位 hex 或 36 位 UUID");
      }
      const r = await rest<any>(ctx.token, `/zones/${enc(zone)}/workers/routes/${enc(s[3])}`, { method: "DELETE" }, false);
      return r.data;
    }
  }

  // ---- Pages 回滚 / 重试。2026-10-21 临时项目 cfconsole-tmp-1021 实测：两条都是 POST + 空 body，
  // 成功返回部署对象；retry 对 Direct Upload 部署回 400 (8000055)，那是上游业务判断，原样上屏。
  // 与网关 writes.pagesRollback / pagesRetry 同一条白名单（tools/check-direct-parity.mjs 覆盖）。
  if (method === "POST" && s[0] === "pages" && s[2] === "deployments" && s[3] && (s[4] === "rollback" || s[4] === "retry")) {
    const project = s[1];
    if (!project) throw new DirectError("badQuery", 422, null, "缺少 Pages 项目名");
    const id = s[3];
    if (!/^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new DirectError("badQuery", 422, null, `deployment id 得是 32 位 hex 或 36 位 UUID（现在是 ${id}）`);
    }
    const r = await rest<any>(ctx.token, `${A(ctx.account)}/pages/projects/${enc(project)}/deployments/${enc(id)}/${s[4]}`, { method: "POST", body: {} }, false);
    return r.data;
  }

  // 段位（2026-10-19 修正，与 routeREST 同一处错位）：/v1/zones/{zone}/{action}[/id]
  // → s[1]=zone、s[2]=动作、s[3]=record id。旧代码取 s[2] 当 zone、s[3] 当动作，
  //   DNS 写四条在直连模式从上线起就没通过（tools/check-direct-parity.mjs 抓的第二个 off-by-one）。
  const zone = s[1];
  if (s[0] !== "zones" || !/^[0-9a-f]{32}$/i.test(zone)) {
    throw new DirectError("badQuery", 422, null, "直连写侧只支持 /v1/zones/{32位id}/... 四条 DNS/缓存路由，以及 /v1/workers/{s}/deployments");
  }
  if (method === "POST" && s[2] === "dns_records") {
    const r = await rest<any>(ctx.token, `/zones/${enc(zone)}/dns_records`, { method: "POST", body }, false);
    return r.data;
  }
  if (method === "PUT" && s[2] === "dns_records" && s[3]) {
    if (!/^[0-9a-f]{32}$/i.test(s[3])) throw new DirectError("badQuery", 422, null, "record id 得是 32 位十六进制");
    const r = await rest<any>(ctx.token, `/zones/${enc(zone)}/dns_records/${enc(s[3])}`, { method: "PUT", body }, false);
    return r.data;
  }
  if (method === "DELETE" && s[2] === "dns_records" && s[3]) {
    if (!/^[0-9a-f]{32}$/i.test(s[3])) throw new DirectError("badQuery", 422, null, "record id 得是 32 位十六进制");
    const r = await rest<any>(ctx.token, `/zones/${enc(zone)}/dns_records/${enc(s[3])}`, { method: "DELETE" }, false);
    return r.data;
  }
  if (method === "POST" && s[2] === "purge_cache") {
    const r = await rest<any>(ctx.token, `/zones/${enc(zone)}/purge_cache`, { method: "POST", body }, false);
    return r.data;
  }
  throw new DirectError("badQuery", 422, null, `直连写侧不认这条路：${method} ${path}`);
}

/* ============================================================================
 * 账户级 API Token 管理（仅 APK 直连；对应 OAuth scope `account_api_tokens:*`）
 *
 * 为什么只做直连：OAuth 凭据只在本机钥匙串里，网关拿不到也不该拿；网页/网关模式没有
 * 可用的 OAuth 通道，这条功能在那里不展示（docs/16 §4）。
 *
 * 端点（2026-10-21 核对官方 API 文档）：
 *   GET    /accounts/{id}/tokens
 *   POST   /accounts/{id}/tokens
 *   DELETE /accounts/{id}/tokens/{tid}
 *   PUT    /accounts/{id}/tokens/{tid}/value          ← 轮转（旧值立即失效）
 *   GET    /accounts/{id}/tokens/permission_groups    ← 建 token 时要填的权限组 id
 * ========================================================================== */

export interface AccountToken {
  id: string;
  name?: string;
  status?: string;
  issued_on?: string;
  modified_on?: string;
  expires_on?: string;
  policies?: Array<{
    effect?: string;
    resources?: Record<string, unknown>;
    permission_groups?: Array<{ id?: string; name?: string }>;
  }>;
}

export type TokenResources = Record<string, string | Record<string, string>>;

export interface NewAccountToken {
  name: string;
  policies: Array<{
    effect: "allow" | "deny";
    resources: TokenResources;
    permission_groups: Array<{ id: string }>;
  }>;
  expires_on?: string;
  not_before?: string;
}

const TOKEN_ID = /^[0-9a-f]{32}$/i;
const GROUP_ID = /^[0-9a-f]{32}$/i;

/** 建 token 前的本地校验：**先把自己发的东西看清楚**，别拿 422 当校验器 */
function validateNewToken(body: NewAccountToken): NewAccountToken {
  const bad = (m: string): never => {
    throw new DirectError("badQuery", 422, null, m);
  };
  const raw = (body ?? {}) as unknown as Record<string, unknown>;
  const unknownKeys = Object.keys(raw).filter((k) => !["name", "policies", "expires_on", "not_before"].includes(k));
  if (unknownKeys.length) bad(`不支持的字段：${unknownKeys.join(",")}`);

  const name = String(raw.name ?? "").trim();
  if (!name) bad("令牌名称不能为空");
  if (name.length > 120) bad("令牌名称最多 120 字符");

  if (!Array.isArray(raw.policies) || raw.policies.length === 0) throw new DirectError("badQuery", 422, null, "至少需要一条策略（policies）");
  const rawPolicies = raw.policies as unknown[];
  if (rawPolicies.length > 8) bad("策略最多 8 条");
  const policies = rawPolicies.map((p, i): NewAccountToken["policies"][number] => {
    if (typeof p !== "object" || p === null) bad(`policies[${i}] 必须是对象`);
    const o = p as Record<string, unknown>;
    const effect = String(o.effect ?? "");
    if (effect !== "allow" && effect !== "deny") bad(`policies[${i}].effect 只能是 allow / deny`);
    if (!Array.isArray(o.permission_groups) || o.permission_groups.length === 0) throw new DirectError("badQuery", 422, null, `policies[${i}].permission_groups 至少一项`);
    const pgRaw = o.permission_groups as unknown[];
    if (pgRaw.length > 64) bad(`policies[${i}].permission_groups 最多 64 项`);
    const groups = pgRaw.map((g, j) => {
      const id = String((g as Record<string, unknown>)?.id ?? "").trim();
      if (!GROUP_ID.test(id)) bad(`policies[${i}].permission_groups[${j}].id 得是 32 位十六进制`);
      return { id };
    });
    const res = o.resources;
    if (typeof res !== "object" || res === null || Array.isArray(res)) bad(`policies[${i}].resources 必须是对象`);
    /**
     * 上游两种形状都收（官方 Create Token 示例文档 2026-10-21 核对）：
     *   扁平  { "com.cloudflare.api.account.zone.<id>": "*" }
     *   嵌套  { "com.cloudflare.api.account.<id>": { "com.cloudflare.api.account.zone.*": "*" } }
     * 早前只放行嵌套，会把官方示例直接 422 掉。
     */
    const resources: TokenResources = {};
    for (const [rk, rv] of Object.entries(res as Record<string, unknown>)) {
      if (!rk.startsWith("com.cloudflare.api.")) bad(`policies[${i}].resources 的键要以 com.cloudflare.api. 开头：${rk}`);
      if (typeof rv === "string") {
        if (!rv.trim()) bad(`policies[${i}].resources.${rk} 不能为空字符串`);
        resources[rk] = rv;
        continue;
      }
      if (typeof rv !== "object" || rv === null || Array.isArray(rv)) bad(`policies[${i}].resources.${rk} 只能是字符串或对象`);
      const bucket: Record<string, string> = {};
      for (const [k, v] of Object.entries(rv as Record<string, unknown>)) {
        if (typeof v !== "string") bad(`policies[${i}].resources.${rk}.${k} 必须是字符串`);
        bucket[k] = v as string;
      }
      if (!Object.keys(bucket).length) bad(`policies[${i}].resources.${rk} 不能为空`);
      resources[rk] = bucket;
    }
    if (!Object.keys(resources).length) bad(`policies[${i}].resources 不能为空`);
    return { effect: effect as "allow" | "deny", resources, permission_groups: groups };
  });

  const out: NewAccountToken = { name, policies };
  for (const k of ["expires_on", "not_before"] as const) {
    const v = String(raw[k] ?? "").trim();
    if (!v) continue;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) bad(`${k} 不是合法时间（要 ISO 8601，例 2026-12-31T00:00:00Z）`);
    if (k === "expires_on" && t <= Date.now()) bad("expires_on 必须晚于当前时间");
    out[k] = new Date(t).toISOString();
  }
  return out;
}

export async function accountTokensDirect(ctx: DirectCtx): Promise<{ result: AccountToken[] }> {
  const r = await rest<AccountToken[]>(ctx.token, `${A(ctx.account)}/tokens`, {}, true);
  return { result: Array.isArray(r.data) ? r.data : [] };
}

export async function permissionGroupsDirect(ctx: DirectCtx): Promise<{ result: any[] }> {
  const r = await rest<any[]>(ctx.token, `${A(ctx.account)}/tokens/permission_groups`, {}, true);
  return { result: Array.isArray(r.data) ? r.data : [] };
}

/** 创建：返回体里的 `value` 是**唯一一次**出现的令牌明文，调用方只许展示、不许落盘 */
export async function createAccountTokenDirect(ctx: DirectCtx, body: NewAccountToken): Promise<AccountToken & { value?: string }> {
  const clean = validateNewToken(body);
  const r = await rest<any>(ctx.token, `${A(ctx.account)}/tokens`, { method: "POST", body: clean }, false);
  return r.data;
}

export async function deleteAccountTokenDirect(ctx: DirectCtx, tokenId: string): Promise<any> {
  if (!TOKEN_ID.test(tokenId)) throw new DirectError("badQuery", 422, null, "token id 得是 32 位十六进制");
  const r = await rest<any>(ctx.token, `${A(ctx.account)}/tokens/${enc(tokenId)}`, { method: "DELETE" }, false);
  return r.data;
}

/** 轮转：同一 token 换一把新值，旧值立即失效（界面上必须提示"用到它的地方要同步换"） */
export async function rotateAccountTokenDirect(ctx: DirectCtx, tokenId: string): Promise<AccountToken & { value?: string }> {
  if (!TOKEN_ID.test(tokenId)) throw new DirectError("badQuery", 422, null, "token id 得是 32 位十六进制");
  const r = await rest<any>(ctx.token, `${A(ctx.account)}/tokens/${enc(tokenId)}/value`, { method: "PUT", body: {} }, false);
  return r.data;
}
