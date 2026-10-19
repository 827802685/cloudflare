/**
 * 网关白名单：App 能要到什么数据、能改什么东西，完全由这张表决定。
 *
 * 设计约束（docs/06 §4、docs/02 §7）：
 *  - 不做 CF API 的通用透传代理，否则网关泄露 = 整个账号泄露；
 *  - SQL 只允许这里的命名模板，参数只有时间窗与 LIMIT，用户输入永远进不了 query 字符串；
 *  - 写操作只有 `WRITE_ROUTES` 那四条（DNS 增删改 + 按 URL 清缓存），逐条加白 + 三道闸门：
 *    `WRITE_ENABLED` → method/path 命中白名单 → 服务端逐字段校验。路径形状与
 *    `console/src/lib/api.ts` 末尾的写侧契约一字不差，但这里更严（前端那份可以被 curl 绕过）。
 */
import { CACHE_TTL_MS, CfClient, CfError } from "./cf";

export type RangeKey = "24h" | "7d" | "30d";
export const RANGES: Record<RangeKey, { days: number; label: string }> = {
  "24h": { days: 1, label: "最近 24 小时" },
  "7d": { days: 7, label: "最近 7 天" },
  "30d": { days: 30, label: "最近 30 天" },
};

export function parseRange(v: string | undefined): { key: RangeKey; days: number; start: string; end: string; dateGeq: string; dateLt: string } {
  const key = (v === "24h" || v === "30d" ? v : "7d") as RangeKey;
  const { days } = RANGES[key];
  /**
   * 时间窗**按缓存 TTL 对齐到 5 分钟整格**，不是取"此刻"。
   * 不这么做的话每条 query 里的 datetime_geq/lt 都带着秒级差异 ⇒ 缓存键永远不同 ⇒ TTL 形同虚设
   * （实测第二轮还剩 4 次出网，就是这个原因，见 tools/probe-request-budget.mjs）。
   * 代价说清楚：这一屏的数据窗最多比"现在"旧 5 分钟，与 Analytics 本身几分钟的延迟同量级。
   */
  const bucket = Math.floor(Date.now() / CACHE_TTL_MS) * CACHE_TTL_MS;
  const end = new Date(bucket);
  const start = new Date(end.getTime() - days * 86400000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    key,
    days,
    start: iso(start),
    end: iso(new Date(end.getTime() + 3600000)),   // 上界多给 1 小时，避免边缘延迟数据被切掉（实测口径问题）
    dateGeq: start.toISOString().slice(0, 10),
    dateLt: new Date(end.getTime() + 86400000).toISOString().slice(0, 10),
  };
}

const ACC = (env: Env) => env.CF_ACCOUNT_ID;

/**
 * 这把令牌能看见哪些账号（`GET /accounts`）。用于校验客户端传来的 `?account=`：
 * 只有出现在这个集合里的 id 才会被拼进 CF 路径，其它一律 422，所以"账号 ID 可由客户端控制"
 * 并没有把任意路径片段开放出去（对照本文件头的设计约束）。
 *
 * 缓存 5 分钟、按令牌分格（key 只存在内存里，绝不进任何响应）。isolate 重启就冷，无害。
 */
const accountsCache = new Map<string, { at: number; ids: string[] }>();
export async function visibleAccountIds(cf: CfClient, token: string): Promise<string[]> {
  const hit = accountsCache.get(token);
  if (hit && Date.now() - hit.at < 300_000) return hit.ids;
  // 逐页拿满：/accounts 默认每页 20，超过 20 个账号时单页取法会让合法 id 被闸门误拒（422）
  const r = await pagedList(cf, `/accounts`, 50);
  const ids = ((r.data as any[]) || []).map((a) => String(a?.id || "")).filter(Boolean);
  accountsCache.set(token, { at: Date.now(), ids });
  return ids;
}

/* ============================================================================
 * 写侧：白名单、闸门用的集合、以及逐项校验
 * ========================================================================== */

/**
 * 这把令牌能看见哪些 zone（`GET /zones`），用途与 `visibleAccountIds` 完全对称：路径里的 `:zone`
 * 来自客户端，只有落进这个集合的 id 才会被拼进 CF 路径，其它一律 422。
 * 顺带把 zone 域名带回来 —— 记录名必须属于这个 zone，否则这条写就变成"往别人的域名上挂记录"。
 *
 * 同一个 `GET /zones?per_page=50` 也是读侧 `/v1/zones` 用的那条，缓存 5 分钟按令牌分格，
 * 所以这道闸门在正常情况下一条都不多出网。缓存写法（含"键绝不进响应"）照 `visibleAccountIds`。
 */
export interface VisibleZone {
  id: string;
  name: string;
  accountId: string;
}
const zonesCache = new Map<string, { at: number; zones: VisibleZone[] }>();
export async function visibleZones(cf: CfClient, token: string): Promise<VisibleZone[]> {
  const hit = zonesCache.get(token);
  if (hit && Date.now() - hit.at < 300_000) return hit.zones;
  // 逐页拿满（/zones 每页 50）：写闸门必须看到完整的可见集合，不然超页的 zone 会被误 422
  const r = await pagedList(cf, `/zones`, 50);
  const zones = ((r.data as any[]) || [])
    .map((z) => ({ id: String(z?.id || ""), name: String(z?.name || "").toLowerCase(), accountId: String(z?.account?.id || "") }))
    .filter((z) => z.id && z.name);
  zonesCache.set(token, { at: Date.now(), zones });
  return zones;
}
export async function visibleZoneIds(cf: CfClient, token: string): Promise<string[]> {
  return (await visibleZones(cf, token)).map((z) => z.id);
}

