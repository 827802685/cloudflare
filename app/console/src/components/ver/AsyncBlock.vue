<script lang="ts">
export default { name: "VerAsyncBlock" };
</script>

<script setup lang="ts">
/**
 * 三态容器（docs/13 §7.3：`showLoading / showError / showData` 互斥显隐）。
 *
 * 为什么值得单独一个件：docs/13 §8.2 点名竞品的反馈渠道是「成功失败都只走 Toast」，
 * 一闪而过等于没说；我们要求错误有自己的位置、并且自带重试。
 * 这里还多留了一档竞品没有的语义：**已经有旧数据、这次刷新失败** → 内容照常显示 +
 * 顶部一条 warn，绝不把"这次没刷出来"渲染成"这块没有数据"（同一类错见 docs/09 §E16）。
 */
import { computed, useSlots } from "vue";
import ErrorNote from "../ErrorNote.vue";
import type { GwError } from "../../lib/api";

const props = withDefaults(
  defineProps<{
    loading?: boolean;
    err?: GwError | { kind?: string; message?: string } | null;
    /** 有没有内容数据。空数组要让调用方自己算成 false，别在这里猜"没长度就是没配" */
    has?: boolean;
    emptyText?: string;
    canRetry?: boolean;
  }>(),
  { loading: false, err: null, has: false, emptyText: "没有数据", canRetry: true },
);
const emit = defineEmits<{ (e: "retry"): void }>();
const slots = useSlots();

const state = computed<"content" | "loading" | "error" | "empty">(() => {
  if (props.has) return "content";
  if (props.loading && !props.err) return "loading";
  if (props.err) return "error";
  // loading 中但上一轮有错：也当作 loading 呈现，错误条不该挡住第一帧
  if (props.loading) return "loading";
  return "empty";
});
</script>

<template>
  <div class="ab">
    <template v-if="state === 'content'">
      <ErrorNote v-if="err" :err="err" tone="warn" :can-retry="canRetry" @retry="emit('retry')" />
      <slot />
    </template>

    <div v-else-if="state === 'loading'" class="ab-loading">
      <slot name="loading">加载中…</slot>
    </div>

    <div v-else-if="state === 'error'" class="ab-error">
      <ErrorNote :err="err" :can-retry="canRetry" @retry="emit('retry')" />
      <slot name="aside" />
    </div>

    <div v-else class="empty">
      <slot name="empty">{{ emptyText }}</slot>
    </div>
  </div>
</template>

<style scoped>
.ab { display: flex; flex-direction: column; gap: 8px; }
.ab-loading { color: var(--muted); font-size: 13px; padding: 10px 2px; }
.ab-error { margin-bottom: 2px; }
</style>
