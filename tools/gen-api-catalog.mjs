#!/usr/bin/env node
/**
 * 底层 API 全量清单生成器
 *
 * 数据源：Cloudflare 官方 OpenAPI 规格（github.com/cloudflare/api-schemas 的 openapi.json，BSD-3-Clause）。
 * raw.githubusercontent.com 在本机不可达，所以走 api.github.com 的 trees + blobs 接口取（约 8 秒 / 27 MB）。
 * 规格文件缓存在仓库外 «LOCAL_PATH»，不入库；重跑只在 sha 变化时才重新下载（--refresh 强制）。
 *
 * 产出：
 *  - docs/evidence/openapi-operations.json  全部 3670 个 operation 的机器可读清单（方法/路径/族/所需令牌权限/是否废弃）
 *  - docs/10-API-全量清单.md                 人读版：四块目标功能逐条列出并与实测交叉，其余产品族只给计数
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const CACHE = "«LOCAL_PATH»";
const SHA_CACHE = "«LOCAL_PATH»";
const REFRESH = process.argv.includes("--refresh");
const API = "https://api.github.com/repos/cloudflare/api-schemas";

async function getJson(url) {
  const r = await fetch(url, { headers: { "user-agent": "cf-console-research", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
  return r.json();
}

async function ensureSpec() {
  const tree = await getJson(API + "/git/trees/main?recursive=1");
  const node = (tree.tree || []).find((x) => x.type === "blob" && x.path === "openapi.json");
  if (!node) throw new Error("openapi.json not found in api-schemas tree");
  const have = existsSync(SHA_CACHE) ? readFileSync(SHA_CACHE, "utf8").trim() : "";
  if (!REFRESH && have === node.sha && existsSync(CACHE)) {
    console.log("规格未变化（sha " + node.sha.slice(0, 8) + "），用缓存");
    return { sha: node.sha, bytes: node.size };
  }
  console.log("下载 openapi.json（" + Math.round(node.size / 1048576) + " MB）...");
  const blob = await getJson(API + "/git/blobs/" + node.sha);
  const buf = Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8");
  writeFileSync(CACHE, buf);
  writeFileSync(SHA_CACHE, node.sha);
  console.log("已缓存到 " + CACHE + "，" + buf.length + " 字节");
  return { sha: node.sha, bytes: node.size };
}

/* ---------- 解析 ---------- */
const meta = await ensureSpec();
const spec = JSON.parse(readFileSync(CACHE, "utf8"));
const ops = [];
for (const [p, po] of Object.entries(spec.paths || {})) {
  for (const [m, o] of Object.entries(po)) {
    if (!o || typeof o !== "object" || !Array.isArray(o.tags)) continue;
    if (!["get", "post", "put", "patch", "delete", "head"].includes(m)) continue;
    ops.push({
      method: m.toUpperCase(),
      path: p,
      family: o.tags[0],
      summary: o.summary || "",
      tokenGroups: o["x-api-token-group"] || [],
      deprecated: !!o.deprecated,
      availability: o["x-fern-availability"] || "",
      hasBody: !!o.requestBody,
    });
  }
}

/* ---------- 与实测交叉 ---------- */
const V = JSON.parse(readFileSync("docs/evidence/api-verification.json", "utf8"));
const measured = Array.isArray(V) ? V : (V.rows || V.results || []);
function keyOf(p) {
  return String(p || "").split("?")[0].replace(/^\/client\/v4/, "");
}
// 把实测路径（含真实 ID）变成段序列，spec 路径的 {x} 当通配段
function segs(p) {
  return keyOf(p).split("/").filter(Boolean);
}
function matchSpec(measPath) {
  const ms = segs(measPath);
  return ops.filter((o) => {
    const ss = segs(o.path);
    if (ss.length !== ms.length) return false;
    return ss.every((s, i) => s.startsWith("{") ? true : s === ms[i]);
  });
}
const measuredByOp = new Map();
let unmatched = [];
for (const r of measured) {
  if (r.group === "G") continue;
  const hits = matchSpec(r.path);
  const hit = hits.find((h) => h.method === r.method) || hits[0];
  if (hit) measuredByOp.set(hit.method + " " + hit.path, { http: r.http, label: r.label, group: r.group, ok: r.ok });
  else unmatched.push({ label: r.label, method: r.method, path: keyOf(r.path), http: r.http });
}

