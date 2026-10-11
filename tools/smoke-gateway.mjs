#!/usr/bin/env node
/**
 * 网关冒烟测试：对着本地 wrangler dev（默认 http://127.0.0.1:8788）逐条打白名单路由，
 * 用你自己的账号取真实数据，并验证闸门（错令牌 401 / 未知路径 404 / 非法枚举 422 / 写 501 或 422）。
 *
 * 用法：
 *   cd app/gateway && npm run dev                    # 终端 A，只读模式（写一律 501）
 *   node tools/smoke-gateway.mjs                     # 终端 B（本脚本）
 *   npx wrangler dev --port 8799 --var WRITE_ENABLED:true   # 想验写侧闸门时用这条
 *   node tools/smoke-gateway.mjs --base http://127.0.0.1:8799
 *
 * 写侧模式是从 /health 的 `writes` 字段自动判定的，两种模式跑的是同一份脚本：
 *   disabled → 断言四条写路由 + 白名单外的非 GET 全部 501（这条是回滚依据）
 *   enabled  → 断言 422 闸门，且**一条真写都不发**
 * 真发一次 DNS 建/改/删要他点头（docs/12 §3 P3），所以这里只打全零 zone id、不存在的 record id、
 * 以及一批"根本不该出网"的非法 body。
 *
 * 关键证据不是 HTTP 状态码，而是 outbox 计数器差值（从 /health 的 cache 段读）：每条写侧用例都要求
 * `cache.writes` 增量为 0（一条写请求都没到 CF），非法 body 那批还额外要求 `cache.cfCalls` 增量为 0
 * （连只读都没碰）。docs/09 §B5 那条 purge 事故的本质就是"我们以为会被拒的请求其实执行了"，
 * 所以这个断言不能用状态码代替。
 *
 * 不打印任何令牌内容，只打印长度。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const BASE = arg("base", "http://127.0.0.1:8788").replace(/\/$/, "");
const RANGE = arg("range", "7d");

const tokFile = resolve(ROOT, "app/gateway/.device-token");
if (!existsSync(tokFile)) {
  console.error("找不到 app/gateway/.device-token —— 先在网关目录生成设备令牌");
  process.exit(2);
}
const TOK = readFileSync(tokFile, "utf8").trim();

let pass = 0, fail = 0;
const rows = [];

/** 出网账本：cf.ts 的计数器从 /health 的 cache 段读，本机 wrangler dev 只有一个 isolate，差值就是真值 */
async function counters() {
  const res = await fetch(BASE + "/health", { signal: AbortSignal.timeout(10000) });
  const j = await res.json().catch(() => null);
  return { calls: Number(j?.cache?.cfCalls ?? -1), writes: Number(j?.cache?.writes ?? -1), writesFlag: j?.writes };
}

async function hit(name, path, expect = 200, opts = {}) {
  const t0 = Date.now();
  let http = 0, body = null, note = "", hdrCalls = null;
  const needLedger = !!opts.ledger;
  const before = needLedger ? await counters() : null;
  try {
    const res = await fetch(BASE + path, {
      headers: opts.noAuth ? {} : { "x-device-token": TOK, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      method: opts.method || "GET",
      body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeout ?? 30000),
    });
    http = res.status;
    hdrCalls = res.headers.get("x-gw-cf-calls");
    body = await res.json().catch(() => null);
  } catch (e) {
    note = "请求异常 " + String(e?.message || e).slice(0, 60);
  }
  const ms = Date.now() - t0;
  const kind = body?.error?.kind;

  let ok = http === expect;
  if (ok && opts.kind) ok = kind === opts.kind;
  if (ok && opts.header) {
    const why = opts.header(hdrCalls);
    if (why) { ok = false; note = why; }
  }
  if (ok && opts.check) {
    try { note = opts.check(body) || ""; } catch (e) { ok = false; note = "断言抛错 " + e.message; }
  }
  if (ok && needLedger) {
    const after = await counters();
    const d = { calls: after.calls - before.calls, writes: after.writes - before.writes };
    if (d.calls < 0 || d.writes < 0) { ok = false; note = "读不到出网计数器（/health 的 cache 段没这两个字段？）"; }
    else {
      const why = opts.ledger(d);
      if (why) { ok = false; note = why; }
      else note = `出网 writes=${d.writes} calls=${d.calls}`;
    }
  }
  if (!note && body?.error?.message) note = String(body.error.message).slice(0, 60);

  (ok ? (pass++, rows) : (fail++, rows)).push({ name, path, http, ms, ok, note });
  console.log(`${ok ? "✓" : "✗"} ${String(http).padEnd(4)} ${String(ms).padStart(5)}ms  ${name}${note ? "  — " + note : ""}`);
  return body;
}

