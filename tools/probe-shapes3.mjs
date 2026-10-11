// 第三轮定向探测：GraphQL 字段名（含内省）、SQL 可查表清单、Workers 版本/下载真实形状
// 只读，不打印令牌。结果写 docs/evidence/probe3.json
import { writeFileSync } from "node:fs";
import { loadCreds } from "./lib/token.mjs";

const { tok: TOK, acc: ACC } = loadCreds();
const H = { authorization: "Bearer " + TOK, "content-type": "application/json" };
const B = "https://api.cloudflare.com/client/v4";
const W = "/accounts/" + ACC + "/workers/scripts/rin-server";
const VER = "e0b67a07-8532-4843-b2ff-f27029fc135b";
const SINCE = "2026-10-02T00:00:00Z";
const UNTIL = "2026-10-09T23:59:59Z";
const out = {};

async function sql(label, query, params) {
  try {
    const r = await fetch(B + "/analytics/sql", { method: "POST", headers: H, body: JSON.stringify({ query, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    let brief = t.slice(0, 150).replace(/\s+/g, " ");
    try { const j = JSON.parse(t); if (j.data) brief = JSON.stringify(j.data).slice(0, 150); } catch {}
    console.log("SQL " + label.padEnd(30), r.status, brief.slice(0, 140));
    out["sql:" + label] = { status: r.status, body: t.slice(0, 4000) };
  } catch (e) { console.log("SQL " + label.padEnd(30), "FAIL", e.cause?.code || e.message); }
}
async function gql(label, query) {
  try {
    const r = await fetch(B + "/graphql", { method: "POST", headers: H, body: JSON.stringify({ query }), signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    const j = JSON.parse(t);
    const msg = j.errors ? j.errors.map((x) => x.message).join("|").slice(0, 120) : "OK " + JSON.stringify(j.data).slice(0, 120);
    console.log("GQL " + label.padEnd(30), r.status, msg);
    out["gql:" + label] = { status: r.status, body: t.slice(0, 4000) };
    return j;
  } catch (e) { console.log("GQL " + label.padEnd(30), "FAIL", e.cause?.code || e.message); }
}
async function get(label, path) {
  try {
    const r = await fetch(B + path, { headers: H, signal: AbortSignal.timeout(25000) });
    const ct = r.headers.get("content-type") || "";
    const t = await r.text();
    let brief = ct.slice(0, 40) + " len=" + t.length;
    try { const j = JSON.parse(t); brief += " keys=" + (j.result ? Object.keys(j.result).slice(0, 10).join(",") : t.slice(0, 80)); } catch { brief += " head=" + t.slice(0, 60).replace(/\s+/g, " "); }
    console.log("GET " + label.padEnd(30), r.status, brief.slice(0, 150));
    out["get:" + label] = { status: r.status, contentType: ct, len: t.length, body: t.slice(0, 6000) };
  } catch (e) { console.log("GET " + label.padEnd(30), "FAIL", e.cause?.code || e.message); }
}

const zr = await fetch(B + "/zones?per_page=5", { headers: H }).then((x) => x.json());
const ZT = zr.result?.[0]?.id;
console.log("zoneTag =", ZT);

console.log("\n=== A. GraphQL 内省是否可用 ===");
await gql("内省 __schema", "{__schema{queryFields{name type{name kind}}}}");

console.log("\n=== B. httpRequestsAdaptiveGroups 维度字段候选 ===");
for (const f of ["clientCountryName", "countryName", "clientRequestHTTPHost", "clientRequestHTTPProtocol", "edgeCacheStatus", "cdnCacheStatus", "edgeResponseStatus", "clientASNDescription", "contentType", "httpVersion"]) {
  await gql("dim " + f, '{viewer{zones(filter:{zoneTag:"' + ZT + '"}){x:httpRequestsAdaptiveGroups(limit:2,filter:{datetime_geq:"' + SINCE + '",datetime_lt:"' + UNTIL + '"}){count dimensions{' + f + "}}}}}");
}
console.log("\n=== C. httpRequestsAdaptiveGroups 聚合字段候选 ===");
for (const f of ["requests", "byte", "visits", "uniqueVisitors", "savedBytes", "indexedBytes", "threatEvents", "originErrors", "totalTimeToFirstByteMs"]) {
  await gql("sum " + f, '{viewer{zones(filter:{zoneTag:"' + ZT + '"}){x:httpRequestsAdaptiveGroups(limit:1,filter:{datetime_geq:"' + SINCE + '",datetime_lt:"' + UNTIL + '"}){sum{' + f + "}}}}}");
}
console.log("\n=== D. 1d/1h 汇总集的 filter 参数候选 ===");
for (const arg of ['datetime_geq:"' + SINCE + '"', 'date_geq:"2026-10-02"', 'datetimeMin:"' + SINCE + '"']) {
  await gql("1dGroups " + arg.slice(0, 14), '{viewer{zones(filter:{zoneTag:"' + ZT + '"}){x:httpRequests1dGroups(limit:2,filter:{' + arg + '}){sum{requests}}}}}');
}
await gql("zone 顶层可用集", '{viewer{zones(filter:{zoneTag:"' + ZT + '"}){httpRequests1mGroups(limit:1){sum{requests}}}}}');

console.log("\n=== E. SQL 可查表枚举（非法列逼出字段/表不存在）===");
for (const t of ["events.httpRequests", "events.httpRequestsAdaptive", "events.workers", "events.workerUsage", "events.engineUsage", "events.cache", "events.caches", "metrics.httpRequests", "analytics.httpRequests", "events.auditEvents", "events.zoneAnalytics"]) {
  await sql("table " + t.split(".").pop(), "SELECT __bogus__ FROM " + t + " LIMIT 1");
}
await sql("SHOW TABLES", "SHOW TABLES");
await sql("information_schema", "SELECT table_name FROM information_schema.tables LIMIT 50");

console.log("\n=== F. Workers 版本/下载真实形状 ===");
await get("versions/{v}", W + "/versions/" + VER);
await get("versions/{v}/content", W + "/versions/" + VER + "/content");
await get("versions/{bogus}/content", W + "/versions/deadbeef-0000-0000-0000-000000000000/content");
await get("scripts/{s} 下载", W);
await get("scripts/{s}/download", W + "/download");
await get("scripts/{s}?environment", W + "?environment=production");
await get("versions 列表项字段", W + "/versions?per_page=3");
await get("deployments/{id}", W + "/deployments?per_page=2");
await get("workers/domains/{id}", "/accounts/" + ACC + "/workers/domains?per_page=1");

writeFileSync("docs/evidence/probe3.json", JSON.stringify(out, null, 2));
console.log("\n已写入 docs/evidence/probe3.json");
