/**
 * 网关客户端。前端只认这一层，永远不直接碰 api.cloudflare.com：
 * 官方 API 无 CORS（预检 400 实测）、且令牌不能出现在客户端，两点都是硬约束（docs/06）。
 *
 * 错误处理的设计原则：网关已经把 CF 那 20 多种错误码归并成 kind（src/cf.ts 的分类表），
 * 前端只需要按 kind 决定「让用户去设置页重填」还是「这块功能灰掉」，
 * 绝对不要出现"请求失败"三个字了事——permission 和 notFound 的处置方式完全不同。
 *
 * ── 双模式（2026-10-17） ──
 * 浏览器（网页 / PWA）绕不过 CORS，必须走网关；而 Capacitor 原生壳（APK）里 fetch 被
 * native-bridge 代理到原生网络栈、不参与同源策略，可以直连 api.cloudflare.com。
 * 于是同一份 api 面有两条 transport：
 *   - `isNativeApp()` = true → 直连（lib/direct.ts，网关 catalog 的逐字移植）；
 *   - 否则 → 网关（本文件原有的全部逻辑，一行未改）。
 * 分流只发生在这一层，上面所有视图 / store / composable 无感。
 */
import { reactive } from "vue";
import { effectiveBase, isNativeApp, loadConfig, type Config } from "./config";
import { findAccount } from "./accounts";
import { ensureAccessToken, OAuthError } from "./oauth";
import { DirectError, dropDirect, gwDirect, probeTokenDirect, takeDirectCalls, writeDirect, type DirectCtx } from "./direct";

export type ErrKind =
  | "auth" | "permission" | "planLimit" | "serviceDisabled" | "notFound"
  | "badQuery" | "rate" | "writesDisabled" | "upstreamBroken" | "misconfigured"
  | "network" | "timeout" | "unknown";

export class GwError extends Error {
  constructor(readonly kind: ErrKind, readonly http: number, readonly code: string | null, message: string) {
    super(message);
  }
  /** UI 文案：一句说明 + 一句下一步做什么 */
  get hint(): string {
    return KIND_HINT[this.kind] ?? "未知错误，试试下拉刷新或看网关日志";
  }
}

const KIND_HINT: Record<ErrKind, string> = {
  auth: "设备令牌不对或已被吊销。去「设置」里重新填一次。",
  permission: "令牌缺这项权限。需要在 Cloudflare 后台给令牌补勾（见 docs/05-令牌权限边界.md）。",
  planLimit: "这个数据集被套餐挡住了（免费档没有 1mGroups / WAF 明细）。",
  serviceDisabled: "该服务在账号里没开通，界面上会一直空。",
  notFound: "没有找到对应资源：Worker 名 / 版本 ID / Pages 项目名可能写错了。",
  badQuery: "参数不合法（时间窗或维度不在白名单里）。",
  rate: "撞到 CF 限流（约 1200 请求 / 5 分钟 / IP），稍后再刷。",
  writesDisabled: "网关第一版只读，变更类操作要单独放行。",
  upstreamBroken: "CF 这个接口本身有问题（5xx），不是你的配置错。",
  misconfigured: "网关自己没配好（缺 CF_API_TOKEN / DEVICE_TOKENS），去看网关的 .dev.vars。",
  network: "连不上网关（这条请求自动重试了 3 次，每次都**立刻**被拒，不是慢）。多半是网关进程没在跑，或者同一个端口上堆了好几个网关实例、请求落到了已经退掉的那个上（电脑上跑 `node tools/dev-port-guard.mjs` 能看清是谁占着端口）；也要确认地址填得对不对、手机和电脑是否在同一网络。",
  // 单独一档：真连不上会**立刻**抛 network（fetch 直接 reject），能等到超时说明 TCP 已经通了，
  // 把"慢"说成"连不上"会让人去查网络，方向完全错（同一类错误见 docs/09 §E17）。
  timeout: "连上了但等满超时没返回（普通请求 25 秒、设置页的连接测试 8 秒）。真连不上会立刻报错、不会等到超时，所以别去查网络，先看 CF 上游是不是慢、这一档扫描行数是不是太大；稍后再刷，或把时间窗缩到 24 小时。",
  unknown: "没归类的错误，看网关响应里的 message。",
};

/* ============================================================================
 * 双模式分流：APK 直连 / 浏览器走网关
 * ========================================================================== */

// isNativeApp 的实现搬到了 config.ts（accounts.ts 的免口令直连存储也要用它，
// 放 config 避免 api↔accounts 循环引用）；这里原样 re-export，老引用不用改。
export { isNativeApp };

/**
 * 直连上下文：选中账号的令牌 + 账号 id。返回 null = 这台设备现在没法直连
 * （没选账号，或保险箱还没解锁）—— 调用方据此报一条说清楚的错，不静默改走网关：
 * APK 里本来就没有网关在跑，"回落网关"在这里只会变成一条迟到的连接失败。
 *
 * OAuth 账号在这里是**异步**的：access token 只在内存，冷启动/过期时先用钥匙串里的
 * refresh token 换一次（oauth.ts 保证同一 credRef 的刷新串行）。API Token 账号仍然同步取值。
 */
async function directCtx(cfg: Config, fresh: boolean, accId?: string): Promise<DirectCtx | null> {
  const want = accId ?? cfg.account;
  const acc = want ? findAccount(want) : null;
  if (!acc) return null;
  if (acc.auth === "oauth") {
    if (!acc.credRef) return null;
    try {
      return { token: await ensureAccessToken(acc.credRef), account: acc.id, fresh };
    } catch (e) {
      throw asGwError(e);
    }
  }
  return { token: acc.token, account: acc.id, fresh };
}

/** 给直连专属功能（如令牌管理）用的上下文；拿不到就按现有口径报错 */
export async function requireDirectCtx(): Promise<DirectCtx> {
  const cfg = loadConfig();
  const ctx = await directCtx(cfg, false);
  if (!ctx) throw noDirectCtxError(cfg);
  return ctx;
}

/**
 * OAuth 账号在网关模式下没有可用凭据（refresh token 只在系统钥匙串，网关拿不到，
 * 也不该把长期凭据交给中间服务器）。与其静默回落到网关 env 令牌、把 A 账号的数据
 * 显示成 B 账号的，不如直接报错让人换认证方式。
 */
function assertGatewayAuth(cfg: Config, accId?: string): void {
  const want = accId ?? cfg.account;
  const acc = want ? findAccount(want) : null;
  if (acc?.auth === "oauth") {
    throw new GwError("auth", 401, null, "OAuth 账号只能在 APK 直连模式使用；网页/网关模式请改用 API Token");
  }
}

/** 直连不可用时的报错口径：分清"没加账号"和"加了没解锁"，两者的下一步动作不一样 */
function noDirectCtxError(cfg: Config): GwError {
  return new GwError(
    "auth",
    401,
    null,
    cfg.account
      ? "选中的账号还没解锁：令牌保险箱是加密保存的，去「设置」页输入口令解锁后才能取数。"
      : "这台设备还没有 Cloudflare 账号：APK 是直连模式（不经过网关），去「设置」页添加一把 API Token 就能用。",
  );
}

/** DirectError 与 GwError 同形（kind/http/code/message），在边界上换成 GwError，界面那一层不用知道有两种错 */
function asGwError(e: unknown): unknown {
  if (e instanceof DirectError) return new GwError(e.kind, e.http, e.code, e.message);
  // OAuthError 的 kind 是 ErrKind 的子集，直接映射；http 保留原状态码便于界面分辨 401 / 0
  if (e instanceof OAuthError) return new GwError(e.kind, e.http, null, e.message);
  return e;
}

function qs(query?: Record<string, string | number | undefined>): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? "?" + s : "";
}

/**
 * 选中账号的令牌头（x-cf-token）。**自带令牌模式下这是唯一要带的东西**，设备令牌可以留空。
 * 没选账号就一个头都不加，退回"设备令牌 + 网关 env 令牌"的老路子 —— 两条路网关都认。
 * 令牌每次请求现取现带，不在这里缓存；网关也不留副本。
 */