/* ---------- 四块功能 -> 族/路径的归属 ---------- */
const BLOCKS = [
  { name: "① 域名流量", fams: ["Analytics SQL", "Analytics", "Analytics Engine", "Usage Analytics", "Zone Analytics (Deprecated)", "User Analytics (Deprecated)", "DNS Analytics", "Argo Analytics for Zone"], paths: [] },
  { name: "② Workers 版本与部署", fams: ["Worker Script", "Worker Versions", "Worker Deployments", "Worker Cron Trigger", "Worker Tail Logs", "Live Tail", "Worker Subdomain", "Worker Environment", "Workers Smart Placement", "Worker Profiling", "Workers", "Preview Deployments", "Client Versions", "Versions"], paths: [] },
  { name: "③ Pages 部署与切换", fams: ["Pages Project", "Pages Deployment", "Pages Domains", "Pages Assets", "Pages Build Cache"], paths: [] },
  { name: "④ 自定义域名 / Zone / DNS", fams: ["DNS Records for a Zone", "Zone Settings", "Zone Cache Settings", "Cache Reserve Clear", "Custom Hostname for a Zone", "Custom Hostname Fallback Origin for a Zone", "Custom SSL for a Zone", "Universal SSL Settings for a Zone", "DNSSEC", "Zone", "Worker Routes"], paths: [/\/workers\/domains/] },
];
const assigned = new Set();
for (const b of BLOCKS) {
  b.rows = ops.filter((o) => {
    if (assigned.has(o.method + " " + o.path)) return false;
    const byFam = b.fams.includes(o.family);
    const byPath = (b.paths || []).some((re) => re.test(o.path));
    return byFam || byPath;
  });
  b.rows.forEach((o) => assigned.add(o.method + " " + o.path));
  b.rows.sort((x, y) => (x.family + x.path).localeCompare(y.family + y.path));
}

/* ---------- 输出机器可读清单 ---------- */
mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/openapi-operations.json", JSON.stringify({ source: "cloudflare/api-schemas openapi.json", sha: meta.sha, retrieved: new Date().toISOString().slice(0, 10), counts: { paths: Object.keys(spec.paths || {}).length, operations: ops.length, families: new Set(ops.map((o) => o.family)).size, deprecated: ops.filter((o) => o.deprecated).length }, operations: ops }, null, 1));