/** 取数组长度，容忍多种信封 */
const len = (v) => (Array.isArray(v) ? v.length : Array.isArray(v?.result) ? v.result.length : -1);

console.log(`\n网关冒烟  ${BASE}  range=${RANGE}  令牌长度=${TOK.length}（值不打印）\n`);

console.log("— 闸门 —");
await hit("无令牌访问 /v1/account", "/v1/account", 401, { noAuth: true, kind: "auth" });
await hit("/health（不需要令牌）", "/health", 200, { check: (b) => { if (!b?.ok) throw new Error("health 没返回 ok"); return `writes=${b.writes}`; } });
/** 写侧模式自动判定：disabled 时断言 501（回滚依据），enabled 时断言 422 闸门 */
const WRITES = (await counters()).writesFlag === "enabled";
console.log(`  · 网关写开关：WRITE_ENABLED=${WRITES ? "true（写侧闸门按 422 验）" : "未开（非 GET 按 501 验）"}`);
await hit("未知路由", "/v1/nope", 404, { kind: "notFound" });
await hit("非法枚举 dim", "/v1/traffic/top?dim=%3Bdrop&range=7d", 422, { kind: "badQuery" });
await hit("POST /v1/zones 不在写白名单", "/v1/zones", 501, {
  method: "POST",
  body: {},
  kind: "writesDisabled",
  ledger: (d) => (d.writes || d.calls ? `拦下了还出网：writes=${d.writes} calls=${d.calls}` : ""),
});

console.log("\n— 账号与流量 —");
await hit("account", "/v1/account", 200, { check: (b) => `账号 ${b?.result?.[0]?.name ?? "?"}` });
await hit("zones", "/v1/zones", 200, { check: (b) => `${len(b?.result)} 个站点` });
await hit(`overview?range=${RANGE}`, `/v1/overview?range=${RANGE}`, 200, {
  check: (b) => {
    // overview 的键是网关自己定的：range / days / consoleTotals / series / status / countries / prev
    const need = ["consoleTotals", "series", "status", "countries", "prev"];
    const miss = need.filter((k) => !(k in b));
    if (miss.length) throw new Error("overview 缺键 " + miss.join(","));
    const days = b?.consoleTotals?.value?.viewer?.accounts?.[0]?.g || [];
    const sum = days.reduce((a, d) => a + (d?.sum?.requests || 0), 0);
    // 环比（看板那三个界面包都在等这个字段）。三种状态必须能分开：
    //   整个 prev 缺失 = 网关没算；字段是 null = 算了没取到（必须带 error）；数字（含 0）= 真值
    const p = b.prev;
    const pf = ["reqs", "bytes", "visits", "threats"];
    const pmiss = pf.filter((k) => !(k in p));
    if (pmiss.length) throw new Error("prev 缺字段 " + pmiss.join(","));
    if (typeof p.range !== "string" || !p.range) throw new Error("prev.range 不是上一窗描述串");
    const pbad = pf.filter((k) => p[k] !== null && typeof p[k] !== "number");
    if (pbad.length) throw new Error("prev 字段类型不对：" + pbad.map((k) => `${k}=${typeof p[k]}`).join(","));
    if (pf.some((k) => p[k] === null) && !p.error) throw new Error("prev 有 null 字段却没带 error，界面上分不清「取不到」和「没算」");
    return `${b.days} 天 · 1dGroups 合计 requests=${sum} · prev[${p.range.slice(0, 24)}]=` + pf.map((k) => (p[k] === null ? "—" : p[k])).join("/");
  },
});
// 同一个 handler 的第二个名字（写侧需求里给的路径），只验键在、不重跑出网
await hit("traffic/overview（/v1/overview 的别名）", `/v1/traffic/overview?range=${RANGE}`, 200, {
  check: (b) => {
    if (!("prev" in b)) throw new Error("别名路由没带 prev，两个名字的形状必须一致");
    return `range=${b.range} prev=${typeof b.prev?.reqs}`;
  },
});
for (const [n, p] of [
  ["traffic/series", `/v1/traffic/series?range=${RANGE}`],
  ["traffic/status", `/v1/traffic/status?range=${RANGE}`],
  ["traffic/origin", `/v1/traffic/origin?range=${RANGE}`],
  ["traffic/totals", `/v1/traffic/totals?range=${RANGE}`],
  ["traffic/countries", `/v1/traffic/countries?range=${RANGE}`],
  ["traffic/top?dim=host", `/v1/traffic/top?dim=host&range=${RANGE}`],
  ["traffic/top?dim=path", `/v1/traffic/top?dim=path&range=${RANGE}`],
  ["traffic/top?dim=bot", `/v1/traffic/top?dim=bot&range=${RANGE}`],
  ["traffic/adaptive?dim=cache", `/v1/traffic/adaptive?dim=cache&range=${RANGE}`],
  ["traffic/adaptive?dim=device", `/v1/traffic/adaptive?dim=device&range=${RANGE}`],
]) {
  await hit(n, p, 200, { check: (b) => { const n2 = len(b?.rows ?? b?.result); return n2 >= 0 ? `${n2} 行` : ""; } });
}