function cfTokenHeader(cfg: Config, accId?: string): Record<string, string> {
  const want = accId ?? cfg.account;
  const acc = want ? findAccount(want) : null;
  return acc ? { "x-cf-token": acc.token } : {};
}

/**
 * `/v1/accounts` 本身不带 ?account=：如果存储里的账号 id 已经不可见（比如后台改了令牌作用域），
 * 带着它连"账号列表"都取不到，设置页就死锁在只能清 localStorage 的境地。
 */
const NO_ACCOUNT_PARAM = new Set(["/v1/accounts", "/health"]);

/* ============================================================================
 * 连不上网关时的重试（只针对"连接层"失败）。
 *
 * 为什么要重试：本机实测过这个故障形状 —— 多个 wrangler dev 抢同一个 8788 端口时，
 * workerd 反复重启，端口会出现**一个监听都没有**的一两秒（tools/dev-port-guard.mjs 顶部记了实测）。
 * 这期间 fetch 不是慢，是**立刻**被拒（connection refused）。不重试的话：一次点击并发出去的
 * 七八条请求里，落在这一秒的那几条直接判死，界面就停在"连不上网关"上，而两秒后其实明明是好的
 * —— 这就是"数据刷新不出来"最容易被误判成代码 bug 的一条路径。
 *
 * 只重试连接层失败是有前提的：连接都没建立，服务端一定没收到这条请求，重试不重复计数、
 * 也不会重复打 CF。**超时不重试**（25 秒已经等满，请求很可能已经打到 CF 了，
 * 再发一次等于白烧配额，而且把用户等的时间翻倍）。写侧 gwWrite() 也不走这里 ——
 * 写请求一旦可能送达就不能盲重，见下面 gwWrite 的说明。
 * ========================================================================== */
const NET_ATTEMPTS = 3;
const NET_BACKOFF_MS = [250, 900];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 是不是"连接根本没建立"：fetch 直接 reject 且不是我们的超时主动中断 */
function isConnectFailure(e: unknown): boolean {
  return (e as Error)?.name !== "TimeoutError" && (e as Error)?.name !== "AbortError";
}

/**
 * 带连接层重试的 fetch。成功就返回响应；试满次数仍是被拒时抛 kind=network 的 GwError，
 * message 里写明试了几次 —— 界面那句"连不上网关"必须是真连不上，而不是"碰巧赶上网关在重启"。
 */
async function fetchNetRetry(url: string, init: RequestInit, attempts = NET_ATTEMPTS): Promise<Response> {
  let last: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (!isConnectFailure(e)) throw e;
      last = e;
      if (i < attempts) await sleep(NET_BACKOFF_MS[Math.min(i - 1, NET_BACKOFF_MS.length - 1)]);
    }
  }
  throw new GwError("network", 0, null, `连不上网关（试过 ${attempts} 次都立刻被拒，最后一次：${String((last as Error)?.message || last)}）`);
}

/* ============================================================================
 * 前端这一层的 5 分钟内存缓存：网关那层已经不会重复打 CF 了，这一层省的是手机流量和
 * 来回 HTTP —— 从 Worker 详情退回列表、再进另一个 Worker，同一份数据不该再要一遍。
 *
 * 「刷新」按钮必须真出新数据，所以它调 forceFreshWindow()：接下来这一批请求都带 ?fresh=1
 * 并绕过两层缓存。不做成"刷新了但其实是缓存"，那是撒谎。
 * ========================================================================== */
export const MEM_TTL_MS = 300_000;
const mem = new Map<string, { at: number; data: any }>();
let freshUntil = 0;

/** 主动刷新：接下来 ms 毫秒内的请求全部绕过缓存、带 fresh=1（一次点击会并发七八条，所以给的是窗口不是单次） */
export function forceFreshWindow(ms = 20_000) {
  freshUntil = Math.max(freshUntil, Date.now() + ms);
}

/**
 * 最近一次调用的数据来源，界面靠它把"缓存里的旧数据"说清楚，不靠猜。
 *
 * 必须是 reactive：这层的值在 gw() 内部就地改，普通对象不会触发 computed 重算，
 * 结果就是 BoardView 那行"数据取自 …"永远停在首次求值（fetchedAt=0 → 空串 → v-if 永远不显示，实测踩过）。
 */
export const gwMeta = reactive({ state: "miss" as "hit" | "miss" | "mixed" | "fresh" | "local" | "direct", fetchedAt: 0, cfCalls: 0 });

export async function gw<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  return gwCore<T>(path, query);
}

/**
 * 按**指定账号**取数（多账号合一模式专用，2026-10-27）。
 *
 * 与 gw() 的唯一区别：账号与令牌都取传入的那个，而不是本机选中的那个。
 * 缓存键里带 `acc:<id>`，所以合并视图与单账号视图不会互相喂脏数据；
 * 写侧不走这里 —— 合并视图是只读的（见 lib/aggregate.ts 顶部的约束）。
 */
export async function gwAs<T>(accId: string, path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  return gwCore<T>(path, query, accId);
}

async function gwCore<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
  accId?: string,
): Promise<T> {
  const cfg = loadConfig();
  const acc = accId ?? cfg.account;
  const merged: Record<string, string | number | undefined> = {
    ...(acc && !NO_ACCOUNT_PARAM.has(path) ? { account: acc } : {}),
    ...(query ?? {}),
  };
  const q = qs(Object.keys(merged).length ? merged : undefined);
  const fresh = Date.now() < freshUntil;
  const native = isNativeApp();
  /**
   * 缓存键：网关模式就是完整 URL；直连模式没有 URL，用 `direct|` + 同一套 path/query 冒充。
   * 仍然包含完整路径，所以 gwWrite() 里的 `dropMem("/v1/zones/" + zoneId)` 一行代码
   * 两种模式都能命中（键里都有 `/v1/zones/{id}/...` 这一段）。
   */
  const url = effectiveBase(cfg) + path + q;
  // 指定账号时键里加一段：网关模式的 url 已经带 ?account=<id>，直连模式没有 url，必须自己补
  const key = native ? "direct|" + (accId ? "acc:" + accId + "|" : "") + path + q : url;
  if (!fresh) {
    const hit = mem.get(key);
    if (hit && Date.now() - hit.at < MEM_TTL_MS) {
      gwMeta.state = "local";
      gwMeta.fetchedAt = hit.at;
      gwMeta.cfCalls = 0;
      return hit.data as T;
    }
  }
  if (native) {
    const ctx = await directCtx(cfg, fresh, accId);
    if (!ctx) throw noDirectCtxError(cfg);
    try {
      const data = await gwDirect<T>(path, merged, ctx);
      gwMeta.state = "direct";
      // 直连没有中间层：数据落地的时刻就是 CF 应答的时刻，直接取现在
      gwMeta.fetchedAt = Date.now();
      gwMeta.cfCalls = takeDirectCalls();
      mem.set(key, { at: gwMeta.fetchedAt, data });
      return data;
    } catch (e) {
      takeDirectCalls(); // 失败路径也把计数清掉：别把这次的出网漏记进下一次请求的账上
      throw asGwError(e);
    }
  }
  assertGatewayAuth(cfg, accId);
  const finalUrl = fresh ? url + (url.includes("?") ? "&" : "?") + "fresh=1" : url;
  let res: Response;
  try {
    res = await fetchNetRetry(finalUrl, { headers: { "x-device-token": cfg.deviceToken, ...cfTokenHeader(cfg, accId) }, signal: AbortSignal.timeout(25000) });
  } catch (e) {
    if (e instanceof GwError) throw e;
    const isTimeout = (e as Error)?.name === "TimeoutError";
    throw new GwError(
      isTimeout ? "timeout" : "network",
      0,
      null,
      isTimeout ? "网关 25 秒没响应" : String((e as Error)?.message || e),
    );
  }
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 一律当失败处理 */ }
  if (!res.ok) {
    const err = json?.error;
    const kind = (err?.kind as ErrKind) || (res.status === 401 ? "auth" : res.status >= 500 ? "upstreamBroken" : "unknown");
    throw new GwError(kind, res.status, err?.code ?? null, String(err?.message || text.slice(0, 160) || res.statusText));
  }
  if (!json) throw new GwError("unknown", res.status, null, "网关返回了非 JSON 内容");
  // 数据年龄以网关给的"真正取数时刻"为准；它没给（老版本网关）才退回现在
  const fetchedAt = Number(res.headers.get("x-gw-fetched-at")) || Date.now();
  gwMeta.state = (res.headers.get("x-gw-cache") as any) || "miss";
  gwMeta.fetchedAt = fetchedAt;
  gwMeta.cfCalls = Number(res.headers.get("x-gw-cf-calls") || 0);
  mem.set(url, { at: fetchedAt, data: json });
  return json as T;
}

