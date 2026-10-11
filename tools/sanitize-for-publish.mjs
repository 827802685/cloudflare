// tools/sanitize-for-publish.mjs
//
// 目的：建仓/公开前把这份项目变成"可以公开"的副本。**不改原文件**，输出到仓库外（默认 F:/work/cf-console-public）。
// 为什么要有它：docs/09 §G 早就说过证据文件里有可识别信息，但如果等到要 push 的那天再手工删，一定会漏。
// 这里的处理是可复跑的、可断言的：
//   - 凭据：直接屏蔽（Account ID / 设备令牌 / CF Token），并断言副本里 0 命中
//   - ID 类：用 HMAC 做**确定性化名**，同一个 id 在副本里始终映射成同一个假 id，
//     这样 docs/evidence 与 docs/*.md 之间的交叉引用关系不会被破坏（形状也保留：还是 32 位十六进制）
//   - 主机名 / 邮箱 / 账号名：同样确定性替换成 example.*
// 不处理的东西（写清楚，别假装干净）：Worker 脚本名（rin-server 等）、队列名、KV/D1 绑定名 ——
// 它们撑起了文档的可读性，本身不构成凭据；要不要一起抹由你决定。
//
// 跑法：node tools/sanitize-for-publish.mjs [--out D:\some\dir]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const outArgIndex = argv.indexOf("--out");
const OUT = outArgIndex >= 0 && argv[outArgIndex + 1] ? path.resolve(argv[outArgIndex + 1]) : "F:/work/cf-console-public";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".wrangler", ".tmp", "android", "ios"]);
// 这些文件**永不**进副本：本地凭据与本地环境变量
const NEVER_COPY = /(^|[\\/])(\.dev\.vars|\.device-token|\.env|\.env\.local|\.env\..*\.local|service-account.*\.json|.*\.pem|.*\.key)$/;
const KEEP_EXAMPLE = /\.(example|template)$/;

const SALT = "cf-console-publish-salt-v1"; // 固定盐：换机器跑结果一致。它不是密钥，公开也没关系（见下面说明）
const hmac32 = (s) => crypto.createHmac("sha256", SALT).update(s).digest("hex").slice(0, 32);

