// tools/probe-tail-net.mjs —— 实时日志（风险 C3）的网络层实测，只读、不带令牌、不创建 tail。
//
// 为什么需要它：`docs/09` §C3 原来只写着"wss 端点能不能连通没测"。这个脚本把"可达面"和"授权面"分开量：
//   - DNS/TCP/TLS 层通不通 → 纯网络事实
//   - WS 升级握手回什么状态码 → 说明这条路径上有无中间层吃掉 Upgrade
// 它**不**调用 `POST …/workers/scripts/{s}/tails`，因为那是写操作（会真的注册一个 tail），要另行授权。
//
// 跑法（在本机，不依赖网关是否在跑）：
//   node tools/probe-tail-net.mjs            # 输出到 console + docs/evidence/tail-reachability.json
//
// 两个坑（都踩过，别再复现）：
//   1. 判定响应结束要看 "\r\n\r\n"，不能等"攒够 N 字节"—— 426/400 这类短响应永远攒不够，会假报超时。
//   2. 手工发 HTTP/1.1 请求必须以空行收尾（"\r\n\r\n"）；用 filter(Boolean) 拼行会把结束空行删掉。
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "evidence", "tail-reachability.json");

const HOSTS = [
  { host: "tail.developers.workers.dev", why: "Workers Tail 的 wss 端点（C3 主角）" },
  { host: "acct0501.workers.dev", why: "对照：本账号的 workers.dev 前缀，验证污染是否覆盖整个 apex" },
  { host: "acct.example.com", why: "对照：自有域名，已知可达；也是将来网关注册的同类域名" },
  { host: "api.cloudflare.com", why: "对照：官方 API，已知可达" },
];
const UPGRADE_KEY = "dGVzdC1rZXktMDEyMzQ1Njc4OQ=="; // 固定假 key，不涉及身份
const MS = 10000;

// 启发式，不是官方清单：CF 的 v4 anycast 常见落在 104.16.0.0/12 与 172.64.0.0/10。
// 只用来把"这个答案像不像真的 CF 边缘 IP"写进证据里，别拿它当判据下结论。
function inCfAnycast(ip) {
  const p = String(ip).split(".").map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return false;
  const n = p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3];
  const between = (a, b) => n >= a && n <= b;
  return between(0x68100000, 0x681fffff) || between(0xac400000, 0xac47ffff); // 104.16-31.x.x / 172.64-71.x.x
}

const guard = (label, p) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${MS}ms (${label})`)), MS).unref?.())]);

const tcp443 = (host) =>
  new Promise((res, rej) => {
    const s = net.connect({ host, port: 443 });
    s.once("connect", () => {
      // Node 24 对多地址解析会走 Happy Eyeballs，connect 可能在 socket 已被销毁的那次尝试上触发，
      // 此时 localAddress 是 undefined —— 早先版本直接 .includes() 就抛了。
      const via = `${s.localAddress || "?"}:${s.localPort || "?"}`;
      const egress = String(s.localAddress || "").includes(":") ? "IPv6" : s.localAddress ? "IPv4" : "unknown";
      s.destroy();
      res({ connected: true, local_socket: via, egress });
    });
    s.once("error", (e) => rej(new Error(`${e.code || ""} ${e.message}`.trim())));
  });

const tlsInfo = (host) =>
  new Promise((res, rej) => {
    const s = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ["h2", "http/1.1"] });
    s.once("secureConnect", () => {
      const c = s.getPeerCertificate();
      res({ connected: true, authorized: s.authorized, alpn: s.alpnProtocol || null, issuer: c?.issuer?.CN || null, notAfter: c?.valid_to || null });
      s.destroy();
    });
    s.once("error", (e) => rej(new Error(`${e.code || ""} ${e.message}`.trim())));
  });

// 手工 WS 升级：要看的是状态码和是否回 101 / 有没有Sec-WebSocket-Protocol 回声
const upgrade = (host, pathName, subprotocol) =>
  new Promise((res, rej) => {
    const s = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ["http/1.1"] });
    let buf = "";
    s.setTimeout(MS);
    s.once("secureConnect", () => {
      const lines = [
        `GET ${pathName} HTTP/1.1`,
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${UPGRADE_KEY}`,
      ];
      if (subprotocol) lines.push(`Sec-WebSocket-Protocol: ${subprotocol}`);
      lines.push("User-Agent: cf-console-netprobe/0", "", "");
      s.write(lines.join("\r\n")); // 结尾两个空串 → 产生 \r\n\r\n，必须有
    });
    const finish = () => {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return false;
      const head = buf.slice(0, sep);
      const headers = {};
      for (const line of head.split("\r\n").slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
      }
      s.destroy();
      res({ status_line: head.split("\r\n")[0], upgrade_header: headers["upgrade"] || null, sec_ws_accept: headers["sec-websocket-accept"] || null, sec_ws_protocol: headers["sec-websocket-protocol"] || null, cf_cache: headers["cf-cache-status"] || null, body_head: buf.slice(sep + 4, sep + 4 + 120).replace(/\r?\n/g, " ") });
      return true;
    };
    s.on("data", (d) => {
      buf += d.toString("latin1");
      if (!finish() && buf.length > 8192) {
        s.destroy();
        rej(new Error("oversized response without terminator"));
      }
    });
    s.on("timeout", () => {
      s.destroy();
      rej(new Error(`no complete response in ${MS}ms (got ${buf.length} bytes)`));
    });
    s.on("end", () => !finish() && rej(new Error(`socket closed early (${buf.length} bytes)`)));
    s.once("error", (e) => rej(new Error(`${e.code || ""} ${e.message}`.trim())));
  });

