// 第六轮：把 cf-mobile（Apache-2.0）源码里的"rulesets phase 404 = 正常空态"这条经验，
// 在我们自己的 zone 上重测一遍 —— 决定 docs/09 D3 那句"WAF 面板第一版不做"到底是套餐限制还是只是空态。
// 只读：全部 GET，不打印令牌。结果写 docs/evidence/rulesets-phases.json
import { writeFileSync } from "node:fs";
import { loadCreds } from "./lib/token.mjs";

const { tok: TOK, acc: ACC } = loadCreds();
const H = { authorization: "Bearer " + TOK, "content-type": "application/json" };
const B = "https://api.cloudflare.com/client/v4";
const out = {};

// 我们账号里实际有哪些 zone（不硬编码，避免以后加了 zone 又要改脚本）
const zr = await fetch(B + "/zones?per_page=20", { headers: H }).then((x) => x.json());
const zones = (zr.result ?? []).map((z) => ({ id: z.id, name: z.name }));
console.log("zones:", zones.map((z) => z.name).join(", "));

const PHASES = [
  "entry",
  "pre-scrub",
  "http_request_security_rule", // 自定义规则所在阶段
  "http_ratelimit",
  "scrub_off", // 托管规则关闭项，合法阶段名
  "post-scrub",
  "http_request_firewall_managed",
  "http_request_firewall_custom",
  "http_request_cache_settings",
  "http_response_managed_settings",
];

async function api(label, path) {
  try {
    const r = await fetch(B + path, { headers: H, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    let brief;
    try {
      const j = JSON.parse(t);
      brief = j.errors?.length
        ? "E " + j.errors.map((x) => (x.code ?? "") + " " + x.message).join("|")
        : JSON.stringify(j.result ?? j).slice(0, 160);
    } catch {
      brief = t.slice(0, 160).replace(/\s+/g, " ");
    }
    console.log(label.padEnd(46), r.status, String(brief).slice(0, 170));
    out[label] = { path, status: r.status, body: t.slice(0, 2500) };
    return { status: r.status, text: t };
  } catch (e) {
    console.log(label.padEnd(46), "FAIL", e.cause?.code || e.message);
    out[label] = { path, status: 0, error: String(e.cause?.code || e.message) };
    return { status: 0, text: "" };
  }
}

for (const z of zones) {
  console.log(`\n=== zone ${z.name} (${z.id}) ===`);
  // 1) 阶段入口：cf-mobile 说没有配过规则的阶段会 404，这是空态不是错误
  for (const p of PHASES) {
    await api(`entrypoint ${p}`, `/zones/${z.id}/rulesets/phases/${p}/entrypoint`);
  }
  // 2) 全量 ruleset 列表（看这个 zone 到底有几个 ruleset、哪些 phase）
  await api("rulesets 列表", `/zones/${z.id}/rulesets`);
  // 3) 账号级阶段入口（免费套餐未必可用）
  await api("account entrypoint http_request_firewall_custom", `/accounts/${ACC}/rulesets/phases/http_request_firewall_custom/entrypoint`);
}

// 从 404 的响应体里把错误码抠出来，方便对照 docs/05 §2 的错误码表
const codes = {};
for (const [k, v] of Object.entries(out)) {
  const m = /"code":\s*(\d+)/.exec(v.body || "");
  if (v.status === 404) codes[k] = m ? m[1] : "no-code";
}
console.log("\n404 的错误码分布:", JSON.stringify(codes));
out.__summary = { zones, codes_404: codes };

writeFileSync("docs/evidence/rulesets-phases.json", JSON.stringify(out, null, 2));
console.log("\n已写入 docs/evidence/rulesets-phases.json");