function readDevVars() {
  const t = fs.readFileSync(path.join(ROOT, "app/gateway/.dev.vars"), "utf8");
  const g = (n) => (t.match(new RegExp(`^${n}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m")) || [])[1]?.trim() || null;
  return { account: g("CF_ACCOUNT_ID"), token: g("CF_API_TOKEN"), device: g("DEVICE_TOKENS") };
}
const creds = readDevVars();
if (!creds.account) {
  console.error("读不到 CF_ACCOUNT_ID（app/gateway/.dev.vars 不在？），先别生成公开副本");
  process.exit(1);
}

const files = [];
(function w(d, rel) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) w(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name);
    } else files.push({ abs: path.join(d, e.name), rel });
  }
})(ROOT, "");

// .gitignore 的意志**不该在副本前失效**。这条是 10-11 补的：脚本原来只按文件系统扫，
// 于是 docs/evidence/text-responses.json（.gitignore 第 20 行明确写着"含真实绑定名与 Worker
// 代码片段，公开前先处理"）照样被复制进副本 —— git 挡住了仓库，却挡不住这里。
// 用 git 自己列 ignored 清单，而不是在这里手抄一遍规则：手抄的表一定会和 .gitignore 分家。
const ignoredByGit = new Set();
try {
  const out = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], { cwd: ROOT });
  for (const p of out.toString("utf8").split("\0")) if (p) ignoredByGit.add(p.replace(/\\/g, "/"));
} catch {
  /* 不在 git 工作树里跑（比如直接在副本里跑）就不做这层跳过 */
}

const skipped = [];
const skippedByIgnore = [];
const todo = [];
for (const f of files) {
  const full = `${f.rel ? f.rel + "/" : ""}${f.abs.split(/[\\/]/).pop()}`;
  if (NEVER_COPY.test(full) && !KEEP_EXAMPLE.test(full)) {
    skipped.push(full);
    continue;
  }
  if (ignoredByGit.has(full)) {
    skippedByIgnore.push(full);
    continue;
  }
  todo.push({ ...f, outRel: full });
}

// 先扫一遍收集要化名化的 id，保证"同一个值 → 同一个假值"
const hexRe = /\b[0-9a-f]{32}\b/g;
// 第二道防线：仓库里**任何**形如 CF API Token 的字面量都要屏蔽，不只是 .dev.vars 里那把。
// 为什么：历史版本只按 creds.token 这一个值屏蔽，而 tools/probe-d1-kv.mjs 里另硬编码过一把真令牌
// —— 于是断言照样报 "CF Token 0"，那是一个**假绿灯**。现在按形态抓，新写死的令牌也会被抓住。
// `cfat_000…` 那种全零占位是 verify-cf-api.mjs 故意发的坏令牌，不是凭据，保留。
const tokenRe = /\bcfat_[A-Za-z0-9_-]{20,}\b/g;
const isPlaceholderToken = (s) => /^cfat_0+$/.test(s);
const ids = new Set();
const tokenLiterals = new Set();
const emails = new Set();
const hosts = new Set();
const texts = new Map();
for (const f of todo) {
  let t;
  try {
    t = fs.readFileSync(f.abs, "utf8");
  } catch {
    continue;
  }
  texts.set(f.outRel, t);
  if (/[\x00-\x08\x0e-\x1f]/.test(t.slice(0, 8000))) continue; // 二进制（图标 PNG 之类）不参与替换
  for (const m of t.matchAll(hexRe)) if (m[0] !== creds.account) ids.add(m[0]);
  for (const m of t.matchAll(tokenRe)) if (!/^cfat_0+$/.test(m[0]) && m[0] !== creds.token) tokenLiterals.add(m[0]);
  for (const m of t.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)) emails.add(m[0]);
  for (const m of t.matchAll(/https?:\/\/([a-z0-9][a-z0-9._-]*[a-z0-9])(?::\d+)?/gi)) {
    const h = m[1].toLowerCase();
    if (/qzz\.io|dpdns|acct|workers\.dev|pages\.dev/.test(h)) hosts.add(h);
  }
  // 关键补充：**正文里不带 http:// 的域名同样会泄露**（`acct.example.com` 实测可达、`acct0501` 这个账号前缀）。
  // 第一版只从 URL 里收，结果断言报了 12 处"真实主机名残留"才发现漏了这条。
  // 注意 `*.workers.dev` / `*.pages.dev` 是 Cloudflare 的公共域名，属于文档论述对象，**不该**被替换。
  for (const m of t.matchAll(/\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:qzz\.io|dpdns\.org)\b/gi)) {
    hosts.add(m[0].toLowerCase());
  }
  for (const m of t.matchAll(/\b(acct[a-z0-9]*)\b/gi)) hosts.add(m[1].toLowerCase());
}
// 主机名/标识映射：**长串优先**，否则 `acct.example.com` 会被先替换掉的裸 `acct` 撕成 `example.com.example.com`。
// example.com / example.org 是 RFC 2606 保留域，占位不会撞真实站点。
// 上一版在这里踩过坑：对 `clist.acct.example.org` 先做了 `acct[.-]*` 的整体替换，把 apex 前面的点也吃掉，
// 于是后面的 `.dpdns.org → .example.org` 匹配不上，副本里留下了 `clist.acct-dpdns.org`（还是真域名）。
// 现在按"逐标签"处理，不再有替换顺序依赖。
const APEX_MAP = { "qzz.io": "example.com", "dpdns.org": "example.org" };
function maskLabel(h) {
  const labels = h.split(".");
  const apexKey = labels.slice(-2).join(".");
  if (APEX_MAP[apexKey]) {
    labels.splice(-2, 2, ...APEX_MAP[apexKey].split("."));
  } else if (apexKey === "workers.dev" || apexKey === "pages.dev") {
    // Cloudflare 公共域名，本身不是个人信息，只把账号前缀那一段换掉
  }
  return labels.map((l) => (/^acct/i.test(l) ? l.replace(/^acct/i, "acct") : l)).join(".");
}
const hostMap = new Map();
{
  const rules = [...hosts].sort((a, b) => b.length - a.length).map((h) => [h, maskLabel(h)]);
  for (const [from, to] of rules) if (!hostMap.has(from)) hostMap.set(from, to);
}
const emailMap = new Map([...emails].sort().map((e, i) => [e, `user${i + 1}@example.com`]));
const idMap = new Map([...ids].sort().map((x) => [x, hmac32(x)]));
// 硬编码令牌不化名（化名后仍是 53 位十六进制，看着像还能用），直接换成明显的占位串：
// 读的人一眼知道"这里原来有一把令牌，已被拿掉"，而不是以为它还能跑。
const tokenMap = new Map(
  [...tokenLiterals]
    .sort((a, b) => b.length - a.length)
    .map((x, i) => [x, `«REMOVED_CF_API_TOKEN_${i + 1}»`])
);

function replaceAll(t) {
  let s = t;
  if (creds.account) s = s.split(creds.account).join("«ACCOUNT_ID»");
  if (creds.token) s = s.split(creds.token).join("«CF_API_TOKEN»");
  if (creds.device) s = s.split(creds.device).join("«DEVICE_TOKEN»");
  for (const [tk, r] of tokenMap) s = s.split(tk).join(r);
  for (const [h, r] of hostMap) s = s.split(h).join(r);
  for (const [e, r] of emailMap) s = s.split(e).join(r);
  for (const [x, r] of idMap) s = s.split(x).join(r);
  return s;
}

fs.rmSync(OUT, { recursive: true, force: true });
let copied = 0;
const stats = { ids: idMap.size, hosts: hostMap.size, emails: emailMap.size };
for (const f of todo) {
  const dst = path.join(OUT, f.outRel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const t = texts.get(f.outRel);
  const isText = t !== undefined && !/[\x00-\x08\x0e-\x1f]/.test(t.slice(0, 8000));
  if (isText) fs.writeFileSync(dst, replaceAll(t));
  else fs.copyFileSync(f.abs, dst);
  copied++;
}

// 断言：副本里绝不允许再出现任何一条凭据；顺带统计假化名的覆盖情况
// residue.token 是"等于 .dev.vars 那把"的命中，residue.tokenShape 是"任何 CF 令牌形态"的命中 ——
// 后者才是防假绿灯的那道：仓库里新冒出来的、脚本没登记过的硬编码令牌会被它抓到。
const residue = { account: 0, token: 0, tokenShape: 0, device: 0, email: 0, realHost: 0, keptPublic: 0 };
const tokenResidueFiles = [];
const scanned = [];
(function w(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) w(p);
    else scanned.push(p);
  }
})(OUT);
for (const p of scanned) {
  // 这个脚本自己的源码里就带着 `qzz.io` / `dpdns.org` 这些**匹配规则**，
  // 把它算进"残留"会得到 12 这种莫名其妙的数字（第一版就被它骗过一次，以为真域名没替掉）。
  // 所以扫描副本时排除自身；真去复核请用外面的 grep，别只信这一行断言。
  if (p.replace(/\\/g, "/").endsWith("tools/sanitize-for-publish.mjs")) continue;
  let t;
  try {
    t = fs.readFileSync(p, "utf8");
  } catch {
    continue;
  }
  if (creds.account) residue.account += t.split(creds.account).length - 1;
  if (creds.token) residue.token += t.split(creds.token).length - 1;
  for (const m of t.matchAll(tokenRe)) {
    if (isPlaceholderToken(m[0])) continue;
    residue.tokenShape++;
    tokenResidueFiles.push(p.replace(OUT + path.sep, "").replace(/\\/g, "/"));
  }
  if (creds.device) residue.device += t.split(creds.device).length - 1;
  for (const e of emailMap.keys()) residue.email += t.split(e).length - 1;
  // 只统计"确实被化名过"的主机名。`*.workers.dev` / `*.pages.dev` 是 Cloudflare 的公共域名，
  // 是文档的论述对象，故意保持原样 —— 把它们算进残留会得到 12 这种假报警（第一版就是这么误报的）。
  for (const [h, mapped] of hostMap) if (mapped !== h) residue.realHost += t.split(h).length - 1;
  if (!residue.keptPublic) residue.keptPublic = 0;
  for (const [h, mapped] of hostMap) if (mapped === h) residue.keptPublic++;
}

const clean =
  residue.account === 0 &&
  residue.token === 0 &&
  residue.tokenShape === 0 &&
  residue.device === 0 &&
  residue.email === 0;
console.log(`副本目录：${OUT}`);
console.log(`  复制 ${copied} 个文件到副本，跳过凭据文件 ${skipped.length} 个：${skipped.join(", ") || "无"}`);
console.log(`  按 .gitignore 跳过 ${skippedByIgnore.length} 个未入库文件：${skippedByIgnore.join(", ") || "无"}`);
console.log(`  化名化：Account ID ×1 直接屏蔽；32 位 id ${stats.ids} 个 → HMAC 稳定假 id；主机名 ${stats.hosts} 个 → example.*；邮箱 ${stats.emails} 个 → user3@example.com`);
console.log(`  屏蔽：.dev.vars 那把令牌/设备令牌各 1 处 + 仓库内其它硬编码令牌 ${tokenMap.size} 把 → «REMOVED_CF_API_TOKEN_n» 占位`);
console.log(`  残留断言：Account ID ${residue.account} · CF Token ${residue.token} · 令牌形态 ${residue.tokenShape} · 设备令牌 ${residue.device} · 邮箱 ${residue.email} · 个人主机名 ${residue.realHost}（另有 ${residue.keptPublic} 个 *.workers.dev / *.pages.dev 公共域名按设计保留）`);
if (tokenResidueFiles.length) console.log(`  ❗ 仍带令牌形态的文件：${[...new Set(tokenResidueFiles)].join(", ")}`);
console.log(`  ${clean ? "✅ 凭据类零残留" : "❌ 还有凭据残留，别 push"}`);
console.log("  注意：Worker 脚本名（rin-server 等）、队列名、绑定名**没**动，要不要一起抹由你决定。");
process.exitCode = clean ? 0 : 2;
