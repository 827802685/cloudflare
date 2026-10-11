/**
 * 请求预算探针：模拟"手机进 App 逛一圈"会打出去多少次 api.cloudflare.com。
 *
 * 一轮 = 六屏实际会发的网关调用（照 console/src/views 里的调用列出来，不虚构）：
 *   看板 1 条 · Workers 列表 1 · Worker 详情 7 · 详情的流量卡片 4（domains/top/zones/routes）
 *   · 域名屏 4（dns_records/settings/routes/waf，routes 与上面重一条）· Pages 1 · 设置 1
 *
 * 计量口径有两个，都要，因为单个会撒谎：
 *   1) 每条响应的 x-gw-cf-calls 头（这一条响应真正出网几次）—— 本轮合计；
 *   2) /health 的 cache.cfCalls（这个 isolate 累计出网次数）—— 前后差值，用来核对 (1) 没漏统计。
 *
 * 上一版这两个口径每次都对不上（16 vs 17），根因是探针自己多打了一条：取 zone id 时
 * 又 hit() 了一次 /v1/zones，那条的出网次数进了 /health 却没进头部合计。
 * 现在直接复用本轮已经跑过的 /v1/zones 响应——计量工具自己不能成为噪声源。
 *
 * 用法：node tools/probe-request-budget.mjs [--base http://127.0.0.1:8788]
 * 只读：全程 GET，不带写动词，账号侧零变更。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const baseIdx = argv.indexOf("--base");
const base = baseIdx >= 0 ? argv[baseIdx + 1] : "http://127.0.0.1:8788";
const token = fs.readFileSync(path.join(root, "app/gateway/.device-token"), "utf8").trim();

const calls = [
  "/v1/overview?range=7d",
  "/v1/workers",
  "/v1/workers/rin-server/versions?per_page=25&page=1",
  "/v1/workers/rin-server/deployments",
  "/v1/workers/rin-server/settings",
  "/v1/workers/rin-server/script-settings",
  "/v1/workers/rin-server/subdomain",
  "/v1/workers/rin-server/secrets",
  "/v1/workers/rin-server/crons",
  "/v1/domains",
  "/v1/traffic/top?range=7d&dim=host",
  "/v1/zones",
  "/v1/pages",
  "/v1/accounts",
];

async function hit(p) {
  const res = await fetch(base + p, { headers: { "x-device-token": token }, signal: AbortSignal.timeout(60000) });
  const body = await res.json().catch(() => null);
  return {
    status: res.status,
    calls: Number(res.headers.get("x-gw-cf-calls") || "0"),
    cache: res.headers.get("x-gw-cache") || "?",
    body,
  };
}

async function health() {
  const r = await fetch(base + "/health", { signal: AbortSignal.timeout(15000) });
  return (await r.json()).cache;
}

/** 域名屏要先知道 zone id，所以它单独一段 */
async function zoneCalls(zone, suffix) {
  return [
    `/v1/zones/${zone}/dns_records`,
    `/v1/zones/${zone}${suffix}`,
    `/v1/zones/${zone}/waf`,
  ];
}

async function round(label, fresh) {
  const before = await health();
  const q = fresh ? (p => p + (p.includes("?") ? "&" : "?") + "fresh=1") : (p => p);
  const t0 = Date.now();
  let gwCalls = 0, upstream = 0;
  const states = {};
  const leaks = [];
  const byPath = {};
  const run = async (p) => {
    const r = await hit(q(p));
    byPath[p] = r;
    gwCalls++;
    upstream += r.calls;
    states[r.cache] = (states[r.cache] || 0) + 1;
    if (r.calls > 0) leaks.push(`      ${String(r.calls)} 次  [${r.cache}]  ${p}`);
    if (r.status >= 400) console.log(`   ! ${r.status} ${p} ${JSON.stringify(r.body?.error || {}).slice(0, 120)}`);
    return r;
  };
  const results = [];
  for (const p of calls) results.push(await run(p));
  const zones = byPath["/v1/zones"]?.body?.result || [];
  for (const z of zones) for (const p of await zoneCalls(z.id, "/routes")) results.push(await run(p));
  const ms = Date.now() - t0;
  const after = await health();
  const delta = after.cfCalls - before.cfCalls;
  console.log(
    `${label.padEnd(10)} 网关往返 ${String(gwCalls).padStart(2)} 条 · 出网 CF ${String(upstream).padStart(2)} 次` +
    ` · /health 累计差值 ${delta} · 响应状态 ${JSON.stringify(states)} · 墙钟 ${ms}ms`,
  );
  if (leaks.length) console.log(leaks.join("\n"));
  if (delta !== upstream) console.log(`   ⚠ 两个口径不一致（头合计 ${upstream} vs 累计 ${delta}）：要么有路由没经过 CfClient，要么 health 也被并发了`);
  return { upstream, gwCalls };
}

console.log(`base=${base}  zone=${(await hit("/v1/zones")).body?.result?.[0]?.name}`);
const cold = await round("① 强制刷新", true);
const warm = await round("② 再逛一圈", false);
const warm2 = await round("③ 第三圈", false);
const h = await health();
console.log("\n缓存现状：", JSON.stringify(h));
console.log(`结论：一圈冷 ${cold.upstream} 次 → 5 分钟内复用 ${warm.upstream} / ${warm2.upstream} 次；` +
  `网关往返 ${cold.gwCalls} 条不变（省的是 CF 出网，不是省 HTTP）。`);
