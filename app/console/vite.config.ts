import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/**
 * 这个文件跑在 Node 里，但本项目没装 @types/node（`npm run check` 会直接报 "Cannot find name 'process'"），
 * 所以只声明真正用到的那一小截，不为一个配置文件把整个 node 类型集拉进来。
 */
declare const process: { env: Record<string, string | undefined> };

import pkg from "./package.json";

/** 当前版本：CI 出包时用 VITE_APP_VERSION（与 Release tag 同口径），本地 dev 退回 package.json */
const APP_VERSION = String(process.env.VITE_APP_VERSION || pkg.version);

/**
 * 开发期把 /api 反代到本地网关（wrangler dev 默认 8787，我们固定 8788 以免和别的 Worker 撞）。
 * 为什么必须走代理而不是直连 api.cloudflare.com：实测官方 API 不发任何 CORS 头，
 * 预检 OPTIONS 直接 400（docs/06 §1），浏览器方案只有自建网关这一条路。
 *
 * strictPort 是被踩出来的：vite 默认在端口被占时**静默往后漂**（5173→5174→5175…）。
 * 本机当时有别的工作树的 vite 占着 5173，本项目的界面因此漂到 5175/5176，
 * 人按习惯打开 localhost:5173 看到的是**旧分支的界面**，还以为是自己刚改的那份没生效 ——
 * 「数据刷新不出来」有一半就是这么来的。宁可起不来报错，也不要悄悄换端口。
 *
 * 端口和网关地址都能用环境变量覆盖：CF_CONSOLE_UI_PORT / CF_CONSOLE_PREVIEW_PORT /
 * CF_CONSOLE_GATEWAY。`npm run dev -- --port 5180` 也照样有效（CLI 优先级更高），
 * app/console 的 predev 端口体检会跟着 npm_config_port 一起判，不会拦住换端口的用法。
 */
export default defineConfig(() => {
  const gwTarget = String(process.env.CF_CONSOLE_GATEWAY || "http://127.0.0.1:8788").replace(/\/+$/, "");
  const uiPort = Number(process.env.CF_CONSOLE_UI_PORT || 5173);
  const previewPort = Number(process.env.CF_CONSOLE_PREVIEW_PORT || 4173);
  // 默认只听本机。要对局域网开放（手机真机验 PWA）时置 CF_CONSOLE_HOST=0.0.0.0 重启即可。
  // 注意：局域网设备要用「同源 /api」（baseUrl 留空），由 vite 在本机反代到 127.0.0.1:8788 的网关 ——
  // 网关本身仍只听 127.0.0.1、不跟着一块儿暴露，设备令牌那道准入闸照旧生效。
  const host = String(process.env.CF_CONSOLE_HOST || "localhost");

  // dev 和 preview 用同一份代理规则：preview serve 的是 dist/ 生产包，
  // 没有这段的话 `npm run preview` 里 /api 会 404，就验不出"生产构建 + 本地网关"这条链路。
  const proxy = {
    "/api": {
      target: gwTarget,
      changeOrigin: true,
      rewrite: (p: string) => p.replace(/^\/api/, ""),
    },
  };
  return {
    plugins: [vue()],
    server: { host, port: uiPort, strictPort: true, proxy },
    preview: { host, port: previewPort, strictPort: true, proxy },
    build: { target: "es2022", sourcemap: false },
    define: {
      // 版本检查（lib/version.ts）用：编译期替换成字面量，运行时不用再发请求
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
  };
});
