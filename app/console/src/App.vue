<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGatewayStore } from "./stores/gateway";
import { gwHealth, isNativeApp } from "./lib/api";
import { checkUpdate, type UpdateInfo } from "./lib/version";
import UpdateDialog from "./components/UpdateDialog.vue";

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
  { key: "domains", label: "域名", to: "/domains", icon: "◎" },
  { key: "compute", label: "计算", to: "/compute", icon: "◈" },
  { key: "board", label: "看板", to: "/board", icon: "▦" },
  { key: "database", label: "数据库", to: "/database", icon: "⛁" },
  { key: "zt", label: "Zero Trust", to: "/zero-trust", icon: "⛨" },
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
 * 顶栏只剩"当前屏名 + 右上角设置"两件事。原来右上角那条网关地址/账号名搬进了设置屏
 * （10-11 他点的：设置挪到右上角，右上角原来的塞进设置里）—— 它本来也是"这台设备的配置"，
 * 不是"这一屏的内容"，放在标题旁边会让人误读成数据口径。地址三级回落的判断（本机填写 /
 * 打包默认 / 同源 /api）在 SettingsView 里用同一个 baseSource() 算，逻辑没变。
 */
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="dot" :class="{ off: !gw.configured }" />
        <b>{{ title }}</b>
      </div>
      <!-- 设置挪到右上角（10-11 他改的口）；右上角原来那条地址/账号一起搬进设置屏，顶栏不再放副标题 -->
      <button class="cfg" :class="{ on: activeTab === 'settings' }" :title="activeTab === 'settings' ? '返回' : '设置'" aria-label="设置" @click="toggleSettings">⚙</button>
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
        <span class="ico">{{ t.icon }}</span>
        <span>{{ t.label }}</span>
      </button>
    </nav>
  </div>
</template>
