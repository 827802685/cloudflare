import { createRouter, createWebHistory } from "vue-router";

import BoardView from "./views/BoardView.vue";
import ComputeView from "./views/ComputeView.vue";
import DomainsView from "./views/DomainsView.vue";
import SettingsView from "./views/SettingsView.vue";
import WorkerDetailView from "./views/WorkerDetailView.vue";
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
    { path: "/settings", name: "settings", component: SettingsView, meta: { tab: "settings", title: "设置" } },
    { path: "/:pathMatch(.*)*", redirect: "/board" },
  ],
});