/**
 * 设置页专用：不带令牌，判断"地址填对了吗"。
 * 直连模式（APK）里没有网关可测，这里改成测「这台设备能不能直连 CF」：
 * 拿选中账号的令牌打一次 /accounts —— 通过就说明令牌有效、且至少看得见一个账号。
 * writes 在直连模式恒为 enabled：写请求从本机直接发给 CF，唯一的闸门就是本机开关（设置页会明说）。
 */
export async function gwHealth(base: string): Promise<{ ok: boolean; service?: string; writes?: string; ranges?: string[]; direct?: boolean; demo?: boolean }> {
  if (isNativeApp()) {
    const cfg = loadConfig();
    try {
      // 用同一套 directCtx 取令牌：OAuth 账号会自动刷新，不能直接读 acc.token（那是空串）
      const ctx = await requireDirectCtx();
      await probeTokenDirect(ctx.token);
      return { ok: true, service: "直连 api.cloudflare.com（不经过网关）", writes: "enabled", ranges: ["24h", "7d", "30d"], direct: true };
    } catch (e) {
      if (e instanceof GwError) throw e;
      throw asGwError(e);
    }
  }
  const url = (base.trim().replace(/\/+$/, "") || "/api") + "/health";
  let res: Response;
  try {
    // 同 gw()：连接被拒重试 3 次（网关正在重启时"测连接"不该直接判死）；超时仍不重试
    res = await fetchNetRetry(url, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    if (e instanceof GwError) throw e;
    // 这里同样要分清"连不上"和"连上了但 8 秒没答"：设置页那条测试就是给人判断地址填没填对的
    const isTimeout = (e as Error)?.name === "TimeoutError";
    throw new GwError(isTimeout ? "timeout" : "network", 0, null, isTimeout ? "8 秒内 /health 没响应" : String((e as Error)?.message || e));
  }
  if (!res.ok) throw new GwError("unknown", res.status, null, `HTTP ${res.status}`);
  return (await res.json()) as any;
}

/**
 * 用一把**还没保存**的令牌去问 CF：它看得见哪些账号。添加账号时用它做验证 ——
 * 令牌对不对、有没有 `Account:Read` 权限，在这一步就说清楚，别等保存完才发现是坏的。
 * 直连模式（APK）里不经过网关：这把令牌本来就不在任何网关那边，直接问 CF 最贴近真相。
 */
export async function probeToken(token: string): Promise<AccountsResult> {
  if (isNativeApp()) {
    try {
      return await probeTokenDirect(token);
    } catch (e) {
      throw asGwError(e);
    }
  }
  const cfg = loadConfig();
  const url = effectiveBase(cfg) + "/v1/accounts";
  let res: Response;
  try {
    res = await fetchNetRetry(url, {
      headers: { "x-cf-token": token, ...(cfg.deviceToken ? { "x-device-token": cfg.deviceToken } : {}) },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    if (e instanceof GwError) throw e;
    const isTimeout = (e as Error)?.name === "TimeoutError";
    throw new GwError(isTimeout ? "timeout" : "network", 0, null, isTimeout ? "网关 25 秒没响应" : String((e as Error)?.message || e));
  }
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 一律当失败处理 */ }
  if (!res.ok) {
    const err = json?.error;
    const kind = (err?.kind as ErrKind) || (res.status === 401 ? "auth" : res.status >= 500 ? "upstreamBroken" : "unknown");
    throw new GwError(kind, res.status, err?.code ?? null, String(err?.message || text.slice(0, 160) || res.statusText));
  }
  if (!json) throw new GwError("unknown", res.status, null, "网关返回了非 JSON 内容");
  return json as AccountsResult;
}

/* ---------- 类型：只写界面真正会读的字段，其余保持开放 ---------- */

export interface SqlResult<T = Record<string, any>> { rows: T[]; stats?: { elapsed_ms?: number; rows_read?: number }; rowsRead?: number }
export interface R<T> { result: T }

export interface Overview {
  range: string;
  days: number;
  consoleTotals: Card<{ viewer: { accounts: Array<{ g?: Array<{ dimensions: { date: string }; sum: { requests: number; bytes?: number; encryptedRequests?: number; threats?: number } }>; v?: Array<{ sum: { visits: number; edgeResponseBytes: number } }> }> } }>;
  series: Card<SqlResult<{ t: string; reqs: number; bytes: number }>>;
  status: Card<SqlResult<{ code: number; reqs: number }>>;
  countries: Card<{ viewer: { accounts: Array<{ a: Array<{ count: number; dimensions: { clientCountryName: string } }> }> } }>;
}

/** 首页看板的每张卡片各自带降级信息：一块坏了不影响整页（网关用 allSettled 实现） */
export interface Card<T> { value: T; error?: string; kind?: string }

/** WAF 只读三阶段：state 的四种取值直接对应 docs/04 §8 的实测形状 */
export interface WafRule {
  id?: string;
  action?: string;
  enabled: boolean;
  description: string;
  expression: string;
  last_updated: string;
  ref: string;
  version: string;
}
export interface WafPhase {
  phase: string;
  label: string;
  state: "ok" | "empty" | "unsupported" | "denied" | "error";
  rules: WafRule[];
  note?: string;
  name?: string;
  last_updated?: string;
  version?: string;
}
export interface Waf { zone: string; phases: WafPhase[]; ruleCount: number }

export interface Account {
  id: string;
  type?: string;
  name: string;
  settings?: Record<string, unknown>;
}

/**
 * Workers 每日用量（计算页那块）。两条数各自来源不同，界面必须分开说：
 *  - 事件数 events = observability/usage 接口值；
 *  - 请求数 requests = GraphQL `workersInvocationsAdaptive`（网关并进同一个响应，best-effort：
 *    取不到时 requests=null，界面回退到"没取到"，绝不显示 0）。
 * 额度上限（10 万/20 万）都不来自接口，是公开文档值。
 */
export interface WorkersUsageRow {
  bin?: string;
  dataset?: string;
  service: string;
  count: number;
  eventSize?: number;
}
export interface WorkersUsage {
  events?: number;
  breakdown?: WorkersUsageRow[];
  /** 今日 Workers 请求数（GraphQL workersInvocationsAdaptive）；null = 这条没取到，不是 0 */
  requests?: number | null;
  /** 同窗口内的 Workers 错误数（status>=400），接口给就一起带上 */
  reqErrors?: number | null;
  /** 请求数这条单独的降级原因；非空说明只有它没取到，事件数仍是真值 */
  requestsErr?: string | null;
  /** 本次统计窗口，epoch 毫秒；网关不给的话界面就不能标「今日」 */
  from?: number;
  to?: number;
}
/** 订阅列表里界面只读套餐标识；网关已经把 client_secrets/价格那些字段减掉了 */
export interface Subscription {
  plan?: string | null;
  state?: string | null;
}

/* ---------- 自定义域名 / 站点路由 / Pages 环境变量的客户端形状 ---------- */
export type PageEnvironment = "production" | "preview";
/** 上游每个值都是 {value,type} 对象（不是裸字符串），这里照实对齐 */
export type PageEnvVar = { value: string; type: "plain_text" | "secret_text" };
export type PageEnvVars = Record<string, PageEnvVar>;
/** 站点 Workers 路由：script 传 null = 这条路由只跳过 Worker */
export interface RouteInput {
  pattern: string;
  script: string | null;
}
/**
 * 网关返回的是 CF 的账号列表信封 + 三个状态字段：
 * active（本响应用的账号，因为 /v1/accounts 豁免 ?account=，所以恒为网关默认）、
 * requested（设备存储里选的）、applied（那个选择现在还算不算数）。
 * 设置页要三个一起看才能把"你选的那个已经失效了"说清楚（docs/09 §E17）。
 */
export type AccountsResult = R<Account[]> & {
  active?: string;
  requested?: string | null;
  applied?: boolean;
};

/**
 * 合并模式的按账号只读读数器（2026-10-27）。
 * 故意只给读方法：合并视图是只读的，写必须发生在单账号上下文里（见 lib/aggregate.ts）。
 */
export function apiAs(acc: string) {
  return {
    zones: () => gwAs<R<any[]>>(acc, "/v1/zones"),
    workers: () => gwAs<R<any[]>>(acc, "/v1/workers"),
    pages: () => gwAs<R<any[]>>(acc, "/v1/pages"),
    domains: () => gwAs<R<any[]>>(acc, "/v1/domains"),
    accountSubdomain: () => gwAs<R<{ subdomain?: string }>>(acc, "/v1/workers/subdomain"),
    dnsRecords: (zone: string) => gwAs<R<any[]>>(acc, "/v1/zones/" + encodeURIComponent(zone) + "/dns_records"),
    zoneRoutes: (zone: string) => gwAs<R<any[]>>(acc, "/v1/zones/" + encodeURIComponent(zone) + "/routes"),
    pageDomains: (p: string) => gwAs<R<any[]>>(acc, "/v1/pages/" + encodeURIComponent(p) + "/domains"),
  };
}

export const api = {
  accounts: () => gw<AccountsResult>("/v1/accounts"),
  account: () => gw<R<any[]>>("/v1/account"),
  zones: () => gw<R<any[]>>("/v1/zones"),
  overview: (range: string) => gw<Overview>("/v1/overview", { range }),
  series: (range: string) => gw<SqlResult>("/v1/traffic/series", { range }),
  status: (range: string) => gw<SqlResult>("/v1/traffic/status", { range }),
  origin: (range: string) => gw<SqlResult>("/v1/traffic/origin", { range }),
  countries: (range: string) => gw<R<any>>("/v1/traffic/countries", { range }),
  top: (range: string, dim: "host" | "path" | "bot") => gw<SqlResult>("/v1/traffic/top", { range, dim }),
  /** 缓存命中 / 设备类型：SQL 面没这两列，网关内部换到 GraphQL adaptive，返回形状仍是 {rows:[{k,reqs}]} */
  adaptive: (range: string, dim: "cache" | "device") => gw<SqlResult & { source?: string; sampled?: boolean }>("/v1/traffic/adaptive", { range, dim }),

  workers: () => gw<R<any[]>>("/v1/workers"),
  workerVersions: (s: string, page = 1, perPage = 25) => gw<R<any[]> & { total?: number }>("/v1/workers/" + encodeURIComponent(s) + "/versions", { page, per_page: perPage }),
  workerVersion: (s: string, v: string) => gw<R<any>>("/v1/workers/" + encodeURIComponent(s) + "/versions/" + encodeURIComponent(v)),
  workerDeployments: (s: string) => gw<R<any>>("/v1/workers/" + encodeURIComponent(s) + "/deployments"),
  workerSettings: (s: string) => gw<R<any>>("/v1/workers/" + encodeURIComponent(s) + "/settings"),
  /** 与 workerSettings 是两条不同路由：observability / logpush 只在这里返回 */
  workerScriptSettings: (s: string) => gw<R<any>>("/v1/workers/" + encodeURIComponent(s) + "/script-settings"),
  /** workers.dev 脚本级开关；"开着" ≠ 你的网络能访问（docs/00） */
  workerSubdomain: (s: string) => gw<R<{ enabled?: boolean; previews_enabled?: boolean }>>("/v1/workers/" + encodeURIComponent(s) + "/subdomain"),
  /**
   * 账户级 workers.dev 前缀（域名页那行 `*.xxx.workers.dev` 要用它）。
   * CF 只返回 { subdomain }，**没有开关字段**，所以界面上只展示前缀、不写"已启用"。
   */
  accountSubdomain: () => gw<R<{ subdomain?: string }>>("/v1/workers/subdomain"),
  /**
   * 账户级 Workers 今日用量（默认 UTC 今日 00:00 → 现在）。网关一次返回事件数 + 请求数：
   * 事件数来自 observability/usage，请求数来自 GraphQL `workersInvocationsAdaptive`（best-effort，取不到 requests=null）。
   */
  workersUsage: (from?: number, to?: number) => gw<R<WorkersUsage>>("/v1/workers/usage", { from, to }),
  subscriptions: () => gw<R<Subscription[]>>("/v1/subscriptions"),
  workerSecrets: (s: string) => gw<R<any>>("/v1/workers/" + encodeURIComponent(s) + "/secrets"),
  workerCrons: (s: string) => gw<R<any>>("/v1/workers/" + encodeURIComponent(s) + "/crons"),

  domains: () => gw<R<any[]>>("/v1/domains"),
  dnsRecords: (zone: string) => gw<R<any[]> & { total?: number }>("/v1/zones/" + encodeURIComponent(zone) + "/dns_records"),
  zoneRoutes: (zone: string) => gw<R<any[]>>("/v1/zones/" + encodeURIComponent(zone) + "/routes"),
  /** WAF/Rulesets 只读：三个 phase 一次拿全，"没配过规则"与"套餐不认这个 phase"是两种不同状态 */
  zoneWaf: (zone: string) => gw<Waf>("/v1/zones/" + encodeURIComponent(zone) + "/waf"),

  pages: () => gw<R<any[]>>("/v1/pages"),
  pageDeployments: (p: string) => gw<R<any>>("/v1/pages/" + encodeURIComponent(p) + "/deployments"),
  /** 项目详情 / 自定义域名（2026-10-21 临时项目实测 200） */
  pageProject: (p: string) => gw<R<any>>("/v1/pages/" + encodeURIComponent(p)),
  pageDomains: (p: string) => gw<R<any[]>>("/v1/pages/" + encodeURIComponent(p) + "/domains"),
  /** 构建日志（只读）。上游实测 result = {total, includes_container_logs, data:[{ts,line}]} */
  pageBuildLogs: (p: string, id: string) =>
    gw<R<{ total?: number; includes_container_logs?: boolean; data?: Array<{ ts: string; line: string }> }>>(
      "/v1/pages/" + encodeURIComponent(p) + "/deployments/" + encodeURIComponent(id) + "/logs",
    ),
  /** 回滚到指定部署 / 重试这次构建：上游都是 POST + 空 body（后者对 Direct Upload 部署会 400 8000055，原样上屏） */
  pageRollback: (p: string, id: string) =>
    gwWrite<any>("POST", "/v1/pages/" + encodeURIComponent(p) + "/deployments/" + encodeURIComponent(id) + "/rollback"),
  pageRetry: (p: string, id: string) =>
    gwWrite<any>("POST", "/v1/pages/" + encodeURIComponent(p) + "/deployments/" + encodeURIComponent(id) + "/retry"),
  /** Pages 自定义域名（上游 2026-10-22 临时项目实测：POST/DELETE 项目下的 domains） */
  pageAddDomain: (p: string, name: string) =>
    gwWrite<any>("POST", "/v1/pages/" + encodeURIComponent(p) + "/domains", { name }),
  pageDeleteDomain: (p: string, name: string) =>
    gwWrite<any>("DELETE", "/v1/pages/" + encodeURIComponent(p) + "/domains/" + encodeURIComponent(name)),
  /** Pages 环境变量（PUT 该环境完整变量表；删除 = 不传这个键） */
  pageEnvPut: (p: string, environment: PageEnvironment, vars: PageEnvVars) =>
    gwWrite<any>("PUT", "/v1/pages/" + encodeURIComponent(p) + "/env_vars", { environment, vars }),

  /** Workers 自定义域名（客户端 POST→上游 PUT；解绑 DELETE） */
  workerDomainAttach: (d: { hostname: string; zone_id: string; service: string }) =>
    gwWrite<any>("POST", "/v1/domains", { ...d, environment: "production" }),
  workerDomainDetach: (id: string) => gwWrite<any>("DELETE", "/v1/domains/" + encodeURIComponent(id)),

  /** 站点 Workers 路由增删改（上游 POST/PUT/DELETE 同路径） */
  zoneRouteCreate: (zone: string, r: RouteInput) => gwWrite<any>("POST", "/v1/zones/" + encodeURIComponent(zone) + "/routes", r),
  zoneRouteUpdate: (zone: string, id: string, r: RouteInput) =>
    gwWrite<any>("PUT", "/v1/zones/" + encodeURIComponent(zone) + "/routes/" + encodeURIComponent(id), r),
  zoneRouteDelete: (zone: string, id: string) =>
    gwWrite<any>("DELETE", "/v1/zones/" + encodeURIComponent(zone) + "/routes/" + encodeURIComponent(id)),

  /** 脚本级 workers.dev 开关（两个布尔全量写） */
  workerSubdomainSet: (s: string, enabled: boolean, previews: boolean) =>
    gwWrite<any>("PUT", "/v1/workers/" + encodeURIComponent(s) + "/subdomain", { enabled, previews_enabled: previews }),

  /* ---------- 写侧（docs/12 §3 P3）。调用前必须先拿 preview* 做回显，见文件末尾的写侧契约 ---------- */
  createDnsRecord: (zone: string, r: DnsRecordInput) => gwWrite<any>("POST", "/v1/zones/" + encodeURIComponent(zone) + "/dns_records", dnsBody(r)),
  updateDnsRecord: (zone: string, id: string, r: DnsRecordInput) => gwWrite<any>("PUT", "/v1/zones/" + encodeURIComponent(zone) + "/dns_records/" + encodeURIComponent(id), dnsBody(r)),
  deleteDnsRecord: (zone: string, id: string) => gwWrite<any>("DELETE", "/v1/zones/" + encodeURIComponent(zone) + "/dns_records/" + encodeURIComponent(id)),
  purgeUrls: (zone: string, files: string[]) => gwWrite<any>("POST", "/v1/zones/" + encodeURIComponent(zone) + "/purge_cache", { files }),

  /* ---------- 数据库（D1 + KV） ---------- */
  d1Databases: () => gw<R<D1Database[]>>("/v1/d1"),
  d1Database: (id: string) => gw<R<D1Database>>("/v1/d1/" + encodeURIComponent(id)),
  /** 只读 SQL：GET 通道（网关只放行 SELECT/PRAGMA/EXPLAIN，写语句 422 指路写通道 —— 2026-10-20 收紧） */
  d1Query: (id: string, sql: string) => gw<D1QueryResult>("/v1/d1/" + encodeURIComponent(id) + "/query?sql=" + encodeURIComponent(sql)),
  /** 写 SQL（CREATE/INSERT/UPDATE/DELETE/DROP…）：POST 通道，归写闸门管；上游形状 2026-10-20 临时库实测全 200 */
  d1WriteQuery: (id: string, sql: string) => gwWrite<any>("POST", "/v1/d1/" + encodeURIComponent(id) + "/query", { sql }),
  kvNamespaces: () => gw<R<KvNamespace[]>>("/v1/kv"),
  kvKeys: (nsId: string, limit = 100, cursor?: string) =>
    // CF 要求 limit ≥ 10（实测 10028），客户端先夹紧再发
    gw<KvKeysResult>("/v1/kv/" + encodeURIComponent(nsId) + "/keys", { limit: Math.min(1000, Math.max(10, limit)), ...(cursor ? { cursor } : {}) }),
  /** 写键值：客户端发 {value}，两层转成上游裸文本 PUT（实测 GET 读回逐字节一致） */
  kvPutValue: (nsId: string, key: string, value: string) =>
    gwWrite<any>("PUT", `/v1/kv/${encodeURIComponent(nsId)}/values/${encodeURIComponent(key)}`, { value }),
  kvDeleteKey: (nsId: string, key: string) => gwWrite<any>("DELETE", `/v1/kv/${encodeURIComponent(nsId)}/values/${encodeURIComponent(key)}`),
  r2Buckets: () => gw<R<R2Bucket[]>>("/v1/r2"),

  /* ---------- Zero Trust（Access）只读 ---------- */
  ztOrganization: () => gw<R<ZtOrganization>>("/v1/zt/organization"),
  ztApps: () => gw<R<ZtApp[]>>("/v1/zt/apps"),
  ztGroups: () => gw<R<ZtGroup[]>>("/v1/zt/groups"),
  ztPolicies: () => gw<R<ZtPolicy[]>>("/v1/zt/policies"),
};

/** 网关把 Worker 脚本名放在 id 字段（不是 name），这是实测踩过的坑，统一在这里兜 */
export function workerName(w: any): string {
  return String(w?.id ?? w?.name ?? "");
}

/* ---------- Pages 项目的「是否已部署 / 最近改动」：列表与看板必须同一套判据 ----------
 * 踩过的坑：计算页列表只看 `deployment_id`，看板只看 `latest_deployment`，
 * 同一个项目在两张面上一个写「已部署」一个写「无部署」—— 自相矛盾。
 * 三处（列表 / 看板 / 详情回退）现在都走这里，字段优先级也写死在这一个地方。 */
export function pageDeploy(p: any): any {
  return p?.latest_deployment ?? p?.canonical_deployment ?? null;
}
export function pageDeployed(p: any): boolean {
  return !!pageDeploy(p) || !!p?.deployment_id;
}
/** 最近一次部署的时间（ISO）；没有部署记录时退回项目 created_on，实在没有就空串 */
export function pageLastActivity(p: any): string {
  const d = pageDeploy(p);
  return String(d?.modified_on ?? d?.created_on ?? p?.created_on ?? "");
}

/* ============================================================================
 * 写侧契约（docs/12 §3 P3）。三条设计决定都来自实测，不是风格偏好：
 *
 *  1. 任何写动作先产出 WritePreview（方法 + 完整路径 + 真实请求体），界面把它显示给人看过、
 *     点确认才真发。因为 docs/13 §8.2 记录竞品把「没等结果就报成功」当常态，而我们改的是真 zone。
 *  2. purge 只接受完整 https URL，空数组与通配一律本地拒掉。因为 docs/09 §B5 实测过：
 *     我们按惯例填 files:[123] 想当「故意非法」的探针，CF 没收下当失败，而是**真的执行了**。
 *     所以「填个非法值赌它被拒」这个范式在 purge 上不成立，只能从源头不给通配。
 *  3. 本地写开关默认关，关着就根本不出网（不是发出去让网关拒）。网关那侧还有 WRITE_ENABLED 第二道。
 *
 * 这里的校验与网关 catalog.ts 的写侧校验是同一套规则，两边必须一致：前端负责别让人白填，
 * 网关负责真正拦住（前端可以被绕过，网关不行）。
 * ========================================================================== */

const WRITES_KEY = "cfconsole.writes.v1";
/** 默认关：没显式打开过就是关 */
export function writesOptIn(): boolean {
  try { return localStorage.getItem(WRITES_KEY) === "1"; } catch { return false; }
}
export function setWritesOptIn(on: boolean): void {
  try {
    if (on) localStorage.setItem(WRITES_KEY, "1");
    else localStorage.removeItem(WRITES_KEY);
  } catch { /* 隐私模式存不下，本次会话内仍然生效 */ }
}

export interface DnsRecordInput {
  name: string;
  type: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
  comment?: string;
}

/** CF 控制台可填的类型集（docs/13 §6.16 那 19 类的并集） */
export const DNS_TYPES = ["A", "AAAA", "CAA", "CERT", "CNAME", "DNAME", "DNSKEY", "DS", "HTTPS", "LOC", "MX", "NS", "OPENPGPKEY", "PTR", "SMIMEA", "SRV", "SSHFP", "TLSA", "TXT", "URL"];
/** 只有这三类能开代理；界面按这个显隐开关，比竞品用类型数组硬判更准的做法是读接口返回的 proxiable 字段 */
export const PROXIABLE_TYPES = new Set(["A", "AAAA", "CNAME"]);
const NEEDS_PRIORITY = new Set(["MX", "SRV"]);
const MAX_PURGE_URLS = 30;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f:]{3,45}$/i;
const HOSTISH = /^[a-z0-9._-]+$/i;

function bad(message: string): never {
  throw new GwError("badQuery", 422, null, message);
}

/** 返回归一化后的记录（小写、去尾点）；不合格直接抛，调用方不用检查返回值 */
export function validateDns(zone: string, r: DnsRecordInput): Required<Pick<DnsRecordInput, "name" | "type" | "content" | "ttl" | "proxied">> & DnsRecordInput {
  const z = String(zone || "").trim().toLowerCase().replace(/\.+$/, "");
  const name = String(r.name || "").trim().toLowerCase().replace(/\.+$/, "");
  const type = String(r.type || "").trim().toUpperCase();
  const content = String(r.content || "").trim();
  const ttl = r.ttl === undefined ? 1 : Number(r.ttl);

  if (!z) bad("缺少 Zone，无法校验记录名");
  if (!name) bad("记录名不能为空（填 @ 表示域名本身）");
  if (!HOSTISH.test(name)) bad(`记录名只能含字母、数字、点、连字符和下划线：${name}`);
  const fqdn = name === "@" ? z : name.endsWith("." + z) ? name : name + "." + z;
  if (fqdn.length > 253) bad("完整域名超过 253 字符");
  if (!DNS_TYPES.includes(type)) bad(`不支持的记录类型：${type}`);
  if (!content) bad("内容不能为空");
  if (type === "A" && !IPV4.test(content)) bad(`A 记录要填 IPv4，例如 203.0.113.10（现在是 ${content}）`);
  if (type === "AAAA" && !IPV6.test(content)) bad(`AAAA 记录要填 IPv6，例如 2001:db8::1（现在是 ${content}）`);
  if ((type === "CNAME" || type === "NS" || type === "PTR" || type === "DNAME") && !HOSTISH.test(content)) bad(`${type} 记录的内容要是一个域名`);
  if (type === "CNAME" && fqdn === content.replace(/\.+$/, "").toLowerCase()) bad("CNAME 不能指向自己");
  if (NEEDS_PRIORITY.has(type) && !(Number(r.priority) >= 0)) bad(`${type} 记录必须给优先级（0 起）`);
  if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 120 || ttl > 172800))) bad("TTL 只能是「自动」(1) 或 120–172800 秒之间的整数");
  if (r.proxied === true && !PROXIABLE_TYPES.has(type)) bad(`${type} 记录不能开代理（只有 A / AAAA / CNAME 可以）`);
  /** 网关要求：proxied=true 时 TTL 必须是 1（自动），否则 CF 会拒 */
  if (r.proxied === true && ttl !== 1) bad("开了代理（橙云）的记录 TTL 必须是「自动」(1)，CF 不允许手动指定 TTL");

  return { ...r, name: fqdn, type, content, ttl, proxied: r.proxied === true };
}

