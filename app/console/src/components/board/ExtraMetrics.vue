<script setup lang="ts">
/**
 * 「补充指标」：只有这两格需要**额外网关请求**，所以默认收起、点了才发（docs/12 §3 P2 那条
 * 验收标准原话是「看板首屏只发 1 次网关请求，下钻再按需 1 次」，限流实测约 1200 请求/5 分钟/IP）。
 * 用的都是已经注册、但界面还没用过的路由：GET /v1/traffic/origin、GET /v1/traffic/adaptive?dim=cache。
 *
 * 两条口径必须写明白，不然数字会被读成别的意思：
 *  1. origin 那条 SQL 只 SELECT 了 count 和 avg(originResponseDurationMs)，**没有源站字节数**
 *     → 这一格是「源站响应请求数」，不是「源站流量(字节)」；字节那项要网关改 SQL 才有（见交付说明）。
 *  2. adaptive 是**采样**数据集，且网关固定 limit:8 → 命中率的分母是这 8 桶之和，不是全量。
 */
import { computed, ref, watch } from "vue";
import AsyncBlock from "./AsyncBlock.vue";
import MetricTile, { type PrevState } from "./MetricTile.vue";
import { api, GwError, type SqlResult } from "../../lib/api";
import { compact, num } from "../../lib/fmt";

const props = defineProps<{ range: string; rangeLabel: string }>();

const open = ref(false);
const loading = ref(false);
const loaded = ref(false);
const stale = ref(false);
const errOf = ref<Record<string, GwError | null>>({ origin: null, cache: null });

const originRows = ref<Array<{ code: number; reqs: number; avg_ms?: number }>>([]);
const cacheRows = ref<Array<{ k: string; reqs: number }>>([]);

watch(open, (v) => { if (!v) loaded.value = false; });
watch(
  () => props.range,
  () => {
    if (loaded.value) stale.value = true;
  },
);

function toErr(e: unknown): GwError {
  return e instanceof GwError ? e : new GwError("unknown", 0, null, String((e as Error)?.message || e));
}

/** 两块各算各的（allSettled），一块 403 另一块照样出数 */
async function load() {
  loading.value = true;
  errOf.value = { origin: null, cache: null };
  const [o, c] = await Promise.allSettled([api.origin(props.range), api.adaptive(props.range, "cache")]);
  if (o.status === "fulfilled") originRows.value = (o.value as SqlResult<any>).rows ?? [];
  else errOf.value.origin = toErr(o.reason);
  if (c.status === "fulfilled") cacheRows.value = (c.value as SqlResult<any>).rows ?? [];
  else errOf.value.cache = toErr(c.reason);
  loaded.value = true;
  stale.value = false;
  loading.value = false;
}

const originTotal = computed(() => originRows.value.reduce((s, r) => s + (Number(r.reqs) || 0), 0));
const origin5xx = computed(() => originRows.value.filter((r) => Number(r.code) >= 500).reduce((s, r) => s + (Number(r.reqs) || 0), 0));
const originErr = computed(() => originRows.value.filter((r) => Number(r.code) >= 400).reduce((s, r) => s + (Number(r.reqs) || 0), 0));
const originAvgMs = computed(() => {
  let w = 0;
  let ms = 0;
  for (const r of originRows.value) {
    const n = Number(r.reqs) || 0;
    if (!Number.isFinite(Number(r.avg_ms))) continue;
    w += n;
    ms += n * Number(r.avg_ms);
  }
  return w ? Math.round(ms / w) : null;
});
const cacheTotal = computed(() => cacheRows.value.reduce((s, r) => s + (Number(r.reqs) || 0), 0));
const hit = computed(() => cacheRows.value.filter((r) => /hit/i.test(String(r.k)) && !/miss/i.test(String(r.k))).reduce((s, r) => s + (Number(r.reqs) || 0), 0));
const hitRate = computed(() => (cacheTotal.value ? (hit.value / cacheTotal.value) * 100 : null));
const cacheItems = computed(() => cacheRows.value.map((r) => ({ label: String(r.k ?? "未知"), value: Number(r.reqs) })));

