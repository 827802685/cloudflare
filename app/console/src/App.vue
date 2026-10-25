<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGatewayStore } from "./stores/gateway";
import { gwHealth, isNativeApp } from "./lib/api";
import { checkUpdate, type UpdateInfo } from "./lib/version";
import UpdateDialog from "./components/UpdateDialog.vue";
import Icon from "./components/Icon.vue";
import { acctState, labelOf, type CfAccount } from "./lib/accounts";
import { reloading, requestReload } from "./lib/bus";

const route = useRoute();
const nav = useRouter();
const gw = useGatewayStore();
/** APK 直连模式：没有网关，进门条件就是"保险箱里有至少一把 CF 令牌" */
const native = isNativeApp();

/* ---------- 冷启动两件静默事：识别展示部署 + 检查更新 ---------- */
/** 发现新版本 → 弹 UpdateDialog（加速/直连双下载）；检查失败就当没有，不弹错误打扰人 */
const updateInfo = ref<UpdateInfo | null>(null);
onMounted(async () => {
  // 展示部署探测：/health 报 demo=true 就免配置出数（失败静默，下次再试）
  if (!native && !gw.demo && !gw.configured) {
    try {
      const h = await gwHealth("");
      if (h?.demo) gw.setDemo(true);
    } catch { /* 未登录（demo 门重定向）或没网：保持原状 */ }
  }
  // 静默检查更新：任何模式都查，出错不出声 —— 更新提示不该打扰正常使用
  try {
    const u = await checkUpdate();
    if (u) updateInfo.value = u;
  } catch { /* 静默 */ }
});

/**
 * 底栏 5 个键，顺序是他 10-11 点的：域名 / 计算 / 看板（正中）/ 数据库（D1+KV+R2 一屏三段）/ Zero Trust。
 * 设置不占底栏一条，是顶栏**右上角**的齿轮（同一轮里他从左上角改到右上角的）。
 */
const tabs = [
  { key: "domains", label: "域名", to: "/domains", icon: "globe" },
  { key: "compute", label: "计算", to: "/compute", icon: "compute" },
  { key: "board", label: "看板", to: "/board", icon: "board" },
  { key: "database", label: "数据库", to: "/database", icon: "disc" },
  { key: "zt", label: "Zero Trust", to: "/zero-trust", icon: "shield" },
];

const activeTab = computed(() => String(route.meta.tab ?? "board"));
const title = computed(() => String(route.meta.title ?? "CF 控制台"));
/** 设置齿轮是开关：不在设置页就进，已经在设置页就返回上一页（看板/详情页原路返回） */
function toggleSettings() {
  if (activeTab.value === "settings") nav.back();
  else nav.push("/settings");
}

const needSetup = computed(() => !gw.configured && activeTab.value !== "settings");

/**
 * 顶栏账号胶囊（2026-10-25）：多账号是这个 App 的核心能力，但切换原来埋在设置页第 6 张卡里。
 * 只有直连模式（APK）才有"账号"这回事 —— 网页模式的身份是网关设备令牌，没有账号可切。
 * 切换动作仍走 gw.save（配置落本机），切完请求一次全局刷新：缓存键含 account，不会串数据，
 * 但屏上仍是旧账号的数值，得让各屏自己重取。
 */
const showWho = computed(() => native && acctState.list.length > 0);
const whoLabel = computed(() => {
  const hit = acctState.list.find((a) => a.id === gw.config.account);
  if (hit) return labelOf(hit);
  return acctState.list.length ? "选择账号" : "未配账号";
});
const whoOpen = ref(false);
function pickWho(a: CfAccount) {
  whoOpen.value = false;
  if (a.id === gw.config.account) return;
  gw.save({ account: a.id, accountName: labelOf(a) });
  requestReload();
}
function goManage() {
  whoOpen.value = false;
  nav.push("/settings");
}

/**
 * 顶栏现在三件：屏名 / 账号胶囊（仅直连）/ 刷新 / 设置。它们都是"设备与这一屏"的控制，
 * 不是数据口径，所以放顶栏；网关地址与账号详情仍在设置屏（10-11 他点的：设置挪右上角，
 * 右上角原来那条塞进设置里）。地址三级回落的判断在 SettingsView 里用同一个 baseSource() 算。
 */
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="dot" :class="{ off: !gw.configured }" />
        <b>{{ title }}</b>
      </div>
      <!-- 顶栏三件套（2026-10-25）：账号胶囊（仅直连）/ 刷新当前屏 / 设置。
           各自只做一件事，原来散在各屏右上角的 6 个「刷新」键收进这里。 -->
      <div class="tb-act">
        <button
          v-if="showWho" class="who" :class="{ on: whoOpen }" :title="'当前账号：' + whoLabel + '（点开切换）'"
          :aria-expanded="whoOpen" @click="whoOpen = !whoOpen"
        >
          <Icon name="account" :size="12" />
          <span class="who-t">{{ whoLabel }}</span>
          <Icon name="chevron" :size="9" />
        </button>
        <button class="tbtn" :class="{ spin: reloading }" :disabled="reloading" title="刷新当前屏" aria-label="刷新当前屏" @click="requestReload">
          <Icon name="refresh" :size="14" />
        </button>
        <button class="cfg" :class="{ on: activeTab === 'settings' }" :title="activeTab === 'settings' ? '返回' : '设置'" aria-label="设置" @click="toggleSettings"><Icon name="gear" :size="14" /></button>
      </div>

      <!-- 账号下拉：每行 = 一个账号（别名优先），底部一条去设置管理。
           下面那层透明遮罩负责"点空白处关掉"——比 document 监听省事，也不会漏掉 iframe 之外的点击。 -->
      <div v-if="whoOpen" class="who-scrim" @click="whoOpen = false" />
      <div v-if="whoOpen" class="who-pop" role="menu">
        <button
          v-for="a in acctState.list" :key="a.id" class="who-item" role="menuitem"
          :class="{ on: a.id === gw.config.account }" @click="pickWho(a)"
        >
          <span class="who-n">{{ labelOf(a) }}</span>
          <span class="who-id">{{ a.id.slice(0, 8) }}…</span>
        </button>
        <button class="who-more" role="menuitem" @click="goManage">管理账号与令牌</button>
      </div>
    </header>

    <main class="body">
      <div v-if="needSetup" class="gate">
        <template v-if="native">
          <p>还没有添加 Cloudflare 账号。</p>
          <p class="muted">APK 是直连模式（不经过网关）：去「设置」粘一把 Cloudflare API Token，验证通过就能用。</p>
        </template>
        <template v-else>
          <p>还没有填网关设备令牌。</p>
          <p class="muted">开发期直接 <code>npm run dev</code>（网关 8788）就能用，令牌在 <code>app/gateway/.device-token</code> 里。</p>
        </template>
        <button class="primary" @click="nav.push('/settings')">去设置</button>
      </div>
      <RouterView v-else />
    </main>

    <UpdateDialog v-if="updateInfo" :info="updateInfo" @close="updateInfo = null" />

    <nav class="tabbar" aria-label="主导航">
      <!-- 桌面档底栏转成左栏后，栏顶要有个名字压阵（不然五个键孤零零贴在浏览器边上）。
           手机档 display:none，不占网格格，所以底栏那 5 列的判定一个字没动。 -->
      <span class="rail-brand">CF 控制台</span>
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ on: activeTab === t.key }"
        :aria-current="activeTab === t.key ? 'page' : undefined"
        @click="nav.push(t.to)"
      >
        <Icon class="ico" :name="t.icon" :size="17" />
        <span>{{ t.label }}</span>
      </button>
    </nav>
  </div>
</template>
