/**
 * 版本与更新检查（APK / 网页通用）。
 *
 * 数据源：本仓库的 GitHub Releases（latest）。国内直连 GitHub 不稳，下载与页面走**加速域名**
 * （路径形式 <accel>/<owner>/<repo>/...，实测确认）；域名不写死在代码里，构建期由仓库
 * 变量 GH_ACCEL_BASE 经 `VITE_GH_ACCEL_BASE` 注入，换加速域名只改仓库变量、重出包。
 *
 * 三级回退（谁先出数用谁）：**API 直连 → releases.atom 经加速 → atom 直连**。
 * 为什么 API 不走加速：加速域名的路径形式是 <accel>/<owner>/<repo>/...（0.1.7 实测确认），
 * api.github.com 没有 owner/repo 结构、代理不了；而 releases.atom 是 github.com 路径、必在放行
 * 范围里。它没有资产清单，兜底时下载按钮退化为「打开发行说明页」。
 * 任何一级的 HTTP 404/5xx 都算"此路不通"继续回退（0.1.4 踩过：404 被当成终局直接报错）；
 * 三级全空才报错 —— 绝不把"读不到"说成"已是最新"。
 */

const REPO = "827802685/cloudflare";

/** 打包时由 vite define 从构建环境注入（CI 的发布版本 or package.json 版本） */
declare const __APP_VERSION__: string;
export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

/** 加速域名（尾斜杠已剥）；空串 = 没配置，全部直连 GitHub */
export const ACCEL_BASE = String(import.meta.env.VITE_GH_ACCEL_BASE ?? "").trim().replace(/\/+$/, "");

/** 全部候选（GH_ACCEL_BASE 支持逗号分隔，按序回退；0.2.2 起）：首选给下载页按钮，检查更新逐个试 */
export const ACCEL_BASES = String(import.meta.env.VITE_GH_ACCEL_BASE ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

/**
 * gh-proxy 的**完整 URL 前缀**拼法（0.2.2 换公共加速站时定的）：<accel>/https://github.com/...。
 * 公共实例（ghproxy.link 等）只认这个形式；自建 gh-proxy Worker 在入口把两种形式都归一化，同样兼容。
 * 0.1.7 用的裸路径拼法 <accel>/<owner>/<repo>/... 只有自建认，公共站全 404，弃。
 * 传进来的必须是 github.com 的 URL（API 域名没有 owner/repo 结构，加速不了，也不需要）。
 */
function viaAccel(base: string, ghUrl: string): string {
  return `${base}/${ghUrl}`;
}

export interface UpdateInfo {
  /** 远端最新版本号（不含 v 前缀） */
  version: string;
  /** 发行说明页（该版本的 tag 页） */
  notesUrl: string;
  /** 下载入口：就开 Releases 页面让人挑包，不再直链 APK 文件（文件名含 sha，拼错一次就是 404） */
  downloadUrl: string;
}

/** 只认 x.y.z 三段数字；比较不了（空/乱码）一律当"没有新版本"，宁可漏报不误报 */
export function isNewer(remote: string, local: string): boolean {
  const p = (v: string) =>
    v
      .replace(/^v/i, "")
      .split(".")
      .map((x) => parseInt(x, 10) || 0);
  const a = p(remote);
  const b = p(local);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** 原生 fetch（CapacitorHttp）对 AbortSignal 支持有限，超时自己控（同 direct.ts 的教训） */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/** 拉文本：网络失败 / 超时 / 任何 HTTP 非 2xx 都返回 null（调用方继续走下一级回退） */
async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await withTimeout(fetch(url, { headers: { accept: "application/vnd.github+json" } }), 10_000, "10 秒没响应");
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function fromApi(text: string): UpdateInfo | null {
  try {
    const j = JSON.parse(text);
    const remote = String(j?.tag_name || "").replace(/^v/i, "");
    if (!remote) return null;
    return {
      version: remote,
      notesUrl: ACCEL_BASE ? viaAccel(ACCEL_BASE, `https://github.com/${REPO}/releases/tag/v${remote}`) : `https://github.com/${REPO}/releases/tag/v${remote}`,
      downloadUrl: ACCEL_BASE ? viaAccel(ACCEL_BASE, `https://github.com/${REPO}/releases/`) : `https://github.com/${REPO}/releases/`,
    };
  } catch {
    return null;
  }
}

function fromAtom(text: string, base: string): UpdateInfo | null {
  // releases.atom 的 entry 链接形如 …/releases/tag/v0.1.4；第一条就是最新 Release
  const m = /releases\/tag\/(v[0-9][0-9.]*)/i.exec(text);
  if (!m) return null;
  const remote = m[1].replace(/^v/i, "");
  return {
    version: remote,
    notesUrl: base ? viaAccel(base, `https://github.com/${REPO}/releases/tag/v${remote}`) : `https://github.com/${REPO}/releases/tag/v${remote}`,
    downloadUrl: base ? viaAccel(base, `https://github.com/${REPO}/releases/`) : `https://github.com/${REPO}/releases/`,
  };
}

/** 查最新 Release；有新版本返回 UpdateInfo，没有返回 null；全部数据源都空才抛错 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  const api = `https://api.github.com/repos/${REPO}/releases/latest`;
  const atom = `https://github.com/${REPO}/releases.atom`;
  // API 域名没有 owner/repo 结构、加速域名代理不了（实测 404），所以 API 只走直连（链接仍走首选加速）；
  // atom 是 github.com 路径：首选加速 → 备用加速逐个试 → 直连
  const routes: Array<{ url: string; kind: "api" | "atom"; base: string }> = [
    { url: api, kind: "api", base: ACCEL_BASE },
  ];
  for (const b of ACCEL_BASES) routes.push({ url: viaAccel(b, atom), kind: "atom", base: b });
  routes.push({ url: atom, kind: "atom", base: "" });

  for (const r of routes) {
    const text = await fetchText(r.url);
    if (!text) continue;
    const info = r.kind === "api" ? fromApi(text) : fromAtom(text, r.base);
    if (info) return isNewer(info.version, APP_VERSION) ? info : null;
  }
  throw new Error("检查更新失败：加速域名和 GitHub 直连都不通（或没读到版本号）");
}