/** 真正发出去的请求体：只带 CF 认的字段，多余的键会让 400；数值字段显式转 Number */
export function dnsBody(r: DnsRecordInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: r.name,
    type: r.type,
    content: r.content,
    ttl: Number(r.ttl ?? 1),
    proxied: r.proxied === true,
  };
  if (r.priority !== undefined) body.priority = Number(r.priority);
  if (r.comment) body.comment = String(r.comment);
  return body;
}

export function validatePurgeFiles(files: string[]): string[] {
  const list = (files || []).map((s) => String(s || "").trim()).filter(Boolean);
  if (!list.length) bad("没有要清理的 URL。清缓存不接受空请求，也不用「全部清理」代替逐条确认");
  if (list.length > MAX_PURGE_URLS) bad(`一次最多 ${MAX_PURGE_URLS} 条 URL（现在是 ${list.length} 条）`);
  for (const f of list) {
    if (f.includes("*")) bad(`URL 里不能带通配符 *：${f}`);
    if (!/^https:\/\/[^\s]+$/i.test(f)) bad(`只接受完整的 https 地址：${f}`);
    /** 网关会对 purge URL 做 new URL() 归一化，这里也走一遍，保证回显的串和发出去的串一字不差 */
    try {
      const u = new URL(f);
      if (u.hash) bad(`URL 不能带 # 片段：${f}`);
      if (u.username || u.password) bad(`URL 不能含用户名/密码：${f}`);
    } catch {
      bad(`不是合法的 URL：${f}`);
    }
  }
  /** 归一化后去重，保持插入顺序 */
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const f of list) {
    const normalized = new URL(f).toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }
  return unique;
}

