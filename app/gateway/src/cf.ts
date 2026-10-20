/**
 * Cloudflare API 调用层。
 *
 * 这里存在的理由（实测结论，见 docs/06 §4）：CF 的响应没有统一信封，同一个人写四种拆包方式：
 *   REST      → { success, result, errors, result_info }
 *   REST 分页 → { success, result: { items, total_count } }
 *   SQL       → { data, rows, statistics }        （没有 success 字段）
 *   GraphQL   → { data: { viewer: … } }           （错误在 errors[].message，无 code）
 *   DNS 导出  → 纯文本；整包代码 → multipart 文本
 * 所以拆包策略必须按调用点指定，而不是全局猜。
 */

export type Kind = "ok" | "auth" | "permission" | "notFound" | "planLimit" | "serviceDisabled" | "verb" | "badQuery" | "upstreamBroken" | "rate" | "misconfigured" | "writesDisabled" | "unknown";

export class CfError extends Error {
  constructor(
    readonly kind: Kind,
    readonly http: number,
    readonly code: string | null,
    message: string,
    readonly raw?: unknown,
  ) {
    super(message);
  }
}

/** 错误码 → 人类结论；这条映射表是 63 次实测攒出来的，不要退回"403 就是没权限" */
export function classify(http: number, code: string | null, message: string): Kind {
  if (http === 401 && code === "1000") return "auth";
  if (code === "10000" || code === "10001") return "permission";
  if (code === "10042") return "serviceDisabled";       // R2 之类未在后台开通
  if (code === "1404") return "planLimit";              // 套餐无配额
  if (code === "7003" || code === "7000") return "notFound";
  if (code === "10007" || code === "8000007") return "notFound";
  // Rulesets 的"这个 phase 没配过规则"（docs/04 §8）与部署详情的"这个部署不存在"（docs/08 §6.1），
  // 都是 notFound 而不是权限问题；早前没映射时它们落到 "unknown"，界面会显示成含糊的"没归类错误"。
  if (code === "10003" || code === "10336") return "notFound";
  if (code === "100146") return "notFound";
  if (code === "10405") return "verb";                  // 动词不支持，不是权限
  if (code === "9109") return "ok";                     // account-scoped 令牌不支持用户级接口，属正常
  if (http === 410) return "serviceDisabled";
  if (http === 422) return "badQuery";
  if (http === 429) return "rate";
  if (http >= 500) return "upstreamBroken";
  if (http >= 400) return "unknown";
  return "ok";
}

export type Unwrap = "result" | "items" | "list" | "data" | "graphql" | "text";

/* ============================================================================
 * 只读调用缓存：把"每进一个界面就打一遍 CF"压成"每个键 5 分钟最多一次"。
 *
 * 为什么放这一层：白名单里每一条路由最终都落到 send()，所以这一层加缓存 = 全部路由都受
 * 保护，不需要在 catalog 里逐条改（漏一条就是漏一个 CF 配额入口）。
 * 为什么是内存 Map 而不是 KV/Cache API：KV 要在账号里建 namespace（那是账号变更，得他点头），
 * Cache API 对 POST（GraphQL/SQL 都是 POST）不生效。内存的代价是 **按 isolate 分格** ——
 * 线上冷 isolate 各打一次，所以"5 分钟一次"是**下界**（可能多打几次），绝不是上界，
 * 这个数字通过 /health 的 cache 段实测出来，不靠嘴说。
 * ========================================================================== */
export const CACHE_TTL_MS = 300_000;

type Entry = { at: number; status: number; text: string };
const cache = new Map<string, Entry>();
/** 同一个键正在打的时候，第二个请求直接等它的结果，不重复出网（一次进 App 会并发七八条） */
const inflight = new Map<string, Promise<Entry>>();
const counters = { upstream: 0, hits: 0, coalesced: 0, writes: 0 };

export function cacheStats() {
  return {
    ttlMs: CACHE_TTL_MS,
    entries: cache.size,
    cfCalls: counters.upstream,
    cacheHits: counters.hits,
    coalesced: counters.coalesced,
    /** 真的发出去的**写**请求条数。冒烟脚本用它的差值证明"422 拦在门口"的那些请求一条都没出网。 */
    writes: counters.writes,
    hitRate: counters.upstream + counters.hits ? Math.round((counters.hits / (counters.upstream + counters.hits)) * 100) : 0,
  };
}
export function cacheClear() { cache.clear(); inflight.clear(); }

