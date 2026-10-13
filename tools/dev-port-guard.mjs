#!/usr/bin/env node
/**
 * 开发端口体检 / 单实例守卫。
 *
 * 为什么需要这个文件（2026-10-11 实测，本机）：
 *  「界面点刷新取不到数据」的根因不在代码里 —— 同一时刻有 **6 个 workerd 同时 LISTENING 127.0.0.1:8788**
 *  （每次 `npm run dev` 都新起一个 wrangler dev，前一个没退干净），Windows 允许这种重复绑定，
 *  于是连接会随机落到某个已经退化的实例上，或者落在刚死掉、还没来得及被别人接手的端口上。
 *  实测 10 次探测：5 次 /health 与 /v1/workers 同时拿 000（连接被拒），中途 netstat 一个监听都没有，
 *  过一会儿又自己好了 —— 这正是"数据有时刷得出来、有时刷不出来"的形状。
 *  另一半坑是 vite：5173 被另一个 worktree（«LOCAL_PATH»）的 vite 占着，
 *  本项目的 vite 静默漂到 5174/5175/5176，而 5174 的 IPv4 又被 workers-ui 那个 worktree 占着，
 *  人打开 localhost:5173 看到的其实是一份**旧分支界面**，还以为是自己刚改的那份。
 *
 * 所以这里只做两件事，都是"把静默失败变成明确报错"：
 *  1. 报告某个端口到底被谁占着、那个进程属于哪个项目目录（本项目 / 别的工作树 / 认不出来）；
 *  2. `--require-free` 给 predev 用：端口不空就直接非零退出，**绝不许再起第二个实例**。
 *     默认只报不动手；`--kill-stale` 才清理，而且只清本项目自己的多余实例（永远保留最新那个），
 *     别的工作树的进程只报 PID、不碰 —— 那是另一个会话正在用的东西。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 本项目里网关和前端的默认端口，跟 wrangler.toml [dev].port 与 vite.config.ts 保持一致 */
const GW_PORT = 8788;
const UI_PORT = 5173;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

/* ---------------- PowerShell 侧：只输出 ASCII，避免控制台代码页把中文改成乱码 ---------------- */

const PS_LISTEN = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.Encoding]::ASCII
foreach ($p in @(__PORTS__)) {
  foreach ($cn in (Get-NetTCPConnection -State Listen -LocalPort $p)) {
    $id = $cn.OwningProcess
    $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
    if (-not $pr) { continue }
    $cd = ''
    if ($pr.CreationDate) { $cd = $pr.CreationDate.ToString('yyyy-MM-dd HH:mm:ss') }
    $cl = ($pr.CommandLine -replace "\t", " ")
    Write-Output ("{0}|{1}|{2}|{3}|{4}|{5}" -f $p, $id, $pr.Name, $cd, $cl, $pr.ParentProcessId)
  }
}
`;

const PS_KILL = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
foreach ($id in @(__PIDS__)) { Stop-Process -Id $id -Force; Write-Output ("killed|{0}" -f $id) }
`;

/**
 * 本项目自己的 dev 进程全景（含它们各自监听在哪个端口上）。
 * 为什么单独查一遍：vite 端口被占时会静默往后漂（5173→5174→5175…），只查固定端口看不到漂走的那些，
 * 而"我打开的到底是哪一份代码"恰恰只有这张表能回答。
 */
