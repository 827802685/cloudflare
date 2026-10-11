<script setup lang="ts">
/**
 * 每日额度（计算页顶部那块）。覆盖 Workers + KV + D1 这一账号免费档的**按日重置**额度。
 *
 * 每条额度的**用量来源不一样，必须分开标**（docs/09 §E16：没取到 ≠ 0，文档值 ≠ 接口值）：
 *  - Workers 请求数：**接口值**，网关在同一条 `/v1/workers/usage` 里并了 GraphQL 账号级
 *    `workersInvocationsAdaptive.sum.requests`（2026-10-11 实测，与 CF 控制台 Workers 分析页同源）。
 *  - Workers 可观测性事件：**接口值**，`observability/usage` 的 events。
 *  - KV 读 / KV 写删列 / D1 行读 / D1 行写：**用量取不到** —— 本机实测这些产品的每日用量
 *    没有任何接口暴露（GraphQL 无对应数据集、AE 系统数据集被 API 拒、D1 列表不返回 size），
 *    所以这里只列文档上限、用量写"接口不提供"，绝不编一个数或显示 0。
 *  - 所有上限（10 万 / 20 万 / …）：Cloudflare 免费套餐的**公开文档值**，接口不返回配额。
 */
import { computed, onMounted, ref, watch } from "vue";
import AsyncBlock from "../board/AsyncBlock.vue";
import BarList from "../BarList.vue";
import { api, GwError, type WorkersUsage } from "../../lib/api";
import { bytes, dt, num } from "../../lib/fmt";

/** 上限来源：developers.cloudflare.com/workers/platform/pricing（免费档，UTC 午夜重置）。接口不返回这些数。 */
const FREE = {
  requests: 100_000,
  events: 200_000,
  kvRead: 100_000,
  kvWrite: 1_000,
  d1Read: 5_000_000,
  d1Write: 100_000,
};
/** ok=接口给了用量；failed=这次该取但没取到；na=接口根本不提供这条用量 */
type QuotaKind = "ok" | "failed" | "na";
interface QuotaRow { key: string; name: string; usage: number | null; limit: number; kind: QuotaKind; extra?: string }

const props = defineProps<{ /** 父屏「刷新」自增，用来带动这块重新取数 */ tick?: number }>();

const usage = ref<WorkersUsage | null>(null);
const err = ref<GwError | null>(null);
const loading = ref(false);
/** 订阅里的套餐标识：只读 ratePlanId，读失败和"没有"要分开 */
const plans = ref<string[] | null>(null);

async function load() {
  loading.value = true;
  err.value = null;
  try {
    const r = await api.workersUsage();
    usage.value = r.result ?? null;
  } catch (e) {
    err.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
    usage.value = null;
  } finally {
    loading.value = false;
  }
}

/** 订阅那条是附属信息，坏了不该把整块拖成错误态 */
async function loadPlans() {
  try {
    const r = await api.subscriptions();
    const ids = (Array.isArray(r.result) ? r.result : []).map((s) => String(s?.plan ?? "")).filter(Boolean);
    plans.value = [...new Set(ids)];
  } catch {
    plans.value = null;
  }
}

onMounted(() => { load(); loadPlans(); });
watch(() => props.tick, () => { load(); loadPlans(); });

const events = computed(() => (typeof usage.value?.events === "number" ? usage.value.events : null));
const reqErrors = computed(() => (typeof usage.value?.reqErrors === "number" ? usage.value.reqErrors : null));

/** 六条每日额度：能测的用量的排前面（按消耗率降序），测不出的排最后 */
const quotaRows = computed<QuotaRow[]>(() => {
  const u = usage.value;
  const reqNum = typeof u?.requests === "number" ? u.requests : null;
  const rows: QuotaRow[] = [
    { key: "requests", name: "Workers 请求数", usage: reqNum, limit: FREE.requests, kind: reqNum !== null ? "ok" : "failed", extra: u?.requestsErr || "" },
    { key: "events", name: "Workers 可观测性事件", usage: events.value, limit: FREE.events, kind: events.value !== null ? "ok" : "failed" },
    { key: "kvRead", name: "KV 读取", usage: null, limit: FREE.kvRead, kind: "na" },
    { key: "kvWrite", name: "KV 写入 / 删除 / 列举", usage: null, limit: FREE.kvWrite, kind: "na" },
    { key: "d1Read", name: "D1 行读取", usage: null, limit: FREE.d1Read, kind: "na" },
    { key: "d1Write", name: "D1 行写入", usage: null, limit: FREE.d1Write, kind: "na" },
  ];
  const score = (r: QuotaRow) => (r.usage === null ? -1 : r.usage / r.limit);
  return rows.sort((a, b) => score(b) - score(a));
});
/** 默认只显消耗最高的那条，展开才给全量（本机偏好） */
const VISIBLE_QUOTA = 1;
const showAllQuota = ref(false);
const shownQuotas = computed(() => (showAllQuota.value ? quotaRows.value : quotaRows.value.slice(0, VISIBLE_QUOTA)));
const restBytes = computed(() => (usage.value?.breakdown ?? []).reduce((s, r) => s + (r.eventSize ?? 0), 0));