/** 只有这三种是读语义；写动词永不进缓存（写路由的白名单在 catalog.ts 的 writes 表） */
function isReadCall(path: string, method: string): boolean {
  if (method === "GET") return true;
  return path === "/graphql" || path.endsWith("/analytics/sql") || path.endsWith("/analytics_engine/sql");
}

/** FNV-1a，只用来给缓存键分区（不把令牌原文留在 Map 的键里），不是安全用途 */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function okOf(status: number) { return status >= 200 && status < 300; }

/**
 * CF 的"列表"在三种信封里长得都不一样，实测确认：
 *   result: [...]                          → /zones、/accounts、/dns_records
 *   result: { items: [...] }               → /workers/scripts/{s}/versions、/deployments(部分)
 *   result: { deployments: [...] }         → /workers/scripts/{s}/deployments
 *   result: { schedules: [...] }           → /workers/scripts/{s}/schedules
 *   result: { data: [...] }                → Pages deployments 未验（账号里 0 个项目），按同名规则兜住
 * "list" 就是把这几种在网关侧一次性拉平，前端只面对数组。
 */
export function listify(result: any, envelope?: any): { items: any[]; total?: number; cursor?: string } {
  if (Array.isArray(result)) return { items: result };
  const nested = result?.items ?? result?.deployments ?? result?.schedules ?? result?.data;
  const items = Array.isArray(nested) ? nested : [];
  // CF 的分页信息有两种位置：绝大多数端点放在**顶层** `result_info.total_count`（与 result 平级），
  // 少数（Pages deployments 之类）放进 `result.total_count`。只看 result 里那一层会永远拿不到 total，
  // 于是 versions/domains 这些列表的"共 N 条"会静默变成 undefined（实测 rin-server versions 顶层 result_info.total_count=148）。
  const ri = envelope?.result_info ?? result?.result_info;
  const total = ri?.total_count ?? result?.total_count;
  // 游标翻页同层：KV keys 的 result_info 里是 cursor 而不是 total_count，丢了它 App 的"加载下一页"就是死的
  const cursor = ri?.cursor ?? result?.cursor;
  return { items, total: typeof total === "number" ? total : undefined, cursor: typeof cursor === "string" && cursor ? cursor : undefined };
}

export interface CallSpec {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  unwrap?: Unwrap;
  /** 请求体是裸 SQL 文本（/analytics_engine/sql 那一族），不是 JSON */
  rawText?: boolean;
  /**
   * multipart/form-data 请求体（PATCH settings 更新 bindings 要这个，JSON 会 415 —— 2026-10-19 实测）。
   * 不要手动设 content-type：fetch 会自动带上带 boundary 的头。
   */
  multipart?: FormData;
}

export class CfClient {
  /** 本次请求的出网账本：route 包装层靠它给响应打 x-gw-cache 头 */
  readonly trace = { upstream: 0, hits: 0, coalesced: 0, fetchedAt: 0 };

  constructor(
    private readonly token: string,
    private readonly base = "https://api.cloudflare.com/client/v4",
    /** `?fresh=1`：界面上的「刷新」按钮要走这条，不能让缓存把用户的主动刷新变成假动作 */
    private readonly fresh = false,
  ) {}

  private async fetchUpstream(key: string, path: string, spec: CallSpec): Promise<Entry> {
    const headers: Record<string, string> = { authorization: "Bearer " + this.token };
    if (spec.multipart) {
      // multipart：content-type（含 boundary）交给 fetch 生成，手动设会把 boundary 弄丢
    } else {
      headers["content-type"] = spec.rawText ? "text/plain;charset=UTF-8" : "application/json";
    }
    const res = await fetch(this.base + path, {
      method: spec.method || "GET",
      headers,
      body: spec.multipart ?? (spec.body === undefined ? undefined : spec.rawText ? String(spec.body) : JSON.stringify(spec.body)),
      signal: AbortSignal.timeout(30000),
    });
    const e: Entry = { at: Date.now(), status: res.status, text: await res.text() };
    // key 为空串 = 这条不可缓存（写请求）。以前写请求是塞一个随机键进缓存表的，
    // 写路由真的注册之后那会变成只增不减的内存泄漏，所以这里明确"不可缓存就不落表"。
    if (key) cache.set(key, e);
    return e;
  }

