// 定向探测：Workers 单版本 / 代码内容 / Analytics Engine 数据集 的正确请求形状
import { readFileSync } from "node:fs";
const s = readFileSync("F:/work/cf-probe/app/.dev.vars", "utf8");
const TOK = /^CF_API_TOKEN=(.*)$/m.exec(s)[1].trim();
const ACC = /^CF_ACCOUNT_ID=(.*)$/m.exec(s)[1].trim();
const H = { authorization: "Bearer " + TOK, "content-type": "application/json" };
const B = "https://api.cloudflare.com/client/v4";
const W = `/accounts/${ACC}/workers/scripts/rin-server`;
const VER = "e0b67a07-8532-4843-b2ff-f27029fc135b";   // versions 列表里的 id，同时也是 deployments 里的 version_id
const DEP = "7f9ad0a6-2aa5-4168-bad4-e080011df277";

async function g(label, p, opt) {
  try {
    const r = await fetch(B + p, { headers: H, ...(opt || {}), signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    let keys = "";
    try { const j = JSON.parse(t); keys = j.result ? Object.keys(j.result).slice(0, 12).join(",") : (j.items ? "items+" + Object.keys(j).join(",") : t.slice(0, 100)); } catch { keys = t.slice(0, 110).replace(/\s+/g, " "); }
    console.log(String(label).padEnd(44), r.status, "len=" + t.length, "|", keys.slice(0, 160));
  } catch (e) { console.log(String(label).padEnd(44), "FAIL", e.cause?.code || e.name); }
}
console.log("=== Workers 版本读取形状 ===");
await g("versions/{v}", `${W}/versions/${VER}`);
await g("versions/{v} 带 ?environment", `${W}/versions/${VER}?environment=production`);
await g("versions/{v}/settings", `${W}/versions/${VER}/settings`);
await g("versions/{v}/content", `${W}/versions/${VER}/content`);
await g("versions/{v}/modules", `${W}/versions/${VER}/modules`);
await g("deployments/{id} 单个", `${W}/deployments/${DEP}`);
await g("scripts/{s}/content 无参", `${W}/content`);
await g("scripts/{s}/content ?environment", `${W}/content?environment=production`);
await g("versions 全量响应键", `${W}/versions?per_page=2`);
await g("subdomain 路由", `/accounts/${ACC}/workers/subdomain`);

console.log("\n=== Analytics Engine / 用量 ===");
await g("datasets 无参", `/accounts/${ACC}/analytics_engine/datasets`);
await g("datasets ?limit=20", `/accounts/${ACC}/analytics_engine/datasets?limit=20`);
await g("datasets ?offset=0&limit=20", `/accounts/${ACC}/analytics_engine/datasets?offset=0&limit=20`);
await g("engine_usage/sum 带viz", `/accounts/${ACC}/analytics/engine_usage/sum?since=2026-10-08T00:00:00Z&until=2026-10-09T00:00:00Z&vizTimeseries=hour`);
await g("workers analytics GraphQL", "/graphql", { method: "POST", body: JSON.stringify({ query: '{viewer{accounts(filter:{accountTag:"' + ACC + '"}){w:workerAnalyticsAdaptiveGroups(limit:5,filter:{datetime_geq:"2026-10-08T00:00:00Z"}){count dimensions{parameters{scriptName}}sum{queries}}}}}' }) });
await g("SQL 表：events.analyticsEngine", "/analytics/sql", { method: "POST", body: JSON.stringify({ query: "SELECT count() FROM events.analyticsEngine WHERE timestamp >= $s", params: { s: "2026-10-08T00:00:00Z" } }) });
await g("SQL 假字段→列出全部字段", "/analytics/sql", { method: "POST", body: JSON.stringify({ query: "SELECT __x__ FROM events.httpRequests LIMIT 1" }) });
