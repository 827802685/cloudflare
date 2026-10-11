#!/usr/bin/env node
/**
 * 路由一致性检查：前端 `api.ts` 里调用的每条网关路径，是否真的在网关 `index.ts` 注册过；
 * 反过来，网关注册了哪些路由是前端没用到的。
 *
 * 为什么要机器做（2026-10-10）：我自己 curl 时就把下钻接口写成了 `/v1/top`，真实路径是
 * `/v1/traffic/top`，返回的是网关 404「没有这条路由」。当时靠记忆躲过去了，但界面上一旦写错路径，
 * 用户看到的就是一个"网关坏了"的错误卡 —— 这类错必须静态抓，不该靠记性。
 *
 * 匹配规则：把两边的动态段都归一成 `*`（网关 `:s` / 前端 `+ encodeURIComponent(...)`），
 * 然后逐段比对，段数必须一致。查询串（?range=…）不参与匹配。
 *
 * 只读：不联网、不改文件。用法：node tools/check-route-parity.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GW = readFileSync(resolve(ROOT, "app/gateway/src/index.ts"), "utf8");
const API = readFileSync(resolve(ROOT, "app/console/src/lib/api.ts"), "utf8");

/** 网关路由：app.get("/v1/workers/:s/versions", ...) 或 跨行的 app.get(\n  "/v1/...", ...) */
const gwRoutes = [];
for (const m of GW.matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
  gwRoutes.push({ verb: m[1], pattern: m[2] });
}

const segs = (p) => p.split("?")[0].split("/").filter(Boolean);
/** `:param` → `*`；其余原样 */
const normGw = (p) => segs(p).map((s) => (s.startsWith(":") ? "*" : s));

