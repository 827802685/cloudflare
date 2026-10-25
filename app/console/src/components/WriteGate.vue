<script setup lang="ts">
/**
 * 本机写开关 —— 全站唯一实现。
 *
 * 这个开关只有一个真相：localStorage 的 `cfconsole.writes.v1`（api.ts 的 writesOptIn）。
 * 但在 2026-10-25 之前，同一个键在 8 个地方各画了一遍，出现了 4 种措辞
 * （「本机写开关：已打开」/「写开关已开」/「打开本机写开关」/「未打开」），
 * 改一句话要翻八个文件，且总有一两处漏改 —— 这就是"同一个概念在界面上有三种名字"的来源。
 *
 * 三种形态按场景选，选的是**位置**而不是语义：
 *  · bar    —— 整行（标题 + 一句后果说明），放在内容顶部，用户读完再动手（域名页 / KV / 清理面板 / cron）；
 *  · inline —— 卡片标题行里的紧凑版，不额外占一行（Worker / Pages 详情）；
 *  · button —— 只给一个开闸键，用于"整页前提"的场景（令牌页：不开闸列表都读不了）。
 *
 * 状态用 v-model 双向绑：父组件保留自己的 `optIn` ref 去做按钮 disabled 判断，
 * 组件负责写 localStorage 并回传 —— 不让出现"组件说开着、父组件以为关着"两份真相。
 */
import { writesOptIn, setWritesOptIn } from "../lib/api";

const props = withDefaults(
  defineProps<{
    /** 位置形态（见文件头）。默认 inline，因为多数调用点在卡片标题行里 */
    variant?: "bar" | "inline" | "button";
    /** bar 形态下那句后果说明，留空用组件内置的两句（四态措辞统一在这里维护） */
    note?: string;
  }>(),
  { variant: "inline", note: "" },
);

const model = defineModel<boolean>({ default: () => writesOptIn() });

function toggle(v: boolean) {
  setWritesOptIn(v);
  model.value = v;
}

/** 网关那一侧还有一道 WRITE_ENABLED。关着时说不说这一句，由调用处的场景决定，
 *  所以只在 bar 形态里内置，inline / button 保持一句话说完。 */
const onNote = () => props.note || "变更请求会真的发出，发出前逐条确认。";
const offNote = () => props.note || "写操作在这台设备上就被拦下，不发请求。";
</script>

<template>
  <!-- 只给开闸键：开了之后按钮自己消失（原令牌页用 v-if 包了一整块，现在收在这里） -->
  <button v-if="variant === 'button'" v-show="!model" class="primary" @click="toggle(true)">
    打开本机写开关
  </button>

  <!-- 卡片标题行里的紧凑版 -->
  <label v-else-if="variant === 'inline'" class="wg-inline">
    <input type="checkbox" class="switch" :checked="model" @change="toggle(($event.target as HTMLInputElement).checked)" />
    <span>{{ model ? "写开关已开" : "写开关关" }}</span>
  </label>

  <!-- 整行版：标题 + 后果说明 -->
  <div v-else class="wg-bar">
    <label class="wg-t">
      <input type="checkbox" class="switch" :checked="model" @change="toggle(($event.target as HTMLInputElement).checked)" />
      <b>本机写开关：{{ model ? "已打开" : "关（默认）" }}</b>
    </label>
    <span class="muted small">{{ model ? onNote() : offNote() }}</span>
  </div>
</template>

<style scoped>
.wg-inline {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  font-size: var(--t-xs); color: var(--muted); white-space: nowrap; cursor: pointer;
}
.wg-bar {
  display: flex; flex-direction: column; gap: 3px;
  padding: 10px 12px; margin-bottom: 12px;
  background: var(--panel-2); border: 1px solid var(--line-soft); border-radius: var(--radius);
}
.wg-t { display: flex; align-items: center; gap: 8px; font-size: var(--t-sm); cursor: pointer; }
</style>