console.log("\n— 多账号（读侧）—");
// 三条分别验：列表可用 / 真 id 能透传 / 假 id 被 422 挡在门口（不会拼进 CF 路径）。
// 注意最后一条：/v1/accounts 自身豁免 ?account=，否则存储里的账号失效时设置页会自锁。
const accts = await hit("accounts", "/v1/accounts", 200, {
  check: (b) => {
    const list = Array.isArray(b?.result) ? b.result : null;
    if (!list) throw new Error("result 不是数组");
    if (!list.length) throw new Error("账号列表为空");
    if (!list.some((a) => a?.id === b?.active)) throw new Error("active 不在列表里");
    return `${list.length} 个账号 · active=${String(b.active).slice(0, 8)}…`;
  },
});
const realId = String(accts?.active || "");
const bogusId = "0".repeat(32);
if (realId) {
  await hit("workers?account=真 id", `/v1/workers?account=${realId}`, 200, {
    check: (b) => `${len(b?.result)} 个 Worker（与默认账号同一把令牌，所以数字应当一致）`,
  });
}
await hit("workers?account=全零 id", `/v1/workers?account=${bogusId}`, 422, { kind: "badQuery" });
await hit("zones?account=形状不对", "/v1/zones?account=deadbeef", 422, { kind: "badQuery" });
await hit("accounts 豁免 account 参数", `/v1/accounts?account=${bogusId}`, 200, {
  check: (b) => (Array.isArray(b?.result) && b.result.length ? `${b.result.length} 个账号仍可取` : "列表为空"),
});