/** 括号感知地切实参：`dnsBody(a, b)` 里的逗号不能把第二个实参切成两半 */
function splitArgs(args) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of args) {
    if ("([".includes(ch)) depth++;
    else if (")]".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** 把 `"..." + encodeURIComponent(x) + "..."` 这种拼接式路径归一成 `/v1/a/{动态段}/b` */
function normPath(first) {
  const tmpl = first.replace(/encodeURIComponent\([^)]*\)/g, "*").replace(/["'\s+]/g, "");
  return tmpl.startsWith("/v1") ? tmpl : null;
}

/**
 * 前端路径：`gw<T>("/v1/overview", { range })`、
 *           `gw("/v1/workers/" + encodeURIComponent(s) + "/versions", {...})`
 * 做法：抓 gw<...>( 之后到与之配对的右括号之间的整段实参，再把 encodeURIComponent(...) 换成 `*`，
 * 去掉字符串引号与加号，最后取第一个 `/v1` 开头的片段序列。
 *
 * 写侧的 `gwWrite<any>("POST", path, body)` 实参顺序不一样（动词在前），所以单独抓一遍，
 * 并且**动词要一起比**：只比路径的话，前端把 DELETE 写成 PUT 也算"通过"，那正是这类检查器最没用的地方。
 */
const uiCalls = [];
function balancedArgs(from) {
  const open = API.indexOf("(", from);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < API.length; j++) {
    if (API[j] === "(") depth++;
    else if (API[j] === ")") {
      depth--;
      if (!depth) return API.slice(open + 1, j);
    }
  }
  return null;
}
{
  let i = 0;
  while ((i = API.indexOf("gw<", i)) > -1) {
    const args = balancedArgs(i);
    if (args === null) break;
    const p = normPath(splitArgs(args)[0]);
    if (p) uiCalls.push({ path: p });
    i += 3;
  }
  i = 0;
  while ((i = API.indexOf("gwWrite<", i)) > -1) {
    const args = balancedArgs(i);
    if (args === null) break;
    const a = splitArgs(args);
    const verb = (a[0].match(/"(GET|POST|PUT|PATCH|DELETE)"/) || [])[1];
    const p = normPath(a[1] || "");
    if (p) uiCalls.push({ path: p, verb: verb ? verb.toLowerCase() : undefined });
    i += 8;
  }
}
/** 按「动词 + 路径」去重，同一条路径被两个动词用（dns_records 的 PUT/DELETE）要各算一条 */
const uniqUi = (list) => Array.from(new Map(list.map((u) => [`${u.verb || "?"} ${u.path}`, u])).values());
const normUi = (p) => segs(p).map((s) => (s === "*" ? "*" : s));

const matchOne = (ui, routes) =>
  routes.filter((r) => {
    if (ui.verb && r.verb !== ui.verb) return false;
    const g = normGw(r.pattern);
    const u = normUi(ui.path);
    return g.length === u.length && g.every((s, k) => s === "*" || u[k] === "*" || s === u[k]);
  });

const used = new Set();
const missing = [];
for (const ui of uniqUi(uiCalls)) {
  const hits = matchOne(ui, gwRoutes);
  if (!hits.length) missing.push(`${ui.verb ? ui.verb.toUpperCase() + " " : ""}${ui.path}`);
  hits.forEach((h) => used.add(h.pattern));
}

/* 冒烟脚本也算调用方：它打了某条路由但界面没用，不该被当成死路由 */
const SMOKE = readFileSync(resolve(ROOT, "tools/smoke-gateway.mjs"), "utf8");
const smokeCalls = [];
for (const m of SMOKE.matchAll(/[`"]((?:\/v1|\/health)[^`"]*)[`"]/g)) {
  smokeCalls.push({ path: m[1].replace(/\$\{[^}]*\}/g, "*").split("?")[0] });
}
// /health 是前端 gwHealth() 用字符串拼出来的，上面按 gw<…> 抓不到，这里补一条显式来源
if (API.includes('"/health"')) smokeCalls.push({ path: "/health" });
const smokeUsed = new Set();
for (const s of new Map(smokeCalls.map((x) => [x.path, x])).values()) matchOne(s, gwRoutes).forEach((r) => smokeUsed.add(r.pattern));

const unused = gwRoutes
  .filter((r) => !used.has(r.pattern))
  .map((r) => `${r.verb.toUpperCase()} ${r.pattern}${smokeUsed.has(r.pattern) ? "（界面没调用，但冒烟脚本在打）" : "（界面和冒烟都没用）"}`);

const ALL_UI = uniqUi(uiCalls);
const label = (u) => `${u.verb ? u.verb.toUpperCase() + " " : "    "}${u.path}`;
console.log(`网关注册路由 ${gwRoutes.length} 条 · 前端调用 ${ALL_UI.length} 种路径（动词一起算）`);
for (const ui of ALL_UI) {
  const hits = matchOne(ui, gwRoutes);
  console.log(`  ${hits.length ? "✓" : "✗"} ${label(ui).padEnd(48)} → ${hits.map((h) => h.verb.toUpperCase() + " " + h.pattern).join(", ") || "网关没有这条路由"}`);
}
/* 自检：一个只会说"通过"的检查器没有价值。故意喂一条我今天真的写错过的路径，
 * 确认匹配器会把它判成缺失（/v1/top 不存在，真路径是 /v1/traffic/top）。
 * 再加一条只有写侧才可能犯的错：路径对、动词错（purge_cache 只注册了 POST）。 */
if (process.argv.includes("--selftest")) {
  const cases = [
    { ui: { path: "/v1/top" }, want: 0, what: "错路径 /v1/top（真路径是 /v1/traffic/top）" },
    { ui: { path: "/v1/traffic/top" }, want: 1, what: "真路径 /v1/traffic/top" },
    { ui: { path: "/v1/zones/*/dns_records", verb: "post" }, want: 1, what: "写路径 POST /v1/zones/:zone/dns_records" },
    { ui: { path: "/v1/zones/*/purge_cache", verb: "delete" }, want: 0, what: "路径对但动词错（purge_cache 只认 POST）" },
    { ui: { path: "/v1/zones/*/dns_records/*", verb: "put" }, want: 1, what: "写路径 PUT /v1/zones/:zone/dns_records/:id" },
  ];
  let bad = 0;
  for (const c of cases) {
    const n = matchOne(c.ui, gwRoutes).length;
    const ok = c.want === 0 ? n === 0 : n > 0;
    if (!ok) bad++;
    console.log(`\n自检：${c.what} → ${ok ? `判定正确（命中 ${n} 条）` : `判错（期望${c.want ? "命中" : "不命中"}，实际命中 ${n} 条）`}`);
  }
  if (bad) process.exit(2);
}

if (unused.length) {
  console.log(`\n网关有、前端没调用（${unused.length} 条，不算错，只是提醒别以为界面已经用上了）：`);
  unused.forEach((u) => console.log("  · " + u));
}
if (missing.length) {
  console.log(`\n✗ 前端调了但网关没注册（${missing.length} 条）：${missing.join(", ")}`);
  console.log("  这就是会稳定 404 的调用，改前端路径或补网关路由，二选一。");
  process.exit(1);
}
console.log("\n合计：前端每一条网关调用都能在网关路由表里落到具体一条。");
