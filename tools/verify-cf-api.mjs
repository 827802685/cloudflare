#!/usr/bin/env node
/**
 * Cloudflare API 可行性验证工具 v2（只读 + 权限探测，不做任何真实变更）
 *
 * 用法：node tools/verify-cf-api.mjs [--verbose]
 * 令牌来源：环境变量 CLOUDFLARE_API_TOKEN，否则回退读 F:\work\cf-probe\app\.dev.vars / Rin\.env.local（只读不打印）
 *
 * 安全约束：
 *  - A~E 组：GET 或只读 SELECT/GraphQL 查询，不改资源。
 *  - F 组「权限探测」：payload 故意非法，服务端必拒，用来区分「无权限」与「鉴权失败」两类错误码。绝不补成合法 payload。
 *  - G 组：只列出需要明确授权才能验的写端点，不发请求。
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCreds } from "./lib/token.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(ROOT, "docs", "evidence");
const VERBOSE = process.argv.includes("--verbose");

// 凭证来源与其余探针共用同一份实现：tools/lib/token.mjs
const loadToken = loadCreds;

const { tok: TOK, acc: ACC_ENV } = loadToken();
const B = "https://api.cloudflare.com/client/v4";
const H = { authorization: "Bearer " + TOK, "content-type": "application/json" };
const results = [], raw = {}, texts = {};
let calls = 0;

async function call(group, label, path, opt = {}) {
  const url = path.startsWith("http") ? path : B + path;
  const t0 = Date.now();
  calls++;
  const rec = { group, label, method: opt.method || "GET", path: url.replace(B, ""), http: 0, ms: 0, ok: false, errCode: null, brief: "" };
  try {
    const r = await fetch(url, { headers: H, ...opt, signal: AbortSignal.timeout(30000) });
    const txt = await r.text();
    rec.http = r.status; rec.ms = Date.now() - t0;
    let j = null; try { j = JSON.parse(txt); } catch { texts[label] = txt.slice(0, 3000); }
    if (j) {
      raw[label] = j;
      rec.errCode = j.errors?.[0]?.code ?? j.code ?? null;
      rec.brief = j.errors?.length
        ? "E " + j.errors.map((e) => `${e.code ?? ""} ${e.message}`).join(" | ").slice(0, 300)
        : (j.data !== undefined ? JSON.stringify(j.data) : JSON.stringify(j.result ?? j)).slice(0, 300);
      rec.ok = r.status < 400 && j.success !== false && !j.errors?.length;
    } else if (r.status < 400) {
      rec.ok = true; rec.brief = "(非 JSON 文本，长度 " + txt.length + ") " + txt.slice(0, 120).replace(/\s+/g, " ");
    }
    if (VERBOSE) console.log(`\n[${label}] HTTP ${r.status}\n${txt.slice(0, 1500)}`);
  } catch (e) {
    rec.ms = Date.now() - t0; rec.brief = "FAIL " + (e.cause?.code || e.name) + " " + String(e.message).slice(0, 90);
  }
  results.push(rec);
  console.log(`${rec.ok ? "✔" : rec.http >= 400 && rec.http < 500 ? "•" : "✘"} [${group}] ${label.padEnd(38)} ${String(rec.http).padEnd(5)} ${String(rec.ms).padStart(5)}ms  ${rec.brief.slice(0, 140)}`);
  return raw[label] ?? null;
}

/* ---------- A 身份与资源发现 ---------- */
console.log("\n=== A 身份与资源发现 ===");
const accs = await call("A", "accounts", "/accounts");
const ACC = ACC_ENV || accs?.result?.[0]?.id;
await call("A", "user（用户级信息）", "/user");
const zones = await call("A", "zones", "/zones?per_page=20");
const ZT = zones?.result?.[0]?.id;
const scr = await call("A", "workers/scripts", `/accounts/${ACC}/workers/scripts`);
await call("A", "workers/domains", `/accounts/${ACC}/workers/domains`);
await call("A", "pages/projects", `/accounts/${ACC}/pages/projects`);
await call("A", "kv namespaces", `/accounts/${ACC}/storage/kv/namespaces`);
const d1 = await call("A", "d1/database", `/accounts/${ACC}/d1/database`);
await call("A", "r2/buckets", `/accounts/${ACC}/r2/buckets`);
await call("A", "queues", `/accounts/${ACC}/queues`);
await call("A", "analytics_engine/datasets", `/accounts/${ACC}/analytics_engine/datasets?limit=50&offset=0`);
await call("A", "engine_usage/sum", `/accounts/${ACC}/analytics/engine_usage/sum?since=2026-10-02T00:00:00Z&until=2026-10-09T00:00:00Z`);
await call("A", "turnstile sites", `/accounts/${ACC}/turnstile/widgets`);
await call("A", "email_routing 配置", `/accounts/${ACC}/email_routing/settings`);

