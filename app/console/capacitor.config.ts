import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor 壳配置。第一版交付形态是 PWA（加主屏），这个文件是给"想装成 APK"的增强路径准备的：
 * 本机没有 Android SDK / Gradle，只有 JDK 8（docs/09 §C6），所以本地不出包，
 * 出包走仓库根的 .github/workflows/cf-console-build.yml（见 docs/11 §4），并且需要先建仓 —— 建仓要另行授权。
 */
const config: CapacitorConfig = {
  appId: "io.acct.console",
  appName: "CF 控制台",
  webDir: "dist",
  backgroundColor: "#000000",
  server: {
    // 打进 APK 的静态壳仍然连你自己的网关；不写死 workers.dev，因为本机网络不可达（docs/09 §C1）
    androidScheme: "https",
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    /**
     * 原生 HTTP：开启后 Capacitor 把 WebView 里的 fetch/XHR 代理到原生网络栈，**不参与同源策略**，
     * 所以 APK 可以直接打 api.cloudflare.com —— 这正是浏览器做不到、必须靠网关绕开 CORS 的那件事。
     * 开了它，App 就不必依赖任何人的网关（开源用户装包即用）。
     *
     * 代价（在直连层里规避）：原生 fetch 对 AbortSignal 支持有限，所以超时用 Promise.race 自己控。
     */
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