export const PURGE_LIMIT = MAX_PURGE_URLS;

/** 回显给人看的东西：这就是将要真的发出去的东西，二者不是两套代码 */
export interface WritePreview {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  body: unknown;
  title: string;
  lines: { k: string; v: string }[];
  /** 破坏性程度：界面据此决定要不要额外让人打一遍对象名（docs/13 §7.5「点名对象」） */
  danger: "normal" | "irreversible";
}

const zonePath = (zone: string) => "/v1/zones/" + encodeURIComponent(zone);

export function previewDnsCreate(zoneId: string, zoneName: string, r: DnsRecordInput): WritePreview {
  const v = validateDns(zoneName, r);
  return { method: "POST", path: zonePath(zoneId) + "/dns_records", body: dnsBody(v), title: "新增 DNS 记录", lines: [{ k: "Zone", v: zoneName }, { k: "名称", v: v.name }, { k: "类型", v: v.type }, { k: "内容", v: v.content }, { k: "TTL", v: v.ttl === 1 ? "自动" : String(v.ttl) + " 秒" }, { k: "代理状态", v: v.proxied ? "已代理（橙云）" : "仅 DNS" }], danger: "normal" };
}

export function previewDnsUpdate(zoneId: string, zoneName: string, id: string, r: DnsRecordInput): WritePreview {
  const v = validateDns(zoneName, r);
  return { method: "PUT", path: zonePath(zoneId) + "/dns_records/" + encodeURIComponent(id), body: dnsBody(v), title: "修改 DNS 记录", lines: [{ k: "Zone", v: zoneName }, { k: "记录 ID", v: id }, { k: "名称", v: v.name }, { k: "类型", v: v.type }, { k: "内容", v: v.content }, { k: "TTL", v: v.ttl === 1 ? "自动" : String(v.ttl) + " 秒" }, { k: "代理状态", v: v.proxied ? "已代理（橙云）" : "仅 DNS" }], danger: "normal" };
}

