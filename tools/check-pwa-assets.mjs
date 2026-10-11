#!/usr/bin/env node
/**
 * PWA 装机面自检：把 index.html 与 manifest 里**引用到的每一个 URL**真的拉一遍，
 * 校验"状态码 200 且类型对"，而不是只看 200。
 *
 * 为什么必须校验类型（2026-10-10 实测踩到的）：vite preview / 静态托管对不存在的路径会走 SPA
 * history 回落，返回的是 **200 + text/html + 那 1 KB 的 index.html**。所以图标路径写错时，
 * 只 curl 状态码会一路绿灯，浏览器却拿到一个"是 HTML 的 PNG"，表现为主屏图标是空白 —— 而空白图标
 * 在装机体验里等于"这 App 不正规"。今天就是这样才发现 `/icon-maskable-512.png` 根本不存在。
 *
 * 用法：
 *   cd app/console && npm run build && npm run preview -- --port 4174
 *   node tools/check-pwa-assets.mjs                      # 默认打 http://localhost:4174
 *   node tools/check-pwa-assets.mjs --base http://127.0.0.1:4174
 *   # 网关上线后同一份检查可以直接对着部署地址跑（前端和 /api 同源时才有意义）
 *
 * 只读：只发 GET，不改任何文件。
 */
import { extname } from "node:path";

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const BASE = String(arg("base", "http://localhost:4174")).replace(/\/+$/, "");

/** 扩展名 → 允许的 content-type 前缀。HTML 回落一定落进"不匹配"。 */
const WANT = {
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".svg": ["image/svg+xml"],
  ".js": ["text/javascript", "application/javascript", "application/ecmascript"],
  ".css": ["text/css"],
  ".webmanifest": ["application/manifest+json", "application/json"],
  ".json": ["application/json"],
  ".woff2": ["font/woff2", "application/font-woff2"],
};

const results = [];
async function probe(url, why) {
  const ext = extname(new URL(url, BASE + "/").pathname).toLowerCase();
  let status = 0, ctype = "", bytes = 0, err = "";
  try {
    const res = await fetch(url, { headers: { "cache-control": "no-store" } });
    status = res.status;
    ctype = String(res.headers.get("content-type") || "");
    bytes = (await res.arrayBuffer()).byteLength;
  } catch (e) {
    err = String((e && e.message) || e);
  }
  const want = WANT[ext];
  const typeOk = want ? want.some((p) => ctype.startsWith(p)) : true;
  const fallback = /text\/html/.test(ctype) && !!want; // 期望二进制/JS/CSS 却拿到 HTML = SPA 回落
  const ok = !err && status === 200 && typeOk && !fallback;
  results.push({ url, why, status, ctype: ctype.split(";")[0], bytes, ok, note: err || (fallback ? "命中 SPA 回落：文件其实不存在" : !typeOk && want ? "类型不符，期望 " + want.join("/") : "") });
}

/* ---- 1. 引用从**服务端真正返回的那份 HTML**里取，不读本地文件 ----
 * 理由：本地 dist/index.html 里的 `/assets/index-<hash>.js` 在 dev 源上是根本不存在的
 * （dev 走 /src/main.ts），拿 dist 的引用去戳 dev 会假报两条"缺失"。装机真正看到的只有服务端返回的 HTML。 */
