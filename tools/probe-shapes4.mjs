// 第四轮：GraphQL 聚合字段/维度清单枚举 + D1/路由/Tail 等剩余端点形状
// 只读，不打印令牌。结果写 docs/evidence/probe4.json
import { writeFileSync } from "node:fs";
import { loadCreds } from "./lib/token.mjs";

const { tok: TOK, acc: ACC } = loadCreds();
const H = { authorization: "Bearer " + TOK, "content-type": "application/json" };
const B = "https://api.cloudflare.com/client/v4";
const SINCE = "2026-10-02T00:00:00Z";
const UNTIL = "2026-10-09T23:59:59Z";
const out = {};

const zr = await fetch(B + "/zones?per_page=5", { headers: H }).then((x) => x.json());
const ZT = zr.result?.[0]?.id;

async function gql(label, query) {
  try {
    const r = await fetch(B + "/graphql", { method: "POST", headers: H, body: JSON.stringify({ query }), signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    const j = JSON.parse(t);
    const msg = j.errors ? "ERR " + j.errors.map((x) => x.message).join("|").slice(0, 90) : "OK " + JSON.stringify(j.data).slice(0, 110);
    console.log(label.padEnd(36), msg);
    out["gql:" + label] = { msg, query, raw: t.slice(0, 2000) };
    return j;
  } catch (e) { console.log(label.padEnd(36), "FAIL", e.cause?.code || e.message); }
}
async function api(label, path, opt) {
  try {
    const r = await fetch(B + path, { headers: H, ...(opt || {}), signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    let brief = "";
    try { const j = JSON.parse(t); brief = (j.errors?.length ? "E " + j.errors.map((x) => x.code + " " + x.message).join("|") : JSON.stringify(j.result ?? j.data ?? j).slice(0, 130)); } catch { brief = t.slice(0, 120).replace(/\s+/g, " "); }
    console.log(label.padEnd(36), r.status, brief.slice(0, 140));
    out["api:" + label] = { status: r.status, body: t.slice(0, 4000) };
    return t;
  } catch (e) { console.log(label.padEnd(36), "FAIL", e.cause?.code || e.message); }
}

const zq = (ds, filt, sel) => '{viewer{zones(filter:{zoneTag:"' + ZT + '"}){x:' + ds + '(limit:2,filter:{' + filt + '}){' + sel + "}}}}";
console.log("=== adaptive groups 聚合字段候选 ===");
for (const f of ["visits", "byte", "requests", "cached", "originErrors", "threats", "savedBytes", "indexedBytes", "egressBytes", "uniques"]) {
  await gql("sum." + f, zq( "httpRequestsAdaptiveGroups", 'datetime_geq:"' + SINCE + '"', "sum{" + f + "}"));
}
console.log("\n=== adaptive groups 维度候选（决定看板能做哪些下钻）===");
for (const f of ["clientRequestURIPath", "clientRequestURIRaw", "clientRequestReferer", "clientRequestQuery", "edgeCacheStatus", "cdnCacheStatus", "clientRequestHTTPMethodName", "clientIP", "clientCountryIsoCode", "raw.COUNTRY", "workloadRunStatus"]) {
  await gql("dim." + f.split(".").pop(), zq( "httpRequestsAdaptiveGroups", 'datetime_geq:"' + SINCE + '"', "count dimensions{" + f + "}"));
}
console.log("\n=== 1dGroups 字段（官方示例口径）===");
await gql("1d 全套", zq( "httpRequests1dGroups", 'date_geq:"2026-10-02",date_lt:"2026-10-10"', "sum{requests byte visits cached originErrors} dimensions{day}"));
await gql("1d dimensions{date}", zq( "httpRequests1dGroups", 'date_geq:"2026-10-02"', "dimensions{date}"));
await gql("1m 无 filter", zq( "httpRequests1mGroups", 'datetime_geq:"2026-10-08T00:00:00Z",datetime_lt:"' + UNTIL + '"', "sum{requests} dimensions{datetime}"));
await gql("visitorTimeseries", zq( "visitorTimeseriesByRequests1dGroups", 'date_geq:"2026-10-02"', "sum{visits uniques} dimensions{date}"));
await gql("firewallEventsAdaptive", zq( "firewallEventsAdaptiveGroups", 'datetime_geq:"' + SINCE + '"', "count dimensions{action}"));

console.log("\n=== 剩余端点 ===");
const d1 = await fetch(B + "/accounts/" + ACC + "/d1/database", { headers: H }).then((x) => x.json());
const duuid = d1.result?.find((x) => x.name === "rin")?.uuid || d1.result?.[0]?.uuid;
await api("d1/{uuid} 详情", "/accounts/" + ACC + "/d1/database/" + duuid);
await api("d1 query 只读", "/accounts/" + ACC + "/d1/database/" + duuid + "/query", { method: "POST", body: JSON.stringify({ sql: "SELECT count(*) AS n FROM info" }) });
await api("d1/{uuid}/time_travel/info", "/accounts/" + ACC + "/d1/database/" + duuid + "/time_travel/info");
await api("zones/{z}/routes", "/zones/" + ZT + "/routes");
await api("zones/{z}/purge_cache 权限", "/zones/" + ZT + "/purge_cache", { method: "POST", body: JSON.stringify({ purge_everything: false, files: [] }) });
await api("workers/tails 列表", "/accounts/" + ACC + "/workers/tails");
await api("workers/tail 读取(需WS?)", "/accounts/" + ACC + "/workers/tails/any");
await api("scripts/{s}/settings 真名", "/accounts/" + ACC + "/workers/scripts/rin-server/settings");
await api("scripts 列表含 tags", "/accounts/" + ACC + "/workers/scripts?per_page=5");
await api("pages/{fake}/deployments", "/accounts/" + ACC + "/pages/projects/__none__/deployments");
await api("rate_limits(zone)", "/zones/" + ZT + "/rate_limits");
await api("waf/rulesets", "/zones/" + ZT + "/settings/security_level");
await api("user/tokens/verify", "/user/tokens/verify");
await api("tokens(列表)", "/accounts/" + ACC + "/tokens");

writeFileSync("docs/evidence/probe4.json", JSON.stringify(out, null, 2));
console.log("\n已写入 docs/evidence/probe4.json");
