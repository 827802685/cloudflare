<script lang="ts">
/**
 * 环比状态的五种取值 —— 由父级（BoardView）按网关 prev 契约判出来，组件只管怎么说这句话。
 * 分开写是因为 `<script setup>` 里不能有 export；这个块只放类型，没有运行时代码。
 */
export type PrevState =
  /** 响应里根本没有 prev 这个键 = 网关这一版还没算环比 */
  | { state: "absent" }
  /** 请求还没回来 */
  | { state: "pending" }
  /** prev 契约只覆盖 reqs/bytes/visits/threats，派生指标不在内 */
  | { state: "out"; why?: string }
  /** 算了但这一项没取到（prev.字段为 null 且带 error） */
  | { state: "error"; message: string }
  /** 字段是 null 且没给原因 */
  | { state: "novalue" }
  /** 拿到上一窗的值了 */
  | { state: "ok"; value: number | null | undefined; range?: string };
</script>

<script setup lang="ts">
/**
 * 指标瓦片 = 公共件 Tile.vue（label / value / note 一套没另起）+ 这一屏缺的**环比**。
 * 用户点名的就是这条：「竞品每条数据旁边都有涨跌」（docs/13 §5.1 第 4 行那 15 个 tile，
 * §10 明确「15 个指标不必全上」）—— 所以这里上的每一格都必须带涨跌，或者带一句
 * 「为什么这格没有涨跌」，不能静默留空。
 *
 * 环比的三种「没有」是三种不同的话，绝不能都写成 0 或「持平」（同一类错误第三次发生，
 * docs/09 §E16：接口没返回 ≠ 值是 0）：
 *   - `absent`：网关这版响应里**根本没有 prev 这个键** → 「上一窗：网关未提供」
 *   - `error` ：prev 算了但这一项取数失败（带 error 原文）→ 显示原因
 *   - `novalue`：prev 里有这一项但值是 null 且没给原因 → 「上一窗返回空值」
 *   - `out`   ：契约 prev 只有 reqs/bytes/visits/threats 四项，派生指标不在内 → 明说
 */
import { computed, ref } from "vue";
import Tile from "../Tile.vue";

const props = defineProps<{
  label: string;
  /** 已格式化好的主数值文本（拿不到数据时由父级传 "—"，绝不传 "0"） */
  value: string;
  /** 单位/口径写死在这一格上（字节 vs 请求、自然日 vs 滚动窗），省得两窗同名不同义 */
  unit?: string;
  note?: string;
  /**
   * 这一格的取数口径（字段路径、派生公式、跟控制台为什么对不齐）。
   * 10-11 他要求把这类话从读数面上撤掉：「介绍给我删了要么丢进介绍页」。
   * 所以它不再常驻，收在格子底部一枚「口径」按钮后面，点一次才占一行 ——
   * 数字与状态摆在脸上，出处一 tap 可查，两者不再抢同一块地方。
   */
  caliber?: string;
  /** 环比用：这一格的当前数值（派生比率传 0–100 的百分数就够，只用于算百分比差） */
  current?: number | null;
  prev?: PrevState;
  /** 涨上去算好还是坏：威胁/错误率是「涨=坏」，默认涨=好 */
  betterUp?: boolean;
  /** 这一格可被用户隐藏（偏好持久化在父级做） */
  hideable?: boolean;
}>();
const emit = defineEmits<{ (e: "hide"): void }>();
const calOpen = ref(false);

/** prev 整块缺失 / 请求还没回来时传 absent|pending，这里不给 0 */
const band = computed(() => {
  const p = props.prev;
  if (!p) return { text: "环比：未接入", tone: "muted" as const };
  switch (p.state) {
    case "absent":
      return { text: "上一窗：网关未提供", tone: "muted" as const };
    case "pending":
      return { text: "上一窗：取数中…", tone: "muted" as const };
    case "out":
      return { text: p.why || "上一窗：网关环比契约里没有这一项", tone: "muted" as const };
    case "error":
      return { text: "上一窗取数失败：" + brief(p.message), tone: "warn" as const };
    case "novalue":
      return { text: "上一窗：网关返回空值（不是 0）", tone: "muted" as const };
    case "ok": {
      if (p.value === null || p.value === undefined) return { text: "上一窗：网关返回空值（不是 0）", tone: "muted" as const };
      const cur = Number(props.current);
      if (!Number.isFinite(cur)) return { text: "本窗没取到，算不了涨跌", tone: "muted" as const };
      const prev = Number(p.value);
      const win = p.range ? "（" + winLabel(p.range) + "）" : "";
      if (!Number.isFinite(prev)) return { text: "上一窗：值不是数（" + String(p.value) + "）", tone: "muted" as const };
      if (prev === 0) {
        if (cur === 0) return { text: "持平" + win + "：两窗都是 0", tone: "flat" as const };
        return { text: "▲ 新增" + win + "：上一窗为 0", tone: arrowTone(true) as "up" | "down" };
      }
      const d = ((cur - prev) / Math.abs(prev)) * 100;
      if (Math.abs(d) < 2) return { text: "持平" + win + "：" + signed(d, 1) + "%", tone: "flat" as const };
      const up = d > 0;
      return { text: (up ? "▲ " : "▼ ") + signed(d, 1) + "%" + win + " · 上一窗 " + human(prev), tone: arrowTone(up) as "up" | "down" };    }
  }
});