/**
 * 本 isolate 内由本网关 POST **创建成功**过的 record id。`DELETE` 只接受这里的 id。
 *
 * 为什么必须有这道闸（docs/12 §3 P3 的红线）：现有 15 条记录里那条名为 `cf` 的 AAAA 是绑自定义域名
 * `cf.acct.example.com` 时 Cloudflare 自建的，删掉线上入口就没了 —— 而 CF 的 API 层面"删这条"和"删错了"
 * 长得一模一样（都是 200 success），拦不住的唯一办法是本网关没建过的 id 根本不给删。
 *
 * 代价要明说：集合只在内存里，isolate 重启或重新部署之后，之前建的记录就删不掉了（得去 CF 后台删）。
 * 这是有意选的下界 —— 宁可删不掉，也不能误删不是自己建的记录。上限按创建顺序丢最老的。
 */
const MAX_CREATED = 500;
const createdRecordIds = new Set<string>();
export function noteCreatedRecord(id: string): void {
  if (!id || createdRecordIds.has(id)) return;
  createdRecordIds.add(id);
  if (createdRecordIds.size > MAX_CREATED) {
    const oldest = createdRecordIds.values().next().value;
    if (oldest) createdRecordIds.delete(oldest);
  }
}
export function canDeleteRecord(id: string): boolean {
  return createdRecordIds.has(id);
}
export function forgetCreatedRecord(id: string): void {
  createdRecordIds.delete(id);
}

/**
 * 第二道闸门的内容：method + 路径必须逐条命中，命不上的非 GET 在 index.ts 末尾照样 501。
 * 开写没有松动"不做通用透传"这条硬规则 —— 这四条之外一条都没有。
 */
export const WRITE_ROUTES = [
  { method: "POST", path: "/v1/zones/:zone/dns_records" },
  { method: "PUT", path: "/v1/zones/:zone/dns_records/:id" },
  { method: "DELETE", path: "/v1/zones/:zone/dns_records/:id" },
  { method: "POST", path: "/v1/zones/:zone/purge_cache" },
] as const;

