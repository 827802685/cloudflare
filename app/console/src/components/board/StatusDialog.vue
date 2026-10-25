<script setup lang="ts">
/**
 * 状态告警弹窗（2026-10-25）。
 *
 * 为什么从"页面里一张状态卡"改成弹窗：那张卡常驻在首屏最上方，正常时是一句"都在阈值线内"，
 * 严重时是一大段红字 —— 两种情况都占了主读数上面的位置。而"严重"本身是**需要打断**的信息，
 * 用弹窗表达才对等：不该被滚过去，也不该天天挡着。
 *
 * 「今天不再提醒」写的是日期而不是布尔：勾一次只管当天，第二天照常提醒。
 * 阈值与判定规则是本控制台自研的（CF 官方没有这三档），所以规则必须能就地展开看。
 */
import { ref } from "vue";

const props = defineProps<{
  level: "ok" | "warn" | "bad" | "unknown";
  text: string;
  rules: string[];
  basis?: string;
}>();
const emit = defineEmits<{ (e: "close", quiet: boolean): void }>();

const quiet = ref(false);
const rulesOpen = ref(false);
const WORD: Record<string, string> = { ok: "正常", warn: "警告", bad: "严重", unknown: "判不了" };
</script>

<template>
  <div class="scrim" @click.self="emit('close', quiet)">
    <div class="dlg" :class="props.level" role="dialog" aria-modal="true" aria-labelledby="sd-word">
      <div class="hd">
        <span class="bulb" />
        <b id="sd-word" class="word">{{ WORD[props.level] }}</b>
        <span class="ttl">仪表盘状态</span>
      </div>

      <p class="msg">{{ props.text }}</p>

      <button class="rulesBtn" :aria-expanded="rulesOpen" @click="rulesOpen = !rulesOpen">
        {{ rulesOpen ? "收起判定规则" : "看判定规则" }}
      </button>
      <div class="rules" v-if="rulesOpen">
        <div class="own">阈值是本控制台自研的（Cloudflare 官方没有这三档定义），规则原文如下，不接受就当我判错：</div>
        <ul>
          <li v-for="(r, i) in props.rules" :key="i">{{ r }}</li>
        </ul>
        <div class="basis" v-if="props.basis">本次判定用到的输入：{{ props.basis }}</div>
      </div>

      <label class="quiet">
        <input type="checkbox" v-model="quiet" />
        <span>今天不再提醒</span>
      </label>

      <div class="acts">
        <button class="primary" @click="emit('close', quiet)">知道了</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed; inset: 0; z-index: 40;
  background: var(--scrim);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
.dlg {
  width: 100%; max-width: 400px;
  background: var(--panel); border-radius: 20px; padding: 16px 17px 14px;
  box-shadow: var(--e-2);
  border: 1px solid var(--line);
}
/* 只染边与标题，不整块铺色：弹窗里要读文字，铺满红底会让长句变难读 */
.dlg.warn { border-color: rgb(var(--warn-rgb) / .45); }
.dlg.bad { border-color: rgb(var(--bad-rgb) / .5); }
.hd { display: flex; align-items: center; gap: 8px; }
.bulb { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--muted); }
.warn .bulb { background: var(--warn); box-shadow: 0 0 0 4px rgb(var(--warn-rgb) / .14), 0 0 8px rgb(var(--warn-rgb) / .7); }
.bad .bulb { background: var(--bad); box-shadow: 0 0 0 4px rgb(var(--bad-rgb) / .16), 0 0 8px rgb(var(--bad-rgb) / .75); }
.ok .bulb { background: var(--ok); box-shadow: 0 0 0 4px rgb(var(--ok-rgb) / .14), 0 0 8px rgb(var(--ok-rgb) / .7); }
.word { font-size: var(--t-base); font-weight: 700; letter-spacing: .04em; }
.warn .word { color: var(--warn); }
.bad .word { color: var(--bad); }
.ok .word { color: var(--ok); }
.unknown .word { color: var(--muted); }
.ttl { margin-left: auto; font-size: var(--t-2xs); color: var(--muted); letter-spacing: .06em; }
.msg { margin: 10px 0 0; font-size: var(--t-sm); line-height: 1.6; color: var(--fg-2); }
.rulesBtn {
  margin-top: 9px; padding: 0; border: 0; background: none; font: inherit;
  font-size: var(--t-xs); color: var(--muted); cursor: pointer;
  text-decoration: underline; text-underline-offset: 3px;
}
.rulesBtn:hover { color: var(--accent); }
.rules { margin-top: 9px; padding-top: 9px; border-top: 1px dashed var(--line); font-size: var(--t-xs); color: var(--muted); }
.rules .own { color: var(--fg-2); margin-bottom: 5px; }
.rules ul { margin: 0; padding-left: 17px; }
.rules li { margin: 3px 0; }
.rules .basis { margin-top: 7px; font-family: var(--font-num); font-size: var(--t-2xs); }
.quiet {
  display: flex; align-items: center; gap: 8px; margin-top: 14px;
  font-size: var(--t-xs); color: var(--muted); cursor: pointer; user-select: none;
}
.acts { display: flex; justify-content: flex-end; margin-top: 12px; }
</style>