console.log("\n— Workers —");
const workers = await hit("workers 列表", "/v1/workers", 200, { check: (b) => `${len(b?.result)} 个 Worker` });
// 脚本只读，但 versions/{v} 要用真实版本 ID，所以挑一个版本数多的（rin-server）而不是列表第一个（可能是个空壳）
const first = (workers?.result || []).find((w) => (w.id || w.name) === "rin-server") || (workers?.result || [])[0];
const name = encodeURIComponent(first?.id || first?.name || "");
if (name) {
  const vs = await hit(`workers/${first.id}/versions`, `/v1/workers/${name}/versions?per_page=5`, 200, {
    check: (b) => {
      const it = b?.result || [];
      if (it.length && !it[0].id) throw new Error("版本条目没有 id 字段，接口形状变了");
      // total 来自 CF 顶层 result_info.total_count。曾经因为 listify 只看 result 内层而丢过（docs/09 §E12）。
      if (it.length && typeof b?.total !== "number") throw new Error("versions 缺 total（result_info.total_count 没透传，分页会退化成\"不满一页=到底\"）");
      return `${it.length} 条 / 共 ${b?.total ?? "?"}（最新 #${it[0]?.number ?? "?"}）`;
    },
  });
  const vid = vs?.result?.[0]?.id;
  if (vid) await hit(`workers/${first.id}/versions/{v}`, `/v1/workers/${name}/versions/${vid}`, 200, {
    check: (b) => {
      const rt = b?.result?.resources?.script_runtime || {};
      const sc = b?.result?.resources?.script || {};
      if (!rt.compatibility_date) throw new Error("详情里没有 resources.script_runtime.compatibility_date");
      return `compat=${rt.compatibility_date} handlers=${(sc.handlers || []).join("/")}`;
    },
  });
  for (const p of ["deployments", "settings", "secrets", "crons"]) {
    await hit(`workers/${first.id}/${p}`, `/v1/workers/${name}/${p}`, 200);
  }
  // script-settings 与 settings 是两条不同路由，observability/logpush 只有前者返回（docs/08 §6.1）。
  // 界面"Observability"那行现在完全依赖这里的字段存在，所以做成断言而不是打印。
  await hit(`workers/${first.id}/script-settings`, `/v1/workers/${name}/script-settings`, 200, {
    check: (b) => {
      const r = b?.result || {};
      if (!("logpush" in r) || !("observability" in r)) throw new Error("script-settings 缺 logpush/observability 字段，界面那两行会退回\"拿 undefined 猜关闭\"");
      return `logpush=${r.logpush} observability=${r.observability === null ? "null（未显式配置）" : JSON.stringify(r.observability)}`;
    },
  });
  await hit(`workers/${first.id}/subdomain`, `/v1/workers/${name}/subdomain`, 200, {
    check: (b) => `workers.dev=${b?.result?.enabled ? "启用" : "关闭"} 预览=${b?.result?.previews_enabled ? "开" : "关"}`,
  });
} else {
  console.log("! 账号里没有 Worker，跳过版本/部署相关路由");
}

console.log("\n— 域名 / DNS / Pages —");
await hit("workers/domains", "/v1/domains", 200, {
  check: (b) => {
    const it = b?.result?.[0];
    if (it && ("verified" in it || "created_on" in it)) throw new Error("接口形状变了：出现了 verified/created_on，去更新 docs/09 §E9");
    return `${len(b?.result)} 个自定义域名（无 verified/created_on 字段，符合预期）`;
  },
});
const zones = await hit("zones（取第一个 zone_tag）", "/v1/zones", 200);
const zt = zones?.result?.[0]?.id;
if (zt) {
  await hit("dns_records", `/v1/zones/${zt}/dns_records`, 200, { check: (b) => `${len(b?.result)} 条记录` });
  await hit("zone routes", `/v1/zones/${zt}/routes`, 200, { check: (b) => `${len(b?.result)} 条路由` });
  // WAF 只读三阶段：empty（没配过规则，404/10003）与 unsupported（套餐不认 phase 名，400）都是**正常结果**，
  // 只有 error/denied 才是真出事 —— 这条断言保证网关没把"没配规则"误报成"没权限"（docs/09 §E14）。
  await hit("zone waf（只读三 phase）", `/v1/zones/${zt}/waf`, 200, {
    check: (b) => {
      const ps = b?.phases || [];
      if (ps.length !== 3) throw new Error("waf 应固定返回 3 个 phase，实际 " + ps.length);
      const bad = ps.filter((p) => p.state === "error" || p.state === "denied");
      if (bad.length) throw new Error("waf 有阶段异常：" + bad.map((p) => `${p.phase}=${p.state}`).join(","));
      if (typeof b?.ruleCount !== "number") throw new Error("waf 缺 ruleCount");
      return ps.map((p) => `${p.label}:${p.state}(${p.rules.length})`).join(" ") + ` · 合计 ${b.ruleCount} 条`;
    },
  });
} else {
  console.log("! 没有 zone，跳过 DNS/路由/设置");
}
await hit("pages 项目", "/v1/pages", 200, { check: (b) => `${len(b?.result)} 个项目（0 = 风险 A1 仍在）` });