/** 写端点表：全部走 cf.rest，不进缓存层（cf.ts 的 isReadCall 只认 GET / graphql / sql） */
export const writes = {
  dnsCreate: (cf: CfClient, zone: string, body: Record<string, unknown>) =>
    cf.rest(`/zones/${encodeURIComponent(zone)}/dns_records`, { method: "POST", body }),
  dnsUpdate: (cf: CfClient, zone: string, id: string, body: Record<string, unknown>) =>
    cf.rest(`/zones/${encodeURIComponent(zone)}/dns_records/${encodeURIComponent(id)}`, { method: "PUT", body }),
  dnsDelete: (cf: CfClient, zone: string, id: string) =>
    cf.rest(`/zones/${encodeURIComponent(zone)}/dns_records/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** 只发 files，永不发 `purge_everything`：那条是全站清空，白名单里没有它的位置 */
  purge: (cf: CfClient, zone: string, files: string[]) =>
    cf.rest(`/zones/${encodeURIComponent(zone)}/purge_cache`, { method: "POST", body: { files } }),
};

/* ---------- 写侧校验（第三道闸门） ----------
 * 规则集与 console/src/lib/api.ts 的 validateDns / validatePurgeFiles 同源，但更严，
 * 并且**校验顺序是刻意的**：先做不依赖 zone 的格式校验，再拿 GET /zones，最后才碰写端点。
 * 所以"body 非法"这类 422 是真的零出网（冒烟脚本用 /health 的 writes 计数差值证明），
 * 只有"zone 不在可见集合"这一类会先读一次 /zones —— 那是只读、且正常情况下命中缓存。
 */

/** CF 控制台可填的类型集，与 console 的 DNS_TYPES 同一份（改一处要改两处，check-route-parity 抓不到这个） */
export const DNS_TYPES = ["A", "AAAA", "CAA", "CERT", "CNAME", "DNAME", "DNSKEY", "DS", "HTTPS", "LOC", "MX", "NS", "OPENPGPKEY", "PTR", "SMIMEA", "SRV", "SSHFP", "TLSA", "TXT", "URL"];
export const PROXIABLE_TYPES = new Set(["A", "AAAA", "CNAME"]);
const PRIORITY_TYPES = new Set(["MX", "SRV"]);
const HOST_TYPES = new Set(["CNAME", "NS", "PTR", "DNAME"]);
export const PURGE_LIMIT = 30;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTISH = /^[a-z0-9._-]+$/i;

function bad(message: string): never {
  throw new CfError("badQuery", 422, null, message);
}

function isIpv6(s: string): boolean {
  // console 那份是 /^[0-9a-f:]{3,45}$/i，"::::" 也算合法；这里按形状真算：至多一个 ::、每组 1–4 位十六进制、末尾可内嵌 IPv4
  if (!/^[0-9a-f:.]+$/i.test(s) || s.includes("..") || /:::/.test(s) || s === "::") return false;
  const parts = s.split("::");
  if (parts.length > 2) return false;
  const count = (part: string): number | null => {
    if (part === "") return 0;
    const list = part.split(":");
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (g.includes(".")) {
        if (i !== list.length - 1 || !IPV4.test(g)) return null;
        n += 2;
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
        n += 1;
      }
    }
    return n;
  };
  const head = count(parts[0]);
  const tail = parts.length === 2 ? count(parts[1]) : null;
  if (head === null || tail === null) return false;
  return parts.length === 2 ? head + tail <= 7 : head === 8;
}

function textField(v: unknown, field: string): string {
  if (typeof v !== "string") bad(`${field} 必须是字符串`);
  return v;
}
function numberField(v: unknown, field: string): number {
  // 只收 JSON 数字。"120" 这种字符串数字一律拒：前端发的是数字，收字符串等于给绕过留门
  if (typeof v !== "number" || !Number.isFinite(v)) bad(`${field} 必须是数字`);
  return v;
}

export interface DnsDraft {
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
  comment?: string;
}

/** 不依赖 zone 的全部逐字段校验；返回归一化后的草稿（name 可能还是相对名） */
export function validateDnsBody(raw: Record<string, unknown>): DnsDraft {
  const allowed = ["name", "type", "content", "ttl", "priority", "proxied", "comment"];
  const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (unknown.length) bad(`不支持的字段：${unknown.join(",")}。这条路由只认 ${allowed.join(" / ")}`);

  const name = textField(raw.name, "name").trim().toLowerCase().replace(/\.+$/, "");
  const type = textField(raw.type, "type").trim().toUpperCase();
  const content = textField(raw.content, "content").trim();
  const ttl = raw.ttl === undefined ? 1 : numberField(raw.ttl, "ttl");

  if (!name) bad("记录名不能为空（填 @ 表示域名本身）");
  if (!HOSTISH.test(name)) bad(`记录名只能含字母、数字、点、连字符和下划线：${name}`);
  const labels = name.split(".");
  if (labels.some((l) => !l || l.length > 63)) bad("记录名的每个标签都要非空且不超过 63 字符");
  if (!DNS_TYPES.includes(type)) bad(`不支持的记录类型：${type}`);
  if (!content) bad("内容不能为空");
  if (/[\u0000-\u001f\u007f]/.test(content)) bad("内容里不能有控制字符或换行");
  if (content.length > 2048) bad("内容超过 2048 字符");
  if (type === "TXT" && content.length > 454) bad("TXT 内容超过 454 字符（CF 对单条 TXT 的硬上限）");
  if (type === "A" && !IPV4.test(content)) bad(`A 记录要填 IPv4，例如 203.0.113.10（现在是 ${content}）`);
  if (type === "AAAA" && !isIpv6(content)) bad(`AAAA 记录要填 IPv6，例如 2001:db8::1（现在是 ${content}）`);
  if ((HOST_TYPES.has(type) || type === "MX") && !HOSTISH.test(content.replace(/\.+$/, ""))) bad(`${type} 记录的内容要是一个域名`);
  if (type === "SRV" && !/^([0-9]{1,5}) ([0-9]{1,5}) ([a-z0-9._-]+)$/i.test(content)) bad("SRV 记录的内容格式是「weight port target」");
  if (type === "URL" && !/^(https?:\/\/\S+|\/\S*)$/i.test(content)) bad("URL 记录的内容要是一个 http(s) 地址或以 / 开头的跳转路径");

  if (!Number.isInteger(ttl) || (ttl !== 1 && (ttl < 120 || ttl > 172800))) bad("TTL 只能是「自动」(1) 或 120–172800 秒之间的整数");

  let priority: number | undefined;
  if (raw.priority !== undefined) {
    priority = numberField(raw.priority, "priority");
    if (!Number.isInteger(priority) || priority < 0 || priority > 65535) bad("priority 得是 0–65535 的整数");
  }
  if (PRIORITY_TYPES.has(type) && priority === undefined) bad(`${type} 记录必须给优先级（0 起）`);
  if (!PRIORITY_TYPES.has(type) && priority !== undefined) bad(`${type} 记录不接受 priority 字段（只有 MX / SRV 用）`);

  let proxied = false;
  if (raw.proxied !== undefined) {
    if (typeof raw.proxied !== "boolean") bad("proxied 必须是布尔值");
    proxied = raw.proxied;
  }
  if (proxied && !PROXIABLE_TYPES.has(type)) bad(`${type} 记录不能开代理（只有 A / AAAA / CNAME 可以）`);
  // CF 侧的硬规则（proxied 记录只允许自动 TTL），前端那份没判，所以这里补上：否则请求出网后才拿 400
  if (proxied && ttl !== 1) bad("已代理（橙云）的记录 TTL 必须是「自动」(1)");

  let comment: string | undefined;
  if (raw.comment !== undefined) {
    comment = textField(raw.comment, "comment");
    if (comment.length > 255) bad("comment 超过 255 字符");
  }

  return { name, type, content, ttl, proxied, ...(priority !== undefined ? { priority } : {}), ...(comment ? { comment } : {}) };
}

/** 请求体真正发给 CF 的字段集：只带 CF 认的键，多余键会 400，所以一个都不带 */
export function dnsPayload(d: DnsDraft): Record<string, unknown> {
  const body: Record<string, unknown> = { name: d.name, type: d.type, content: d.content, ttl: d.ttl, proxied: d.proxied };
  if (d.priority !== undefined) body.priority = d.priority;
  if (d.comment) body.comment = d.comment;
  return body;
}

/**
 * 把相对名落到具体 zone 上，并确认结果仍然属于这个 zone。
 * CF 收的是 FQDN；相对名（`www`）按 CF 的语义补上 zone 名，已经写成绝对名的原样保留。
 */
export function dnsNameInZone(d: DnsDraft, zoneName: string): DnsDraft {
  const z = zoneName.toLowerCase();
  const name = d.name === "@" ? z : d.name === z || d.name.endsWith("." + z) ? d.name : `${d.name}.${z}`;
  if (!(name === z || name.endsWith("." + z))) bad(`记录名 ${name} 不属于这个 zone（${z}）`);
  if (name.length > 253) bad("完整域名超过 253 字符");
  if (d.type === "CNAME" && name === d.content.replace(/\.+$/, "").toLowerCase()) bad("CNAME 不能指向自己");
  return { ...d, name };
}

/** 清缓存请求体。红线来自 docs/09 §B5：CF 对 `files:[123]` 回的是 200 并**真的执行**，所以非法值不能指望上游拦 */
export function validatePurgeBody(raw: Record<string, unknown>): string[] {
  const unknown = Object.keys(raw).filter((k) => k !== "files");
  if (unknown.length) bad(`不支持的字段：${unknown.join(",")}。清缓存这条路由只接受 files，绝不接受 purge_everything`);
  if (!Array.isArray(raw.files)) bad("files 必须是 URL 数组");
  const list = raw.files as unknown[];
  if (!list.length) bad("没有要清理的 URL。清缓存不接受空请求，也不用「全部清理」代替逐条确认");
  if (list.length > PURGE_LIMIT) bad(`一次最多 ${PURGE_LIMIT} 条 URL（现在是 ${list.length} 条）`);
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") bad(`files 只能是字符串数组（收到 ${item === null ? "null" : typeof item}）`);
    const u = item.trim();
    if (!u) bad("files 里有空 URL");
    if (u.includes("*")) bad(`URL 里不能带通配符 *：${u}`);
    if (!/^https:\/\/[^\s]+$/i.test(u)) bad(`只接受完整的 https 地址：${u}`);
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      bad(`URL 解析不过去：${u}`);
    }
    if (parsed.protocol !== "https:") bad(`只接受 https：${u}`);
    if (parsed.username || parsed.password) bad(`URL 里不能带用户名/密码：${u}`);
    if (u.includes("#")) bad(`URL 里不能带片段（#）：${u}`);
    out.push(parsed.toString());
  }
  const uniq = Array.from(new Set(out));
  if (!uniq.length) bad("没有要清理的 URL");
  return uniq;
}

