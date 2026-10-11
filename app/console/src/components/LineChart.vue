<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  points: Array<{ x: string; y: number }>;
  height?: number;
  format?: (v: number) => string;
  color?: string;
}>();

const W = 320;
const H = computed(() => props.height ?? 96);
const fmt = computed(() => props.format ?? ((v: number) => String(Math.round(v))));

/** 手算 SVG：不引图表库（PWA 要单文件可离线，而且手机上柱状/折线够用了） */
const geo = computed(() => {
  const pts = props.points.map((p, i) => ({ i, y: Number(p.y) || 0, x: String(p.x) }));
  if (pts.length === 0) return null;
  const ys = pts.map((p) => p.y);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const px = (i: number) => (pts.length === 1 ? W / 2 : (i / (pts.length - 1)) * W);
  const py = (y: number) => H.value - 8 - ((y - min) / span) * (H.value - 20);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");
  const area = `${line} L${px(pts.length - 1).toFixed(1)},${H.value} L0,${H.value} Z`;
  return {
    line,
    area,
    first: pts[0].x,
    last: pts[pts.length - 1].x,
    max: fmt.value(max),
    min: fmt.value(min),
    peakX: px(ys.indexOf(max)).toFixed(1),
  };
});
</script>

<template>
  <div v-if="geo">
    <svg class="chart" :viewBox="`0 0 ${W} ${height ?? 96}`" preserveAspectRatio="none" :style="{ height: (height ?? 96) + 'px' }">
      <path :d="geo.area" :fill="color ?? 'var(--accent)'" opacity=".14" />
      <path :d="geo.line" fill="none" :stroke="color ?? 'var(--accent)'" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    </svg>
    <div class="row" style="justify-content: space-between">
      <span class="muted small">{{ geo.first }}</span>
      <span class="muted small">峰值 {{ geo.max }} · 谷值 {{ geo.min }}</span>
      <span class="muted small">{{ geo.last }}</span>
    </div>
  </div>
  <div v-else class="empty">这个时间窗里没有数据</div>
</template>