/* ---------- B 流量分析 ---------- */
console.log("\n=== B 流量分析（只读查询）===");
const S = "2026-10-02T00:00:00Z";
const sql = (label, query, extra = {}) => call("B", label, "/analytics/sql", { method: "POST", body: JSON.stringify({ query, params: { z: ZT, s: S }, ...extra }) });
const disc = await call("B", "SQL SELECT * LIMIT 1（列名）", "/analytics/sql", { method: "POST", body: JSON.stringify({ query: "SELECT * FROM events.httpRequests WHERE zoneTag=$z AND timestamp >= $s LIMIT 1", params: { z: ZT, s: "2026-10-08T00:00:00Z" } }) });
console.log("   → 返回列: " + Object.keys(disc?.data?.[0] || {}).join(", "));
await call("B", "SQL 完整字段清单（故意用假字段触发）", "/analytics/sql", { method: "POST", body: JSON.stringify({ query: "SELECT __probe__ FROM events.httpRequests LIMIT 1", params: {} }) });
await sql("SQL 7天总量", "SELECT count() AS reqs, sum(edgeResponseBytes) AS bytes FROM events.httpRequests WHERE zoneTag=$z AND timestamp >= $s");
await sql("SQL 按天(带 LIMIT)", "SELECT toDate(timestamp) AS d, count() AS reqs FROM events.httpRequests WHERE zoneTag=$z AND timestamp >= $s GROUP BY d ORDER BY d LIMIT 31");
await sql("SQL 按小时", "SELECT toStartOfHour(timestamp) AS h, count() AS reqs FROM events.httpRequests WHERE zoneTag=$z AND timestamp >= $s GROUP BY h ORDER BY h DESC LIMIT 24");
await sql("SQL 状态码", "SELECT edgeResponseStatus, count() AS reqs FROM events.httpRequests WHERE zoneTag=$z AND timestamp >= $s GROUP BY edgeResponseStatus ORDER BY reqs DESC LIMIT 12");
await sql("SQL 源站状态码+耗时", "SELECT originResponseStatus, round(avg(originResponseDurationMs)) AS avg_ms, count() AS reqs FROM events.httpRequests WHERE zoneTag=$z AND timestamp >= $s GROUP BY originResponseStatus ORDER BY reqs DESC LIMIT 10");
await sql("SQL 主机名 top", "SELECT clientRequestHttpHost, count() AS reqs FROM events.httpRequests WHERE zoneTag=$z AND timestamp >= $s GROUP BY clientRequestHttpHost ORDER BY reqs DESC LIMIT 12");
await sql("SQL 路径 top", "SELECT clientRequestPath, count() AS reqs FROM events.httpRequests WHERE zoneTag=$z AND timestamp >= $s GROUP BY clientRequestPath ORDER BY reqs DESC LIMIT 12");
await sql("SQL UA/爬虫类别", "SELECT verifiedBotCategory, count() AS reqs FROM events.httpRequests WHERE zoneTag=$z AND timestamp >= $s GROUP BY verifiedBotCategory ORDER BY reqs DESC LIMIT 10");
await call("B", "SQL account 维度", "/analytics/sql", { method: "POST", body: JSON.stringify({ query: "SELECT count() AS reqs FROM events.httpRequests WHERE timestamp >= $s", params: { s: "2026-10-08T00:00:00Z" }, scope: { accountTag: ACC } }) });
await call("B", "GraphQL 1dGroups(date_geq)", "/graphql", { method: "POST", body: JSON.stringify({ query: '{viewer{zones(filter:{zoneTag:"' + ZT + '"}){t:httpRequests1dGroups(limit:7,filter:{date_geq:"2026-10-02",date_lt:"2026-10-10"}){dimensions{date}sum{requests}}}}}' }) });
await call("B", "GraphQL adaptive 国家分布", "/graphql", { method: "POST", body: JSON.stringify({ query: '{viewer{zones(filter:{zoneTag:"' + ZT + '"}){t:httpRequestsAdaptiveGroups(limit:8,filter:{datetime_geq:"2026-10-02T00:00:00Z",datetime_lt:"2026-10-09T23:59:59Z"},orderBy:["count_DESC"]){count dimensions{clientCountryName}}}}}' }) });
await call("B", "GraphQL adaptive 主机名+协议+状态码", "/graphql", { method: "POST", body: JSON.stringify({ query: '{viewer{zones(filter:{zoneTag:"' + ZT + '"}){t:httpRequestsAdaptiveGroups(limit:5,filter:{datetime_geq:"2026-10-02T00:00:00Z"}){count dimensions{clientRequestHTTPHost clientRequestHTTPProtocol edgeResponseStatus clientRequestHTTPMethodName}}}}}' }) });