/** 清缓存的 URL 必须落在这个 zone 上：否则这条请求既清不到东西，又把 zone 片段当成了访问别的域名的入口 */
export function assertPurgeHostsInZone(files: string[], zoneName: string): void {
  const z = zoneName.toLowerCase();
  for (const f of files) {
    const host = new URL(f).hostname.toLowerCase().replace(/\.+$/, "");
    if (!(host === z || host.endsWith("." + z))) bad(`URL 的主机名 ${host} 不属于这个 zone（${z}）`);
  }
}

/**
 * 通用逐页拉取：CF 的列表端点都有每页上限（/accounts 默认 20、/zones 50、dns_records 100…），
 * 单页取法在条数超限时**静默截断**，界面上毫无提示。这里按每页上限逐页拿满（在哪页断就停），
 * total 照 result_info 透传。Pages 那条有自己的怪癖（per_page>10 直接 400），仍走 pagesList。
 */
async function pagedList<T = any>(cf: CfClient, base: string, perPage: number, maxPages = 10): Promise<{ data: any[]; total?: number }> {
  const out: any[] = [];
  let total: number | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const r = await cf.rest<any[]>(`${base}${base.includes("?") ? "&" : "?"}per_page=${perPage}&page=${page}`, { unwrap: "list" });
    const items = r.data || [];
    out.push(...items);
    if (typeof r.total === "number") total = r.total;
    if (items.length < perPage) break;
  }
  return { data: out, total };
}

/**
 * Pages 的列表分页跟 REST 其它接口不是一套：
 * 实测 `per_page>10` 直接 400 `code 8000024 Invalid list options`（per_page=10/8/6 通过，12/15/20/24 拒绝），
 * 而且账号里 0 个项目，deployments 的真实信封无法确认，所以统一走 unwrap:"list"（cf.listify 兼容数组与嵌套）。
 * 这条属于 docs/09 风险 A1「Pages 全纸面」的一部分，等你建了项目要复验。
 */
async function pagesList(cf: CfClient, base: string, maxPages = 10): Promise<{ data: any[]; total?: number }> {
  const out: any[] = [];
  let total: number | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const r = await cf.rest<any[]>(`${base}?page=${page}&per_page=10`, { unwrap: "list" });
    const items = r.data || [];
    out.push(...items);
    if (typeof r.total === "number") total = r.total;
    if (items.length < 10) break;
  }
  return { data: out, total };
}

