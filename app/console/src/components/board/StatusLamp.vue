<script setup lang="ts">
/**
 * 状态灯 + 一句结论（docs/13 §5.1 卡片第 1 行：竞品是「标题 + 状态指示灯 + 状态文本」）。
 *
 * 关键前提：**竞品这三档的阈值没有任何出处**（docs/13 L251 只给了灯和文案，没给判定线；
 * §10 把「阈值」归到「必须自研」）。所以这里的规则是我们自己定的，而且**规则本身必须显示出来**
 * —— 不显示就等于把我们的猜测伪装成 Cloudflare 的结论。点灯或点「判定规则」就地展开原文。
 */
import { ref } from "vue";

const props = defineProps<{
  level: "ok" | "warn" | "bad" | "unknown";
  /** 一句结论，必须逐字能被屏上的数字支撑 */
  text: string;
  /** 自研阈值原文（每条一行），展开给人看，可被否决 */
  rules: string[];
  /** 这一句用到了哪些输入、哪些没参与到 */
  basis?: string;
}>();

const open = ref(false);
const WORD: Record<string, string> = { ok: "正常", warn: "警告", bad: "严重", unknown: "判不了" };
</script>

<template>
  <div class="lamp" :class="props.level">
    <button class="head" @click="open = !open" :aria-expanded="open">
      <span class="bulb" />
      <span class="word">{{ WORD[props.level] }}</span>
      <span class="concl">{{ props.text }}</span>
      <span class="hint">{{ open ? "收起判定规则" : "判定规则" }}</span>
    </button>
    <div class="rules" v-if="open">
      <div class="own">阈值是本控制台自研的（Cloudflare 官方也没有这个三档定义），规则原文如下，不接受就当我判错：</div>
      <ul>
        <li v-for="(r, i) in props.rules" :key="i">{{ r }}</li>
      </ul>
      <div class="basis" v-if="props.basis">本次判定用到的输入：{{ props.basis }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 状态灯是这一屏的脸面：整块按档位染色，但只染到"能感觉到、又没抢数字"的程度 */
.lamp { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 10px 12px; margin: 8px 0 12px; box-shadow: var(--shadow); }
.lamp.ok { border-color: rgb(var(--ok-rgb) / .32); background: linear-gradient(180deg, rgb(var(--ok-rgb) / .07), transparent 70%), var(--panel); }
.lamp.warn { border-color: rgb(var(--warn-rgb) / .34); background: linear-gradient(180deg, rgb(var(--warn-rgb) / .07), transparent 70%), var(--panel); }
.lamp.bad { border-color: rgb(var(--bad-rgb) / .38); background: linear-gradient(180deg, rgb(var(--bad-rgb) / .09), transparent 70%), var(--panel); }
.head { display: flex; align-items: baseline; gap: 9px; width: 100%; background: none; border: 0; padding: 0; color: var(--fg); text-align: left; font: inherit; cursor: pointer; }
.bulb { width: 9px; height: 9px; border-radius: 50%; flex: none; align-self: center; background: var(--muted); }
.ok .bulb { background: var(--ok); box-shadow: 0 0 0 4px rgb(var(--ok-rgb) / .14), 0 0 8px rgb(var(--ok-rgb) / .7); }
.warn .bulb { background: var(--warn); box-shadow: 0 0 0 4px rgb(var(--warn-rgb) / .14), 0 0 8px rgb(var(--warn-rgb) / .7); }
.bad .bulb { background: var(--bad); box-shadow: 0 0 0 4px rgb(var(--bad-rgb) / .16), 0 0 8px rgb(var(--bad-rgb) / .75); }
.word { font-size: 13px; font-weight: 700; letter-spacing: .04em; flex: none; }
.ok .word { color: var(--ok); }
.warn .word { color: var(--warn); }
.bad .word { color: var(--bad); }
.unknown .word { color: var(--muted); }
.concl { font-size: 13px; line-height: 1.5; flex: 1; min-width: 0; color: var(--fg-2); }
.hint { font-size: 11px; color: var(--muted); flex: none; text-decoration: underline; text-underline-offset: 3px; }
.rules { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); font-size: 12px; color: var(--muted); }
.rules .own { color: var(--fg-2); margin-bottom: 5px; }
.rules ul { margin: 0; padding-left: 18px; }
.rules li { margin: 3px 0; }
.rules .basis { margin-top: 7px; font-family: var(--font-num); font-size: 11.5px; }
</style>
