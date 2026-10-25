// 第五轮：路由/Workers 用量/1dGroups 聚合/AE 数据集 剩余形状
// 只读，不打印令牌。结果写 docs/evidence/probe5.json
import { writeFileSync } from "node:fs";
import { loadCreds } from "./lib/token.mjs";

const { tok: TOK, acc: ACC } = loadCreds();
const H = { authorization: "Bearer " + TOK, "content-type": "application/json" };
const B = "https://api.cloudflare.com/client/v4";
const out = {};
const SINCE = "2026-10-08T00:00:00Z";
const UNTIL = "2026-10-09T23:59:59Z";

const zr = await fetch(B + "/zones?per_page=5", { headers: H }).then((x) => x.json());
const ZT = zr.result?.[0]?.id;

async function api(label, path, opt) {
  try {
    const r = await fetch(B + path, { headers: H, ...(opt || {}), signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    let brief;
    try { const j = JSON.parse(t); brief = (j.errors?.length ? "E " + j.errors.map((x) => (x.code ?? "") + " " + x.message).join("|") : JSON.stringify(j.result ?? j).slice(0, 120)); } catch { brief = t.slice(0, 120).replace(/\s+/g, " "); }
    console.log(label.padEnd(40), r.status, String(brief).slice(0, 130));
    out[label] = { path, status: r.status, body: t.slice(0, 3000) };
  } catch (e) { console.log(label.padEnd(40), "FAIL", e.cause?.code || e.message); }
}
async function gql(label, query) {
  await api("GQL " + label, "/graphql", { method: "POST", body: JSON.stringify({ query }) });
}

console.log("=== Workers 路由（Zone 级）===");
await api("zones/{z}/workers/routes", "/zones/" + ZT + "/workers/routes");
await api("accounts/{a}/workers/routes", "/accounts/" + ACC + "/workers/routes");
await api("accounts/{a}/workers/routes?zone_id", "/accounts/" + ACC + "/workers/routes?zone_id=" + ZT);

console.log("\n=== Workers 用量/分析候选 ===");
await api("analytics/workers_usage/sum", "/accounts/" + ACC + "/analytics/workers_usage/sum?since=" + SINCE + "&until=" + UNTIL);
await api("analytics/engine_usage/sum", "/accounts/" + ACC + "/analytics/engine_usage/sum?since=" + SINCE + "&until=" + UNTIL);
await api("workers/analysis/overview", "/accounts/" + ACC + "/workers/analysis/overview");
await api("workers/scripts/{s}/analytics", "/accounts/" + ACC + "/workers/scripts/rin-server/analytics");
await gql("acct workersAnalyticsAdaptiveGroups", '{viewer{accounts(filter:{accountTag:"' + ACC + '"}){x:workersAnalyticsAdaptiveGroups(limit:2,filter:{datetime_geq:"' + SINCE + '"}){count sum{requests}}}}}');
await gql("acct workersRequestsAdaptiveGroups", '{viewer{accounts(filter:{accountTag:"' + ACC + '"}){x:workersRequestsAdaptiveGroups(limit:2,filter:{datetime_geq:"' + SINCE + '"}){count}}}}');
await gql("zone httpRequests1dGroups 仅 requests", '{viewer{zones(filter:{zoneTag:"' + ZT + '"}){x:httpRequests1dGroups(limit:3,filter:{date_geq:"2026-10-06"}){sum{requests} dimensions{date}}}}}');
await gql("zone 1d sum{visits cached originErrors}", '{viewer{zones(filter:{zoneTag:"' + ZT + '"}){x:httpRequests1dGroups(limit:2,filter:{date_geq:"2026-10-06"}){sum{visits cached originErrors}}}}}');
await gql("zone adaptive sum{count via _id}", '{viewer{zones(filter:{zoneTag:"' + ZT + '"}){x:httpRequestsAdaptiveGroups(limit:2,filter:{datetime_geq:"' + SINCE + '"}){count max{visits} min{visits}}}}}');

console.log("\n=== Analytics Engine 数据集 REST 候选 ===");
await api("analytics_engine/datasets v2", "/accounts/" + ACC + "/analytics_engine/v2/datasets");
await api("analytics_engine/datasets?dataplane", "/accounts/" + ACC + "/analytics_engine/datasets?dataplane=core&limit=10");
await api("ae 列 definitions", "/accounts/" + ACC + "/analytics_engine/column/definitions");
await api("SQL AE 默认数据集名", "/analytics/sql", { method: "POST", body: JSON.stringify({ query: "SELECT count() AS n FROM events.analyticsEngine.default LIMIT 1" }) });

console.log("\n=== 其余 ===");
await api("d1 time_travel 候选", "/accounts/" + ACC + "/d1/database/84f4174e-c620-481a-bd3a-e1312dfbddee/time_travel");
await api("zones/{z}/dns_records?type=A", "/zones/" + ZT + "/dns_records?type=A&per_page=10");
await api("zones/{z}/dns_records/{id}", "/zones/" + ZT + "/dns_records/993ec836f8d85674ebe4e9f208dd40e9");
await api("pages/{fake} 项目详情", "/accounts/" + ACC + "/pages/projects/__none__");
await api("accounts/{a}/workers/services/environment", "/accounts/" + ACC + "/workers/services/rin-server/environments/production/scripts");
await api("versions/{v}/secrets", "/accounts/" + ACC + "/workers/scripts/rin-server/versions/" + "e0b67a07-8532-4843-b2ff-f27029fc135b/secrets");

writeFileSync("docs/evidence/probe5.json", JSON.stringify(out, null, 2));
console.log("\n已写入 docs/evidence/probe5.json");