/** 只读端点表：name → 具体 CF 调用。所有列表端点都走 pagedList 逐页拿满，单页超限不再静默截断 */
export const reads = {
  account: (cf: CfClient, env: Env) => pagedList(cf, `/accounts`, 50),
  zones: (cf: CfClient, env: Env) => pagedList(cf, `/zones`, 50),
  workerScripts: (cf: CfClient, env: Env) => pagedList(cf, `/accounts/${ACC(env)}/workers/scripts`, 100),
  workerSettings: (cf: CfClient, env: Env, s: string) => cf.rest(`/accounts/${ACC(env)}/workers/scripts/${encodeURIComponent(s)}/settings`),
  /**
   * 与 `settings` 是**两条不同路由、字段几乎不重叠**（docs/08 §6.1 实测）：
   *   /settings        → compatibility_date / compatibility_flags / placement / usage_model / tags / tail_consumers
   *   /script-settings → logpush / tags / tail_consumers / observability
   * 注意 `observability` 只有后者返回，所以界面上"Observability 关闭"这种话只能来自这条，
   * 拿 /settings 的 undefined 当"关闭"是错的（本轮就是靠这条实测才发现的，docs/09 §E16）。
   */
  workerScriptSettings: (cf: CfClient, env: Env, s: string) => cf.rest(`/accounts/${ACC(env)}/workers/scripts/${encodeURIComponent(s)}/script-settings`),
  /** 脚本级 workers.dev 开关；能读到 ≠ 你的网络能访问（docs/00、docs/08 §6.1） */
  workerSubdomain: (cf: CfClient, env: Env, s: string) => cf.rest(`/accounts/${ACC(env)}/workers/scripts/${encodeURIComponent(s)}/subdomain`),
  /**
   * 账户级 workers.dev 前缀（拼 `*.<前缀>.workers.dev` 要用它）。2026-10-11 复跑实测：
   * `200 {"result":{"subdomain":"acct0501"}}` —— 这个信封里**只有 subdomain 一个字段，没有 enabled**，
   * 所以界面只能报"前缀是什么"，不能顺手写成"已启用/已关闭"（docs/09 §E16 同一类错）。
   */
  accountSubdomain: (cf: CfClient, env: Env) => cf.rest(`/accounts/${ACC(env)}/workers/subdomain`),
  /**
   * Workers 可观测性事件用量（计算页「每日额度」那条真数据）。2026-10-11 直连实测：
   * `GET /accounts/{a}/workers/observability/usage?from=<毫秒>&to=<毫秒>` → 200
   * `{"result":{"events":1457,"breakdown":[{"bin":"2026-10-10 00:00:00","dataset":"cloudflare-workers","service":"mail","count":363,"eventSize":1589317},…]}}`。
   * **参数只认 epoch 毫秒字符串**：给 ISO 报 `{"expected":"number","received":"NaN"}`，
   * 给 epoch 秒会被当毫秒解析，于是回 `from cannot be more than 90 days in the past`（这两条报错都见过，别再去试）。
   * 只给 events，**不给请求数也不给额度上限** —— 上限走公开文档值，见 index.ts 那条路由的注释。
   */
  workersUsage: (cf: CfClient, env: Env, from: number, to: number) =>
    cf.rest(`/accounts/${ACC(env)}/workers/observability/usage?from=${from}&to=${to}`),
  /**
   * Workers 今日**请求数**（不是事件数）。2026-10-11 直连实测：GraphQL 账号级数据集
   * `workersInvocationsAdaptive`（**没有 `Groups` 后缀**，跟站点口径的 `httpRequestsAdaptiveGroups` 不同名，
   * 之前 11 次探测都因为带 Groups 而 `unknown field`，见 docs/11 §14）→ 200：
   * `viewer.accounts[].workersInvocationsAdaptive[].sum = { requests, errors }`。
   * 这就是 CF 控制台 Workers 分析页那个"请求数"的同源数字，可作 100,000/日 的分子。
   * filter 只吃 ISO（`datetime_geq/lt`），跟 observability/usage 的 epoch 毫秒不同，这里自己转。
   */
  workersRequests: async (cf: CfClient, env: Env, from: number, to: number) => {
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const q = `{ viewer { accounts(filter:{accountTag:"${ACC(env)}"}) { workersInvocationsAdaptive(limit:1, filter:{datetime_geq:"${iso(from)}", datetime_lt:"${iso(to)}"}) { sum { requests errors } } } } }`;
    const d = await cf.graphql<any>(q);
    const sum = d?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0]?.sum;
    return { requests: typeof sum?.requests === "number" ? sum.requests : null, errors: typeof sum?.errors === "number" ? sum.errors : null };
  },
  /**
   * 账号订阅（只用来告诉界面"当前套餐是哪个"）。实测 200，result 是数组，套餐标识在
   * **`rate_plan.id`**（不是 camelCase 的 ratePlanId，网关注册时踩过一次）：
   * 本账号是 `free` + `beta_analytics_engine_api`。**里面没有任何配额数字**，所以 100,000/日这类
   * 上限只能引用 Cloudflare 文档，不能写成"接口返回的"（docs/09 §E16 同一类错）。
   * 原始条目还带 `client_secrets`，字段减法在 index.ts 那条路由里做。
   */
  subscriptions: (cf: CfClient, env: Env) => cf.rest(`/accounts/${ACC(env)}/subscriptions`),
  workerVersions: (cf: CfClient, env: Env, s: string, perPage = 25, page = 1) =>
    cf.rest(`/accounts/${ACC(env)}/workers/scripts/${encodeURIComponent(s)}/versions?per_page=${perPage}&page=${page}`, { unwrap: "list" }),
  workerVersion: (cf: CfClient, env: Env, s: string, v: string) =>
    cf.rest(`/accounts/${ACC(env)}/workers/scripts/${encodeURIComponent(s)}/versions/${encodeURIComponent(v)}`),
  workerDeployments: (cf: CfClient, env: Env, s: string) =>
    cf.rest(`/accounts/${ACC(env)}/workers/scripts/${encodeURIComponent(s)}/deployments?environment=production&per_page=50`, { unwrap: "list" }),
  workerSecrets: (cf: CfClient, env: Env, s: string) => cf.rest(`/accounts/${ACC(env)}/workers/scripts/${encodeURIComponent(s)}/secrets`),
  workerCrons: (cf: CfClient, env: Env, s: string) => cf.rest(`/accounts/${ACC(env)}/workers/scripts/${encodeURIComponent(s)}/schedules`),
  workerDomains: (cf: CfClient, env: Env) => pagedList(cf, `/accounts/${ACC(env)}/workers/domains`, 100),
  pagesProjects: (cf: CfClient, env: Env) => pagesList(cf, `/accounts/${ACC(env)}/pages/projects`),
  pagesDeployments: (cf: CfClient, env: Env, p: string) =>
    pagesList(cf, `/accounts/${ACC(env)}/pages/projects/${encodeURIComponent(p)}/deployments`),
  dnsRecords: (cf: CfClient, env: Env, zone: string) => pagedList(cf, `/zones/${encodeURIComponent(zone)}/dns_records`, 100, 50),
  zoneRoutes: (cf: CfClient, env: Env, zone: string) => cf.rest(`/zones/${encodeURIComponent(zone)}/workers/routes?per_page=100`, { unwrap: "list" }),
  /** D1 数据库列表：fields 来自 docs/evidence/responses.sample.json「d1/database」实测 */
  d1Databases: (cf: CfClient, env: Env) => cf.rest(`/accounts/${ACC(env)}/d1/database?per_page=100`, { unwrap: "list" }),
  /** D1 单库详情（同列表字段，多一个 updated_at） */
  d1Database: (cf: CfClient, env: Env, id: string) => cf.rest(`/accounts/${ACC(env)}/d1/database/${encodeURIComponent(id)}`),
  /** D1 SQL 查询：CF 那一头只收 POST（body 放 sql），网关对界面暴露的是 GET（见 index.ts 那条注释）。SQL 原样透传，网关不做模板注入 */
  d1Query: (cf: CfClient, env: Env, id: string, sql: string) =>
    cf.rest(`/accounts/${ACC(env)}/d1/database/${encodeURIComponent(id)}/query`, { method: "POST", body: { sql }, unwrap: "list" }),
  /** KV 命名空间列表 */
  kvNamespaces: (cf: CfClient, env: Env) => pagedList(cf, `/accounts/${ACC(env)}/storage/kv/namespaces`, 100),
  /** KV 命名空间内 keys 列表，默认 limit=100，支持 ?cursor 翻页。CF 要求 limit ≥ 10（实测 10028），这里统一夹紧 */
  kvKeys: (cf: CfClient, env: Env, nsId: string, limit = 100, cursor?: string) => {
    const q = new URLSearchParams({ limit: String(Math.min(1000, Math.max(10, Math.floor(limit)))) });
    if (cursor) q.set("cursor", cursor);
    return cf.rest(`/accounts/${ACC(env)}/storage/kv/namespaces/${encodeURIComponent(nsId)}/keys?${q.toString()}`, { unwrap: "list" });
  },
  /**
   * R2 存储桶列表（数据库屏第三段）。2026-10-11 直连实测：这个账号 `GET /accounts/{a}/r2/bucket`
   * 返回 **404 `10015 No route matches this url`**，GraphQL 侧 `viewer.accounts.r2Buckets` 也是
   * `unknown field` —— 和 `09` §A3 当年记的 `403 10042` 是同一件事的两种形状（R2 没在这账号上开通，
   * CF 换了报错口径）。路由照注册：开通后不改代码就出数，没开通时界面拿到的是 CF 原样报错，
   * 绝不能因为 404 就显示"0 个桶"（`09` §E16）。
   */
  r2Buckets: (cf: CfClient, env: Env) => pagedList(cf, `/accounts/${ACC(env)}/r2/bucket`, 100),
  /**
   * Zero Trust（Access）组织信息。2026-10-11 实测这个账号**是有 ZT 组织的**：
   * `GET /accounts/{a}/access/organizations` → 200，result 是**对象**（auth_domain / name /
   * created_at / login_design / is_ui_read_only…），所以不能 unwrap:"list"。
   * 同批实测 `400 7003` 的是 `/zerotrust/configuration` 与 `/zerotrust/rule/providers`
   * （那两个要走 ZT 的 uid/账户级新路径），别拿它们的失败当"账号没开通 Zero Trust"。
   */
  ztOrganization: (cf: CfClient, env: Env) => cf.rest(`/accounts/${ACC(env)}/access/organizations`),
  /** Access 应用 / 用户组 / 访问策略：三条都是 200 + 空数组（账号确实一条没配，不是读不到） */
  ztApps: (cf: CfClient, env: Env) => pagedList(cf, `/accounts/${ACC(env)}/access/apps`, 100),
  ztGroups: (cf: CfClient, env: Env) => pagedList(cf, `/accounts/${ACC(env)}/access/groups`, 100),
  ztPolicies: (cf: CfClient, env: Env) => pagedList(cf, `/accounts/${ACC(env)}/access/policies`, 100),
};

