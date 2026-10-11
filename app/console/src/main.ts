import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { watchSystemTheme } from "./lib/theme";
import "./styles/main.css";

/**
 * 手机上真正跑的形态是 PWA（加到主屏），不是 APK：
 * docs/09 §C5 实测 GitHub Actions 的 artifact 下载在国内不稳，Capacitor 出包留作增强项。
 */
// 挂载前先把外观档落好，避免深色下白闪一屏（MASTER.md §7）
watchSystemTheme();

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");

// 只在生产构建里注册 SW；开发期注册会让 vite 的改动被旧缓存吃掉
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* 注册失败不影响使用，最坏情况就是没有离线缓存 */
  });
}
