<script setup lang="ts">
/**
 * 看板二级页：深度分析（2026-10-25 从 BoardView 拆出来）。
 *
 * 为什么拆：补充指标与下钻 Top 20 都属于"深挖"，放在首屏会把一屏拉成三屏，
 * 而且它们各自还带一套三态状态机。首屏该只回答"现在怎么样"（主表盘 + 副表盘 + 一张图）；
 * "为什么"和"具体是谁"放到这一页。
 *
 * 这一页的取数原则（2026-10-25 定）：
 *  · 进来就取 —— 用户主动点「深度分析」进来，要看的就是这些，不该再让他点一次确认；
 *  · 点哪个维度查哪个 —— 不用先选再点「开始查询」两下；
 *  · 选中的维度记住 —— 切走再回来还是那一档，不退回默认的「域名」；
 *  · 查过的按维度留一份 —— 切回来立刻出数且不重发（限流约 1200 请求/5 分钟/IP）；
 *    换时间窗才整体作废（旧窗的数字挂在新窗下面就是误导）。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { reloadTick } from "../lib/bus";
import AsyncBlock from "../components/board/AsyncBlock.vue";
import ExtraMetrics from "../components/board/ExtraMetrics.vue";
import BarList from "../components/BarList.vue";
import { api, GwError } from "../lib/api";
import { compact } from "../lib/fmt";
import { enumLabel } from "../lib/drillLabels";
import { boardPrefs, DRILL_DIMS, RANGES, type DrillDim } from "../lib/boardPrefs";

const nav = useRouter();
const range = computed(() => boardPrefs.range);
const rangeLabel = computed(() => "过去 " + (RANGES.find((r) => r.k === range.value)?.label ?? ""));

/** 维度选择落在共享偏好里；用 computed 代理，模板里 dim = d.k 的写法不用改 */
const dim = computed<DrillDim>({
  get: () => boardPrefs.drillDim,
  set: (v) => { boardPrefs.drillDim = v; },
});

/** host/path/bot 走 Analytics SQL；cache/device 只有 GraphQL adaptive 有这两列，网关内部换面 */
const SQL_DIMS: DrillDim[] = ["host", "path", "bot"];

const drill = ref<Array<{ k: string; reqs: number }> | null>(null);
const drillVia = ref("");
const drillErr = ref<GwError | null>(null);
const drillLoading = ref(false);

/** 每个维度查过的结果留一份：切回来直接显示，不重发 */
const cache = new Map<DrillDim, { rows: Array<{ k: string; reqs: number }>; via: string }>();

function restore(d: DrillDim): boolean {
  const hit = cache.get(d);
  if (!hit) return false;
  drill.value = hit.rows;
  drillVia.value = hit.via;
  drillErr.value = null;
  return true;
}

async function loadDrill(force = false) {
  const d = dim.value;
  if (!force && restore(d)) return;
  drillLoading.value = true;
  drillErr.value = null;
  drill.value = null;
  try {
    const r = SQL_DIMS.includes(d)
      ? await api.top(range.value, d as "host" | "path" | "bot")
      : await api.adaptive(range.value, d as "cache" | "device");
    const rows = ((r as { rows?: unknown }).rows ?? []) as Array<{ k: string; reqs: number }>;
    const via = "source" in (r as object) ? String((r as { source?: unknown }).source) : "analytics-sql";
    drill.value = rows;
    drillVia.value = via;
    cache.set(d, { rows, via });
  } catch (e) {
    drillErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    drillLoading.value = false;
  }
}

const drillItems = computed(() =>
  (drill.value ?? []).map((r) => ({ label: enumLabel(dim.value, r.k), value: Number(r.reqs) })),
);

/** 点哪个维度就查哪个（缓存的直接出，没查过的才发请求） */
watch(dim, () => { void loadDrill(); });
/** 顶栏刷新：当前这一档强制重查 */
watch(reloadTick, () => { cache.delete(dim.value); void loadDrill(true); });
/** 换时间窗：所有维度的旧结果作废 */
watch(range, () => { cache.clear(); void loadDrill(true); });

/** 进这一页就等于"我要深挖"：按记住的维度（默认域名）直接查一次 */
onMounted(() => { void loadDrill(); });
</script>

<template>
  <div>
    <div class="row" style="margin-bottom: 10px; gap: 10px; align-items: center">
      <button class="ghost" type="button" @click="nav.push('/board')">← 看板</button>
      <span class="muted small">{{ rangeLabel }} · 补充指标与下钻</span>
    </div>

    <!-- 补充指标：这一页传 auto，进屏就取（首屏那边仍要点） -->
    <ExtraMetrics :range="range" :range-label="rangeLabel" auto />

    <div class="card">
      <h3>下钻 Top 20</h3>
      <div class="row" style="margin-bottom: 8px">
        <!-- 点一下就直接查；选中的维度会记住 -->
        <button
          v-for="d in DRILL_DIMS" :key="d.k" class="chip" :class="{ on: dim === d.k }"
          :disabled="drillLoading && dim !== d.k"
          @click="dim = d.k"
        >{{ d.label }}</button>
        <button class="ghost" :disabled="drillLoading" @click="loadDrill(true)">
          {{ drillLoading ? "查询中…" : "重新查询" }}
        </button>
      </div>

      <!-- 三态各说各的话（docs/09 §E17）：还没查 / 正在查 / 查完确实为空。
           v-if 不能省：mounted 之前那一帧 drill/loading 都还是空，直接让 AsyncBlock 渲染，
           它会先说一句「查询完成了，这一档确实没返回条目」——那是假话。 -->
      <AsyncBlock
        v-if="drillLoading || !!drill || !!drillErr"
        :loading="drillLoading" :err="drillErr" :has="drillItems.length > 0"
        loading-text="查询中…"
        empty-text="查询完成了，这一档确实没返回条目（采样后为空）"
      >
        <BarList :items="drillItems" :format="compact" />
      </AsyncBlock>
      <div v-else class="empty">准备查询…</div>

      <div class="small muted" style="margin-top: 6px">
        {{ SQL_DIMS.includes(dim) ? "这一档来自 Analytics SQL（采样），数字与控制台会有几个百分点出入" : "这一档来自 GraphQL adaptive（采样）；SQL 面没有缓存/设备两列" }}
        <template v-if="dim === 'bot'"> · 「未识别」= CF 没给出 bot 类别（返回空字符串），不等于「确认是人类」</template>
        <template v-if="drillVia"> · 数据来源：{{ drillVia }}</template>
      </div>
    </div>
  </div>
</template>
