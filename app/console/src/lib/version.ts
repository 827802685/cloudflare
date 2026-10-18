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

/**
 * 加速域名的路径形式（实测 0.1.7 撞出来的）：<accel>/<owner>/<repo>/...，
 * **不带** https://github.com 前缀 —— 按 gh-proxy 的老拼法 <accel>/https://github.com/... 反而 404。
 * 传进来的必须是 github.com 的 URL（API 域名没有 owner/repo 结构，加速不了，也不需要）。
 */
function viaAccel(ghUrl: string): string {
  return `${ACCEL_BASE}/${ghUrl.replace(/^https:\/\/github\.com\//i, "")}`;
}

export interface UpdateInfo {
  /** 远端最新版本号（不含 v 前缀） */
  version: string;
  /** 发行说明页（Releases） */
  notesUrl: string;
  /** APK 下载（配置了加速域名就带前缀）；atom 兜底拿不到资产清单时为 null */
  apkUrl: string | null;
  /** APK 直连下载（原始 GitHub 地址）；加速域名抽风时的备选，与 apkUrl 二选一 */
  apkUrlDirect: string | null;
  /** APK 字节数（拿不到就不显示） */
  size?: number;
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
    const assets: any[] = Array.isArray(j?.assets) ? j.assets : [];
    const apk = assets.find((a) => String(a?.name || "").toLowerCase().endsWith(".apk"));
    const dl = apk?.browser_download_url ? String(apk.browser_download_url) : null;
    // 发行说明页与下载链接都按加速域名的路径形式给（<accel>/<owner>/<repo>/...）
    const notes = ACCEL_BASE
      ? viaAccel(`https://github.com/${REPO}/releases/tag/v${remote}`)
      : String(j?.html_url || `https://github.com/${REPO}/releases`);
    return {
      version: remote,
      notesUrl: notes,
      apkUrl: dl && ACCEL_BASE ? viaAccel(dl) : dl,
      apkUrlDirect: dl,
      size: typeof apk?.size === "number" ? apk.size : undefined,
    };
  } catch {
    return null;
  }
}

function fromAtom(text: string): UpdateInfo | null {
  // releases.atom 的 entry 链接形如 …/releases/tag/v0.1.4；第一条就是最新 Release
  const m = /releases\/tag\/(v[0-9][0-9.]*)/i.exec(text);
  if (!m) return null;
  const remote = m[1].replace(/^v/i, "");
  // atom 没有资产清单，拼不出 APK 文件名 —— 下载入口退化为发行说明页
  const notes = ACCEL_BASE ? viaAccel(`https://github.com/${REPO}/releases/tag/v${remote}`) : `https://github.com/${REPO}/releases/tag/v${remote}`;
  return { version: remote, notesUrl: notes, apkUrl: null, apkUrlDirect: null };
}

/** 查最新 Release；有新版本返回 UpdateInfo，没有返回 null；三级数据源全空才抛错 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  const api = `https://api.github.com/repos/${REPO}/releases/latest`;
  const atom = `https://github.com/${REPO}/releases.atom`;
  // API 域名没有 owner/repo 结构、加速域名代理不了（实测 404），所以 API 只走直连；
  // atom 是 github.com 路径，走加速 → 直连两级
  const routes: Array<{ url: string; kind: "api" | "atom" }> = [
    { url: api, kind: "api" },
  ];
  if (ACCEL_BASE) routes.push({ url: viaAccel(atom), kind: "atom" });
  routes.push({ url: atom, kind: "atom" });

  for (const r of routes) {
    const text = await fetchText(r.url);
    if (!text) continue;
    const info = r.kind === "api" ? fromApi(text) : fromAtom(text);
    if (info) return isNewer(info.version, APP_VERSION) ? info : null;
  }
  throw new Error("检查更新失败：加速域名和 GitHub 直连都不通（或没读到版本号）");
}
