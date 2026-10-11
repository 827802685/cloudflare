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
};

export default config;