/**
 * 环比取数失败时，网关把 CF 的原文一路带上来，长度能吃掉半屏（同一个原因还在四格里各来一遍）。
 * 这里只做**显示层**压缩：账号 UUID 换成「本账号」、砍掉 "but your query…" 那条重复的尾巴，
 * 原因本身一个字不改；原文整条挂在 title 上，长按/悬停可查，不做删改。
 */
function brief(msg: string): string {
  let s = msg.replace(/account\s*"[0-9a-fA-F-]{8,}"/i, "本账号").replace(/,\s*but your query\b.*$/i, "");
  if (s.length > 72) s = s.slice(0, 72) + "…";
  return s;
}
/** 网关给的上一窗描述带完整 ISO 秒级时间戳，摆在每格脸上太长；这里只留月-日，原文在「口径与说明」里 */
function winLabel(r: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})T[^\s)]*\s*→\s*(\d{4})-(\d{2})-(\d{2})T/.exec(r);
  return m ? `${m[2]}-${m[3]} → ${m[5]}-${m[6]}` : r;
}
const prevRaw = computed(() => (props.prev?.state === "error" ? props.prev.message : ""));

/** 涨跌到底算好还是坏，由指标语义决定，不能一律「绿涨红跌」：威胁请求涨是坏事 */
function arrowTone(up: boolean): "up" | "down" {
  const good = props.betterUp === false ? !up : up;
  return good ? "up" : "down";
}
function signed(v: number, digits: number): string {
  const s = Math.abs(v).toFixed(digits);
  return (v > 0 ? "+" : v < 0 ? "−" : "") + s;
}
function human(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(2) + " 亿";
  if (a >= 1e4) return (v / 1e4).toFixed(2) + " 万";
  if (a >= 100) return String(Math.round(v));
  return String(Math.round(v * 100) / 100);
}
</script>

<template>
  <div class="mt">
    <button v-if="hideable" class="x" title="隐藏这一格（会记住）" @click="emit('hide')">×</button>
    <Tile :label="label" :value="value" :note="note" />
    <div class="unit" v-if="unit">单位：{{ unit }}</div>
    <div class="delta" :class="band.tone" :title="prevRaw || undefined">
      <span>{{ band.text }}</span>
    </div>
    <button v-if="caliber" class="cal" :aria-expanded="calOpen" @click="calOpen = !calOpen">{{ calOpen ? "收起口径" : "口径" }}</button>
    <div class="cal-x" v-if="caliber && calOpen">{{ caliber }}</div>
  </div>
</template>

<style scoped>
.mt { position: relative; }
.mt :deep(.card) { margin-bottom: 0; }
.mt :deep(.card > h3) { padding-right: 24px; }
.unit { color: var(--muted); font-size: 11px; margin-top: 6px; font-family: var(--font-num); opacity: .8; }
.delta { display: flex; gap: 6px; align-items: baseline; margin-top: 5px; font-size: 12px;
  font-family: var(--font-num); font-variant-numeric: tabular-nums; line-height: 1.35; word-break: break-word; }
.delta.up { color: var(--ok); }
.delta.down { color: var(--bad); }
.delta.flat { color: var(--muted); }
.delta.muted { color: var(--muted); opacity: .85; }
.delta.warn { color: var(--warn); }
/* 「口径」是这一格唯一允许点开看解释的地方：默认不占面，点开才多一行 */
.cal { background: none; border: 0; padding: 0; margin-top: 4px; font: inherit; font-size: 11px;
  color: var(--muted); opacity: .8; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.cal:hover, .cal:focus-visible { color: var(--accent); }
.cal-x { margin-top: 4px; font-size: 11.5px; line-height: 1.5; color: var(--muted);
  border-left: 2px solid var(--line); padding-left: 8px; }
.x {
  position: absolute; top: 8px; right: 8px; z-index: 2;
  width: 22px; height: 22px; line-height: 18px; padding: 0;
  background: var(--panel-2); color: var(--muted); border: 1px solid var(--line);
  border-radius: 6px; font-size: 15px;
}
.x:hover { color: var(--fg); border-color: var(--line); background: var(--panel-3); }
</style>