console.log("\n— 存储（D1 / KV / R2）与 Zero Trust —");
const dbs = await hit("d1 列表", "/v1/d1", 200, { check: (b) => `${len(b?.result)} 个库` });
const dbId = dbs?.result?.[0]?.uuid;
if (dbId) {
  /**
   * D1 SQL 这条是 10-11 那轮"点执行必 404"的回归位：前端只会发 GET，而这条路由以前注册的是
   * app.post；同一次修复里还漏了第二个形状问题 —— 直接把 `reads.d1Query()` 返回给界面会甩出
   * `{data:[…]}`，界面读 `result[0].results` 就永远空。所以这里两个都断言，少一个都会红。
   */
  await hit("d1 query（GET + {result:[{results}]} 信封）", `/v1/d1/${dbId}/query?sql=${encodeURIComponent("SELECT 1 AS ok")}`, 200, {
    check: (b) => {
      if (!Array.isArray(b?.result)) throw new Error("信封不对：缺 result 数组（拿到 " + Object.keys(b || {}).join(",") + "）");
      if (!Array.isArray(b.result[0]?.results)) throw new Error("result[0].results 不是数组，界面 queryRows 会空");
      if (b.result[0]?.meta?.duration === undefined) throw new Error("缺 meta.duration，界面那行耗时没得显示");
      return `${b.result[0].results.length} 行 · 读 ${b.result[0].meta.rows_read} · ${(b.result[0].meta.duration * 1000).toFixed(0)}ms`;
    },
  });
} else {
  console.log("! 账号里没有 D1 库，跳过 query 路由");
}
await hit("kv 列表", "/v1/kv", 200, { check: (b) => `${len(b?.result)} 个命名空间` });
// R2 不在这份断言里：这个账号 CF 侧就 404 10015（未开通），断言状态码等于把账号状态写进基线。
// 它只需要保证"网关有这条路由"，那是 check:routes 静态管的（tools/check-route-parity.mjs）。
await hit("zt 组织", "/v1/zt/organization", 200, {
  check: (b) => {
    const r = b?.result;
    if (!r || Array.isArray(r)) throw new Error("组织信息应是对象信封，界面 .kv 那块会空");
    return `auth_domain=${r.auth_domain ? "有" : "无"} 只读锁=${typeof r.is_ui_read_only === "boolean" ? r.is_ui_read_only : "缺字段"}`;
  },
});
for (const p of ["apps", "groups", "policies"]) {
  await hit(`zt ${p}`, `/v1/zt/${p}`, 200, { check: (b) => `${len(b?.result)} 条（0 = 确实没配，不是没取到）` });
}

/*
 * Workers 每日额度那块的两个数据来源。用量这条的断言是**对着界面写的**：
 * WorkersQuota.vue 读 result.events 判"有没有数"、读 result.from/to 才能把"今日"这个窗口标出来，
 * 少任何一个字段，界面就会把"接口给了对象"显示成空白卡（D1 那次信封泄漏就是同一个坑）。
 */
