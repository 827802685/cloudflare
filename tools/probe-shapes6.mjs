// 第六轮形状核对：把 `docs/08` §6 交叉核对里"同类 App 调过、我们没测过"的端点逐个落地。
// 原则：GET 是纯读；带写动词的只打**必然不存在的 id + 空 body**，用错误码判断路由是否存在（沿用 docs/09 §F 的口径，不产生任何变更）。
// 不打印令牌。结果写 docs/evidence/probe6.json
import { writeFileSync } from "node:fs";
import { loadCreds } from "./lib/token.mjs";

const { tok: TOK, acc: ACC } = loadCreds();
const H = { authorization: "Bearer " + TOK, "content-type": "application/json" };
const B = "https://api.cloudflare.com/client/v4";
const out = {};
const FAKE = "00000000-0000-4000-8000-000000000000"; // 不存在的 UUID，专门用来区分 405(动词错) / 404(资源不存在) / 10000(没权限)
const SCRIPT = "rin-server";
const VER = "e0b67a07-8532-4843-b2ff-f27029fc135b"; // 真实存在过的版本号，只用于 GET 详情

async function api(label, path, opt) {
  try {
    const r = await fetch(B + path, { headers: H, ...(opt || {}), signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    let brief;
    try {
      const j = JSON.parse(t);
      brief = j.errors?.length ? "E " + j.errors.map((x) => (x.code ?? "no-code") + " " + x.message).join("|") : JSON.stringify(j.result ?? j).slice(0, 140);
    } catch { brief = t.slice(0, 140).replace(/\s+/g, " "); }
    console.log(label.padEnd(44), r.status, String(brief).slice(0, 150));
    out[label] = { path, method: opt?.method || "GET", status: r.status, body: t.slice(0, 2500) };
  } catch (e) {
    console.log(label.padEnd(44), "FAIL", e.cause?.code || e.message);
    out[label] = { path, method: opt?.method || "GET", status: 0, error: String(e.cause?.code || e.message) };
  }
}

console.log("=== Workers：同类 App 调过、我们没测的读接口 ===");
await api("script-settings GET", `/accounts/${ACC}/workers/scripts/${SCRIPT}/script-settings`);
await api("deployments/{id} GET(假 id)", `/accounts/${ACC}/workers/scripts/${SCRIPT}/deployments/${FAKE}`);
// 用真实存在的生产部署 ID（读侧证据 responses.sample.json 里那个）确认"详情路由"到底存不存在，
// 否则我们只会得到一个 404，没法区分"路由不存在"和"这个 id 没部署"。
await api("deployments/{id} GET(真实 id)", `/accounts/${ACC}/workers/scripts/${SCRIPT}/deployments/7f9ad0a6-2aa5-4168-bad4-e080011df277`);
await api("worker subdomain GET", `/accounts/${ACC}/workers/subdomain`);
await api("script subdomain GET", `/accounts/${ACC}/workers/scripts/${SCRIPT}/subdomain`);
await api("versions/{v} GET（已在 B2 测过，复跑对照）", `/accounts/${ACC}/workers/scripts/${SCRIPT}/versions/${VER}`);

console.log("\n=== Workers：路由存在性（不带写动词碰生产脚本）===");
// 这一组用「不存在的脚本名 / 假 id」，确保即使路由存在也不可能改成任何东西：
// 服务端一定先校验资源存在（10007 Worker does not exist）或校验 payload，落不到"真部署"那一步。
// 代价是错误码会被"资源不存在"混淆，只能判断"路由存在 + 鉴权通过"，不能判断业务语义 —— 业务语义留给 docs/11 §4.4 的测试 Worker。
const NOPE = "__probe-nonexistent-worker__";
await api("domains PATCH(假 id)", `/accounts/${ACC}/workers/domains/${FAKE}`, { method: "PATCH", body: "{}" });
await api("workers/workers/{id}/versions DELETE(假)", `/accounts/${ACC}/workers/workers/${NOPE}/versions/${FAKE}`, { method: "DELETE" });
await api("versions/{v}/deploy POST(假 worker)", `/accounts/${ACC}/workers/scripts/${NOPE}/versions/${FAKE}/deploy`, { method: "POST", body: "{}" });
await api("secrets-bulk PATCH(假 worker)", `/accounts/${ACC}/workers/scripts/${NOPE}/secrets-bulk`, { method: "PATCH", body: "{}" });

console.log("\n=== Pages：假项目下的读接口（只看错误码是 8000007 还是权限）===");
await api("pages deployments/{id}", `/accounts/${ACC}/pages/projects/__none__/deployments/${FAKE}`);
await api("pages deployments/{id}/history/logs", `/accounts/${ACC}/pages/projects/__none__/deployments/${FAKE}/history/logs`);
await api("pages upload-token", `/accounts/${ACC}/pages/projects/__none__/upload-token`);

writeFileSync("docs/evidence/probe6.json", JSON.stringify(out, null, 2));
console.log("\n已写入 docs/evidence/probe6.json");