/** 删除必须点名：竞品那句「确定要删除此 DNS 记录吗？」不带记录名，是 docs/13 §8.2 点名的反面教材 */
export function previewDnsDelete(zoneId: string, zoneName: string, id: string, name: string): WritePreview {
  if (!name) bad("删除必须点名：没有记录名就不发这条请求");
  return { method: "DELETE", path: zonePath(zoneId) + "/dns_records/" + encodeURIComponent(id), body: undefined, title: "删除 DNS 记录", lines: [{ k: "Zone", v: zoneName }, { k: "要删除的记录", v: name }, { k: "记录 ID", v: id }], danger: "irreversible" };
}

export function previewPurge(zoneId: string, zoneName: string, files: string[]): WritePreview {
  const list = validatePurgeFiles(files);
  return { method: "POST", path: zonePath(zoneId) + "/purge_cache", body: { files: list }, title: `清理 ${list.length} 个 URL 的缓存`, lines: [{ k: "Zone", v: zoneName }, { k: "条数", v: String(list.length) }, ...list.map((u, i) => ({ k: "URL " + (i + 1), v: u }))], danger: "normal" };
}

/* ---------- 自定义域名 / 站点路由 / Pages 环境变量 / workers.dev 开关的预览 ----------
 * 校验与网关 catalog 同一套规则：前端负责别让人白填，网关负责真正拦住。
 */

