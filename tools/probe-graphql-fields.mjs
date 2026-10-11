// 第六轮：把 GraphQL 两个数据集的可用 dimensions/sum 字段一次扫干净（写证据文件）
// 只读。结果写 docs/evidence/graphql-fields.json
import { writeFileSync } from "node:fs";
import { loadCreds } from "./lib/token.mjs";

const { tok: TOK } = loadCreds();
const H = { authorization: "Bearer " + TOK, "content-type": "application/json" };
const B = "https://api.cloudflare.com/client/v4";
const ZT = (await fetch(B + "/zones?per_page=5", { headers: H }).then((r) => r.json())).result[0].id;
const res = { verifiedAt: new Date().toISOString(), zoneTag: ZT, sets: {} };

async function test(ds, block, field, filt) {
  const q = "{viewer{zones(filter:{zoneTag:\"" + ZT + "\"}){x:" + ds + "(limit:1,filter:{" + filt + "}){" + block + "{" + field + "}}}}}";
  const j = await fetch(B + "/graphql", { method: "POST", headers: H, body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(25000) }).then((r) => r.json());
  if (j.errors) return { ok: false, why: j.errors[0].message.slice(0, 70) };
  return { ok: true, sample: j.data.viewer.zones[0].x[0][block][field] };
}

const ADAPT = 'datetime_geq:"2026-10-07T00:00:00Z",datetime_lt:"2026-10-09T23:59:59Z"';
const DAY = 'date_geq:"2026-10-05",date_lt:"2026-10-10"';

const jobs = [
  ["httpRequestsAdaptiveGroups", "sum", ["visits", "edgeResponseBytes", "requests", "indexedBytes", "savedBytes", "originErrorRequests", "encryptedRequestCount", "uniques"], ADAPT],
  ["httpRequestsAdaptiveGroups", "count", ["count"], ADAPT],
  ["httpRequestsAdaptiveGroups", "dimensions", ["clientCountryName", "clientRequestHTTPHost", "clientRequestHTTPProtocol", "clientRequestHTTPMethodName", "edgeResponseStatus", "clientIP", "clientASN", "clientASNDescription", "cacheStatus", "edgeCacheStatus", "clientRequestURIPath", "clientRequestURIRaw", "clientRequestQuery", "clientRequestReferer", "clientRequestScheme", "clientBrowserFamily", "clientOSFamily", "clientDeviceType", "contentType", "workerVersion", "workloadRunStatus", "originResponseStatus", "jobRunStatus", "jobName", "jobID", "datasetName", "accountName", "clientRequestHTTPVersion", "ipVersion", "visitorUUID"], ADAPT],
  ["httpRequests1dGroups", "sum", ["requests", "bytes", "pageViews", "visits", "uniques", "threats", "cached", "originErrors", "encryptedRequests", "savedBytes", "indexedBytes", "botRequests", "totalEncryptedRequests"], DAY],
  ["httpRequests1dGroups", "dimensions", ["date", "day", "datetimeDay"], DAY],
];

for (const [ds, block, fields, filt] of jobs) {
  const key = ds + "." + block;
  res.sets[key] = res.sets[key] || { ok: [], denied: [], unknown: [] };
  for (const f of fields) {
    const r = await test(ds, block, f, filt);
    if (r.ok) { res.sets[key].ok.push({ field: f, sample: r.sample }); console.log("OK   ", key, f, JSON.stringify(r.sample)); }
    else if (/does not have access/.test(r.why)) { res.sets[key].denied.push({ field: f, why: r.why }); console.log("DENY ", key, f); }
    else { res.sets[key].unknown.push({ field: f, why: r.why }); }
  }
}

writeFileSync("docs/evidence/graphql-fields.json", JSON.stringify(res, null, 2));
console.log("\n汇总：");
for (const [k, v] of Object.entries(res.sets)) console.log(k.padEnd(40), "可用 " + v.ok.length, "被套餐挡 " + v.denied.length, "不存在 " + v.unknown.length);
console.log("已写 docs/evidence/graphql-fields.json");