const none: PrevState = { state: "out", why: "上一窗：这几格的环比网关契约里没有（契约只给 请求/流量/访客/威胁 四项）" };
</script>

<template>
  <div class="card">
    <h3>补充指标（要点才取数）</h3>
    <div class="row">
      <button class="ghost" :disabled="loading" @click="open ? (open = false) : ((open = true), load())">
        {{ loading ? "取数中" : open ? "收起" : "取这两格的数" }}
      </button>
      <span class="small muted">展开会多打 2 次网关请求（origin + adaptive/cache），所以不放首屏</span>
    </div>

    <template v-if="open">
      <div class="small muted" v-if="stale" style="margin-top: 8px">
        时间窗已经换成 {{ rangeLabel }}，下面还是上次取的那一窗，要新窗请按「重新取数」。
      </div>
      <div class="row" style="margin-top: 8px" v-if="loaded">
        <button class="ghost" :disabled="loading" @click="load">{{ loading ? "取数中" : "重新取数" }}</button>
      </div>

      <div class="grid ex" v-if="loaded || loading">
        <AsyncBlock :loading="loading" :err="errOf.origin" :has="originTotal > 0" empty-text="源站这块取回来了，但这一窗没有一条 originResponseStatus>0 的记录">
          <MetricTile
            label="源站响应请求数"
            :value="originTotal ? num(originTotal) : '—'"
            unit="次（SQL 采样，非字节流量）"
            caliber="GET /v1/traffic/origin · WHERE originResponseStatus>0 · 这条 SQL 没 SELECT 源站字节数，所以摆不出「源站流量(GB)」"
            :current="originTotal"
            :prev="none"
          />
        </AsyncBlock>
        <AsyncBlock :loading="loading" :err="errOf.origin" :has="originTotal > 0" empty-text="这一窗没有源站错误记录">
          <MetricTile
            label="源站错误率"
            :value="originTotal ? ((originErr / originTotal) * 100).toFixed(1) : '—'"
            unit="%（4xx+5xx / 源站响应数）"
            :note="'其中 5xx ' + compact(origin5xx) + ' 条'"
            :caliber="'派生自 /v1/traffic/origin 那张表 · 分母是这块返回的 Top 12 源站码'"
            :current="originTotal ? (originErr / originTotal) * 100 : null"
            :prev="none"
            :better-up="false"
          />
        </AsyncBlock>
        <AsyncBlock :loading="loading" :err="errOf.origin" :has="originAvgMs !== null" empty-text="没返回 avg_ms">
          <MetricTile
            label="源站平均耗时"
            :value="originAvgMs !== null ? String(originAvgMs) : '—'"
            unit="ms（按请求数加权）"
            caliber="派生自 origin 的 avg(originResponseDurationMs)"
            :current="originAvgMs"
            :prev="none"
            :better-up="false"
          />
        </AsyncBlock>
        <AsyncBlock :loading="loading" :err="errOf.cache" :has="cacheTotal > 0" empty-text="adaptive 这块这一窗没返回 cacheStatus">
          <MetricTile
            label="缓存命中率"
            :value="hitRate !== null ? hitRate.toFixed(1) : '—'"
            unit="%（采样，分母是返回的前 8 桶之和）"
            caliber="GET /v1/traffic/adaptive?dim=cache · GraphQL httpRequestsAdaptiveGroups.cacheStatus，SQL 面没有这一列"
            :current="hitRate"
            :prev="none"
          />
        </AsyncBlock>
      </div>

      <div class="cachebars" v-if="cacheItems.length">
        <div v-for="i in cacheItems" :key="i.label" class="bar">
          <span class="name">{{ i.label }}</span>
          <span class="track"><span class="fill" :style="{ width: Math.max(2, (i.value / (cacheItems[0]?.value || 1)) * 100) + '%' }" /></span>
          <span class="n">{{ compact(i.value) }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ex { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); margin-top: 10px; }
.cachebars { margin-top: 10px; }
</style>