const PS_MINE = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [System.Text.Encoding]::ASCII
$procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='workerd.exe'" | Where-Object { $_.CommandLine -like '*__ROOT__*' -and $_.CommandLine -match 'vite|wrangler|workerd' })
$listen = @(Get-NetTCPConnection -State Listen)
foreach ($pr in $procs) {
  $ports = (($listen | Where-Object { $_.OwningProcess -eq $pr.ProcessId } | ForEach-Object { ('{0}:{1}' -f $_.LocalAddress, $_.LocalPort) }) | Sort-Object -Unique) -join ','
  $kind = 'other'
  if ($pr.CommandLine -match 'workerd|wrangler') { $kind = 'gateway' } elseif ($pr.CommandLine -match 'vite') { $kind = 'console' }
  Write-Output ("{0}|{1}|{2}|{3}|{4}" -f $pr.ProcessId, $pr.ParentProcessId, $kind, $ports, $pr.Name)
}
`;

/**
 * 用 -EncodedCommand（UTF-16LE base64）传脚本：命令行里带反斜杠路径和引号时，
 * 走 -Command 会被 bash/PowerShell 两层引号规则各吃掉一半，实测很难读也很难对。
 */
function runPs(script, replacements) {
  let s = script;
  for (const [k, v] of Object.entries(replacements)) s = s.replaceAll(k, v);
  const b64 = Buffer.from(s, "utf16le").toString("base64");
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64], {
    encoding: "utf8",
    maxBuffer: 8 << 20,
  });
  if (r.error) return { ok: false, lines: [], why: String(r.error.message) };
  const lines = String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // 非交互宿主会把进度记录序列化成 `#< CLIXML …` 打到 stderr —— 那不是失败，别拿它当错误说
  const why = String(r.stderr || "").split(/\r?\n/).filter((l) => l.trim() && !/CLIXML|^<Objs|<\/Objs>/.test(l)).join(" ").trim();
  return { ok: r.status === 0 || lines.length > 0, lines, why };
}

/**
 * 从进程命令行里认它属于哪个项目：抓 `...\app\console` 或 `...\app\gateway` 前面那段。
 * 认不出来（不是这两个目录里的 vite/wrangler，或者命令行取不到）就归 "unknown"，
 * 后面一律按"不是我们的东西，别杀"处理。
 */
