#!/usr/bin/env node
/**
 * 账号级 GraphQL 字段扫描：`viewer.accounts` 下面 `httpRequests1dGroups` / `httpRequestsAdaptiveGroups`
 * 到底能取哪些 sum/dimensions 字段。
 *
 * 起因：网关首页看板写了 `sum { requests visits bandwidth }`，实测报 `unknown field "visits"`，
 * 说明账号级 1dGroups 和控制台/zone 级的字段集不一样，不能照抄。
 * 全部只读（一次一个字段，方便定位是谁被拒）。输出：docs/evidence/graphql-account-fields.json
 */
import { writeFileSync } from "node:fs";
import { loadCreds } from "./lib/token.mjs";

const { tok: TOK, acc: ACC } = loadCreds();
const B = "https://api.cloudflare.com/client/v4";
const H = { authorization: "Bearer " + TOK, "content-type": "application/json" };

const dateGeq = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
const dateLt = new Date().toISOString().slice(0, 10);
const dtGeq = new Date(Date.now() - 3 * 86400000).toISOString();
const dtLt = new Date().toISOString();

const out = { verifiedAt: new Date().toISOString(), accountTag: ACC, note: "账号级 = viewer.accounts(filter:{accountTag})", sets: {} };

const cases = {
  "httpRequests1dGroups.sum": {
    head: `g: httpRequests1dGroups(limit:2, filter:{date_geq:"${dateGeq}", date_lt:"${dateLt}"})`,
    block: "sum",
    fields: ["requests", "visits", "bandwidth", "bytes", "cachedDatabytes", "uncachedDatabytes", "encryptedRequests", "threats", "pageSessions", "indexedBytes", "savedBytes", "originErrorRequests", "botRequests"],
  },
  "httpRequests1dGroups.dimensions": {
    head: `g: httpRequests1dGroups(limit:2, filter:{date_geq:"${dateGeq}", date_lt:"${dateLt}"})`,
    block: "dimensions",
    fields: ["date", "day", "datetimeDay", "countryName"],
  },
  "httpRequestsAdaptiveGroups.sum": {
    head: `g: httpRequestsAdaptiveGroups(limit:2, filter:{datetime_geq:"${dtGeq}", datetime_lt:"${dtLt}"})`,
    block: "sum",
    fields: ["count", "visits", "requests", "edgeResponseBytes", "originalResponseBytes", "cachedRequestCount", "uncachedRequestCount", "encryptedRequestCount", "savedBytes", "indexedBytes"],
  },
  "httpRequestsAdaptiveGroups.dimensions": {
    head: `g: httpRequestsAdaptiveGroups(limit:2, filter:{datetime_geq:"${dtGeq}", datetime_lt:"${dtLt}"})`,
    block: "dimensions",
    fields: ["clientCountryName", "clientRequestHTTPHost", "cacheStatus", "clientDeviceType", "edgeResponseStatus", "originResponseStatus", "clientASNDescription", "clientRequestReferer"],
  },
};

for (const [key, c] of Object.entries(cases)) {
  const set = { ok: [], denied: [], unknown: [] };
  for (const f of c.fields) {
    const q = `{ viewer { accounts(filter:{accountTag:"${ACC}"}) { ${c.head} { ${c.block} { ${f} } } } } }`;
    const res = await fetch(B + "/graphql", { method: "POST", headers: H, body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(25000) });
    const j = await res.json().catch(() => null);
    const msg = j?.errors?.[0]?.message || "";
    const sample = j?.data?.viewer?.accounts?.[0]?.g?.[0]?.[c.block]?.[f];
    if (!msg) { set.ok.push({ field: f, sample }); console.log("OK    ", key, f, JSON.stringify(sample)); }
    else if (/does not have access/.test(msg)) { set.denied.push({ field: f, why: msg.slice(0, 90) }); console.log("DENY  ", key, f); }
    else { set.unknown.push({ field: f, why: msg.slice(0, 90) }); console.log("NONE  ", key, f, "->", msg.slice(0, 60)); }
  }
  out.sets[key] = set;
}

writeFileSync("docs/evidence/graphql-account-fields.json", JSON.stringify(out, null, 2));
console.log("\n写 docs/evidence/graphql-account-fields.json");
