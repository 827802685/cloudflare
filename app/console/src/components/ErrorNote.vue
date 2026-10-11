<script setup lang="ts">
import { computed } from "vue";
import { GwError, type ErrKind } from "../lib/api";

const props = defineProps<{
  /** GwError 或网关卡片降级返回的 {kind,message} */
  err?: GwError | { kind?: string; message?: string } | null;
  /** 只有一块面板坏了时用 info 语气，不要满屏红 */
  tone?: "bad" | "warn" | "info";
  /** 给错误块配一个「重试」按钮（竞品每条错误都自带重试，我们原来只有右上角那个全局刷新） */
  canRetry?: boolean;
}>();
const emit = defineEmits<{ (e: "retry"): void }>();

/** kind → 该用什么语气：权限/套餐类是"这块功能灰掉"，不是"你错了" */
const SOFT: ErrKind[] = ["permission", "planLimit", "serviceDisabled", "writesDisabled", "notFound"];
const cls = computed(() => {
  if (props.tone) return props.tone;
  const k = props.err?.kind as ErrKind | undefined;
  return k && SOFT.includes(k) ? "warn" : "bad";
});
const hint = computed(() => (props.err instanceof GwError ? props.err.hint : undefined));
</script>

<template>
  <div v-if="err" class="err" :class="cls">
    <div>{{ err.message || "请求失败" }}<span class="muted" v-if="err.kind"> · {{ err.kind }}</span></div>
    <div class="why" v-if="hint">{{ hint }}</div>
    <button v-if="canRetry" class="ghost sm" @click="emit('retry')">重试</button>
  </div>
</template>