/* ---------- C Workers 版本/部署（脚本名在 id 字段） ---------- */
console.log("\n=== C Workers 版本/部署 ===");
const items = (scr?.result || []).map((x) => ({ id: x.id, tag: x.tag }));
console.log("   Worker 列表(id/tag): " + items.map((i) => i.id).join(", "));
const S1 = items.find((i) => i.id === "rin-server")?.id || items[0]?.id;
console.log("   样本脚本: " + S1);
const P = `/accounts/${ACC}/workers/scripts/${S1}`;
await call("C", "scripts/{s}/settings", `${P}/settings`);
const vl = await call("C", "scripts/{s}/versions", `${P}/versions?per_page=5`);
await call("C", "versions?deployable=true", `${P}/versions?deployable=true&per_page=5`);
await call("C", "versions 第2页(验 result_info)", `${P}/versions?page=2&per_page=3`);
const V1 = vl?.result?.items?.[0]?.id ?? vl?.result?.[0]?.id ?? vl?.items?.[0]?.id;
await call("C", "versions/{v} 详情", `${P}/versions/${V1}`);
await call("C", "versions/{v}/settings（后缀被忽略，同 {v}）", `${P}/versions/${V1}/settings`);
await call("C", "deployments 当前生产配比", `${P}/deployments`);
await call("C", "deployments?environment=production", `${P}/deployments?environment=production&per_page=50`);
await call("C", "scripts/{s} 整包下载(multipart)", `${P}`);
await call("C", "scripts/{s}/secrets 环境变量", `${P}/secrets`);
await call("C", "scripts/{s}/schedules cron", `${P}/schedules`);
await call("C", "scripts/{s}/content 代码下载(预期405)", `${P}/content?environment=production`);
await call("C", "subdomain 是否开启", `/accounts/${ACC}/workers/subdomain`);
await call("C", "tail 端点存在性", `/accounts/${ACC}/workers/tails?per_page=5`);

/* ---------- D 域名与站点 ---------- */
console.log("\n=== D 自定义域名 / Zone 设置 ===");
const doms = raw["workers/domains"]?.result || [];
if (doms[0]) await call("D", "workers/domains/{id}", `/accounts/${ACC}/workers/domains/${doms[0].id}`);
await call("D", "zones/{id}", `/zones/${ZT}`);
await call("D", "zones/{id}/settings(56项)", `/zones/${ZT}/settings`);
await call("D", "zones/{id}/dns_records", `/zones/${ZT}/dns_records?per_page=50`);
await call("D", "dns_records/export(zone 文件)", `/zones/${ZT}/dns_records/export`);
await call("D", "ssl/universal/settings", `/zones/${ZT}/ssl/universal/settings`);
await call("D", "custom_hostnames(SaaS)", `/zones/${ZT}/custom_hostnames`);
await call("D", "zones/{id}/workers/routes", `/zones/${ZT}/workers/routes`);
await call("D", "old analytics/report", `/zones/${ZT}/analytics/report?since=2026-10-08T00:00:00Z`);

