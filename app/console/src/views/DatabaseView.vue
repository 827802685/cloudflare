<script setup lang="ts">
/**
 * 数据库（D1 + KV + R2 三段一屏，底栏因此是 5 个键）。
 * 三块面板的取数逻辑原样留在 components/data 里，这里只管：
 *  · 选哪一块（写进 URL query，`/kv` 的老链接还能直达 KV）；
 *  · 只挂载当前这一块 —— 另两块连网关请求都不该发（免费档限流实测约 1200 请求/5 分钟/IP）。
 */
import { computed, ref, watch } from "vue";
import { reloadTick } from "../lib/bus";
import { useRoute, useRouter } from "vue-router";
import D1Panel from "../components/data/D1Panel.vue";
import KvPanel from "../components/data/KvPanel.vue";
import R2Panel from "../components/data/R2Panel.vue";

type Store = "d1" | "kv" | "r2";
const SEG: Array<{ k: Store; label: string }> = [
  { k: "d1", label: "D1 数据库" },
  { k: "kv", label: "KV 命名空间" },
  { k: "r2", label: "R2 存储桶" },
];

const route = useRoute();
const nav = useRouter();

/** 初始值只从 URL 读一次：URL 是这屏的唯一事实来源，别再存一份 localStorage 偏好 */
function fromUrl(): Store {
  const s = route.query.store;
  return s === "kv" || s === "r2" ? s : "d1";
}
const store = ref<Store>(fromUrl());

watch(store, (v) => nav.replace({ query: v === "d1" ? {} : { store: v } }));
/** 浏览器前进/后退也要跟着走，否则地址栏和屏幕说的不是同一件事 */
watch(
  () => route.query.store,
  () => {
    const next = fromUrl();
    if (next !== store.value) store.value = next;
  },
);

const PANELS: Record<Store, unknown> = { d1: D1Panel, kv: KvPanel, r2: R2Panel };
const panel = computed(() => PANELS[store.value]);

/** 顶栏「刷新当前屏」：三块面板各自有 refresh，但没往外暴露（它们只认自己的状态）。
 *  重挂是最省事又不会说谎的"整块重取"—— key 一变，组件销毁重建，onMounted 的取数照原样跑一遍。 */
const reloadKey = ref(0);
watch(reloadTick, () => { reloadKey.value++; });
</script>

<template>
  <div>
    <div class="seg" role="tablist" aria-label="存储类型">
      <button
        v-for="s in SEG" :key="s.k" role="tab" :aria-selected="store === s.k"
        class="seg-b" :class="{ on: store === s.k }" @click="store = s.k"
      >{{ s.label }}</button>
    </div>
    <component :is="panel" :key="store + ':' + reloadKey" />
  </div>
</template>

<style scoped>
.seg {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px; margin-bottom: 12px;
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 12px; padding: 3px;
}
.seg-b {
  background: none; border: 0; border-radius: 9px; color: var(--muted);
  padding: 9px 4px; font-size: 13px; font-family: inherit; letter-spacing: .02em;
  transition: color .16s ease, background .16s ease;
}
.seg-b.on { background: var(--panel-3); color: var(--accent); font-weight: 650; box-shadow: 0 1px 0 rgba(255, 255, 255, .04) inset; }
</style>
