/**
 * 设备配置的读写。单独一个文件是因为 api.ts 和设置页都要用，而谁都不该依赖 Pinia 实例
 * （否则 store ↔ api 会形成循环引用）。
 *
 * 存 localStorage 的只有"网关地址 + 设备令牌 + 选定的账号 id/名"。CF API Token 永远只在网关的
 * .dev.vars / Worker secret 里，前端拿不到，这是整套架构的前提（docs/06 §2）。
 */
const KEY = "cfconsole.config.v1";

export interface Config {
  /** 网关根地址。留空 = 用同源 /api（开发期由 vite 反代到 127.0.0.1:8788） */
  baseUrl: string;
  /** 网关设备令牌，对应网关 .dev.vars 的 DEVICE_TOKENS 之一 */
  deviceToken: string;
  /**
   * 选定的 Cloudflare 账号 id。留空 = 用网关 env 里的默认账号。
   * 网关会拿 `GET /accounts` 的可见集合校验它，不合法直接 422，所以这里存的值不可能是任意字符串。
   */
  account: string;
  /** 上面那个 id 对应的账号名，只用于顶栏显示（重新选时会覆盖） */
  accountName: string;
}

const EMPTY: Config = { baseUrl: "", deviceToken: "", account: "", accountName: "" };

/**
 * 打包期默认网关地址：构建时用 `VITE_GATEWAY_BASE` 注入（见 `.env.apk.example` 与
 * 仓库根 `.github/workflows/cf-console-build.yml` 的手动输入项）。
 *
 * 为什么非要有这个：Capacitor 的 WebView origin 是 `https://localhost`，相对路径 `/api`
 * 会打到手机自己的 localhost 上，而 APK 里并没有网关在跑；纯静态托管（把 dist/ 丢到别处）
 * 同理。没有打包默认值，每次装机都得手填地址才能出数。留空时仍然退回同源 `/api`，
 * 这样 `npm run dev` / `npm run preview`（vite 反代到 127.0.0.1:8788）零配置照常用。
 */
const BUILD_BASE = String(import.meta.env.VITE_GATEWAY_BASE ?? "").trim().replace(/\/+$/, "");
export const PACKAGED_DEFAULT_BASE = BUILD_BASE;

export function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const p = JSON.parse(raw) as Partial<Config>;
    // 旧版本（只有 baseUrl/deviceToken）读进来时 account 自动取 EMPTY 的 ""，所以 KEY 不用升版本：
    // ""= 不传 ?account=，行为与升级前完全一致。
    return {
      baseUrl: String(p.baseUrl ?? "").trim(),
      deviceToken: String(p.deviceToken ?? "").trim(),
      account: /^[0-9a-f]{32}$/i.test(String(p.account ?? "").trim()) ? String(p.account).trim().toLowerCase() : "",
      accountName: String(p.accountName ?? "").trim(),
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveConfig(c: Config): Config {
  const next = {
    baseUrl: c.baseUrl.trim().replace(/\/+$/, ""),
    deviceToken: c.deviceToken.trim(),
    // 只存形状对的 id：网关那侧还会拿 GET /accounts 的可见集合二次校验，这里只是不把脏值写进存储
    account: /^[0-9a-f]{32}$/i.test(c.account.trim()) ? c.account.trim().toLowerCase() : "",
    accountName: c.account.trim() ? c.accountName.trim() : "",
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式下 localStorage 会抛，内存里仍然可用，只是不持久 */
  }
  return next;
}

/** 实际请求用的根地址：设备配置 > 打包默认 > 同源 /api（开发期由 vite 反代） */
export function effectiveBase(c: Config = loadConfig()): string {
  return c.baseUrl || BUILD_BASE || "/api";
}

/** 当前用的是哪一级来源，设置页要如实告诉用户（别让人以为填了其实没生效） */
export function baseSource(c: Config = loadConfig()): { base: string; from: "本机填写" | "打包默认" | "同源 /api" } {
  if (c.baseUrl) return { base: c.baseUrl, from: "本机填写" };
  if (BUILD_BASE) return { base: BUILD_BASE, from: "打包默认" };
  return { base: "/api", from: "同源 /api" };
}

/**
 * 是不是跑在 Capacitor 原生壳里（APK）。判定按优先级：
 *  1. `window.Capacitor.isNativePlatform()` —— 原生运行时（native-bridge.js）注入的全局。
 *     它存在就说明两件事都成立：这是原生壳、且 fetch 已被 patch 到原生网络栈（直连的前提）。
 *  2. 兜底：`capacitor://` 老 scheme，或 `androidScheme:"https"` 下的 `https://localhost`
 *     + Android WebView UA（桥注入万一晚到时的第二信号）。
 *
 * 放在 config.ts 而不是 api.ts：accounts.ts（免口令直连存储）也要用它，
 * 而 api.ts 已经 import config —— 放这里就不会出现 api↔accounts 循环引用。
 */
export function isNativeApp(): boolean {
  try {
    const c = (globalThis as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (c && typeof c.isNativePlatform === "function" && c.isNativePlatform()) return true;
  } catch {
    /* 探测本身抛错：按非原生走 */
  }
  try {
    if (typeof location !== "undefined") {
      if (location.protocol === "capacitor:") return true;
      if (location.protocol === "https:" && location.hostname === "localhost" && /android/i.test(navigator.userAgent)) return true;
    }
  } catch {
    /* 同左 */
  }
  return false;
}