await hit("workers 今日用量", "/v1/workers/usage", 200, {
  check: (b) => {
    const r = b?.result;
    if (!r || Array.isArray(r)) throw new Error("result 应是对象信封（拿到 " + Object.keys(b || {}).join(",") + "）");
    if (typeof r.events !== "number") throw new Error("缺 result.events，额度那条没数");
    if (!Array.isArray(r.breakdown)) throw new Error("缺 result.breakdown 数组");
    if (typeof r.from !== "number" || typeof r.to !== "number") throw new Error("缺 from/to，界面不能写成「今日」");
    if (r.to - r.from > 86_400_000) throw new Error("默认窗口超过一天，「今日」这个说法就不成立了");
    return `${r.events} 条事件 · ${r.breakdown.length} 个 Worker`;
  },
});
// 参数只认 epoch 毫秒：ISO 串会被 CF 当成 NaN，网关提前 422 并把出网账本按住为零
await hit("workers 用量：from 传日期字符串 → 422 且不出网", "/v1/workers/usage?from=2026-10-11", 422, {
  kind: "badQuery",
  header: (v) => (v === "0" ? "" : `x-gw-cf-calls 应为 "0"，实际 ${v}`),
});
await hit("workers 用量：from 回溯超过 90 天 → 422 且不出网", `/v1/workers/usage?from=${Date.now() - 91 * 86_400_000}`, 422, {
  kind: "badQuery",
  header: (v) => (v === "0" ? "" : `x-gw-cf-calls 应为 "0"，实际 ${v}`),
});
await hit("订阅（界面只取套餐标识）", "/v1/subscriptions", 200, {
  check: (b) => {
    if (!Array.isArray(b?.result)) throw new Error("result 不是数组");
    if (b.result.some((s) => s && typeof s === "object" && ("client_secrets" in s || "rate_plan" in s))) {
      throw new Error("原始订阅字段没减干净：client_secrets / rate_plan 不该发给设备");
    }
    const ids = [...new Set(b.result.map((s) => s?.plan).filter(Boolean))];
    if (!ids.length) throw new Error("没拿到套餐标识，界面那行「套餐」只能显示没取到");
    return ids.join(" / ");
  },
});

/* ============================================================================
 * 写侧闸门。一条真写都不发 —— 每次断言都带出网账本差值，因为"状态码看着像被拦住了"
 * 不等于"没出网"（docs/09 §B5 那条 purge 就是这么栽的：CF 对 files:[123] 回 200 并执行）。
 *   ZERO_EGRESS：writes 增量 0 且 calls 增量 0 —— 校验不过连 GET /zones 都不该碰
 *   WRITE_ONLY  ：writes 增量必须 0；calls 允许 ≤1（zone 可见集合那一次只读，命中缓存时为 0）
 * ========================================================================== */
const ZERO_LEDGER = {
  ledger: (d) => (d.writes || d.calls ? `拦下了还出网：writes=${d.writes} calls=${d.calls}` : ""),
};
// x-gw-cf-calls 这个头只有走 route() 包装的响应才有（401/501 是中间件直接回的），所以只配给 422 用例
const ZERO_EGRESS = {
  ...ZERO_LEDGER,
  header: (v) => (v === "0" ? "" : `x-gw-cf-calls 应为 "0"，实际 ${v}`),
};
const WRITE_ONLY = {
  ledger: (d) => (d.writes ? `拦下了但写请求出网了：writes=${d.writes}` : d.calls > 1 ? `多出网 ${d.calls} 次（zone 可见集合没命中缓存？）` : ""),
};

const ZERO_ZONE = "0".repeat(32);
const ZERO_RECORD = "0".repeat(32);
const GHOST_RECORD = "f".repeat(32);
const okDns = { name: "smoke-gw-invalid", type: "A", content: "203.0.113.10", ttl: 1, proxied: false };

console.log(`\n— 写侧（WRITE_ENABLED=${WRITES ? "true" : "未开"}）—`);
await hit("无令牌的 DELETE 仍然先 401", `/v1/zones/${ZERO_ZONE}/dns_records/${GHOST_RECORD}`, 401, { noAuth: true, method: "DELETE", ...ZERO_LEDGER });