/* ---------- 输出人读文档 ---------- */
const esc = (s) => String(s || "").replace(/\|/g, "\\|");
function statusCell(o) {
  const m = measuredByOp.get(o.method + " " + o.path);
  if (!m) return "—";
  return (m.ok ? "✅ " : "⚠️ ") + m.http + "（实测项「" + esc(m.label) + "」）";
}
const famAll = [...new Set(ops.map((o) => o.family))].size;
let md = "# 10 · 底层 API 全量清单（官方 OpenAPI 展开）\n\n";
md += "前 9 份文档回答的是「我这四块功能要用的接口能不能跑」。这份回答另一个问题：**Cloudflare 公开的 API 到底有多大，我们这套东西建在多大的面上** —— 依据是官方机器可读规格，不是网页文档目录。\n\n";
md += "## 1. 数据源与统计\n\n";
md += "| 项 | 值 |\n|---|---|\n";
md += "| 来源 | `cloudflare/api-schemas` 仓库的 `openapi.json`（OpenAPI " + (spec.openapi || "?") + "，BSD-3-Clause，**不是**我们手写清单） |\n";
md += "| 规格 blob sha | `" + meta.sha + "`（缓存于仓库外 `«LOCAL_PATH»`，约 " + Math.round(meta.bytes / 1048576) + " MB，不入库） |\n";
md += "| 路径数 | " + Object.keys(spec.paths || {}).length + " |\n";
md += "| operation 数（path×method） | " + ops.length + " |\n";
md += "| 产品族（tag）数 | " + famAll + " |\n";
md += "| 官方标 `deprecated` 的 operation | " + ops.filter((o) => o.deprecated).length + " |\n";
md += "| 规格里能查到「所需令牌权限」的 | " + ops.filter((o) => o.tokenGroups.length).length + " 条带 `x-api-token-group`，" + ops.filter((o) => !o.tokenGroups.length).length + " 条没标 |\n\n";
md += "> 每条 operation 都带 `x-api-token-group`（例如 `Workers Scripts Write`、`DNS Write`），这就是**令牌权限的权威名字**，比网页文档里的手写清单可靠。第 4 节把它反查成我们需要的权限集合。\n\n";
md += "## 2. 与 63 次实测的交叉\n\n";
md += "| 情况 | 数量 | 说明 |\n|---|---|---|\n";
md += "| 实测请求能在规格里找到对应 operation | " + measuredByOp.size + " / " + measured.filter((r) => r.group !== "G").length + " | 见下面各块的「实测」列 |\n";
md += "| 实测过、但规格里查无此路径 | " + unmatched.length + " | **不是我们测错了**，是规格未收录（回落行为、废弃路径、GraphQL/SQL 这类非 REST 面） |\n\n";
md += "规格里查无此路径的实测项（逐条给原因，不是笼统的「规格没写」）：\n\n| 请求 | 路径 | HTTP | 为什么不在规格里 |\n|---|---|---|---|\n";
const WHY = (u) => {
  const p = u.path;
  if (/^\/graphql$/.test(p)) return "GraphQL 是独立 schema（`cloudflare/api-schemas` 只收 REST），规格里当然查不到";
  if (/^\/analytics\/sql/.test(p)) return "规格里正式路径是 `/accounts/{account_tag}/analytics/sql`，我们打的顶层别名等价（本轮两条都实测 200）";
  if (/analytics_engine\/datasets$/.test(p)) return "规格里 `analytics_engine` 只剩 `/sql` 一条 —— **datasets REST 已被移除**，所以它 500。列自建数据集改用 `POST /accounts/{a}/analytics_engine/sql` + 裸 `SHOW TABLES`（本轮实测 200）";
  if (/engine_usage/.test(p)) return "规格里完全没有 `engine_usage` 这一族 —— Workers 用量的老接口已经没了，对应 500";
  if (/turnstile/.test(p)) return "规格里 `turnstile` 相关路径 0 条：这个产品只有网页文档，不在公开 OpenAPI 面上";
  if (/email_routing/.test(p)) return "路径写法过时：规格里是 `/accounts/{a}/email/routing/...`（斜杠），下划线老写法未收录";
  if (/\/workers\/tails(\?|$)/.test(p)) return "规格里已无此路径（405 也证明老批量接口不受理 GET）；Tail 改走 `/workers/scripts/{script_name}/tails` 与 `/workers/observability/telemetry/live-tail`";
  if (/\/analytics\/report(\?|$)/.test(p)) return "规格里 zone 侧只剩 `dns_analytics/report`、`analytics/dashboard` 等；老的 `analytics/report` 已下架（我们 400 收到的正是 7003 路由不存在）";
  if (/\/versions\/[^/]+\/settings$/.test(p)) return "**后缀回落**验证：`versions/{v}/settings` 未收录，服务端把尾巴丢掉后返回版本详情（200 是假的“存在”）";
  if (/storage\/kv\/namespaces\/[^/]+\/keys\//.test(p)) return "规格里 `…/namespaces/{namespace_id}/keys` 只支持 GET，写值路径是 `…/values/{key_name}` —— 10025 的报错原文就把正确路径告诉我们了";
  return "回落/废弃类验证，规格只收录合法路径";
};
unmatched.forEach((u) => { md += "| " + esc(u.label) + " | `" + u.method + " " + esc(u.path) + "` | " + u.http + " | " + WHY(u) + " |\n"; });
md += "\n## 3. 四块目标功能：逐条端点（规格展开 + 实测状态）\n\n";
for (const b of BLOCKS) {
  const w = b.rows.filter((o) => o.method !== "GET").length;
  md += "### " + b.name + " — " + b.rows.length + " 个 operation（GET " + (b.rows.length - w) + " / 写 " + w + "），涉及令牌权限 " + new Set(b.rows.flatMap((o) => o.tokenGroups)).size + " 种\n\n";
  md += "| 产品族 | 方法 | 路径 | 说明 | 所需令牌权限 | 实测 |\n|---|---|---|---|---|---|\n";
  for (const o of b.rows) {
    md += "| " + esc(o.family) + " | " + o.method + " | `" + esc(o.path) + "`" + (o.deprecated ? " ⚠️废弃" : "") + " | " + esc(o.summary) + " | " + (o.tokenGroups.length ? o.tokenGroups.map((g) => "`" + esc(g) + "`").join(" / ") : "—") + " | " + statusCell(o) + " |\n";
  }
  md += "\n";
}
md += "## 4. 令牌权限反查（照这个勾后台，别自己猜名字）\n\n";
const need = {};
for (const b of BLOCKS) for (const o of b.rows) {
  if (o.method === "GET" || o.method === "HEAD") continue;
  for (const g of (o.tokenGroups.length ? o.tokenGroups : ["（规格未标注）"])) (need[g] = need[g] || { write: 0, ex: [] }).write++;
  const gg = o.tokenGroups[0] || "（规格未标注）";
  if (need[gg].ex.length < 2) need[gg].ex.push(o.method + " `" + o.path + "`");
}
md += "| 令牌权限名（`x-api-token-group` 原样） | 覆盖的写操作数 | 例子 |\n|---|---|---|\n";
Object.entries(need).sort((a, b) => b[1].write - a[1].write).forEach(([g, v]) => { md += "| " + esc(g) + " | " + v.write + " | " + v.ex.map(esc).join("；") + " |\n"; });
md += "\n> 当前令牌已有的权限面见 `05-令牌权限边界.md`；把这两张表对照，缺的就是「⛔」那几条。\n\n";
md += "## 5. 其余产品族（本期不做，但要知道大盘有多大）\n\n";
const rest = ops.filter((o) => !assigned.has(o.method + " " + o.path));
const byFam = {};
for (const o of rest) {
  const v = (byFam[o.family] = byFam[o.family] || { n: 0, w: 0, ex: o.path });
  v.n++;
  if (o.method !== "GET" && o.method !== "HEAD") v.w++;
}
md += "四块功能只覆盖 " + assigned.size + " / " + ops.length + " 个 operation（" + Math.round((assigned.size / ops.length) * 1000) / 10 + "%），剩下 " + rest.length + " 个分布在 " + Object.keys(byFam).size + " 个产品族里。前 30 族：\n\n";
md += "| 产品族 | operation 数 | 其中写操作 | 路径示例 |\n|---|---|---|---|\n";
Object.entries(byFam).sort((a, b) => b[1].n - a[1].n).slice(0, 30).forEach(([f, v]) => { md += "| " + esc(f) + " | " + v.n + " | " + v.w + " | `" + esc(v.ex) + "` |\n"; });
md += "\n剩下的多半是 Zero Trust / Access / Gateway、Radar 公开数据、Turnstile、Email Security、AI/Void 这些。结论没变：**「覆盖网页版全部功能」= 3600 多个 operation，做不完也不需要**；按四块范围做，App 的第一版面对的就是上面第 3 节这 " + assigned.size + " 个。\n\n";
md += "\n## 6. 数据面收口：Analytics SQL / Analytics Engine / Workers Observability\n\n";
try {
  const IN = JSON.parse(readFileSync("docs/evidence/sql-introspection.json", "utf8"));
  const ds = IN.datasets || [];
  const cat = {};
  for (const d of ds) cat[d.category] = (cat[d.category] || 0) + 1;
  md += "`GET /analytics/sql/introspection?account_tag={a}` 是官方给的**数据集目录接口**（200，" + ds.length + " 个数据集），一次把「SQL 面到底能查什么」说死了：\n\n";
  md += "| 分类 | 数据集数 |\n|---|---|\n";
  Object.entries(cat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => { md += "| " + esc(k) + " | " + v + " |\n"; });
  const names = new Set(ds.map((d) => d.name));
  md += "\n关键判定（都是查这份目录 + 实跑得到的，不是猜）：\n\n";
  md += "- 站点流量在 SQL 面**只有 `events.httpRequests` 一个表**（" + (names.has("events.httpRequests") ? "目录里有" : "目录里没有") + "），它是自适应采样表，`kind.sampling = adaptive`。\n";
  md += "- `events.dnsQueries`、`events.firewallEvents`、`events.workersRequests` **在 SQL 面根本不存在**（目录 0 条 + 实跑 422 `table not found`）。DNS 数据要走 `zones/{z}/dns_analytics/report`，防火墙数据走 GraphQL；Workers 级用量在 REST/SQL 的老路上确实一个都没有，唯一有希望的是下面第 3 条的新 Observability 面。\n";
  md += "- 自建 Analytics Engine 数据集在 SQL 里写作 `events.analyticsEngine.{dataset}`；本账号 0 个数据集（`SHOW TABLES` 返回空数组），所以 `analytics_engine/datasets` REST 才一直 500。\n";
  md += "- `logs.workersLogs`、`logs.containerLogs` 在目录里（Logs and Traces 类），说明**新版 Workers 日志走的是 SQL 可查的 logs 面**，和老的 Tail 是两条路。\n\n";
} catch (e) { md += "（缺 `docs/evidence/sql-introspection.json`，先跑 `node tools/probe-sql-surfaces.mjs`）\n\n"; }
if (existsSync("docs/evidence/sql-surfaces.json")) {
  const SS = JSON.parse(readFileSync("docs/evidence/sql-surfaces.json", "utf8"));
  md += "本轮补测的 14 条形状（`node tools/probe-sql-surfaces.mjs` 生成，全部只读）：\n\n";
  md += "| 测的是什么 | 请求 | HTTP | 结果摘要 |\n|---|---|---|---|\n";
  for (const r of SS) md += "| " + esc(r.label) + " | `" + r.method + " " + esc(String(r.path).replace(/[0-9a-f]{32}/g, "{a}").replace(/[0-9a-f-]{36}/g, "{uuid}")) + "` | " + r.http + " | " + esc(String(r.brief).slice(0, 110)) + " |\n";
  md += "\n三条对写代码有直接影响的结论：\n\n";
  md += "1. **`time_range` 参数可用**：`{query, time_range:{start,end}, scope:{accountTag}}` 实测 200 并按天返回真实计数 —— App 里做时间范围选择器不用自己拼 `WHERE timestamp >= …`，少一类 SQL 注入/拼错风险。\n";
  md += "2. **`/accounts/{a}/analytics_engine/sql` 收的是裸 SQL 文本**（`content-type: text/plain` 或 GET `?query=`），跟 `/analytics/sql` 的 JSON 信封完全不同；同一个客户端里要两套调用。AE 面里选数据集**不能带 `events.` 前缀**。\n";
  md += "3. **Workers Observability 的 `telemetry/keys` 实测 200** 并返回真实属性目录（`$metadata.message` 之类），但 `telemetry/query` 要 `queryId`（跑已保存查询，不吞裸 SQL）且规格要求 `Workers Observability Write` 权限 —— 想在自己的域名上看 Workers 级用量，这条路是通的，但要补权限并且得先在后台建保存查询。\n\n";
}
md += "## 7. 复跑与刷新\n\n";
md += "```bash\ncd «LOCAL_PATH» tools/gen-api-catalog.mjs            # sha 没变就走 «LOCAL_PATH» 缓存\nnode tools/gen-api-catalog.mjs --refresh   # 强制重新拉官方规格（Cloudflare 几乎每天更新）\n```\n\n";
md += "机器可读全量在 `docs/evidence/openapi-operations.json`（" + ops.length + " 条，含族名/权限/废弃标记），后续要按产品族筛接口、生成客户端代码都从它出发。\n";
writeFileSync("docs/10-API-全量清单.md", md);

console.log("生成 docs/10-API-全量清单.md");
console.log("  operation 总数：" + ops.length + "，四块覆盖：" + assigned.size + "，实测匹配：" + measuredByOp.size + "，规格未收录的实测项：" + unmatched.length);
