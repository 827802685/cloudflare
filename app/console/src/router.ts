import { createRouter, createWebHistory } from "vue-router";

import BoardView from "./views/BoardView.vue";
import ComputeView from "./views/ComputeView.vue";
import DomainsView from "./views/DomainsView.vue";
import SettingsView from "./views/SettingsView.vue";
import TokensView from "./views/TokensView.vue";
import WorkerDetailView from "./views/WorkerDetailView.vue";
import PagesDetailView from "./views/PagesDetailView.vue";
import DatabaseView from "./views/DatabaseView.vue";
import ZeroTrustView from "./views/ZeroTrustView.vue";

/**
 * 底部导航固定 5 个，顺序按他点的来：域名 / 计算 / 看板（正中）/ 数据库 / Zero Trust。
 * 设置不占底栏，改成顶栏左上角的齿轮（App.vue）。
 * `/kv` 是历史链接（旧版把它单列一屏），现在并进数据库屏，用 query 保留能直达 KV 那段。
 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/board" },
    { path: "/domains", name: "domains", component: DomainsView, meta: { tab: "domains", title: "域名" } },
    { path: "/compute", name: "compute", component: ComputeView, meta: { tab: "compute", title: "计算" } },
    { path: "/board", name: "board", component: BoardView, meta: { tab: "board", title: "看板" } },
    { path: "/database", name: "database", component: DatabaseView, meta: { tab: "database", title: "数据库" } },
    { path: "/kv", redirect: (to) => ({ path: "/database", query: { ...to.query, store: "kv" } }) },
    { path: "/zero-trust", name: "zero-trust", component: ZeroTrustView, meta: { tab: "zt", title: "Zero Trust" } },
    { path: "/workers/:s", name: "worker", component: WorkerDetailView, meta: { tab: "compute", title: "Worker" } },
    // Pages 项目详情：与 Worker 详情同级，从计算页点项目行或动作宫格进来
    { path: "/pages/:p", name: "pages-project", component: PagesDetailView, meta: { tab: "compute", title: "Pages" } },
    { path: "/settings", name: "settings", component: SettingsView, meta: { tab: "settings", title: "设置" } },
    // 令牌管理与设置同属"本机凭据"这一组，但不占底栏；APK 直连才真正可用（视图内有说明）
    { path: "/settings/tokens", name: "tokens", component: TokensView, meta: { tab: "settings", title: "API 令牌" } },
    { path: "/:pathMatch(.*)*", redirect: "/board" },
  ],
});
