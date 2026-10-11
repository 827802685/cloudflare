<script setup lang="ts">
/**
 * 三态容器（docs/13 §7.3 那条「可直接落地的组件契约」落到看板上）。
 * 竞品是 DashboardCardView.kt:498-520 的 showLoading/showError/showData 互斥显隐，
 * 我们原来是三个屏三套手写（docs/13 §10、gap-checklist E-21）：这里统一成一个组件，
 * **每一块各用自己的三态**，一块坏了不拖整页 —— 网关 overview 用 allSettled 给每张卡
 * 单独带 error，界面就必须能把「只是状态码那块没取到」和「整页挂了」区分开。
 *
 * 状态优先级：loading > error(+有没有内容) > content。
 * 「取到但为空」和「没取到」是两件事：前者走 emptyText（这个窗内确实没有数据），
 * 后者是 error（原因写出来），绝不合并成同一个「0 / —」（docs/09 §E16 那条硬规矩）。
 */
import { computed } from "vue";
import ErrorNote from "../ErrorNote.vue";

const props = defineProps<{
  /** 这一块自己在这次请求里是否还没回来 */
  loading?: boolean;
  /** 这一块的降级原因：网关 Card.error 归成的 {kind,message}，或 GwError */
  err?: { kind?: string; message?: string } | null;
  /** 内容到底有没有：false = 没有任何可显示的东西（不要再叠一层空态文案） */
  has?: boolean;
  loadingText?: string;
  emptyText?: string;
  /** 单块重试（竞品每条错误都自带重试，我们原来只有右上角那个全局刷新） */
  canRetry?: boolean;
}>();
const emit = defineEmits<{ (e: "retry"): void }>();

const kind = computed<"loading" | "error" | "error+partial" | "content">(() => {
  if (props.loading) return "loading";
  if (props.err) return props.has ? "error+partial" : "error";
  return "content";
});

/**
 * 同一份状态再暴露成一个类名，只为 main.css 里那道「读数轨」上色用 ——
 * 判断逻辑一行没改，也不是新事实：它就是上面这四态的另一种呈现。
 * 注意 st-empty 只代表"取到了但这一窗确实没条目"，跟 st-error（没取到）必须分开，
 * 别让视觉层把 docs/09 §E16 那套口径又混回去。
 */
const railClass = computed(() => {
  if (kind.value === "loading") return "st-pending";
  if (kind.value === "error") return "st-error";
  if (kind.value === "error+partial") return "st-partial";
  return props.has ? "st-data" : "st-empty";
});
</script>

<template>
  <div class="async" :class="railClass" aria-live="polite">
    <template v-if="kind === 'loading'">
      <slot name="loading">
        <div class="empty">{{ loadingText || "取数中…" }}</div>
      </slot>
    </template>

    <template v-else-if="kind === 'error'">
      <slot name="error" :err="err">
        <ErrorNote :err="err || undefined" :can-retry="canRetry" @retry="emit('retry')" />
      </slot>
    </template>

    <template v-else-if="kind === 'error+partial'">
      <ErrorNote :err="err || undefined" tone="warn" :can-retry="canRetry" @retry="emit('retry')" />
      <slot />
    </template>

    <template v-else>
      <slot v-if="has" />
      <div v-else class="empty">{{ emptyText || "这个时间窗里确实没有数据（不是没取到）" }}</div>
    </template>
  </div>
</template>

<style scoped>
.async { display: block; }
.async > .err { margin-bottom: 8px; }
</style>
