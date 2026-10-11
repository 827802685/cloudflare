<script setup lang="ts">
/**
 * 介绍类的话从读数面撤到这里：默认收起，点开才给出处和论证。
 *
 * 口径来自看板那张「口径与说明」卡（他两次说过废话多，但删字不等于删诚实 ——
 * 这些段落解释的是"这个数为什么这么取 / 为什么取不到"，必须留在界面上够得着的地方）。
 * 外观刻意不像一块数据：细边、灰字、没有读数轨，别让人以为藏着指标。
 */
import { ref } from "vue";

withDefaults(
  defineProps<{
    label?: string;
    /** 收起时挂在右边的那句提示；有状态要露出来就填这里（如"这次两套口径对不齐"） */
    hint?: string;
  }>(),
  { label: "口径与出处", hint: "" },
);

const open = ref(false);
</script>

<template>
  <div class="fn">
    <button type="button" class="fn-h" :aria-expanded="open" @click="open = !open">
      <span class="fn-t">{{ label }}</span>
      <span class="fn-x">{{ open ? "收起" : hint || "展开" }}</span>
    </button>
    <div class="fn-b" v-if="open"><slot /></div>
  </div>
</template>

<style scoped>
.fn { margin: 10px 2px 0; border: 1px solid var(--line-soft); border-radius: var(--radius-s); background: var(--panel-2); }
.fn-h {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px; width: 100%;
  padding: 8px 11px; background: none; border: 0; text-align: left; cursor: pointer;
  font-family: inherit; font-size: 12px; color: var(--fg-2);
}
.fn-x { font-size: 11px; color: var(--muted); text-decoration: underline; text-underline-offset: 3px; flex: none; }
.fn-b {
  padding: 0 11px 10px; font-size: 11.5px; line-height: 1.65; color: var(--muted);
  overflow-wrap: break-word;
}
.fn-b :deep(code) { font-size: 11px; }
</style>
