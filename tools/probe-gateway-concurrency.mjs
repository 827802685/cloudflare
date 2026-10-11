#!/usr/bin/env node
/**
 * 本地网关并发探针：量 `wrangler dev` 到底是并发处理请求、还是把请求排队串行。
 *
 * 起因（2026-10-10）：我在浏览器里连点两次"下钻查询"，其中一次 **25 秒没返回**，前端如实报成超时，
 * 但我无法判断瓶颈在 CF 上游还是在本地开发器上。这个 distinction 很重要：
 *   - 如果是 wrangler dev 串行 → 只是本地现象，4.1 部署到真 Worker 后不会这样；
 *   - 如果是 CF SQL 慢 → 上线后一样会卡，前端 25 秒超时就会真的咬人，得考虑给慢路由单独放宽或做缓存。
 *
 * 方法：同一批路由分别用"并发"和"串行"两种打法计时。并发总耗时 ≈ 各条之和 ⇒ 串行；≈ 单条最大值 ⇒ 真并发。
 * 对照组用 /health（不碰 CF），这样"网关自己排不排队"和"CF 上游慢不慢"能被分开看。
 *
 * 只读：只发 GET，只打本地网关，不打印任何令牌（设备令牌从 app/gateway/.device-token 读，只报长度）。
 * 用法：cd app/gateway && npm run dev   # 另一个终端
 *       node tools/probe-gateway-concurrency.mjs [--base http://127.0.0.1:8788] [--n 8] [--no-cf]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const BASE = String(arg("base", "http://127.0.0.1:8788")).replace(/\/+$/, "");
const N = Number(arg("n", 8));
const SKIP_CF = process.argv.includes("--no-cf");

const devToken = readFileSync(resolve(ROOT, "app/gateway/.device-token"), "utf8").trim();

async function hit(path) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, { headers: { "x-device-token": devToken }, signal: AbortSignal.timeout(30000) });
    const body = await res.text();
    return { path, status: res.status, ms: Math.round(performance.now() - t0), bytes: body.length, kind: (() => { try { return JSON.parse(body)?.error?.kind || ""; } catch { return ""; } })() };
  } catch (e) {
    return { path, status: 0, ms: Math.round(performance.now() - t0), bytes: 0, kind: "clientError", message: String((e && e.name) || e) };
  }
}

const summary = (label, runs, wall) => ({
  label,
  wall_ms: Math.round(wall),
  per_request_ms: runs.map((r) => r.ms),
  sum_ms: runs.reduce((s, r) => s + r.ms, 0),
  max_ms: Math.max(...runs.map((r) => r.ms)),
  statuses: runs.map((r) => r.status),
  // status 0 = 客户端在 30 秒上限处主动断掉的条数。这个数字必须显式记下来：
  // 首轮实测里 12 条 /health 有 11 条撞上限，如果只看"并发/最大 ≈ 1"就会误判成"网关不卡"。
  client_timeouts: runs.filter((r) => r.status === 0).length,
  kinds: [...new Set(runs.map((r) => r.kind).filter(Boolean))],
});

const out = {
  generated_at: new Date().toISOString(),
  base: BASE,
  device_token_length: devToken.length,
  // 允许把"这一轮之外观察到的现象"一起落到证据文件里，免得只留下数字、丢掉上下文。
  operator_notes: String(arg("note", ""))
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean),
  tests: [],
};

async function run(label, path, count, mode) {
  const t0 = performance.now();
  let runs;
  if (mode === "parallel") {
    runs = await Promise.all(Array.from({ length: count }, () => hit(path)));
  } else {
    runs = [];
    for (let i = 0; i < count; i++) runs.push(await hit(path));
  }
  const s = summary(`${label}（${mode} ×${count}）`, runs, performance.now() - t0);
  // 判据：并发那轮里，若 wall 明显大于单条最大值（≈ sum），说明请求在网关里排队
  if (mode === "parallel") {
    const ratio = s.wall_ms / Math.max(1, s.max_ms);
    s.serialization_ratio = Number(ratio.toFixed(2)); // ≈1 真并发；≈count 完全串行
    s.verdict = ratio < 1.6 ? "concurrent" : ratio > count * 0.6 ? "serialized" : "partially_concurrent";
  }
  out.tests.push(s);
  console.log(
    `  ${s.label}: wall ${s.wall_ms}ms · 单条 max ${s.max_ms}ms · sum ${s.sum_ms}ms · 撞 30s 上限 ${s.client_timeouts} 条${s.serialization_ratio ? ` · 并发/最大 = ${s.serialization_ratio} → ${s.verdict}` : ""}`,
  );
  return s;
}

console.log(`基址 ${BASE}（设备令牌只读长度 ${devToken.length}，不打印内容）`);

const health = "/health";
const slow = "/v1/traffic/top?range=24h&dim=host&limit=20";
const overview = "/v1/overview?range=24h";

await run("health", health, N, "parallel");
await run("health", health, 4, "serial");
if (!SKIP_CF) {
  await run("traffic/top（碰 CF SQL）", slow, 3, "parallel");
  await run("traffic/top（碰 CF SQL）", slow, 2, "serial");
  await run("overview（碰 CF 多次）", overview, 3, "parallel");
}

const h = out.tests.find((t) => t.label.startsWith("health（parallel"));
const stalled = out.tests.filter((t) => t.client_timeouts > 0);
out.conclusion = {};
if (h) {
  out.conclusion.serialization =
    h.verdict === "serialized"
      ? "并发总耗时≈各条之和 ⇒ 网关在排队"
      : h.verdict === "concurrent"
        ? "并发总耗时≈单条最大值 ⇒ 网关没有把请求串行化（health 与碰 CF 的路由都成立）"
        : `/health 并发比 = ${h.serialization_ratio}，介于两者之间，看逐项数字`;
  out.conclusion.health_parallel_verdict = h.verdict;
}
// 只陈述数字能支撑的部分；"为什么卡"必须靠 operator_notes 写清楚，不许脚本替我下因果结论。
out.conclusion.client_timeouts = stalled.length ? `${stalled.reduce((s, t) => s + t.client_timeouts, 0)} 条撞到我探针的 30 秒上限（分布在：${stalled.map((t) => t.label).join("、")}）` : "本轮没有请求撞到 30 秒上限";
out.conclusion.causal_claim = "无。本脚本只判并发/串行；卡顿的成因（CF 上游、wrangler dev 本地运行时、机器负载）要靠 operator_notes 与多轮复测，不要从单轮数字外推。";

console.log("\n结论：");
if (out.conclusion.serialization) console.log("  · " + out.conclusion.serialization);
console.log("  · " + out.conclusion.client_timeouts);
console.log("  · " + out.conclusion.causal_claim);
const file = resolve(ROOT, "docs/evidence/gateway-concurrency.json");
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log("证据：" + file);