let rootRes;
try {
  rootRes = await fetch(BASE + "/", { headers: { "cache-control": "no-store" } });
} catch (e) {
  // 服务没起来是"用法的错"，不是"检查失败"：要给一句人话和一个专门的退出码，别甩 Node 堆栈
  console.error(`✗ 打不开 ${BASE}/（${String((e && e.cause?.message) || e && e.message || e)}）—— 先 npm run build && npm run preview，或用 --base 指到起来了的那个端口`);
  process.exit(2);
}
const indexHtml = await rootRes.text();
if (!/text\/html/.test(String(rootRes.headers.get("content-type") || ""))) {
  console.error(`✗ ${BASE}/ 返回的不是 HTML（${rootRes.headers.get("content-type")}），后面的检查没有意义`);
  process.exit(1);
}
const refs = [];
for (const m of indexHtml.matchAll(/<link[^>]+rel="(manifest|icon|apple-touch-icon)"[^>]+href="([^"]+)"/g)) {
  refs.push({ url: m[2], why: `index.html 的 rel=${m[1]}` });
}
for (const m of indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g)) refs.push({ url: m[1], why: "index.html 的入口脚本" });
for (const m of indexHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) refs.push({ url: m[1], why: "index.html 的样式表" });

const manRef = refs.find((r) => /manifest/.test(r.url));
const manUrl = new URL(manRef ? manRef.url : "/manifest.webmanifest", BASE + "/").href;
const manRes = await fetch(manUrl, { headers: { "cache-control": "no-store" } });
const manText = await manRes.text();
let manifest = null;
try {
  manifest = JSON.parse(manText);
} catch (e) {
  results.push({ url: manUrl, why: "manifest JSON", status: manRes.status, ctype: "", bytes: 0, ok: false, note: "解析失败：" + String(e && e.message) });
}
if (manifest) for (const ic of manifest.icons || []) refs.push({ url: ic.src, why: `manifest icons（${ic.sizes} ${ic.purpose}）` });
if (manifest) refs.push({ url: manifest.start_url, why: "manifest start_url" });

/* ---- 2. 逐个拉 ---- */
const seen = new Set();
for (const r of refs) {
  const abs = new URL(r.url, BASE + "/").href;
  if (seen.has(abs)) continue;
  seen.add(abs);
  await probe(abs, r.why);
}

/* ---- 3. 结构项：start_url 必须落在 scope 里，否则"添加到主屏"打开的不是同一个 App ---- */
const structNotes = [];
if (manifest) {
  const scope = manifest.scope || "/";
  const start = manifest.start_url || "/";
  const inside = start === scope || start.startsWith(scope.endsWith("/") ? scope : scope + "/") || start.startsWith(scope);
  structNotes.push(`${inside ? "✓" : "✗"} start_url ${start} ${inside ? "在" : "不在"} scope ${scope} 内`);
  structNotes.push(`${manifest.display === "standalone" ? "✓" : "✗"} display=${manifest.display}（不是 standalone 就不会以 App 形态打开）`);
  const anyMaskable = (manifest.icons || []).some((i) => /maskable/.test(i.purpose || ""));
  structNotes.push(`${anyMaskable ? "✓" : "✗"} 有 maskable 图标：${anyMaskable ? "有" : "没有"}（Android 自适应图标会裁边）`);
  structNotes.push(`iOS 不看 manifest 的 display，靠 index.html 里的 apple-mobile-web-app-capable（本轮已补）`);
}

/* ---- 4. 输出 ---- */
console.log(`基址：${BASE}`);
let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.status || "ERR"} ${(r.ctype || "-").padEnd(28)} ${String(r.bytes).padStart(7)}B  ${r.url.replace(BASE, "") || "/"}  ← ${r.why}${r.note ? " · " + r.note : ""}`);
}
for (const s of structNotes) console.log("  " + s);
console.log(bad ? `\n✗ ${bad} 项不合格：装机后大概率表现为图标空白或壳加载不全，先补文件再谈 4.6。` : `\n合计 ${results.length} 个引用全部 200 且类型正确。`);
/* 退出码用 process.exitCode，不用 process.exit()。
 * 原因（2026-10-10 撞上）：本机 Node 24 + Windows 下，fetch 留下的 keep-alive socket 还在收尾时
 * 调 process.exit() 会触发 libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING)`，进程以 127 收场 ——
 * 于是"8 项全绿"的那次运行反而返回失败码，自检脚本最容易骗人的就是这种地方。 */
process.exitCode = bad ? 1 : 0;