/* ---------- E 端点存在性（假对象名） ---------- */
console.log("\n=== E 端点存在性 ===");
await call("E", "pages deployments（假项目）", `/accounts/${ACC}/pages/projects/__nope__/deployments`);
await call("E", "pages rollback（假项目）", `/accounts/${ACC}/pages/projects/__nope__/deployments/x/rollback`, { method: "POST" });
await call("E", "pages domains（假项目）", `/accounts/${ACC}/pages/projects/__nope__/domains`);
await call("E", "d1 query（真库只读）", `/accounts/${ACC}/d1/database/${(d1?.result || [])[0]?.uuid}/query`, { method: "POST", body: JSON.stringify({ sql: "SELECT 1 AS probe" }) });

/* ---------- F 写权限探测：payload 必被拒 ---------- */
console.log("\n=== F 写权限探测（非法 payload）===");
await call("F", "DNS 写 POST(缺字段)", `/zones/${ZT}/dns_records`, { method: "POST", body: JSON.stringify({ type: "TXT" }) });
await call("F", "域名绑定 PUT(非法域名)", `/accounts/${ACC}/workers/domains`, { method: "PUT", body: JSON.stringify({ hostname: "nope.invalid-tld", service: S1 }) });
await call("F", "版本切换 POST(空 versions)", `${P}/deployments`, { method: "POST", body: "{}" });
await call("F", "版本上传 POST(非 multipart)", `${P}/versions`, { method: "POST", body: "{}" });
await call("F", "secrets 写 POST(空 body)", `${P}/secrets`, { method: "POST", body: "{}" });
await call("F", "schedules 写 PUT(空)", `${P}/schedules`, { method: "PUT", body: "{}" });
await call("F", "cache purge POST(files:[123])", `/zones/${ZT}/purge_cache`, { method: "POST", body: JSON.stringify({ purge_everything: false, files: ["123"] }) });
await call("F", "kv 键写 PUT(缺值)", `/accounts/${ACC}/storage/kv/namespaces/${raw["kv namespaces"]?.result?.[0]?.id}/keys/probe`, { method: "PUT", body: "" });
try {
  const r = await fetch(B + "/accounts", { headers: { authorization: "Bearer cfat_00000000000000000000000000000000" } });
  console.log(`✘ [F] ${"控制组：坏令牌".padEnd(38)} ${String(r.status).padEnd(5)}   ${(await r.text()).slice(0, 140)}`);
} catch (e) { /* ignore */ }

console.log("\n=== G 需要明确授权才能验的真实写操作（本工具不发请求）===");
["上传新 Worker 版本(multipart)", "把某版本部署到 100%（回滚/灰度）", "PUT 绑定自定义域名（会建 DNS + 签 Advanced Certificate）",
 "Pages 部署 rollback", "purge_cache 真实清理", "创建 Workers Tail 并连 wss", "D1 执行写 SQL", "KV/R2 真实写入"].forEach((t) => console.log("   · " + t));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, "api-verification.json"), JSON.stringify({ ran_at: new Date().toISOString(), calls, results }, null, 2));
writeFileSync(resolve(OUT_DIR, "responses.sample.json"), JSON.stringify(raw, null, 2));
writeFileSync(resolve(OUT_DIR, "text-responses.json"), JSON.stringify(texts, null, 2));
const st = results.reduce((a, r) => { a[r.ok ? "ok" : r.http >= 400 && r.http < 500 ? "rejected" : "bad"] = (a[r.ok ? "ok" : r.http >= 400 && r.http < 500 ? "rejected" : "bad"] || 0) + 1; return a; }, {});
console.log(`\n合计 ${calls} 次请求：成功 ${st.ok || 0} · 4xx 有明确语义 ${st.rejected || 0} · 异常 ${st.bad || 0}`);
console.log("证据：docs/evidence/{api-verification.json, responses.sample.json, text-responses.json}");