if (!WRITES) {
  // 回滚依据：secret 删掉之后四条写路由必须全部 501，而且一条都没出网
  await hit("POST dns_records → 501", `/v1/zones/${ZERO_ZONE}/dns_records`, 501, { method: "POST", body: okDns, kind: "writesDisabled", ...ZERO_LEDGER });
  await hit("PUT dns_records → 501", `/v1/zones/${ZERO_ZONE}/dns_records/${GHOST_RECORD}`, 501, { method: "PUT", body: okDns, kind: "writesDisabled", ...ZERO_LEDGER });
  await hit("DELETE dns_records → 501", `/v1/zones/${ZERO_ZONE}/dns_records/${GHOST_RECORD}`, 501, { method: "DELETE", kind: "writesDisabled", ...ZERO_LEDGER });
  await hit("POST purge_cache → 501", `/v1/zones/${ZERO_ZONE}/purge_cache`, 501, { method: "POST", body: { files: ["https://smoke.invalid/a.png"] }, kind: "writesDisabled", ...ZERO_LEDGER });
  await hit("PATCH 不在白名单 → 501", `/v1/zones/${ZERO_ZONE}/dns_records/${GHOST_RECORD}`, 501, { method: "PATCH", body: okDns, kind: "writesDisabled", ...ZERO_LEDGER });
} else {
  console.log("  · 闸门三：请求体逐字段校验（DNS）");
  const post = (name, body, extra = {}) => hit(name, `/v1/zones/${extra.zone || ZERO_ZONE}/dns_records`, extra.expect ?? 422, { method: "POST", body, kind: "badQuery", ...ZERO_EGRESS, ...extra.opts });
  await post("DNS 非法记录名（有空格）", { ...okDns, name: "bad name" });
  await post("DNS 非法类型", { ...okDns, type: "NOPE" });
  await post("DNS 类型小写归一化后照样拦非法 IPv4", { ...okDns, type: "a", content: "203.0.113.999" });
  await post("DNS A 记录内容不是 IPv4", { ...okDns, content: "203.0.113.999" });
  await post("DNS AAAA 内容不是 IPv6", { ...okDns, type: "AAAA", content: "::::" });
  await post("DNS TTL 60（既不是自动也不到 120）", { ...okDns, ttl: 60 });
  await post("DNS TTL 传字符串", { ...okDns, ttl: "120" });
  await post("DNS proxied 传字符串", { ...okDns, proxied: "true" });
  await post("DNS TXT 不能开代理", { ...okDns, type: "TXT", content: "v=smoke", proxied: true });
  await post("DNS 已代理但 TTL 不是自动", { ...okDns, proxied: true, ttl: 300 });
  await post("DNS MX 缺优先级", { ...okDns, type: "MX", content: "mail.example.com" });
  await post("DNS A 记录给了优先级", { ...okDns, priority: 10 });
  await post("DNS 带白名单外的字段", { ...okDns, meta: { a: 1 } });
  await hit("DNS 请求体不是 JSON", `/v1/zones/${ZERO_ZONE}/dns_records`, 422, { method: "POST", body: "name=smoke&type=A", kind: "badQuery", ...ZERO_EGRESS });
  await hit("DNS 请求体是数组", `/v1/zones/${ZERO_ZONE}/dns_records`, 422, { method: "POST", body: [okDns], kind: "badQuery", ...ZERO_EGRESS });

  console.log("  · 闸门三：清缓存（§B5 那条红线只能从源头拦）");
  const purge = (name, body) => hit(name, `/v1/zones/${ZERO_ZONE}/purge_cache`, 422, { method: "POST", body, kind: "badQuery", ...ZERO_EGRESS });
  await purge("purge 空数组", { files: [] });
  await purge("purge 带通配符 *", { files: ["https://*.acct.example.com/a"] });
  await purge("purge 条目是数字（§B5 那次真的执行了的写法）", { files: [123] });
  await purge("purge 是 http 不是 https", { files: ["http://acct.example.com/a"] });
  await purge("purge 不是完整 URL", { files: ["acct.example.com/a"] });
  await purge("purge 带片段 #", { files: ["https://acct.example.com/a#x"] });
  await purge("purge files 不是数组", { files: "https://acct.example.com/a" });
  await purge("purge 全站清空", { purge_everything: true });
  await hit("purge 31 条超上限", `/v1/zones/${ZERO_ZONE}/purge_cache`, 422, {
    method: "POST",
    body: { files: Array.from({ length: 31 }, (_, i) => `https://acct.example.com/smoke-${i}.png`) },
    kind: "badQuery",
    ...ZERO_EGRESS,
  });

  console.log("  · 闸门三：只允许删自己创建的记录（现有 15 条一条都不能少）");
  await hit("DELETE 全零 record id", `/v1/zones/${ZERO_ZONE}/dns_records/${ZERO_RECORD}`, 422, { method: "DELETE", kind: "badQuery", ...ZERO_EGRESS });
  if (zt) {
    // 真 zone id 也要拦住：这条证明"删除账本"这道闸和 zone 可见集合是两件事，缺一不可
    await hit("DELETE 真 zone 下网关没建过的 id", `/v1/zones/${zt}/dns_records/${GHOST_RECORD}`, 422, { method: "DELETE", kind: "badQuery", ...ZERO_EGRESS });
    await hit("PUT 真 zone + 非法 record id 形状", `/v1/zones/${zt}/dns_records/not-hex`, 422, { method: "PUT", body: okDns, kind: "badQuery", ...ZERO_EGRESS });
  }

  console.log("  · 闸门三：zone 片段必须过可见集合白名单");
  await hit("POST dns_records + 全零 zone id", `/v1/zones/${ZERO_ZONE}/dns_records`, 422, { method: "POST", body: okDns, kind: "badQuery", ...WRITE_ONLY });
  await hit("PUT dns_records + 全零 zone id", `/v1/zones/${ZERO_ZONE}/dns_records/${GHOST_RECORD}`, 422, { method: "PUT", body: okDns, kind: "badQuery", ...WRITE_ONLY });
  await hit("POST purge_cache + 全零 zone id", `/v1/zones/${ZERO_ZONE}/purge_cache`, 422, { method: "POST", body: { files: ["https://smoke.invalid/a.png"] }, kind: "badQuery", ...WRITE_ONLY });
  await hit("POST dns_records + zone 形状不对", `/v1/zones/deadbeef/dns_records`, 422, { method: "POST", body: okDns, kind: "badQuery", ...ZERO_EGRESS });
  await hit("PATCH 已注册路径 → 仍然 501（动词不在白名单）", `/v1/zones/${ZERO_ZONE}/dns_records/${GHOST_RECORD}`, 501, { method: "PATCH", body: okDns, kind: "writesDisabled", ...WRITE_ONLY });
}

