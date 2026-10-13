// 第二轮定向探测：确认单版本/代码下载/GraphQL/SQL 表结构，结果落盘到 docs/evidence
// 只读：全部 GET 或 SELECT/GraphQL 查询，不改任何资源，不打印令牌。
import { readFileSync, writeFileSync } from "node:fs";

const s = readFileSync("«LOCAL_PATH»", "utf8");
const TOK = /^CF_API_TOKEN=(.*)$/m.exec(s)[1].trim();
const ACC = /^CF_ACCOUNT_ID=(.*)$/m.exec(s)[1].trim();
const H = { authorization: "Bearer " + TOK, "content-type": "application/json" };
const B = "https://api.cloudflare.com/client/v4";const W = "/accounts/" + ACC + "/workers/scripts/rin-server";
const VER = "e0b67a07-8532-4843-b2ff-f27029fc135b";
const SINCE = "2026-10-02T00:00:00Z";
const UNTIL = "2026-10-09T23:59:59Z";

const out = {};
// zoneTag 动态取（account 级令牌可读 /zones）
const zr = await fetch(B + "/zones?per_page=5", { headers: H, signal: AbortSignal.timeout(20000) }).then((r) => r.json());
const ZT = zr.result && zr.result[0] ? zr.result[0].id : "";
console.log("zoneTag =", ZT || "(未取到)");
async function probe(key, path, opt) {
  const rec = { path, method: (opt && opt.method) || "GET" };
  try {
    const r = await fetch(B + path, { headers: H, ...(opt || {}), signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    rec.status = r.status;
    rec.len = t.length;
    try {
      const j = JSON.parse(t);
      rec.errCode = j.errors && j.errors[0] ? j.errors[0].code : undefined;
      rec.errMsg = j.errors && j.errors[0] ? j.errors[0].message : undefined;
      rec.resultKeys = j.result ? (Array.isArray(j.result) ? "array[" + j.result.length + "]" : Object.keys(j.result).join(",")) : undefined;
      rec.body = j.result !== undefined ? j.result : (j.items !== undefined ? { items: j.items } : j);
    } catch { rec.text = t.slice(0, 2000); }
    const tag = (rec.status || "ERR") + (rec.errCode ? "/" + rec.errCode : "");
    console.log(key.padEnd(34), tag.padEnd(10), "len=" + rec.len, rec.errMsg ? String(rec.errMsg).slice(0, 90) : String(rec.resultKeys || rec.text || "").slice(0, 90));
  } catch (e) {
    rec.error = String(e && e.message);
    rec.cause = e && e.cause && e.cause.code;
    console.log(key.padEnd(34), "FAIL".padEnd(10), rec.cause || rec.error);
  }
  out[key] = rec;
  return rec;
}

const q = (body) => ({ method: "POST", body: JSON.stringify(body) });

console.log("=== 1. 单版本 / 代码下载 形状复核 ===");
await probe("versions/{v}", W + "/versions/" + VER);
await probe("versions/{v}/bogus后缀", W + "/versions/" + VER + "/totallybogus");
await probe("versions/{v}/content", W + "/versions/" + VER + "/content");
await probe("legacy scripts/{s}", W);
await probe("scripts/{s}/settings", W + "/settings");
await probe("scripts/{s}/secrets", W + "/secrets");
await probe("scripts/{s}/schedules(cron)", W + "/schedules");
await probe("tail-sessions", W + "/tail-sessions");
await probe("deployments?environment", W + "/deployments?environment=production&per_page=100");
await probe("versions/{v}/deployments", W + "/versions/" + VER + "/deployments");

console.log("\n=== 2. GraphQL 数据集名候选 ===");
const accGql = (ds, extra) => '{viewer{accounts(filter:{accountTag:"' + ACC + '"}){' + ds + '(limit:5,filter:{datetime_geq:"' + SINCE + '"}' + (extra || "") + '){' + "count sum{queries}}}}}";
for (const name of ["workerAnalyticsAdaptiveGroups", "workersAnalyticsAdaptiveGroups", "workerVersionsAdaptiveGroups", "engineUsageAdaptiveGroups"]) {
  await probe("GQL " + name, "/graphql", q({ query: accGql(name) }));
}
const zoneGql = (ds, dims) => "{viewer{zones(filter:{zoneTag:\"" + ZT + "\"}){" + ds + "(limit:5,filter:{datetime_geq:\"" + SINCE + "\",datetime_lt:\"" + UNTIL + '"}){count sum{visits} dimensions{' + dims + "}}}}}";
for (const [ds, dims] of [["httpRequestsAdaptiveGroups", "country{countryName} clientRequestHTTPProtocol"], ["httpRequests1dGroups", "dimensions{date}"], ["cachesAdaptiveGroups", "cacheStatus"]]) {
  await probe("GQL zone " + ds, "/graphql", q({ query: zoneGql(ds, dims) }));
}

console.log("\n=== 3. SQL API 表/字段枚举（用非法列逼出完整列表）===");
for (const tbl of ["events.httpRequests", "events.firewallEvents", "events.dnsQueries", "events.workerVersions", "analytics.httpRequests1m", "analytics.httpRequests1d"]) {
  await probe("SQL schema " + tbl, "/analytics/sql", q({ query: "SELECT __bogus__ FROM " + tbl + " LIMIT 1" }));
}
await probe("SQL analytics.httpRequests1d 按国家", "/analytics/sql", q({
  query: "SELECT countryName, sum(requests) AS n FROM analytics.httpRequests1d WHERE datetime >= $s AND datetime < $u GROUP BY countryName ORDER BY n DESC LIMIT 5",
  params: { s: SINCE, u: UNTIL },
}));
await probe("SQL events.httpRequests 按国家", "/analytics/sql", q({
  query: "SELECT countryName, count() AS n FROM events.httpRequests WHERE zoneTag=$z AND timestamp >= $s GROUP BY countryName ORDER BY n DESC LIMIT 5",
  params: { z: ZT, s: SINCE },
}));
await probe("SQL workers 用量表试探", "/analytics/sql", q({ query: "SELECT __bogus__ FROM analytics.workerVersions LIMIT 1" }));
await probe("SQL AE 指定数据集名", "/analytics/sql", q({ query: "SELECT __bogus__ FROM events.analyticsEngine.__nope__ LIMIT 1" }));

console.log("\n=== 4. 其余待确认端点 ===");
await probe("analytics_engine/datasets", "/accounts/" + ACC + "/analytics_engine/datasets?limit=10&visibility=WorkerVisible");
await probe("analytics_engine/datasets/{ns}", "/accounts/" + ACC + "/analytics_engine/datasets/default");
await probe("engine_usage 无viz", "/accounts/" + ACC + "/analytics/engine_usage/sum?since=2026-10-08T00:00:00Z&until=2026-10-09T00:00:00Z");
await probe("workers/domains?per_page", "/accounts/" + ACC + "/workers/domains?per_page=50");
await probe("pages/projects", "/accounts/" + ACC + "/pages/projects");
await probe("d1/database", "/accounts/" + ACC + "/d1/database");
await probe("r2/buckets", "/accounts/" + ACC + "/r2/buckets");
await probe("zones?per_page", "/zones?per_page=50");
await probe("accounts", "/accounts");

writeFileSync("docs/evidence/endpoint-shapes.json", JSON.stringify(out, null, 2));
console.log("\n已写入 docs/evidence/endpoint-shapes.json");