  private async send(path: string, spec: CallSpec) {
    const method = spec.method || "GET";
    const bodyStr = spec.body === undefined ? "" : spec.rawText ? String(spec.body) : JSON.stringify(spec.body);
    const key = isReadCall(path, method) ? `${fnv(this.token)}|${method}|${path}|${fnv(bodyStr)}` : "";

    let e: Entry;
    const hit = key && !this.fresh ? cache.get(key) : undefined;
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      e = hit;
      this.trace.hits++; counters.hits++;
    } else if (!key) {
      // 写语义：既不读缓存也不合并，直接出网。计数器单独一档，冒烟脚本靠它的差值
      // 证明"被 422/501 拦在门口"的请求一条都没到 CF（GET /zones 那类只读探测不算它）。
      counters.writes++;
      e = await this.fetchUp("", path, spec);
    } else {
      const pending = inflight.get(key);
      if (pending) {
        e = await pending;
        this.trace.coalesced++; counters.coalesced++;
      } else {
        const p = this.fetchUp(key, path, spec).finally(() => inflight.delete(key));
        inflight.set(key, p);
        e = await p;
      }
    }
    this.trace.fetchedAt = e.at;
    let json: any = null;
    try { json = JSON.parse(e.text); } catch { /* 文本类响应：DNS 导出、multipart 代码包 */ }
    return { res: { ok: okOf(e.status), status: e.status }, text: e.text, json };
  }

  private async fetchUp(key: string, path: string, spec: CallSpec): Promise<Entry> {
    this.trace.upstream++; counters.upstream++;
    return this.fetchUpstream(key, path, spec);
  }

  /** REST：{ success, result } 或 { success, result:{items} } */
  async rest<T = any>(path: string, spec: CallSpec = {}): Promise<{ data: T; total?: number; cursor?: string }> {
    const { res, json, text } = await this.send(path, spec);
    if (!json) {
      if (!res.ok) throw new CfError(classify(res.status, null, text), res.status, null, text.slice(0, 200));
      return { data: text as T };
    }
    const err = json.errors?.[0];
    const code = err ? String(err.code) : json.code ? String(json.code) : null;
    const message = err?.message || json.error || json.message || "";
    if (json.success === false || !res.ok) {
      throw new CfError(classify(res.status, code, message), res.status, code, message || `HTTP ${res.status}`, json);
    }
    if (spec.unwrap === "items" || spec.unwrap === "list") {
      const { items, total, cursor } = listify(json.result, json);
      return { data: (spec.unwrap === "items" ? (json.result?.items ?? json.result) : items) as T, total, cursor };
    }
    return { data: json.result as T };
  }

  /** 分析 SQL：path 由调用方给全（/analytics/sql、/accounts/{a}/analytics/sql、/accounts/{a}/analytics_engine/sql 三者形状不同） */
  async sql<T = any>(path: string, query: string, extra: Record<string, unknown> = {}, opts: { rawText?: boolean } = {}): Promise<{ rows: T[]; stats?: any; rowsRead?: number }> {
    const body: unknown = opts.rawText ? query : { query, ...extra };
    const { res, json, text } = await this.send(path, { method: "POST", body, rawText: !!opts.rawText });
    if (!res.ok || !json) {
      const msg = (json && (json.message || (json.errors && json.errors[0]?.message))) || text;
      throw new CfError(classify(res.status, json?.errors?.[0] ? String(json.errors[0].code) : null, msg), res.status, json?.errors?.[0] ? String(json.errors[0].code) : null, String(msg).slice(0, 240), json);
    }
    return { rows: (json.data || []) as T[], stats: json.statistics, rowsRead: json.rows };
  }

  /** GraphQL：错误没有 code，只有 message，必须按文案判断 */
  async graphql<T = any>(query: string, vars?: Record<string, unknown>): Promise<T> {
    const { res, json, text } = await this.send("/graphql", { method: "POST", body: { query, variables: vars } });
    const gqlErr = json?.errors?.[0]?.message as string | undefined;
    if (gqlErr && /does not have access to the path/i.test(gqlErr)) {
      throw new CfError("planLimit", res.status, "GQL_PATH", gqlErr, json);
    }
    if (gqlErr) throw new CfError("badQuery", res.status, "GQL", gqlErr, json);
    if (!res.ok || !json) throw new CfError(classify(res.status, null, text), res.status, null, text.slice(0, 200));
    return json.data as T;
  }

  async text(path: string, spec: CallSpec = {}): Promise<string> {
    const { res, text } = await this.send(path, spec);
    if (!res.ok) throw new CfError(classify(res.status, null, text), res.status, null, text.slice(0, 200));
    return text;
  }
}