const run = async (label, fn) => {
  try {
    return { step: label, ok: true, result: await guard(label, fn()) };
  } catch (e) {
    return { step: label, ok: false, error: String(e?.message || e).slice(0, 260) };
  }
};

const report = {
  generated_at: new Date().toISOString(),
  source: "tools/probe-tail-net.mjs",
  scope_note: "只读网络探测：不带 CF 令牌、不调 POST …/tails（那是写操作）。结论只覆盖'本机能不能连到'这一面。",
  hosts: {},
};

for (const { host, why } of HOSTS) {
  const rec = { why };
  // 连查三次：污染型解析每次给不同的假答案，单查一次容易被当成"就是那个 IP"
  const resolves = [];
  for (let i = 0; i < 3; i++) resolves.push(await run(`resolve4#${i}`, () => dns.resolve4(host)));
  rec.resolve4_tries = resolves;
  // dns.resolve4 直接返回字符串数组（不是 {addresses}），早先按对象取 → ips 恒空、verdict 误报 "no_dns_answer"
  const ips = [...new Set(resolves.flatMap((r) => (Array.isArray(r.result) ? r.result : r.result?.addresses || [])))];
  rec.distinct_ipv4 = ips;
  rec.resolve4_errors = resolves.filter((r) => !r.ok).map((r) => r.error);
  // resolve4 走的是"配置里的 DNS 服务器"，lookup 走的是系统解析器（含 hosts/缓存/代理链）。
  // 两者分开看才知道污染发生在哪一层。
  rec.lookup = await run("lookup(system)", () => dns.lookup(host, { all: true, verbatim: true }));
  const looked = (rec.lookup.result || []).map((a) => a.address);
  rec.lookup_answers = looked;
  const all = [...new Set([...ips, ...looked])];
  rec.dns_answers = all;
  rec.all_in_cf_anycast = all.length > 0 && all.every((ip) => inCfAnycast(ip) || ip.startsWith("2606:4700:"));
  rec.dns_stable = all.length === 1;
  rec.resolve6 = await run("resolve6", () => dns.resolve6(host));
  rec.tcp = await run("tcp:443", () => tcp443(host));
  rec.tls = await run("tls", () => tlsInfo(host));
  rec.upgrade = await run("WS upgrade", () => upgrade(host, "/__netprobe_nope__", null));
  rec.upgrade_tracev1 = await run("WS upgrade + trace-v1", () => upgrade(host, "/__netprobe_nope__", "trace-v1"));
  rec.verdict = rec.tcp.ok && rec.tls.ok ? "reachable" : all.length ? "dns_answers_but_unreachable" : "no_dns_answer";
  // 判据要说清楚：anycast 本来就一次给多个地址，"答案多"本身不等于污染；
  // "答案全不在 CF 段 + 一个都连不上"才是这台机器的污染特征。
  rec.dns_note = !all.length
    ? "两种解析都拿不到地址：不是解析到假地址，是压根没有答案"
    : rec.all_in_cf_anycast
      ? `${all.length} 个答案，全落在 CF 常见 anycast 段（v4 ${ips.filter(inCfAnycast).length} 个 + v6 ${looked.filter((x) => x.startsWith("2606:4700:")).length} 个），属于正常 anycast`
      : all.length > 1
        ? `${all.length} 个不同答案且都不在 CF 段（${all.slice(0, 4).join(", ")}）—— 污染型解析：同一个 host 每次给不同的假地址`
        : `唯一答案 ${all[0]} 不在 CF 常见 anycast 段${rec.verdict === "dns_answers_but_unreachable" ? "，且 TCP 443 连不上" : ""}`;
  report.hosts[host] = rec;

  console.log(`\n=== ${host} → ${rec.verdict}｜${why}`);
  console.log(`    解析：${rec.dns_note}`);
  console.log(`    三次 resolve4：${resolves.map((r) => (r.ok ? (Array.isArray(r.result) ? r.result : r.result?.addresses || []).join("/") : "E")).join(" | ") || "无"}`);
  console.log(`    系统 lookup：${looked.join(", ") || "无"}`);
  console.log(`    tcp ${rec.tcp.ok ? "通" : "不通"}${rec.tcp.ok ? ` · 出口走 ${rec.tls.result?.alpn || "?"} / ${rec.tcp.result?.egress}` : ` · ${rec.tcp.error}`}`);
  console.log(`    tls ${rec.tls.ok ? `通 · ${rec.tls.result.issuer} · alpn=${rec.tls.result.alpn}` : `不通 · ${rec.tls.error}`}`);
  console.log(`    upgrade  ${rec.upgrade.ok ? rec.upgrade.result.status_line + (rec.upgrade.result.upgrade_header ? ` · Upgrade=${rec.upgrade.result.upgrade_header}` : "") : "· " + rec.upgrade.error}`);
  console.log(`    trace-v1 ${rec.upgrade_tracev1.ok ? rec.upgrade_tracev1.result.status_line + (rec.upgrade_tracev1.result.sec_ws_protocol ? ` · 回声子协议=${rec.upgrade_tracev1.result.sec_ws_protocol}` : "") : "· " + rec.upgrade_tracev1.error}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\n证据写入 ${path.relative(ROOT, OUT)}`);