/** 按 Worker 的事件分布：同样默认只显最多那条 */
const rows = computed(() =>
  [...(usage.value?.breakdown ?? [])]
    .filter((r) => r?.service)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
);
const VISIBLE_TOP = 1;
const showAll = ref(false);
const shownRows = computed(() => (showAll.value ? rows.value : rows.value.slice(0, VISIBLE_TOP)));
const barItems = computed(() => shownRows.value.map((r) => ({ label: r.service, value: r.count })));
const barMax = computed(() => Math.max(1, ...rows.value.map((r) => r.count ?? 0)));

const pct = (v: number, limit: number) => Math.min(100, Math.max(0, (v / limit) * 100));
const calOpen = ref(false);
const windowLabel = computed(() => {
  const u = usage.value;
  if (!u?.from || !u?.to) return "";
  return `${dt(u.from)} → ${dt(u.to)}`;
});
</script>

<template>
  <div class="card">
    <div class="hd">
      <h3>每日额度</h3>
      <button type="button" class="cal" :aria-expanded="calOpen" @click="calOpen = !calOpen">{{ calOpen ? "收起" : "口径" }}</button>
    </div>
    <div class="small muted line">
      订阅
      <template v-if="plans === null">没取到</template>
      <template v-else-if="!plans.length">没给套餐标识</template>
      <template v-else>{{ plans.join(" / ") }}</template>
      · 上限是文档值
    </div>
    <div v-if="windowLabel" class="small muted line">窗口 {{ windowLabel }}</div>

    <div class="cal-x" v-if="calOpen">
      <p>这块列的是本账号免费档<b>按日（UTC 午夜）重置</b>的额度，覆盖 Workers + KV + D1。所有上限（10 万 / 20 万 / 500 万 …）都是 Cloudflare <b>公开文档值</b>，没有任何接口返回配额；能读到订阅时把套餐标在上面。</p>
      <p><b>Workers 请求数</b>来自网关在同一条 <code>/v1/workers/usage</code> 里并的 GraphQL 账号级数据集 <code>workersInvocationsAdaptive.sum.requests</code>（2026-10-11 实测，与 CF 控制台 Workers 分析页同源）。它是 Workers 口径，跟看板那个<b>站点（zone）HTTP 请求数</b>不是一回事，两块不能互相当分子。这条 best-effort：万一这次没取到，会退回"没取到"而不是 0。</p>
      <p><b>Workers 可观测性事件</b>来自 <code>observability/usage</code>，是<b>事件数</b>不是请求数；下面那条按 Worker 的分布同理。</p>
      <p><b>KV 读 / KV 写删列 / D1 行读 / D1 行写</b>：本机实测这些产品的<b>每日用量没有任何接口暴露</b>（GraphQL 账号级无对应数据集、Analytics Engine 系统数据集被 API 拒、D1 列表不返回 size），所以只列文档上限、用量标"—（接口不提供）"，绝不编数或显示 0。</p>
      <p>额度按 UTC 午夜重置，界面上的窗口时间是本地时间。</p>
    </div>

    <AsyncBlock :loading="loading && !usage" :err="err" :has="events !== null" empty-text="这个窗口里没有事件（不是没取到）" can-retry @retry="load">
      <!-- 每日额度：默认只显消耗最高的那条，展开看全部（Workers 请求/事件能测，KV/D1 只列文档上限） -->
      <div v-for="q in shownQuotas" :key="q.key" class="quota" :class="{ na: q.kind !== 'ok' }">
        <div class="qhead">
          <span class="qname">{{ q.name }}</span>
          <span v-if="q.kind === 'ok'" class="qnum">{{ num(q.usage) }}<span class="qlim"> / {{ num(q.limit) }}</span></span>
          <span v-else class="qnum miss">{{ q.kind === "na" ? "—" : "没取到" }}<span class="qlim">（上限 {{ num(q.limit) }}/日）</span></span>
        </div>
        <div class="track"><span v-if="q.kind === 'ok'" class="fill" :style="{ width: pct(q.usage ?? 0, q.limit) + '%' }" /><span v-else class="fill none" /></div>
        <div v-if="q.kind === 'ok'" class="small muted line">
          接口值 · {{ pct(q.usage ?? 0, q.limit).toFixed(2) }}%<span v-if="q.key === 'requests' && reqErrors !== null"> · 错误 {{ num(reqErrors) }}</span><span v-if="q.key === 'events'"> · {{ bytes(restBytes) }}</span>
        </div>
        <div v-else-if="q.kind === 'na'" class="small muted line">用量接口不提供 · 上限是文档值</div>
        <div v-else class="small muted line"><b>不是 0</b>：这条这次没取到{{ q.extra ? "（" + q.extra + "）" : "" }}</div>
      </div>
      <button v-if="quotaRows.length > VISIBLE_QUOTA" type="button" class="fold" @click="showAllQuota = !showAllQuota">
        {{ showAllQuota ? "收起（只看最多那条）" : `展开全部额度（还有 ${quotaRows.length - VISIBLE_QUOTA} 条）` }}
      </button>

      <!-- ③ 按 Worker 的事件分布：长列表默认只显 5 条 -->
      <div v-if="rows.length" class="small muted line">按 Worker（事件数）</div>
      <BarList v-if="rows.length" :items="barItems" :format="num" :max="barMax" />
      <button v-if="rows.length > VISIBLE_TOP" type="button" class="fold" @click="showAll = !showAll">
        {{ showAll ? "收起（只看最多那条）" : `展开全部（还有 ${rows.length - VISIBLE_TOP} 条）` }}
      </button>
    </AsyncBlock>
  </div>
