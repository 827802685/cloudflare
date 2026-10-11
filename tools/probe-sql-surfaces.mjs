#!/usr/bin/env node
/**
 * 定向补测：官方规格里有、但前一轮没覆盖到的「数据面」端点形状。
 * 全部只读（SHOW TABLES / SELECT count() / GET introspection / 空 body 的 keys 查询），不改任何资源。
 * 输出：docs/evidence/sql-surfaces.json
 */
import { writeFileSync } from "node:fs";
import { loadCreds } from "./lib/token.mjs";

const { tok: TOK, acc: ACC } = loadCreds();
const B = "https://api.cloudflare.com/client/v4";
const H = { authorization: "Bearer " + TOK };
const rows = [];

async function probe(label, path, opt = {}, note = "") {
  const { headers: extra, ...rest } = opt;
  const t0 = Date.now();
  let rec = { label, group: "H", method: rest.method || "GET", path, http: 0, ms: 0, ok: false, brief: "", note };
  try {
    const r = await fetch(B + path, { ...rest, headers: { ...H, ...(extra || {}) }, signal: AbortSignal.timeout(30000) });
    const t = await r.text();
    rec.http = r.status; rec.ms = Date.now() - t0;
    let j = null; try { j = JSON.parse(t); } catch { /* 文本响应 */ }
    rec.ok = r.status < 400 && (!j || j.success !== false) && !(j && j.errors && j.errors.length);
    if (j && j.errors && j.errors.length) rec.brief = "E " + j.errors.map((e) => `${e.code ?? ""} ${e.message}`).join(" | ").slice(0, 200);
    else if (j && j.data !== undefined) rec.brief = "data=" + JSON.stringify(j.data).slice(0, 200) + (j.rows !== undefined ? " rows=" + j.rows : "");
    else if (j && j.result !== undefined) rec.brief = "result=" + JSON.stringify(j.result).slice(0, 200);
    else rec.brief = t.slice(0, 200).replace(/\s+/g, " ");
  } catch (e) { rec.brief = "FAIL " + (e.cause?.code || e.name); }
  rows.push(rec);
  console.log(String(label).padEnd(38) + String(rec.http).padStart(4) + "  " + rec.brief.slice(0, 96));
}

const SQLH = { "content-type": "application/json" };
const TXTH = { "content-type": "text/plain" };
const JSONB = (o) => JSON.stringify(o);
const SINCE = "2026-10-08T00:00:00Z";

console.log("=== Analytics SQL 官方数据面 ===");
await probe("SQL introspection（数据集目录）", `/analytics/sql/introspection?account_tag=${ACC}`, {}, "GET；返回账号可查的全部数据集清单（名称/分类/采样方式）");
await probe("SQL 顶层别名（带 scope）", "/analytics/sql", { method: "POST", headers: SQLH, body: JSONB({ query: "SELECT count() AS n FROM events.httpRequests WHERE timestamp >= $s", params: { s: SINCE }, scope: { accountTag: ACC } }) }, "与 /accounts/{a}/analytics/sql 等价");
await probe("SQL account 作用域路径", `/accounts/${ACC}/analytics/sql`, { method: "POST", headers: SQLH, body: JSONB({ query: "SELECT count() AS n FROM events.httpRequests WHERE timestamp >= $s", params: { s: SINCE }, scope: { accountTag: ACC } }) }, "规格里收录的正式路径");
await probe("SQL 带 time_range 参数", "/analytics/sql", { method: "POST", headers: SQLH, body: JSONB({ query: "SELECT toStartOfDay(timestamp) d, count() n FROM events.httpRequests GROUP BY d ORDER BY d LIMIT 8", time_range: { start: "2026-10-02T00:00:00Z", end: "2026-10-09T00:00:00Z" }, scope: { accountTag: ACC } }) }, "time_range 替代手写 WHERE");
await probe("SQL SHOW TABLES（不允许）", "/analytics/sql", { method: "POST", headers: SQLH, body: JSONB({ query: "SHOW TABLES", scope: { accountTag: ACC } }) }, "httpRequests 面禁用 information_schema");

console.log("\n=== Analytics Engine：raw SQL 文本面（替代 500 的 datasets REST）===");
await probe("AE SHOW TABLES（列自建数据集）", `/accounts/${ACC}/analytics_engine/sql`, { method: "POST", headers: TXTH, body: "SHOW TABLES" }, "body 是裸 SQL，不是 JSON");
await probe("AE 选数据集不能带库名前缀", `/accounts/${ACC}/analytics_engine/sql`, { method: "POST", headers: TXTH, body: "SELECT count() FROM events.httpRequests WHERE timestamp >= now() - INTERVAL 1 DAY" }, "负例：证明这里是 AE 方言，只能选自己的数据集");
await probe("AE GET ?query=", `/accounts/${ACC}/analytics_engine/sql?query=${encodeURIComponent("SHOW TABLES")}`, {}, "GET 形态同样可用");

console.log("\n=== Workers Observability（OTel 面，规格里新增）===");
await probe("telemetry/keys 属性目录", `/accounts/${ACC}/workers/observability/telemetry/keys`, { method: "POST", headers: SQLH, body: JSONB({ timeframe: { start: "2026-10-08T00:00:00Z", end: "2026-10-09T00:00:00Z" } }) }, "200 即说明这个产品在本账号可用");
await probe("telemetry/query 需要 queryId", `/accounts/${ACC}/workers/observability/telemetry/query`, { method: "POST", headers: SQLH, body: JSONB({ query: "SELECT 1" }) }, "负例：证明它跑的是已保存查询而不是裸 SQL");
await probe("telemetry/values 取值", `/accounts/${ACC}/workers/observability/telemetry/values`, { method: "POST", headers: SQLH, body: JSONB({ timeframe: { start: "2026-10-08T00:00:00Z", end: "2026-10-09T00:00:00Z" } }) }, "");

console.log("\n=== 规格里路径写法与老写法不一致的两处 ===");
await probe("email routing 正确路径", `/accounts/${ACC}/email/routing/settings`, {}, "规格里只有 /email/routing/...（斜杠），我们上一轮打的 /email_routing/settings 是老写法");
const NS = (await fetch(B + `/accounts/${ACC}/storage/kv/namespaces?per_page=1`, { headers: H }).then((r) => r.json()).catch(() => null))?.result?.[0]?.id;
await probe("KV 写值正确路径（不存在则 404）", NS ? `/accounts/${ACC}/storage/kv/namespaces/${NS}/values/__probe__` : `/accounts/${ACC}/storage/kv/namespaces/__none__/values/__probe__`, {}, "GET；规格里 keys 只能列，写值走 /values/{key_name}");
await probe("workers/tails 老批量接口", `/accounts/${ACC}/workers/tails`, {}, "规格里已无此路径，改用 /workers/scripts/{s}/tails");

writeFileSync("docs/evidence/sql-surfaces.json", JSON.stringify(rows, null, 1));
console.log("\n写入 docs/evidence/sql-surfaces.json，共 " + rows.length + " 条");