const HOSTNAME_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

function hostnameFor(v: unknown, field: string): string {
  const h = String(v ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (!h) bad(`${field} 不能为空`);
  if (h.includes("/") || h.includes(":") || h.includes("*") || h.includes(" ")) bad(`${field} 只填域名本身，不带协议 / 端口 / 通配符：${h}`);
  if (h.length > 253 || !HOSTNAME_RE.test(h)) bad(`${field} 不是合法域名：${h || "空"}`);
  return h;
}

function scriptNameFor(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!SCRIPT_NAME_RE.test(s)) bad(`Worker 脚本名不合法：${s || "空"}`);
  return s;
}

function routeBodyFor(zoneName: string, r: RouteInput): RouteInput {
  const pattern = String(r?.pattern ?? "").trim().toLowerCase();
  if (!pattern) bad("pattern 不能为空");
  if (pattern.includes("://") || /\s/.test(pattern)) bad("pattern 是「主机名/路径」形状，不带协议、不带空格");
  if (!/^(\*\.)?[a-z0-9.-]+\/\S*$/.test(pattern)) bad(`pattern 得是 example.com/* 或 *.example.com/* 这种形状（现在是 ${pattern}）`);
  if (!pattern.endsWith("*")) bad("pattern 要以 * 结尾（CF 的路由靠末尾通配匹配路径）");
  const host = pattern.split("/")[0].replace(/^\*\./, "");
  const z = zoneName.toLowerCase();
  if (!(host === z || host.endsWith("." + z))) bad(`pattern 的主机名 ${host} 不属于这个 zone（${z}）`);
  const script = r?.script === null || r?.script === undefined ? null : scriptNameFor(r.script);
  return { pattern, script };
}

/** Workers 自定义域名绑定：客户端 POST /v1/domains → 上游 PUT /accounts/{a}/workers/domains */
export function previewWorkerDomainAttach(zoneId: string, zoneName: string, hostname: string, service: string): WritePreview {
  const h = hostnameFor(hostname, "hostname");
  const z = zoneName.toLowerCase();
  if (!(h === z || h.endsWith("." + z))) bad(`hostname ${h} 不属于 zone ${z}`);
  if (!/^[0-9a-f]{32}$/i.test(zoneId)) bad("zone id 得是 32 位");
  const s = scriptNameFor(service);
  return {
    method: "POST",
    path: "/v1/domains",
    body: { hostname: h, zone_id: zoneId, service: s, environment: "production" },
    title: `绑定自定义域名 ${h}`,
    lines: [
      { k: "域名", v: h },
      { k: "Zone", v: zoneName },
      { k: "Worker", v: s },
      { k: "环境", v: "production（上游这个端点只有 production）" },
      { k: "上游形状", v: "2026-10-22 实测：PUT /accounts/{a}/workers/domains（POST 回 405）" },
    ],
    danger: "normal",
  };
}

export function previewWorkerDomainDetach(d: Record<string, any>): WritePreview {
  const id = String(d?.id ?? "").trim();
  if (!id) bad("这条域名没有 id，不解绑");
  return {
    method: "DELETE",
    path: "/v1/domains/" + encodeURIComponent(id),
    body: undefined,
    title: `解绑 ${String(d?.hostname ?? id)}`,
    lines: [
      { k: "要删除的记录", v: String(d?.hostname ?? id) },
      { k: "域名", v: String(d?.hostname ?? "—") },
      { k: "绑定 ID", v: id },
      { k: "Worker", v: String(d?.service ?? "—") },
      { k: "影响", v: "解绑后这个域名不再指向 Worker；DNS 记录是否保留以 Cloudflare 后台为准" },
    ],
    danger: "irreversible",
  };
}

export function previewPageDomainAdd(project: string, hostname: string): WritePreview {
  const h = hostnameFor(hostname, "name");
  return {
    method: "POST",
    path: `/v1/pages/${encodeURIComponent(project)}/domains`,
    body: { name: h },
    title: `给「${project}」添加域名 ${h}`,
    lines: [
      { k: "项目", v: project },
      { k: "域名", v: h },
      { k: "前提", v: "域名所属 zone 必须在本账号下；添加后还要按 CF 提示配置 DNS" },
      { k: "实测", v: "2026-10-22 临时项目：POST → 200，建后即删无残留" },
    ],
    danger: "normal",
  };
}

export function previewPageDomainDelete(project: string, d: Record<string, any>): WritePreview {
  const name = hostnameFor(d?.name ?? d?.domain, "name");
  return {
    method: "DELETE",
    path: `/v1/pages/${encodeURIComponent(project)}/domains/${encodeURIComponent(name)}`,
    body: undefined,
    title: `从「${project}」移除 ${name}`,
    lines: [
      { k: "要删除的记录", v: name },
      { k: "项目", v: project },
      { k: "域名", v: name },
      { k: "影响", v: "移除后这个域名不再指向该项目；pages.dev 子域不受影响" },
    ],
    danger: "irreversible",
  };
}

/** 站点 Workers 路由：新建 / 改 / 删，三条都回显最终 pattern + script */
export function previewZoneRoute(
  zoneId: string,
  zoneName: string,
  action: "create" | "update" | "delete",
  r: RouteInput & { id?: string },
): WritePreview {
  if (!/^[0-9a-f]{32}$/i.test(zoneId)) bad("zone id 得是 32 位");
  if (action === "delete") {
    const id = String(r?.id ?? "").trim();
    if (!id) bad("这条路由没有 id，不删");
    return {
      method: "DELETE",
      path: `/v1/zones/${encodeURIComponent(zoneId)}/routes/${encodeURIComponent(id)}`,
      body: undefined,
      title: `删除路由 ${String(r?.pattern ?? id)}`,
      lines: [
        { k: "要删除的记录", v: String(r?.pattern ?? id) },
        { k: "Zone", v: zoneName },
        { k: "路由 ID", v: id },
        { k: "pattern", v: String(r?.pattern ?? "—") },
        { k: "script", v: r?.script ? String(r.script) : "仅记录（不跑 Worker）" },
        { k: "影响", v: "这条 pattern 的请求不再经过该 Worker（或不再跳过）" },
      ],
      danger: "irreversible",
    };
  }
  const body = routeBodyFor(zoneName, r);
  const id = String(r?.id ?? "").trim();
  if (action === "update" && !id) bad("改动路由需要 id");
  return {
    method: action === "create" ? "POST" : "PUT",
    path: `/v1/zones/${encodeURIComponent(zoneId)}/routes` + (action === "update" ? "/" + encodeURIComponent(id) : ""),
    body,
    title: action === "create" ? `新增路由 ${body.pattern}` : `修改路由 ${body.pattern}`,
    lines: [
      { k: "Zone", v: zoneName },
      ...(action === "update" ? [{ k: "路由 ID", v: id }] : []),
      { k: "pattern", v: body.pattern },
      { k: "script", v: body.script ?? "null（仅记录，不跑 Worker）" },
      { k: "前提", v: "写这条需要令牌带 Workers Routes Write；缺权限时 CF 会回 403，原样上屏" },
    ],
    danger: "normal",
  };
}

