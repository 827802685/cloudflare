/**
 * 版本与更新检查（APK / 网页通用）。
 *
 * 数据源：本仓库的 GitHub Releases（latest）。国内直连 GitHub 不稳，所以下载与 API
 * 都走**加速域名**前缀（gh-proxy 形态：<accel>/<完整 GitHub URL>）；域名不写死在代码里，
 * 构建期由仓库变量 GH_ACCEL_BASE 经 `VITE_GH_ACCEL_BASE` 注入（cf-console-build.yml），
 * 以后换加速域名只改仓库变量、重出包即可。
 *
 * 诚实边界：加速域名只保证「尽量可达」，不保证它一直活着 —— 所以 accel 请求失败会
 * 静默退回直连 GitHub；两条都挂就报错，绝不假装"已是最新"。
 */

const REPO = "827802685/cloudflare";

/** 打包时由 vite define 从构建环境注入（package.json 版本 or CI 算出的发布版本） */
declare const __APP_VERSION__: string;
export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

/** 加速域名（尾斜杠已剥）；空串 = 没配置，全部直连 GitHub */
export const ACCEL_BASE = String(import.meta.env.VITE_GH_ACCEL_BASE ?? "").trim().replace(/\/+$/, "");

export interface UpdateInfo {
  /** 远端最新版本号（不含 v 前缀） */
  version: string;
  /** 发行说明页（Releases） */
  notesUrl: string;
  /** APK 直链：配了加速域名就走它，没有就退回 GitHub 原始下载地址 */
  apkUrl: string;
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

async function fetchLatest(api: string): Promise<Response> {
  const headers = { accept: "application/vnd.github+json" };
  if (ACCEL_BASE) {
    try {
      return await withTimeout(fetch(`${ACCEL_BASE}/${api}`, { headers }), 10_000, "加速域名 10 秒没响应");
    } catch {
      /* 加速域名挂了/不支持 API：退回直连，别直接判死 */
    }
  }
  return withTimeout(fetch(api, { headers }), 10_000, "GitHub 直连 10 秒没响应");
}

/**
 * 查最新 Release；有新版本返回 UpdateInfo，没有（本机已是最新 / 远端读不出版本）返回 null。
 * 抛错只发生在两条网络路都失败 —— 界面要把它如实显示出来，不能吞成"没有更新"。
 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  const api = `https://api.github.com/repos/${REPO}/releases/latest`;
  const res = await fetchLatest(api);
  if (!res.ok) throw new Error(`检查更新失败：HTTP ${res.status}`);
  const j: any = await res.json();
  const remote = String(j?.tag_name || "").replace(/^v/i, "");
  if (!remote || !isNewer(remote, APP_VERSION)) return null;
  const assets: any[] = Array.isArray(j?.assets) ? j.assets : [];
  const apk = assets.find((a) => String(a?.name || "").toLowerCase().endsWith(".apk"));
  const dl = String(apk?.browser_download_url || `https://github.com/${REPO}/releases/latest`);
  return {
    version: remote,
    notesUrl: String(j?.html_url || `https://github.com/${REPO}/releases`),
    apkUrl: ACCEL_BASE ? `${ACCEL_BASE}/${dl}` : dl,
    size: typeof apk?.size === "number" ? apk.size : undefined,
  };
}
