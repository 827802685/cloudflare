<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  /** readonly：useFold 折叠出来的切片是只读的，这里不该要求可写数组（只读地遍历它就够了） */
  items: ReadonlyArray<{ label: string; value: number }>;
  format?: (v: number) => string;
  max?: number;
}>();

/** 手机上不用图表库：条宽按最大值归一，标签写死在左侧，避免缩放后看不清 */
const top = computed(() => props.max ?? Math.max(1, ...props.items.map((i) => Number(i.value) || 0)));
const fmt = computed(() => props.format ?? ((v: number) => String(v)));
</script>

<template>
  <div>
    <div v-for="(i, idx) in items" :key="i.label + '#' + idx" class="bar">
      <span class="name" :title="i.label">{{ i.label }}</span>
      <span class="track"><span class="fill" :style="{ width: Math.max(2, (Number(i.value) / top) * 100) + '%' }" /></span>
      <span class="n">{{ fmt(Number(i.value)) }}</span>
    </div>
    <div v-if="!items.length" class="empty">这个时间窗里没有数据</div>
  </div>
</template>