function classify(entry) {
  const cl = entry.commandLine || "";
  const m = /([A-Za-z]:[^"']*?)\\app\\(console|gateway)/.exec(cl.replace(/\//g, "\\"));
  const kind = /wrangler|workerd/.test(cl) ? "gateway" : /vite/.test(cl) ? "console" : "other";
  if (!m) return { kind, root: null, mine: false };
  const root = path.resolve(m[1]);
  return { kind, root, mine: root.toLowerCase() === REPO_ROOT.toLowerCase() };
}

function probe(ports) {
  const r = runPs(PS_LISTEN, { __PORTS__: ports.join(",") });
  if (!r.ok && !r.lines.length && r.why) console.error("（取端口占用信息失败：" + r.why.slice(0, 200) + "）");
  const byPort = new Map(ports.map((p) => [p, []]));
  const seen = new Set();
  for (const line of r.lines) {
    const [port, pid, name, created, ...rest] = line.split("|");
    const p = Number(port);
    if (!byPort.has(p)) continue;
    // 末列是父进程 id（一个 wrangler 会派生多个 workerd，见下面的 instances()）
    const tail = rest.join("|");
    const cut = tail.lastIndexOf("|");
    const commandLine = cut >= 0 ? tail.slice(0, cut) : tail;
    const ppid = cut >= 0 ? tail.slice(cut + 1) : "";
    const entry = { port: p, pid: Number(pid), name, created, ppid, commandLine };
    if (seen.has(entry.pid + "@" + p)) continue;
    seen.add(entry.pid + "@" + p);
    entry.info = classify(entry);
    byPort.get(p).push(entry);
  }
  for (const list of byPort.values()) list.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  return byPort;
}

const short = (e) => `${e.pid} ${e.name || "?"} ${e.created || ""}`.trim();
/**
 * 「几个进程在监听」不等于「起了几个实例」：一次 `wrangler dev` 会派生**两个** workerd 子进程
 * （2026-10-11 实测：同一个父 node 进程下的 8020/3080 同时绑在 8788 上，创建时间同一秒）。
 * 所以判重必须按父进程归组，否则体检会把一个正常实例喊成"两个重复绑定"，
 * 而 --kill-stale 照那份名单下手，就会砍掉活着那个 wrangler 的半个身子。
 */
const instKey = (e) => (e.ppid && e.ppid !== "0" ? "p" + e.ppid : "x" + e.pid);
function instances(arr) {
  const m = new Map();
  for (const e of arr) {
    const k = instKey(e);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  return [...m.values()];
}
const owner = (e) => (e.info.root ? (e.info.mine ? "本项目" : path.basename(e.info.root) + "（" + e.info.root + "）") : "认不出归属");

/* ---------------- 非 Windows：退化成一次纯 TCP 探测，不做进程归属 ---------------- */

async function probePosix(ports) {
  const net = await import("node:net");
  const byPort = new Map(ports.map((p) => [p, []]));
  for (const p of ports) {
    const open = await new Promise((res) => {
      const s = net.connect(p, "127.0.0.1");
      s.setTimeout(1200);
      s.on("connect", () => { s.destroy(); res(true); });
      s.on("timeout", () => { s.destroy(); res(false); });
      s.on("error", () => res(false));
    });
    if (open) byPort.get(p).push({ port: p, pid: 0, name: "(非 Windows 探测：只能确认端口有人监听，取不到 PID)", created: "", commandLine: "", info: { kind: "other", root: null, mine: false } });
  }
  return byPort;
}

/* ---------------- 主流程 ---------------- */

const isWin = process.platform === "win32";

/**
 * 要检查哪个端口，按这个顺序定：命令行数字 > `npm run dev -- --port` 注入的 npm_config_port >
 * CF_CONSOLE_UI_PORT / CF_CONSOLE_GATEWAY_PORT > 默认（跟 wrangler.toml [dev].port、vite.config.ts 一致）。
 * 之所以要把"用户换端口"这条路算进来：predev 查错端口就是脚本自己造的假故障。
 */
const digits = argv.filter((a) => /^\d+$/.test(a)).map(Number);
const reqIdx = argv.indexOf("--require-free");
const reqArg = reqIdx >= 0 ? argv[reqIdx + 1] : undefined;
const isUi = reqArg === "ui";
const envPort = Number(isUi ? process.env.CF_CONSOLE_UI_PORT : process.env.CF_CONSOLE_GATEWAY_PORT) || undefined;
const npmPort = Number(process.env.npm_config_port) || undefined;
const requireFree = reqIdx >= 0 ? (digits.length ? digits : [npmPort || envPort || (isUi ? UI_PORT : GW_PORT)]) : null;
/**
 * 谁的端口被占算"致命"：
 *  · 网关侧全算 —— workerd 在 Windows 上重复绑同一个端口**不会报错**，第二个实例照样起得来，
 *    于是端口上挂 6 个实例、请求随机落到已经退掉的那个上（本机实测），只能在起之前拦住；
 *  · 前端侧只拦"本项目自己已经在跑"的情况 —— vite 配了 strictPort，端口被别人占时它自己会明确失败，
 *    这里再拦一次就成了双重把关、还会挡住 `npm run dev -- --port 5180` 这种正当用法。
 */
const fatalForForeign = !isUi;
const targetPorts = digits.length ? digits : requireFree || [GW_PORT, UI_PORT, 8789];

const byPort = isWin ? probe(targetPorts) : await probePosix(targetPorts);

let bad = false;
for (const p of targetPorts) {
  const list = byPort.get(p) || [];
  if (!list.length) {
    console.log(`端口 ${p}：空着`);
    continue;
  }
  const mine = list.filter((e) => e.info.mine);
  const foreign = list.filter((e) => !e.info.mine);
  const myInsts = instances(mine);
  const allInsts = instances(list);
  console.log(`端口 ${p}：${list.length} 个进程在监听` + (allInsts.length !== list.length ? `（按父进程归组是 ${allInsts.length} 个实例）` : ""));
  for (const e of list) {
    console.log(`  - ${short(e)}｜${e.info.kind}｜归属：${owner(e)}`);
    if (e.commandLine) console.log(`      ${e.commandLine.slice(0, 160)}`);
  }
  if (requireFree && requireFree.includes(p)) {
    if (mine.length) {
      console.log(`  ⚠ 本项目已经有一个实例在 ${p} 上跑着了，别再起第二个（要用现成的就直接打开界面）`);
      bad = true;
    }
    if (foreign.length && fatalForForeign) {
      console.log(`  ⚠ ${p} 被非本项目的进程占着，workerd 会静默重复绑定、把请求带偏 —— 这里直接拦下`);
      bad = true;
    } else if (foreign.length) {
      console.log(`  ⚠ ${p} 被 ${owner(foreign[0])} 占着；vite 配了 strictPort，起不来的时候会明确报错，不会悄悄漂到别的端口`);
    }
  } else if (myInsts.length > 1) {
    console.log(`  ⚠ 本项目在 ${p} 上起了 ${myInsts.length} 个实例（共 ${mine.length} 个进程），重复绑定会让请求随机落到已退出的那个上`);
    bad = true;
  }
  if (!requireFree && foreign.length) {
    console.log(`  ⚠ ${p} 上有 ${foreign.length} 个不是本项目的进程：${foreign.map((e) => owner(e)).join("、")}（体检模式只报不动）`);
  }
}

/* 体检模式（不带 --require-free）多打一张"本项目 dev 进程全景"：漂走的 vite 端口不查固定表是看不见的 */
if (isWin && !requireFree) {
  const r = runPs(PS_MINE, { __ROOT__: REPO_ROOT });
  const rows = r.lines.map((l) => {
    const [pid, ppid, kind, listenPorts, name] = l.split("|");
    return { pid, ppid, kind, listenPorts, name };
  });
  if (rows.length) {
    console.log(`\n本项目名下的 dev 进程（${rows.length} 个，归属按命令行里的项目路径判）：`);
    for (const x of rows) {
      const what = x.kind === "gateway" ? "网关(wrangler/workerd)" : x.kind === "console" ? "前端(vite)" : "其它";
      console.log(`  - PID ${x.pid}（父 ${x.ppid}）${what}｜监听：${x.listenPorts || "（没有监听端口 —— 多半是包装进程或已经起不来了）"}｜${x.name}`);
    }
    const drift = rows.filter((x) => x.kind === "console" && x.listenPorts && !x.listenPorts.includes(`:${UI_PORT}`));
    if (drift.length) {
      console.log(`  ⚠ 有 ${drift.length} 个本项目的 vite 不在 ${UI_PORT} 上（端口被占后静默漂走了）。` +
        `浏览器里打开 localhost:${UI_PORT} 看到的可能是别的目录的界面，不是这一份。`);
    }
  }
}


if (flag("kill-stale")) {
  if (!isWin) console.log("--kill-stale 只在 Windows 上有效");
  else {
    let killed = 0;
    for (const p of targetPorts) {
      const mine = (byPort.get(p) || [])
        .filter((e) => e.info.mine)
        // 命令行里写了 --port 却不等于它现在占的这个端口的，一律不动：
        // 那多半是别的会话按自己的端口起的实例，只是 node_modules 的路径指回了本仓库
        .filter((e) => {
          const m = /--port[= ](\d+)/.exec(e.commandLine || "");
          return !m || Number(m[1]) === p;
        });
      // 按实例（父进程）归组后保留创建时间最新的那一组，其余整组杀掉 ——
      // 同一组的两个 workerd 必须同生共死，只杀半个会把还活着的那个打成残废
      const groups = instances(mine).sort((a, b) => String(b[0].created).localeCompare(String(a[0].created)));
      const stale = groups.slice(1).flat();
      if (!stale.length) continue;
      const r = runPs(PS_KILL, { __PIDS__: stale.map((e) => e.pid).join(",") });
      for (const e of stale) {
        console.log(`清理 ${p} 上本项目的旧实例：PID ${e.pid}（${e.info.kind}）${r.ok ? " → 已杀" : " → 杀失败，手动 Stop-Process -Id " + e.pid}`);
        if (r.ok) killed++;
      }
    }
    console.log(killed ? `共清理 ${killed} 个多余实例；别的工作树的进程一个没动` : "没有本项目的多余实例需要清理");
  }
} else {
  const dupPorts = [...byPort.entries()].filter(([, list]) => instances(list.filter((e) => e.info.mine)).length > 1).map(([p]) => p);
  if (dupPorts.length) console.log(`（${dupPorts.join("、")} 上有本项目多个实例重复绑定，想自动只留最新那个：node tools/dev-port-guard.mjs --kill-stale）`);
}

if (requireFree && bad) {
  console.log(`
端口不干净，所以没继续起服务 —— 再起一个只会让同一个端口上多一个实例，
请求会随机落到某个已经退出的那个上，界面上就是"刷新了但数据不出来"。三种处置：
  · 占着的是本项目自己的旧 dev server → node tools/dev-port-guard.mjs --kill-stale（只留最新一个）
  · 占着的是别的工作树/项目的进程 → 别杀（那边可能正在用），换端口起：npm run dev -- --port <一个空闲端口>
  · 端口其实没人用、只是刚关掉 → 直接再跑一次 npm run dev
`);
  process.exit(1);
}
process.exit(bad && requireFree ? 1 : 0);