/* ---------- Rulesets / WAF：只读，三种失败形状必须分开 ---------- */

/**
 * 三个阶段的 entrypoint（docs/04 §8，2026-10-09 实测当前令牌即可读）。
 * 只列界面值得显示的三个；其余 phase 名实测对免费套餐是 `400 unknown phase`，没必要给 App 添噪音。
 */
export const WAF_PHASES = [
  { phase: "http_request_firewall_custom", label: "自定义规则" },
  { phase: "http_request_firewall_managed", label: "托管规则集" },
  { phase: "http_ratelimit", label: "限流规则" },
] as const;

/** 规则原文很长，字段做减法是刻意的：动作/开关/描述/expression 才是手机上要看的东西 */
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
 * 三种"没拿到规则"的形状完全不同，混在一起就会把"没配过规则"报成"你没权限"（docs/09 §E14）：
 *   200               → 有规则集，但 `rules` 仍可能是空数组
 *   404 code 10003    → 这个 phase 从没配过规则 = **正常空态**
 *   400 unknown phase → 阶段名对本套餐不成立；这个错误对象**没有 code**，只能按文案分支
 */
export async function waf(cf: CfClient, env: Env, zone: string) {
  const phases = await Promise.all(
    WAF_PHASES.map(async ({ phase, label }) => {
      try {
        const r = await cf.rest<any>(`/zones/${encodeURIComponent(zone)}/rulesets/phases/${phase}/entrypoint`);
        const res = r.data ?? {};
        const rules = Array.isArray(res.rules) ? res.rules.map(slimRule) : [];
        return { phase, label, state: "ok" as const, name: res.name || "", last_updated: res.last_updated || "", version: res.version || "", rules, note: "" };
      } catch (e) {
        if (e instanceof CfError) {
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

/* ---------- 流量：命名模板，参数只有时间窗 ---------- */

type SqlRow = Record<string, string | number | null>;

const SCOPE = (env: Env) => ({ scope: { accountTag: ACC(env) } });

export const traffic = {
  /** 首页大数字：与控制台同口径的请求总量走 1dGroups。
   *
   * 账号级字段实测（tools/probe-gql-account-fields.mjs → docs/evidence/graphql-account-fields.json）：
   *   httpRequests1dGroups.sum 只有 requests / bytes / encryptedRequests / threats；
   *   —— 带宽字段名是 **bytes**，写 bandwidth 会报 unknown field；
   *   —— 1dGroups 里没有 visits；
   *   visits 与 edgeResponseBytes 只在 httpRequestsAdaptiveGroups.sum 里（那边反过来没有 requests）。
   * 所以一次查询要拿两个数据集，别在 UI 上假装它们同源。
   */
  consoleTotals(cf: CfClient, env: Env, r: ReturnType<typeof parseRange>) {
    const q = `{ viewer { accounts(filter:{accountTag:"${ACC(env)}"}) {
      g: httpRequests1dGroups(limit:${r.days}, filter:{date_geq:"${r.dateGeq}", date_lt:"${r.dateLt}"}, orderBy:["date_ASC"]) {
        dimensions { date }
        sum { requests bytes encryptedRequests threats }
      }
      v: httpRequestsAdaptiveGroups(limit:1, filter:{datetime_geq:"${r.start}", datetime_lt:"${r.end}"}) {
        sum { visits edgeResponseBytes }
      }
    } } }`;
    return cf.graphql(q);
  },
  /** 国家分布：SQL 面没有国家列，只有这里有 */
  countries(cf: CfClient, env: Env, r: ReturnType<typeof parseRange>) {
    const q = `{ viewer { accounts(filter:{accountTag:"${ACC(env)}"}) {
      a: httpRequestsAdaptiveGroups(limit:8, filter:{datetime_geq:"${r.start}", datetime_lt:"${r.end}"}, orderBy:["count_DESC"]) {
        count dimensions { clientCountryName }
      }
    } } }`;
    return cf.graphql(q);
  },
  /**
   * 看板那三块 GraphQL 合成一条：`viewer.accounts` 是同一层，同一数据集用不同 alias 各取一次
   * 本来就合法（`consoleTotals` 里的 g/v 已经是这个写法），所以再加一个 a 只是把两次出网压成一次。
   * 字段与 `consoleTotals`/`countries` **逐字一致**，只是并到一条 query 里 ⇒ 响应形状不变，
   * overview 再把 a 拆回 countries 那张卡，前端不必知道底下并过。
   *
   * 代价（诚实记一条）：这三块现在**同生共死** —— 一条 query 失败，顶部卡片和国家分布会一起降级，
   * 不再有"只是国家那块没取到"的细分。用 `x-gw-cf-calls` 能实测出省下的那一次。
   */
  dashboard(cf: CfClient, env: Env, r: ReturnType<typeof parseRange>) {
    const q = `{ viewer { accounts(filter:{accountTag:"${ACC(env)}"}) {
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
    return cf.graphql(q);
  },

  /** 时序：SQL time_range 参数实测可用，SQL 模板固定 */
  series(cf: CfClient, env: Env, r: ReturnType<typeof parseRange>) {
    const fn = r.days <= 1 ? "toStartOfHour(timestamp)" : "toStartOfDay(timestamp)";
    const limit = r.days <= 1 ? 24 : Math.min(r.days + 1, 31);
    return cf.sql(
      "/analytics/sql",
      `SELECT ${fn} AS t, count() AS reqs, sum(edgeResponseBytes) AS bytes FROM events.httpRequests GROUP BY t ORDER BY t ASC LIMIT ${limit}`,
      { time_range: { start: r.start, end: r.end }, ...SCOPE(env) },
    );
  },
  status(cf: CfClient, env: Env, r: ReturnType<typeof parseRange>) {
    return cf.sql(
      "/analytics/sql",
      "SELECT edgeResponseStatus AS code, count() AS reqs FROM events.httpRequests GROUP BY code ORDER BY reqs DESC LIMIT 12",
      { time_range: { start: r.start, end: r.end }, ...SCOPE(env) },
    );
  },
  origin(cf: CfClient, env: Env, r: ReturnType<typeof parseRange>) {
    return cf.sql(
      "/analytics/sql",
      "SELECT originResponseStatus AS code, count() AS reqs, round(avg(originResponseDurationMs)) AS avg_ms FROM events.httpRequests WHERE originResponseStatus > 0 GROUP BY code ORDER BY reqs DESC LIMIT 12",
      { time_range: { start: r.start, end: r.end }, ...SCOPE(env) },
    );
  },
  top(cf: CfClient, env: Env, r: ReturnType<typeof parseRange>, dim: "host" | "path" | "bot") {
    // dim 只能是枚举值 —— 这就是"用户输入不进 SQL"的具体做法
    const col = dim === "host" ? "clientRequestHttpHost" : dim === "path" ? "clientRequestPath" : "verifiedBotCategory";
    return cf.sql(
      "/analytics/sql",
      `SELECT ${col} AS k, count() AS reqs FROM events.httpRequests GROUP BY k ORDER BY reqs DESC LIMIT 20`,
      { time_range: { start: r.start, end: r.end }, ...SCOPE(env) },
    );
  },
  /**
   * 缓存命中 / 设备类型：SQL 面（events.httpRequests）**没有这两列**，实测 422 Schema error，
   * 只有 GraphQL adaptive 有，且账号级可用（docs/evidence/graphql-account-fields.json）。
   * 在这里把两种信封拉平成和 top() 一样的 {rows:[{k,reqs}]}，前端就不必知道底下换了一个数据面。
   */
  async adaptiveDim(cf: CfClient, env: Env, r: ReturnType<typeof parseRange>, dim: "cache" | "device") {
    const col = dim === "cache" ? "cacheStatus" : "clientDeviceType";
    const q = `{ viewer { accounts(filter:{accountTag:"${ACC(env)}"}) {
      x: httpRequestsAdaptiveGroups(limit:8, filter:{datetime_geq:"${r.start}", datetime_lt:"${r.end}"}, orderBy:["count_DESC"]) {
        count dimensions { ${col} }
      }
    } } }`;
    const j = await cf.graphql<any>(q);
    const rows = (j?.viewer?.accounts?.[0]?.x ?? []).map((g: any) => ({ k: g.dimensions?.[col] ?? "未知", reqs: g.count }));
    return { rows, source: "graphql-adaptive", sampled: true };
  },
};

/**
 * 上一窗：把当前窗口整段往前挪 `days` 天。
 * 关键是它和 `parseRange` 用同一套 5 分钟对齐，所以同一个格子内重复请求 overview 时，
 * 这条 query 字符串与上一次**逐字相同** ⇒ 直接命中 cf.ts 的缓存层，不额外出网。
 */
export function prevWindow(r: ReturnType<typeof parseRange>): ReturnType<typeof parseRange> {
  const shift = r.days * 86400000;
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const start = new Date(Date.parse(r.start) - shift);
  const end = new Date(Date.parse(r.end) - shift);
  return {
    key: r.key,
    days: r.days,
    start: iso(start),
    end: iso(end),
    dateGeq: start.toISOString().slice(0, 10),
    dateLt: new Date(end.getTime() + 86400000).toISOString().slice(0, 10),
  };
}

export interface PrevTotals {
  reqs: number | null;
  bytes: number | null;
  visits: number | null;
  threats: number | null;
  range: string;
  error?: string;
  /** 上一窗整段落在 CF 分析数据保留期外：没查、也不该查 —— 跟 error（查了但失败）是两件事 */
  skipped?: string;
}

/**
 * CF 分析数据的保留期，本账号（免费档）实测报 "cannot request data older than 4w4d" ＝ 32 天。
 * 30d 这一档的上一窗落在 30–60 天前，整段在保留期之外 —— 那不是"取数失败"，
 * 是这段历史在 CF 那边根本不存在。所以先按保留期判掉、一次出网都不发，
 * 界面上也就不会把"根本没有的历史"染成黄色故障（docs/09 §E16 同一类口径）。
 */
const RETENTION_DAYS = 32;
const beyondRetention = (startIso: string) => Date.parse(startIso) < Date.now() - RETENTION_DAYS * 86400_000;
const retentionSkip = () => `CF 只保留最近 ${RETENTION_DAYS} 天的分析数据，上一窗整段在保留期外`;

/** 保留期类的拒绝长这样；套餐不同天数就不同，所以命中文案就认，不硬编天数 */
const isRetentionError = (msg: string) => /older than\s+\d+[wd]/i.test(msg);

const prevLabel = (p: ReturnType<typeof parseRange>) => `上一窗 ${RANGES[p.key].label}（${p.start} → ${p.end}）`;

/**
 * 环比的四个数一条 GraphQL 就够：reqs / bytes / threats 在 `httpRequests1dGroups.sum` 里，
 * visits 只在 `httpRequestsAdaptiveGroups.sum` 里 —— 就是 `traffic.consoleTotals` 已有的那两个 alias，
 * 所以这里是**一次**出网，不是把主查询再打一遍（口径与主查询一致，界面上两个数才可比）。
 */
async function prevTotals(cf: CfClient, env: Env, r: ReturnType<typeof parseRange>): Promise<PrevTotals> {
  const p = prevWindow(r);
  const base: PrevTotals = { reqs: null, bytes: null, visits: null, threats: null, range: prevLabel(p) };
  if (beyondRetention(p.start)) return { ...base, skipped: retentionSkip() };
  try {
    const j = await traffic.consoleTotals(cf, env, p);
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
    // 算了但没取到：四个字段留 null，界面上写"上一窗没取到"。缺整个 prev 才代表网关没算这个功能。
    const msg = e instanceof CfError ? e.message : String((e as Error)?.message || e);
    // 保留期被 CF 挡回来：按"没有这段历史"说，不按"取数失败"说（上面那道预判按的是实测 32 天，
    // 套餐不同天数会不一样，这里兜住差出来的那一档）
    if (isRetentionError(msg)) return { ...base, skipped: retentionSkip() };
    return { ...base, error: msg };
  }
}

/** 首页看板：**3 次** CF 请求出全部卡片（原先 4 次，国家分布那条已并进同一条 GraphQL） */
export async function overview(cf: CfClient, env: Env, range?: string) {
  const r = parseRange(range);
  const settled = await Promise.allSettled([
    traffic.dashboard(cf, env, r),
    traffic.series(cf, env, r),
    traffic.status(cf, env, r),
    prevTotals(cf, env, r),
  ]);
  const pick = <T,>(i: number, fallback: T): { value: T; error?: string; kind?: string } => {
    const s = settled[i];
    if (s.status === "fulfilled") return { value: s.value as T };
    const e = s.reason;
    return { value: fallback, error: e instanceof CfError ? e.message : String(e), kind: e instanceof CfError ? e.kind : "unknown" };
  };
  /** 一条 query 回来的三个 alias 拆回原来的两张卡（g+v 属于 consoleTotals，a 属于 countries），
   *  前端读的字段路径一个都没变（BoardView 拿 accounts[0].g / .v / countries 的 .a） */
  const merged = pick(0, null) as { value: any; error?: string; kind?: string };
  const acc = merged.value?.viewer?.accounts?.[0];
  const split = (fields: Record<string, any>) =>
    merged.error
      ? { value: null, error: merged.error, kind: merged.kind }
      : { value: { viewer: { accounts: [fields] } } };
  return {
    range: r.key,
    days: r.days,
    consoleTotals: split({ g: acc?.g, v: acc?.v }),
    series: pick(1, { rows: [] as SqlRow[] }),
    status: pick(2, { rows: [] as SqlRow[] }),
    countries: split({ a: acc?.a }),
    /**
     * 环比。界面上的三种状态分别是：
     *   整个 `prev` 缺失   → 这台网关还没这个功能（老版本）
     *   `skipped`         → 上一窗整段在 CF 保留期外，网关一条请求都没发（不是故障）
     *   某个字段是 `null` + `error` → 算了，但上一窗没取到
     *   字段是数字（含 0）  → 真值，0 就是"上一窗确实没流量"，不是"没数据"
     */
    prev:
      settled[3].status === "fulfilled"
        ? settled[3].value
        : { reqs: null, bytes: null, visits: null, threats: null, range: prevLabel(prevWindow(r)), error: String((settled[3] as PromiseRejectedResult).reason?.message ?? "上一窗统计失败") },
  };
}
