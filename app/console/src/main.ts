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

/* ---------- 安卓返回键：不直接退出应用（2026-10-19） ----------
 * 默认行为是「能回退就回退，到根就 activity 退出」，到首页手一滑就整个退出去，太脆。
 * 接 @capacitor/app 的 backButton：能回退走路由历史；到根改成最小化到后台
 * （minimizeApp 不杀进程，回来还是原状态），真正想关就从最近任务里划掉。
 * 只在 APK 原生壳里注册；网页 / PWA 没有实体返回键，不引入这段。
 */
if (import.meta.env.PROD) {
  import("@capacitor/core").then(({ Capacitor }) => {
    if (!Capacitor.isNativePlatform()) return;
    import("@capacitor/app").then(({ App: CapApp }) => {
      CapApp.addListener("backButton", ({ canGoBack }) => {
        if (canGoBack) window.history.back();
        else CapApp.minimizeApp().catch(() => CapApp.exitApp());
      });
    }).catch(() => { /* 插件没装上就退回系统默认行为 */ });
  }).catch(() => { /* 同上 */ });
}