/** Pages 环境变量：body 是该环境**完整**变量表（PUT 全量覆盖），界面据此回显变更摘要 */
export function previewPageEnv(
  project: string,
  environment: PageEnvironment,
  vars: PageEnvVars,
  summary: string,
): WritePreview {
  const entries = Object.entries(vars);
  if (entries.length > 64) bad("一次最多 64 个环境变量");
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || k.length > 64) bad(`环境变量名不合法：${k}`);
    if (typeof v?.value !== "string") bad(`${k} 的值必须是字符串`);
    if (v.type !== "plain_text" && v.type !== "secret_text") bad(`${k} 的类型只能是 plain_text / secret_text`);
  }
  return {
    method: "PUT",
    path: `/v1/pages/${encodeURIComponent(project)}/env_vars`,
    body: { environment, vars },
    title: `更新「${project}」${environment === "production" ? "生产" : "预览"}环境变量`,
    lines: [
      { k: "项目", v: project },
      { k: "环境", v: environment === "production" ? "生产" : "预览" },
      { k: "变更", v: summary },
      { k: "覆盖方式", v: `整表覆盖（共 ${entries.length} 个变量）；没出现在表里的键会被删除，删除只能靠"不传键"` },
      { k: "实测", v: "2026-10-22 临时项目：PATCH deployment_configs.{env}.env_vars → 200" },
    ],
    danger: "normal",
  };
}

/** 脚本级 workers.dev 开关：上游 POST 收两个布尔（缺一个会被当成 reset） */
export function previewWorkerSubdomain(s: string, enabled: boolean, previews: boolean): WritePreview {
  const svc = scriptNameFor(s);
  return {
    method: "PUT",
    path: `/v1/workers/${encodeURIComponent(svc)}/subdomain`,
    body: { enabled, previews_enabled: previews },
    title: `${enabled ? "启用" : "关闭"} ${svc} 的 workers.dev`,
    lines: [
      { k: "脚本", v: svc },
      { k: "workers.dev", v: enabled ? "启用" : "关闭" },
      { k: "预览子域", v: previews ? "启用" : "关闭" },
      { k: "上游形状", v: "2026-10-22 实测：POST …/scripts/{s}/subdomain，两个布尔全量写" },
    ],
    danger: "normal",
  };
}

/** 写完必须让这条 zone 的只读缓存作废，否则界面会拿 5 分钟前的旧记录说"已经改好了" */
export function dropMem(prefix: string): void {
  for (const k of Array.from(mem.keys())) if (k.includes(prefix)) mem.delete(k);
}

/**
 * 写完作废两层读缓存。路径形状 `/v1/{kind}/{id}/...`：第二段是资源类型，第三段是对象 id/项目名。
 * Pages 回滚后部署列表要立刻重取，否则「当前版本」还停在旧的那条。
 */
function dropAfterWrite(path: string): void {
  const s = path.split("/");
  const kind = s[2], id = s[3];
  if (!kind || !id) return;
  if (kind === "zones") {
    dropMem("/v1/zones/" + id);
    dropDirect("/zones/" + id);
  } else if (kind === "pages") {
    dropMem("/v1/pages/" + id);
    dropDirect("/pages/projects/" + id);
  }
}

/**
 * 写请求专用：与 gw() 同一套鉴权与错误归类，但有五件事必须不同 ——
 * 不进任何缓存、发之前查本地写开关、成功后让相关读缓存作废、绝不"没等结果就报成功"
 * （返回值就是网关剥过的 CF result，界面上报的成败都以它为准）、
 * 以及**不走 fetchNetRetry**：写请求一旦被服务端收到就不能盲重，
 * 连接被拒时我们无法证明"没送达"（可能是响应半路断了），所以一次都不重试，直接报错让人看结果。
 */
export async function gwWrite<T = any>(method: WritePreview["method"], path: string, body?: unknown): Promise<T> {
  if (!writesOptIn()) throw new GwError("writesDisabled", 403, null, "本机写开关没打开，这条请求没有发出");
  const cfg = loadConfig();
  // 直连模式（APK）：没有设备令牌这一说，凭据就是选中账号的 CF 令牌；写完了两层缓存都要作废
  if (isNativeApp()) {
    const ctx = await directCtx(cfg, false);
    if (!ctx) throw noDirectCtxError(cfg);
    try {
      const data = await writeDirect(ctx, method, path, body);
      dropAfterWrite(path);
      return data as T;
    } catch (e) {
      throw asGwError(e);
    }
  }
  if (!cfg.deviceToken) throw new GwError("auth", 401, null, "没有设备令牌，去「设置」里填");
  assertGatewayAuth(cfg);
  const q = cfg.account && !NO_ACCOUNT_PARAM.has(path) ? { account: cfg.account } : undefined;
  const url = effectiveBase(cfg) + path + qs(q);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "x-device-token": cfg.deviceToken, "content-type": "application/json", ...cfTokenHeader(cfg) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    const isTimeout = (e as Error)?.name === "TimeoutError";
    throw new GwError(isTimeout ? "timeout" : "network", 0, null, isTimeout ? "网关 25 秒没响应" : String((e as Error)?.message || e));
  }
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 当失败处理 */ }
  if (!res.ok) {
    const err = json?.error;
    const kind = (err?.kind as ErrKind) || (res.status === 401 ? "auth" : res.status === 501 ? "writesDisabled" : res.status >= 500 ? "upstreamBroken" : "unknown");
    throw new GwError(kind, res.status, err?.code ?? null, String(err?.message || text.slice(0, 160) || res.statusText));
  }
  if (!json) throw new GwError("unknown", res.status, null, "网关返回了非 JSON 内容");
  dropAfterWrite(path);
  return (json?.result ?? json) as T;
}

/* ============================================================================
 * 以下为调度层追加（feat/console-data）。只加不改：上面 gw()/gwWrite()/gwHealth()
 * 的行为、签名、缓存策略全部保持原样。
 * ========================================================================== */

/**
 * 「最近一次经手的 gw() 响应距今多久」，毫秒。
 *
 * 没取到过任何数据时返回 Infinity 而不是 0：调度器拿它判新鲜期，
 * 若把"从没有过"当成 0（=最新鲜），第一轮就永远发不出去 —— 语义上 Infinity 才是诚实的。
 * 界面文案侧同理：Infinity 对应"没取到"，不能渲染成"0 秒前"。
 */
export function gwAgeMs(): number {
  return gwMeta.fetchedAt ? Math.max(0, Date.now() - gwMeta.fetchedAt) : Number.POSITIVE_INFINITY;
}

/** 数据现在算"过期"吗？调度器和屏共用同一把尺子（MEM_TTL_MS），避免两处判得不一致。 */
export function gwStale(): boolean {
  return gwAgeMs() >= MEM_TTL_MS;
}

/* ============================================================================
 * 数据库类型：D1 + KV。字段只列界面会读的部分，其余保持开放。
 * 来源：docs/evidence/responses.sample.json「d1/database」「kv namespaces」+ OpenAPI spec。
 * ========================================================================== */
export interface D1Database {
  uuid: string;
  name: string;
  created_at: string;
  version: string;
  num_tables: number;
  file_size: number;
  jurisdiction: string | null;
}
export interface D1QueryResult {
  result: Array<{ results: Record<string, any>[]; meta: { served_by: string; served_by_colo: string; duration: number; rows_read: number; changes: number } }>;
}

export interface KvNamespace {
  id: string;
  title: string;
  supports_url_encoding: boolean;
}
export interface KvKey {
  name: string;
  metadata?: Record<string, unknown>;
  expiration?: number;
}
export interface KvKeysResult {
  result: KvKey[];
  success: boolean;
  errors: any[];
  messages: any[];
  cursor?: string;
  total?: number;
}

/** R2 存储桶（CF 官方字段；这个账号当前读不到，界面走错误态，字段留作开通后用） */
export interface R2Bucket {
  name: string;
  creation_date: string;
  location?: string;
  jurisdiction?: string | null;
}

/** Zero Trust（Access）组织信息：实测 result 是对象，不是列表 */
export interface ZtOrganization {
  auth_domain?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  is_ui_read_only?: boolean;
  login_design?: Record<string, unknown>;
}
export interface ZtApp {
  id?: string;
  name?: string;
  domain?: string;
  session_duration?: string;
  type?: string;
}
export interface ZtGroup {
  id?: string;
  name?: string;
}
export interface ZtPolicy {
  id?: string;
  name?: string;
  decision?: string;
  precedence?: number;
  access_app_id?: string;
}