</template>

<style scoped>
.hd { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.hd > h3 { margin-bottom: 0; }
.cal { background: none; border: 1px solid var(--line); border-radius: 7px; color: var(--muted); font-size: 11px; padding: 2px 8px; cursor: pointer; flex: none;
  box-shadow: inset 3px 3px 5px var(--neu-dark), inset -3px -3px 5px var(--panel), 0 0 0 1px var(--line); transition: color .3s ease, box-shadow .3s ease, border-color .3s ease; }
.cal:hover { color: var(--accent); box-shadow: inset 2px 2px 4px var(--neu-dark), inset -2px -2px 4px var(--panel), 0 0 0 1px var(--accent); }
.cal:hover { color: var(--accent); border-color: var(--accent); }
.cal-x { margin-top: 8px; border-left: 3px solid var(--line); background: var(--panel-2); border-radius: 0 8px 8px 0; padding: 8px 10px; font-size: 12px; line-height: 1.6; color: var(--fg-2); }
.cal-x p { margin: 0 0 6px; }
.cal-x p:last-child { margin-bottom: 0; }
.line { margin-top: 4px; }
.quota { margin-top: 12px; }
.quota.na { opacity: .9; }
.qhead { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.qname { font-size: 14px; font-weight: 600; }
.qnum { font-family: var(--font-num); font-variant-numeric: tabular-nums; font-size: 16px; }
.qnum.miss { color: var(--muted); font-size: 13px; }
.qlim { color: var(--muted); font-size: 12px; margin-left: 4px; }
.track { height: 8px; background: var(--panel-2); border-radius: 4px; overflow: hidden; box-shadow: 0 0 0 1px var(--line-soft) inset; margin: 6px 0 4px; }
.fill { display: block; height: 100%; background: linear-gradient(90deg, var(--accent-dim), var(--accent)); border-radius: 4px; }
.fill.none { width: 0; }
.fold { align-self: flex-start; margin-top: 6px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; color: var(--muted); font-size: 12px; padding: 5px 10px; cursor: pointer;
  box-shadow: inset 3px 3px 5px var(--neu-dark), inset -3px -3px 5px var(--panel), 0 0 0 1px var(--line); transition: color .3s ease, box-shadow .3s ease, border-color .3s ease; }
.fold:hover { color: var(--accent); box-shadow: inset 2px 2px 4px var(--neu-dark), inset -2px -2px 4px var(--panel), 0 0 0 1px var(--accent); }
code { font-family: ui-monospace, Consolas, monospace; }
</style>