/* CORS 预检：写动词没在 access-control-allow-methods 里的话，手机上的 PUT/DELETE 根本到不了网关 */
{
  const res = await fetch(BASE + `/v1/zones/${ZERO_ZONE}/dns_records`, {
    method: "OPTIONS",
    headers: { origin: "https://cf.acct.example.com", "access-control-request-method": "DELETE", "access-control-request-headers": "x-device-token,content-type" },
    signal: AbortSignal.timeout(15000),
  });
  const m = res.headers.get("access-control-allow-methods") || "";
  const miss = ["GET", "POST", "PUT", "DELETE"].filter((x) => !m.includes(x));
  (miss.length ? (fail++, rows) : (pass++, rows)).push({ name: "CORS 预检允许写动词", path: "-", http: res.status, ok: !miss.length, note: miss.length ? "缺 " + miss.join(",") : m });
  console.log(`${miss.length ? "✗" : "✓"} ${String(res.status).padEnd(4)} ${String(0).padStart(5)}ms  CORS 预检 allow-methods — ${m || "(没有这个头)"}`);
}

console.log(`\n合计 ${pass} 通过 / ${fail} 失败`);
if (fail) console.log("失败的行见上面带 ✗ 的条目；路由白名单定义在 app/gateway/src/catalog.ts");
// 同 tools/check-pwa-assets.mjs：本机 Node 24 + Windows 上，还有 keep-alive socket 在收尾时调
// process.exit() 会触发 libuv 断言、进程以 127 收场 —— 全绿也变成"失败"，所以只设 exitCode。
process.exitCode = fail ? 1 : 0;
