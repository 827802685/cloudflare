<script setup lang="ts">
/**
 * 看板（流量总览）。这一屏的形状来自 docs/13 §5.1 那 8 行规格，§10 明确「只抄 ①，15 个指标不必全上」。
 * 三条硬约束决定了下面的写法：
 *  · 首屏只发 **1 次网关请求**（docs/12 §3 P2 验收原话），要多一块就得让用户点一下；
 *  · 「没取到」永远不写成 0 / 持平（docs/09 §E16、docs/13 §8.2 那两条反面教训）；
 *  · 状态灯的阈值**没有出处**（竞品只给了灯和文案），所以是自研的，规则原文必须显示在界面上。
 * 只读屏：这里不出现任何写请求。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { reloadTick, requestReload } from "../lib/bus";
import AsyncBlock from "../components/board/AsyncBlock.vue";
import MetricTile, { type PrevState } from "../components/board/MetricTile.vue";
import StatusDialog from "../components/board/StatusDialog.vue";
import WorldMap from "../components/board/WorldMap.vue";
import BarList from "../components/BarList.vue";
import ErrorNote from "../components/ErrorNote.vue";
import LineChart from "../components/LineChart.vue";
import { api, apiAs, forceFreshWindow, gwMeta, GwError, type Overview } from "../lib/api";
import { agg, aggAccounts, aggSkipped, mapLimit } from "../lib/aggregate";
import { labelOf } from "../lib/accounts";
import { boardPrefs, CHARTS, RANGES, toggleSubTile, type ChartKey, type RangeKey } from "../lib/boardPrefs";
import { countryName } from "../lib/country";
import { bytes, compact, dt, hourLabel, num } from "../lib/fmt";
import { foldText, useFold } from "../lib/lists";

/* ---------------- 偏好：住在 lib/boardPrefs.ts（2026-10-25 起设置页也要改它） ----------------
 * 这里用 computed 代理，是为了让本文件里 range.value / chart.value 那一大堆写法一个字都不用改。
 * hidden 用 computed 出一份 Set，模板里 hidden.has(id) 照旧。写盘在模块里做。 */
const range = computed({ get: () => boardPrefs.range, set: (v: RangeKey) => { boardPrefs.range = v; } });
const chart = computed({ get: () => boardPrefs.chart, set: (v: ChartKey) => { boardPrefs.chart = v; } });
const hidden = computed(() => new Set(boardPrefs.hidden));

const rangeLabel = computed(() => "过去 " + (RANGES.find((r) => r.k === range.value)?.label ?? ""));
const axisLabel = computed(() => (range.value === "24h" ? "横轴按小时" : "横轴按天"));

/* ---------------- 数据：首屏就这一条网关请求 ---------------- */
const ov = ref<Overview | null>(null);
const err = ref<GwError | null>(null);
const loading = ref(false);

/* ---------------- 多账号合一（只读）：每个账号各取一条 overview，再按字段做加法 ----------------
 * 网关 /v1/overview 一次只认一个账号，没有账户级聚合口，所以加法只能在客户端做。
 * 失败口径与计算页/域名页一致：按账号独立失败 —— 一个账号令牌过期只在这里说明，
 * 其余账号照常出数；合计只含成功的账号，这一点在顶部状态条里逐条写清，不假装是全量。 */
type AccOv = { acc: string; accName: string; ov: Overview | null; err: GwError | null; pending: boolean };
const aggData = ref<AccOv[]>([]);
const aggLoading = ref(false);
const aggDone = ref(0);
/** 合并时哪些账号的哪一块没取到（数值仍是其余账号的真合计，只是缺了这一份） */
const aggMiss = ref<Array<{ accName: string; label: string }>>([]);
const asGw = (e: unknown): GwError => (e instanceof GwError ? e : new GwError("unknown", 0, null, String((e as Error)?.message || e)));
const aggPending = computed(() => aggData.value.filter((b) => b.pending).map((b) => b.accName));
const aggErrList = computed(() => aggData.value.filter((b) => !!b.err).map((b) => ({ accName: b.accName, err: b.err as GwError })));

/**
 * 把 N 份 overview 相加成一份。
 *  · consoleTotals：按自然日对齐后逐日相加；v（滚动窗采样）也相加；
 *  · series：按时间点对齐后相加（各账号同一时间窗的桶本来就对齐）；
 *  · status / countries：按码 / 按国家相加。
 * 某一块在某个账号上取不到时，不把它当 0 混进合计：记账到 miss，由顶部状态条如实说明。
 */
function mergeOverviews(list: Array<{ accName: string; ov: Overview }>): { ov: Overview & { prev?: PrevBlock }; miss: Array<{ accName: string; label: string }> } | null {
  if (!list.length) return null;
  const miss: Array<{ accName: string; label: string }> = [];
  const dayMap = new Map<string, { dimensions: { date: string }; sum: any }>();
  const seriesMap = new Map<string, { t: string; reqs: number; bytes: number }>();
  const statusMap = new Map<string, number>();
  const countryMap = new Map<string, number>();
  let visits = 0, edgeBytes = 0, hasV = false;
  let days = 0, rowsRead = 0, elapsed = 0;
  const totalsMiss: string[] = [], seriesMiss: string[] = [], statusMiss: string[] = [], countryMiss: string[] = [];

  for (const { accName, ov: one } of list) {
    days = Math.max(days, Number(one.days) || 0);

    const acc = one.consoleTotals?.value?.viewer?.accounts?.[0];
    if (one.consoleTotals?.error || !acc) {
      totalsMiss.push(accName);
      miss.push({ accName, label: "总请求 / 带宽 / 威胁" });
    } else {
      if (!Array.isArray(acc.g)) miss.push({ accName, label: "总请求 / 带宽 / 威胁" });
      else {
        for (const g of acc.g) {
          const d = String(g?.dimensions?.date ?? "");
          if (!d) continue;
          const cur = dayMap.get(d) ?? { dimensions: { date: d }, sum: { requests: 0, bytes: 0, encryptedRequests: 0, threats: 0 } };
          cur.sum.requests += Number(g.sum?.requests || 0);
          cur.sum.bytes += Number(g.sum?.bytes || 0);
          cur.sum.encryptedRequests += Number(g.sum?.encryptedRequests || 0);
          cur.sum.threats += Number(g.sum?.threats || 0);
          dayMap.set(d, cur);
        }
      }
      const v0 = acc.v?.[0]?.sum;
      if (!v0) miss.push({ accName, label: "独立访客 / 滚动窗带宽" });
      else { visits += Number(v0.visits || 0); edgeBytes += Number(v0.edgeResponseBytes || 0); hasV = true; }
    }

    const ser = one.series?.value;
    if (one.series?.error || !ser) {
      seriesMiss.push(accName);
      miss.push({ accName, label: "曲线" });
    } else {
      for (const r of ser.rows ?? []) {
        const t = String(r?.t ?? "");
        if (!t) continue;
        const cur = seriesMap.get(t) ?? { t, reqs: 0, bytes: 0 };
        cur.reqs += Number(r.reqs || 0);
        cur.bytes += Number(r.bytes || 0);
        seriesMap.set(t, cur);
      }
      rowsRead += Number(ser.stats?.rows_read || 0);
      elapsed = Math.max(elapsed, Number(ser.stats?.elapsed_ms || 0));
    }

    const st = one.status?.value;
    if (one.status?.error || !st) {
      statusMiss.push(accName);
      miss.push({ accName, label: "状态码分布" });
    } else for (const r of st.rows ?? []) {
      const code = String(r?.code ?? "");
      if (!code) continue;
      statusMap.set(code, (statusMap.get(code) ?? 0) + Number(r.reqs || 0));
    }

    const co = one.countries?.value?.viewer?.accounts?.[0];
    if (one.countries?.error || !co) {
      countryMiss.push(accName);
      miss.push({ accName, label: "国家分布" });
    } else for (const c of co.a ?? []) {
      const code = String(c?.dimensions?.clientCountryName ?? "");
      if (!code) continue;
      countryMap.set(code, (countryMap.get(code) ?? 0) + (Number(c.count) || 0));
    }
  }

  const allMiss = (names: string[]) => names.length === list.length;
  const merged: Overview & { prev?: PrevBlock } = {
    range: list[0].ov.range,
    days,
    consoleTotals: {
      value: {
        viewer: {
          accounts: [{
            g: [...dayMap.values()].sort((a, b) => a.dimensions.date.localeCompare(b.dimensions.date)),
            v: hasV ? [{ sum: { visits, edgeResponseBytes: edgeBytes } }] : [],
          }],
        },
      } as any,
      ...(allMiss(totalsMiss) ? { error: `所有 ${list.length} 个账号的总请求卡都没取到`, kind: "error" } : {}),
    },
    series: {
      value: {
        rows: [...seriesMap.values()].sort((a, b) => String(a.t).localeCompare(String(b.t))),
        stats: { rows_read: rowsRead, elapsed_ms: elapsed },
      },
      ...(allMiss(seriesMiss) ? { error: `所有 ${list.length} 个账号的曲线都没取到`, kind: "error" } : {}),
    },
    status: {
      value: { rows: [...statusMap.entries()].map(([code, reqs]) => ({ code: Number(code), reqs })) },
      ...(allMiss(statusMiss) ? { error: `所有 ${list.length} 个账号的状态码分布都没取到`, kind: "error" } : {}),
    },
    countries: {
      value: { viewer: { accounts: [{ a: [...countryMap.entries()].map(([code, count]) => ({ count, dimensions: { clientCountryName: code } })) }] } },
      ...(allMiss(countryMiss) ? { error: `所有 ${list.length} 个账号的国家分布都没取到`, kind: "error" } : {}),
    },
  };

  // 环比：只有每个账号都给了 prev 才合并（缺一份就没有全量的上一窗，宁可写"未提供"也不给半个环比）
  const prevs = list.map(({ ov: one }) => (one as Overview & { prev?: PrevBlock }).prev);
  if (prevs.every((p) => p && typeof p === "object")) {
    const ps = prevs as PrevBlock[];
    if (ps.some((p) => p.skipped)) {
      merged.prev = { skipped: ps.map((p) => p.skipped).filter(Boolean)[0], range: ps[0].range };
    } else {
      const out: PrevBlock = { range: ps[0].range };
      for (const k of ["reqs", "bytes", "visits", "threats"] as const) {
        const vals = ps.map((p) => p[k]);
        out[k] = vals.every((v) => typeof v === "number") ? vals.reduce((s, v) => s + Number(v), 0) : null;
      }
      const pe = ps.map((p) => p.error).filter(Boolean)[0];
      if (pe) out.error = pe;
      merged.prev = out;
    }
  }

  return { ov: merged, miss };
}

/** 显示的是**数据在 CF 侧真正被取到的时刻**（网关用 x-gw-fetched-at 回传），不是"我刚点过刷新" */
const updatedAt = computed(() => (gwMeta.fetchedAt ? dt(gwMeta.fetchedAt) : ""));
/**
 * "多少分钟前"要真的会走。用请求时刻算出来的 ageMs 会冻在屏幕上：盯着页面看四分钟，
 * 上面还写着"5 秒前"，这等于撒谎（同一类问题见 docs/09 §E17、界面上四态措辞的口径）。
 */
const now = ref(Date.now());
const clock = setInterval(() => (now.value = Date.now()), 10_000);
onUnmounted(() => clearInterval(clock));
const sourceNote = computed(() => {
  if (agg.on) {
    const total = aggData.value.length;
    const ok = aggData.value.filter((b) => !!b.ov).length;
    return `合并视图：${total} 个账号各取一条 /v1/overview，数值相加${ok < total ? `（${total - ok} 个没取到，见上方说明）` : ""} · 只读`;
  }
  const age = Math.max(0, Math.round((now.value - (gwMeta.fetchedAt || now.value)) / 1000));
  const ageTxt = age < 60 ? `${age} 秒前` : Math.round(age / 60) + " 分钟前";
  if (gwMeta.state === "local") return `本机内存里的数据（${ageTxt}取的）· 没发请求`;
  // 直连模式（APK）：请求不经过网关，直接从这台设备打 CF；cfCalls 是直连层记的真出网次数
  if (gwMeta.state === "direct") return `直连 Cloudflare API，不经过网关（${ageTxt}取的）· 本次出网 ${gwMeta.cfCalls} 次 CF`;
  if (gwMeta.state === "hit") return `网关缓存复用（${ageTxt}取的）· 这次一次 CF 都没打`;
  if (gwMeta.state === "mixed") return `部分复用缓存 · 这次出网 ${gwMeta.cfCalls} 次 CF`;
  if (gwMeta.state === "fresh") return `强制刷新 · 本次出网 ${gwMeta.cfCalls} 次 CF（看板 3 条：1 条 GraphQL + 2 条 SQL）`;
  return `本次出网 ${gwMeta.cfCalls} 次 CF（看板 3 条：1 条 GraphQL + 2 条 SQL）`;
});

async function load() {
  loading.value = true;
  err.value = null;
  try {
    if (agg.on) {
      const accs = aggAccounts();
      aggDone.value = 0;
      aggMiss.value = [];
      aggData.value = accs.map((a) => ({ acc: a.id, accName: labelOf(a), ov: null, err: null, pending: true }));
      if (!accs.length) {
        ov.value = null;
        err.value = new GwError("unknown", 0, null, "合并视图里没有可用的账号");
        return;
      }
      aggLoading.value = true;
      await mapLimit(accs, 2, async (a) => {
        const b = aggData.value.find((x) => x.acc === a.id);
        if (!b) return;
        try { b.ov = await apiAs(a.id).overview(range.value); }
        catch (e) { b.err = asGw(e); }
        b.pending = false;
        aggDone.value++;
      });
      const ok = aggData.value.filter((b): b is AccOv & { ov: Overview } => !!b.ov);
      if (!ok.length) {
        throw aggData.value[0]?.err ?? asGw(new Error("合并视图没有取到任何账号的数据"));
      }
      const m = mergeOverviews(ok.map((b) => ({ accName: b.accName, ov: b.ov })));
      ov.value = m?.ov ?? null;
      aggMiss.value = m?.miss ?? [];
    } else {
      aggData.value = [];
      aggMiss.value = [];
      ov.value = await api.overview(range.value);
    }
  } catch (e) {
    err.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    loading.value = false;
    aggLoading.value = false;
  }
}
/** 首屏正好一次：onMounted 里 load() 一次，watch 不带 immediate；换时间 chip 才再发一次（也仍是 1 条） */
onMounted(load);
watch(range, load);

/** 「刷新」= 明确要新数据：绕过前端 5 分钟内存 + 网关 5 分钟缓存，两层一起破 */
/** 顶栏「刷新当前屏」（lib/bus）：各屏不再自备右上角刷新键 */
watch(reloadTick, () => { void refresh(); });
function refresh() { forceFreshWindow(); load(); }

/** 退出合并视图：回到当前账号的单账号读数（顶栏下拉里也有同一个开关） */
function exitAgg() {
  agg.on = false;
  requestReload();
}

/**
 * 没有数据时，指标卡**不能显示 0**。
 * "请求数 0"读起来像"你这站点今天没人访问"，而真实情况可能是鉴权/网络失败，也可能只是还在路上 ——
 * 这是同一类错第三次差点发生（`09` §E16：接口没返回 ≠ 功能是关的），所以这里直接改成占位符 + 两种文案。
 *
 * 注意两种"没有数据"要分开：`ov` 为 null 既可能是整体失败（dead），也可能是首次加载还没返回（pending）。
 * 之前只在失败时改成"—"，加载中的那一两秒仍然显示 `0`，浏览器实测截图里就抓到了这个不一致
 * （同一个屏上"请求数 0"和"出口流量 —"并存，因为 `bytes(0)` 本来就渲染成"—"）。
 */
const dead = computed(() => !!err.value && !ov.value);
const blank = computed(() => !ov.value);
const blankNote = computed(() => (dead.value ? "没取到，不是 0" : "加载中…"));
const blankWord = computed(() => (dead.value ? "没取到" : "加载中"));

const noteOf = (c?: { error?: string; kind?: string }) => (c?.error ? { kind: c.kind ?? "unknown", message: c.error } : null);

const totalsAcc = computed(() => ov.value?.consoleTotals?.value?.viewer?.accounts?.[0] ?? null);
const days = computed(() => totalsAcc.value?.g ?? []);
const adaptive = computed(() => totalsAcc.value?.v?.[0]?.sum ?? null);
const requests = computed(() => days.value.reduce((s, d) => s + (d.sum.requests || 0), 0));
const bytesConsole = computed(() => days.value.reduce((s, d) => s + (d.sum.bytes || 0), 0));
const threats = computed(() => days.value.reduce((s, d) => s + (d.sum.threats || 0), 0));
const encrypted = computed(() => days.value.reduce((s, d) => s + (d.sum.encryptedRequests || 0), 0));

const dailyItems = computed(() => days.value.map((d) => ({ label: d.dimensions.date.slice(5), value: d.sum.requests })));
const seriesRows = computed(() => ov.value?.series?.value?.rows ?? []);
const seriesPoints = computed(() => seriesRows.value.map((r) => ({ x: hourLabel(r.t), y: Number(r.reqs) })));
/** SQL 曲线合计：跟上面 1dGroups 的请求数天生不同源，24 小时窗尤其明显（1dGroups 只含已完成的自然日） */
const sqlSeriesTotal = computed(() => seriesRows.value.reduce((s, r) => s + Number(r.reqs || 0), 0));
const sqlSeriesBytes = computed(() => seriesRows.value.reduce((s, r) => s + Number(r.bytes || 0), 0));
const caliberNote = computed(() => {
  const a = requests.value, b = sqlSeriesTotal.value;
  if (!b) return "";
  const diff = b - a;
  const pct = a ? Math.round((Math.abs(diff) / a) * 100) : 0;
  const d = ov.value?.days ?? 0;
  if (d <= 1 && diff > 0)
    return `24 小时窗里 1dGroups 只统计到 ${d} 个自然日（${num(a)}），按小时曲线（SQL 采样）合计 ${num(b)}，差 ${num(diff)}。不是掉了数据，是"过去 24 小时"和"今天这一天"本来就不同口径 —— 曲线含今天已过去的钟点，卡片不含今天这个还没走完的日期。出口流量同理：${bytes(bytesConsole.value)}（自然日）对 ${bytes(adaptive.value?.edgeResponseBytes ?? 0)}（滚动窗），实测能差到 80 倍。`;
  if (pct >= 5) return `顶部卡片是 GraphQL 1dGroups（= 控制台口径 ${num(a)}），曲线是 SQL 采样合计 ${num(b)}，差 ${pct}%。同一时刻两套口径本来就对不齐（docs/09 §D1）。`;
  return `两套口径这次差 ${num(diff)}（${pct}%），属正常采样差异。`;
});

/* ---------------- 派生指标：全部出自首屏那一条响应，不额外出网 ---------------- */
const statusRows = computed(() => ov.value?.status?.value?.rows ?? []);
const statusTotal = computed(() => statusRows.value.reduce((s, r) => s + (Number(r.reqs) || 0), 0));
const statusErr = computed(() => statusRows.value.filter((r) => Number(r.code) >= 400).reduce((s, r) => s + (Number(r.reqs) || 0), 0));
const status5xx = computed(() => statusRows.value.filter((r) => Number(r.code) >= 500).reduce((s, r) => s + (Number(r.reqs) || 0), 0));
/** 错误率：分母是状态码那块 Top 12 码之和（SQL 面），跟 1dGroups 的请求数不是一个口径，所以逐格写清 */
const errorRate = computed(() => (statusTotal.value ? (statusErr.value / statusTotal.value) * 100 : null));
const rate5xx = computed(() => (statusTotal.value ? (status5xx.value / statusTotal.value) * 100 : null));
const plainHttp = computed(() => (noTotals.value ? null : Math.max(0, requests.value - encrypted.value)));
const encShare = computed(() => (noTotals.value || requests.value <= 0 ? null : (encrypted.value / requests.value) * 100));
const threatShare = computed(() => (noTotals.value || requests.value <= 0 ? null : (threats.value / requests.value) * 100));
const avgBytes = computed(() => (noSeries.value || sqlSeriesTotal.value <= 0 ? null : sqlSeriesBytes.value / sqlSeriesTotal.value));

const statusItems = computed(() => statusRows.value.map((r) => ({ label: String(r.code), value: Number(r.reqs) })));
const countryRows = computed(() => (ov.value?.countries?.value?.viewer?.accounts?.[0]?.a ?? []).map((c) => ({ code: String(c.dimensions?.clientCountryName ?? ""), value: Number(c.count) || 0 })));
const countryItems = computed(() => countryRows.value.map((r) => ({ label: countryName(r.code), value: r.value })));

/**
 * 每一块各自判"有没有取到"，不能整页一刀切：网关 overview 用 allSettled，
 * 完全可能「1dGroups 回来了但 status 那块 403」。哪一块降级了，对应那几格的数值就必须是
 * 「—」+ 自己的原因，而不是拿 0 顶上（docs/09 §E16）。
 */
const totalsCardErr = computed(() => noteOf(ov.value?.consoleTotals));
const statusCardErr = computed(() => noteOf(ov.value?.status));
const seriesCardErr = computed(() => noteOf(ov.value?.series));
const countriesCardErr = computed(() => noteOf(ov.value?.countries));
const noTotals = computed(() => blank.value || !!totalsCardErr.value);
const noStatus = computed(() => blank.value || !!statusCardErr.value);
const noSeries = computed(() => blank.value || !!seriesCardErr.value);

/* ---------------- 环比：网关 prev 契约的三个"没有"要分开说 ---------------- */
/**
 * 契约（网关侧另一分支正在给 GET /v1/traffic/overview 加，形状已定死）：
 *   prev: { reqs, bytes, visits, threats, range, error? }
 * 全部按**可选**读：现在这版网关还没有这个键，界面不能崩，也不能把"没提供"渲染成 0。
 */
interface PrevBlock {
  reqs?: number | null;
  bytes?: number | null;
  visits?: number | null;
  threats?: number | null;
  range?: string;
  error?: string;
  /** 网关判定上一窗整段在 CF 分析保留期外，一条请求都没发 —— 不是故障，是没这段历史 */
  skipped?: string;
}
const prevObj = computed<PrevBlock | null | undefined>(
  () => (ov.value as (Overview & { prev?: PrevBlock }) | null | undefined)?.prev,
);
/** prev 这个键在不在响应里：整块缺失 = 网关这版还没算环比，跟"算了但取不到"是两件事 */
const prevAbsent = computed(() => !!ov.value && !("prev" in (ov.value as object)));
const prevRange = computed(() => prevObj.value?.range ?? "");
const prevSkipped = computed(() => prevObj.value?.skipped ?? "");
const OUT = (why: string): PrevState => ({ state: "out", why });
const DERIVED_OUT = OUT("上一窗：派生指标无环比");

function prevOf(key: "reqs" | "bytes" | "visits" | "threats"): PrevState {
  if (!ov.value) return loading.value ? { state: "pending" } : { state: "error", message: "概览这一窗没取到，环比没有基数" };
  if (prevAbsent.value || prevObj.value === undefined || prevObj.value === null) return { state: "absent" };
  const p = prevObj.value;
  // 保留期外：这一档的四个数 CF 那边根本不存在，所以是"没有历史"而不是"取数失败"，
  // 走 out（灰字）而不是 error（黄字）—— 黄色只留给真坏了的东西
  if (p.skipped) return OUT("上一窗：" + p.skipped);
  if (!(key in p)) return OUT("上一窗：prev 里没有这个字段（这版网关只给了一部分）");
  const v = p[key];
  if (v === null || v === undefined) return p.error ? { state: "error", message: p.error } : { state: "novalue" };
  return { state: "ok", value: Number(v), range: p.range };
}
/** 只有 prev 真给了 reqs 数值时才参与状态灯 */
const reqsDeltaPct = computed<number | null>(() => {
  const p = prevOf("reqs");
  if (p.state !== "ok" || p.value === null || p.value === undefined) return null;
  const prev = Number(p.value);
  if (!Number.isFinite(prev) || prev <= 0) return null;
  return ((requests.value - prev) / prev) * 100;
});

/* ---------------- 瓦片定义（首屏这一条响应就能算出来的 8 格） ---------------- */
interface TileSpec {
  id: string; label: string; value: string; unit?: string; note?: string; caliber?: string;
  current: number | null; prev: PrevState; betterUp?: boolean;
  err: { kind?: string; message?: string } | null;
}
/**
 * 每格只摆「数 + 单位 + 涨跌 + 这一格自己的取数状态」。
 * 字段路径、派生公式、跟控制台为什么对不齐 —— 这些原来常驻在 note 上，10-11 他要求从读数面撤走
 * （「介绍给我删了要么丢进介绍页」），现在一律收进 caliber，点「口径」才出现。
 * note 这个位置只留给两种话：这一格没取到（blankNote / 卡片 error），或一个真数值的派生比（占比、5xx）。
 */
const tiles = computed<TileSpec[]>(() => [
  {
    id: "requests", label: "总请求", value: noTotals.value ? "—" : num(requests.value),
    unit: "次", current: noTotals.value ? null : requests.value, prev: prevOf("reqs"), err: totalsCardErr.value,
    caliber: "GraphQL 1dGroups.sum.requests（控制台同口径，只含已完成自然日）",
  },
  {
    id: "bytes", label: "出口带宽", value: noTotals.value ? "—" : bytes(bytesConsole.value),
    unit: "字节（1024 进制）", current: noTotals.value ? null : bytesConsole.value, prev: prevOf("bytes"), err: totalsCardErr.value,
    caliber: "1dGroups.sum.bytes（自然日）· adaptive 滚动窗另有 " + bytes(adaptive.value?.edgeResponseBytes ?? 0) + "，两个口径不是一回事",
  },
  {
    id: "visits", label: "独立访客", value: noTotals.value || !adaptive.value ? "—" : compact(adaptive.value.visits),
    unit: "人（采样）", current: adaptive.value ? adaptive.value.visits : null, prev: prevOf("visits"), err: totalsCardErr.value,
    caliber: "adaptive.visits：采样口径，与控制台的「独立访客」不完全等价",
  },
  {
    id: "threats", label: "威胁拦截", value: noTotals.value ? "—" : num(threats.value),
    unit: "次", current: noTotals.value ? null : threats.value, prev: prevOf("threats"), betterUp: false, err: totalsCardErr.value,
    note: noTotals.value ? blankNote.value : "占本窗请求 " + (threatShare.value === null ? "算不出" : threatShare.value.toFixed(2) + "%"),
    caliber: "1dGroups.sum.threats",
  },
  {
    id: "encShare", label: "HTTPS 加密率", value: encShare.value === null ? "—" : encShare.value.toFixed(1),
    unit: "%", current: encShare.value, prev: DERIVED_OUT, err: totalsCardErr.value,
    caliber: "派生：encryptedRequests / requests（1dGroups），界面上算的，不是网关给的字段",
  },
  {
    id: "plainHttp", label: "HTTP 明文请求", value: plainHttp.value === null ? "—" : num(plainHttp.value),
    unit: "次", current: plainHttp.value, prev: DERIVED_OUT, err: totalsCardErr.value,
    caliber: "派生：requests − encryptedRequests（网关没有这条，减法在这里算的）",
  },
  {
    id: "errorRate", label: "边缘错误率", value: errorRate.value === null ? "—" : errorRate.value.toFixed(1),
    unit: "%（4xx+5xx）", current: errorRate.value, prev: DERIVED_OUT, betterUp: false, err: statusCardErr.value,
    note: noStatus.value ? blankNote.value : "其中 5xx " + (rate5xx.value === null ? "算不出" : rate5xx.value.toFixed(1) + "%"),
    caliber: "派生自 /v1/overview 的 status 卡（SQL 边缘状态码，Top 12 码之和做分母）",
  },
  {
    id: "avgBytes", label: "平均响应体积", value: avgBytes.value === null ? "—" : bytes(avgBytes.value),
    unit: "字节 / 请求", current: avgBytes.value, prev: DERIVED_OUT, err: seriesCardErr.value,
    caliber: "派生自 series 卡：sum(edgeResponseBytes) / count()，SQL 采样面",
  },
]);
/* ---------------- 图表里的长列表：遵守设置页那一档「长列表默认显示」（lib/lists.ts） ----------------
 * 用户明确要求「按天请求 / 状态码分布」跟那一档走：30 天窗就是 30 根条，
 * 不折的话光图表卡就比整个看板还长。点「展开更多」只影响这一条列表，不改全局档位。 */
const dailyFold = useFold(() => dailyItems.value);
const statusFold = useFold(() => statusItems.value);

/**
 * 主表盘 / 副表盘（2026-10-25）：原来 8 格等大平铺，信息密度均匀 = 视觉重点为零。
 * 现在「总请求」单独提成主表盘（44px 数字 + 迷你走纸），其余 7 格做副表盘横滑。
 * 主表盘不参与隐藏偏好 —— 它是这屏的主读数，藏了就没有"这是一台读数仪"的意思了。
 */
const mainTile = computed(() => tiles.value.find((t) => t.id === "requests") ?? null);
/** 副表盘可隐藏的 7 格（chip 行只列这些，原来连总请求也能藏） */
const subTiles = computed(() => tiles.value.filter((t) => t.id !== "requests"));
const shownTiles = computed(() => subTiles.value.filter((t) => !hidden.value.has(t.id)));

/** 主表盘的迷你走纸：24h 用按小时曲线，7d/30d 用按天。都出自首屏那一条响应，不额外发请求 */
const sparkPoints = computed(() =>
  range.value === "24h"
    ? seriesPoints.value
    : dailyItems.value.map((d) => ({ x: d.label, y: Number(d.value) || 0 })),
);

/** 主表盘的环比：跟 MetricTile 同一套 prev 契约，只是这里要一句话而不是一整块 */
const mainDelta = computed((): { text: string; tone: string } => {
  const p = prevOf("reqs");
  if (p.state === "absent") return { text: "上一窗：网关未提供环比", tone: "muted" };
  if (p.state === "pending") return { text: "上一窗：取数中…", tone: "muted" };
  if (p.state === "out") return { text: p.why || "上一窗无可比数据", tone: "muted" };
  if (p.state === "error") return { text: "上一窗取数失败", tone: "warn" };
  if (p.state === "novalue") return { text: "上一窗：网关返回空值（不是 0）", tone: "muted" };
  const prev = Number(p.value);
  if (!Number.isFinite(prev) || prev <= 0) return { text: "上一窗为 0，环比不成立", tone: "muted" };
  const d = ((requests.value - prev) / Math.abs(prev)) * 100;
  const up = d > 0;
  return {
    text: (up ? "▲ +" : "▼ −") + Math.abs(d).toFixed(1) + "% · 上一窗 " + compact(prev),
    tone: up ? "up" : "down",
  };
});

/** 副表盘显隐：写进共享偏好（设置页里是同一份开关，两边永远一致） */
function toggleTile(id: string) {
  toggleSubTile(id);
}

/* ---------------- 状态灯：阈值自研，规则原文要能被看到 ---------------- */
const RULES = [
  "严重：边缘错误率 ≥ 10%；或总请求环比跌幅 ≥ 80%（且本窗请求 ≥ 100 条，样本太小不算）",
  "警告：边缘错误率 ≥ 5% 且 < 10%；或总请求环比跌幅 ≥ 50%；或威胁请求占比 ≥ 5%",
  "正常：上面一条都没触发",
  "判不了（灰灯）：错误率和总请求这一窗都没取到 → 结论句只写「数据不足以下结论」，不猜",
  "不参与判定：缓存命中率与源站耗时（它们要额外请求才有，见「补充指标」）；独立访客与带宽只呈现涨跌，不触发档位",
  "涨跌色按指标语义定：请求/带宽/访客涨为绿，威胁、错误率涨为红",
];

const lamp = computed<{ level: "ok" | "warn" | "bad" | "unknown"; text: string; basis: string }>(() => {
  const er = errorRate.value;
  const reqs = noTotals.value ? null : requests.value;
  const dd = reqsDeltaPct.value;
  const ts = threatShare.value;
  const basis = `错误率 ${er === null ? "没取到" : er.toFixed(1) + "%"}｜本窗请求 ${reqs === null ? "没取到" : num(reqs) + " 次"}｜请求环比 ${dd === null ? "没有（prev 未提供或没值）" : dd.toFixed(1) + "%"}｜威胁占比 ${ts === null ? "算不出" : ts.toFixed(2) + "%"}`;

  if (er === null && reqs === null) {
    return { level: "unknown", text: "数据不足以下结论：错误率和总请求这一窗都没取到，具体原因看下面每块自己的说明。", basis };
  }
  const badReasons: string[] = [];
  const warnReasons: string[] = [];
  if (er !== null && er >= 10) badReasons.push(`边缘错误率 ${er.toFixed(1)}%，越过自研的严重线 10%`);
  if (dd !== null && dd <= -80 && (reqs ?? 0) >= 100) badReasons.push(`请求数比上一窗跌 ${Math.abs(dd).toFixed(0)}%，越过严重线 80%`);
  if (er !== null && er >= 5 && er < 10) warnReasons.push(`边缘错误率 ${er.toFixed(1)}%，落在警告线 5%–10%`);
  if (dd !== null && dd <= -50 && dd > -80) warnReasons.push(`请求数比上一窗跌 ${Math.abs(dd).toFixed(0)}%，越过警告线 50%`);
  if (ts !== null && ts >= 5) warnReasons.push(`威胁请求占比 ${ts.toFixed(2)}%，越过警告线 5%`);

  if (badReasons.length) return { level: "bad", text: badReasons.join("；") + "。先看下面的状态码分布。", basis };
  if (warnReasons.length) return { level: "warn", text: warnReasons.join("；") + "。", basis };
  const parts: string[] = [];
  if (reqs !== null) parts.push(`${rangeLabel.value} ${num(reqs)} 请求` + (dd === null ? "（环比没取到，不作涨跌判断）" : `，环比 ${dd >= 0 ? "+" : "−"}${Math.abs(dd).toFixed(1)}%`));
  if (er !== null) parts.push(`错误率 ${er.toFixed(1)}%`);
  if (ts !== null) parts.push(`威胁占比 ${ts.toFixed(2)}%`);
  return { level: "ok", text: parts.join("、") + "，都在自研阈值线内。", basis };
});

/* ---- 状态弹窗（2026-10-25）：bad/warn 自动弹一次，「今天不再提醒」只管当天 ---- */
const ALERT_KEY = "cfconsole.board.alert.v1";
const alertOpen = ref(false);
/** YYYY-MM-DD：sv-SE 的日期格式正好是 ISO，省掉手拼补零 */
const today = () => new Date().toLocaleDateString("sv-SE");
function quietToday(): boolean {
  try { return localStorage.getItem(ALERT_KEY) === today(); } catch { return false; }
}
function closeAlert(quiet: boolean) {
  alertOpen.value = false;
  if (quiet) { try { localStorage.setItem(ALERT_KEY, today()); } catch { /* 隐私模式 */ } }
}
/** 数据落到 bad/warn 的那一刻弹一次；已经在弹就不重复开 */
watch(lamp, (l) => {
  if (alertOpen.value) return;
  if ((l.level === "bad" || l.level === "warn") && !quietToday()) alertOpen.value = true;
});

/* ---- 下钻 Top 20 与补充指标已搬到 /board/deep（二级页，见 views/BoardDeepView.vue）。
   搬走的原因：它们都是"点了才取数"的深挖，留在首屏既占长度又多一套三态状态。 ---- */

/**
 * 从读数脸上撤下来的介绍话，集中收进这一屏的「口径与说明」折叠里
 * （10-11 他要求：「介绍给我删了要么丢进介绍页」）。
 * 逐格的出处（字段路径、派生公式）仍在各格自己的「口径」按钮后面；
 * 这一份只管**跨格**的口径：首屏打几次请求、环比契约覆盖哪几项、哪些"没有"不是坏消息。
 * 默认收起（notesOpen），读数面先给数。
 */
const NOTES = [
  "首屏只发 1 次网关请求（/v1/overview）；下面每一块各用自己的三态，一块坏了不拖整页。",
  "顶部卡片是 GraphQL 1dGroups（控制台同口径，只含已完成的自然日），曲线是 Analytics SQL 采样 —— 同一时刻两套口径本来就对不齐（docs/09 §D1）。",
  "派生指标（HTTPS 加密率、HTTP 明文请求、边缘错误率、平均响应体积）不在环比契约的那四项里，所以那几格写「无环比」—— 那不是持平，也不是取数失败。",
  "同一时间窗网关 5 分钟才出网一次，所以「数据取自 …」那一行的时刻就是这份数的真实年龄；按刷新会强制出网重取。",
];
const notesOpen = ref(false);
</script>

<template>
  <div>
    <!-- 合并视图（只读）：每个账号各取一条 /v1/overview，这里做加法。
         失败按账号独立说明，一个账号没取到不拖整页，合计里缺了谁会逐条写出。 -->
    <div v-if="agg.on" class="aggbar">
      <div class="aggtop">
        <span class="aggt">合并视图 · {{ aggAccounts().length }} 个账号合计 · 只读</span>
        <button class="ghost sm" @click="exitAgg">退出合并</button>
      </div>
      <div class="small muted" v-if="aggLoading">
        正在取数：{{ aggDone }}/{{ aggAccounts().length }} 个账号已就绪{{ aggPending.length ? " · 等待 " + aggPending.join("、") : "" }}
      </div>
      <div class="small muted" v-else>每个账号各取一条概览，数值相加；曲线、状态码、国家分布按同一维度相加。</div>
      <div class="small muted" v-if="aggSkipped().length">网页模式跳过 {{ aggSkipped().length }} 个 OAuth 账号（拿不到令牌）。</div>
      <div v-for="(x, i) in aggErrList" :key="'ae-' + i" class="small agg-err">{{ x.accName }}：{{ x.err.hint }}</div>
      <div v-for="(x, i) in aggMiss" :key="'am-' + i" class="small agg-err">{{ x.accName }} · {{ x.label }}没取到，合计未含这一份。</div>
    </div>

    <!-- 工具栏：时间窗分段控制 + 数据年龄（刷新已收进顶栏，这里不再重复一个键） -->
    <div class="card toolbar">
      <div class="seg" role="tablist" aria-label="时间窗">
        <button v-for="k in RANGES" :key="k.k" class="seg-b" :class="{ on: range === k.k }" role="tab" :aria-selected="range === k.k" @click="range = k.k">
          {{ k.label }}
        </button>
      </div>
      <div class="tl">
        <span v-if="updatedAt" class="age">{{ updatedAt }} · {{ sourceNote }}</span>
      </div>
    </div>

    <ErrorNote :err="err" />

    <!-- 状态条（2026-10-25）：原来是一整张卡，现在压成一行；bad/warn 会自己弹窗。
         点这一行随时能把弹窗叫回来（当天勾过"不再提醒"也一样，手动点永远能看）。 -->
    <button class="statline" :class="'lv-' + lamp.level" @click="alertOpen = true">
      <span class="sd" />
      <span class="st">{{ lamp.text }}</span>
      <span class="sa">详情</span>
    </button>

    <StatusDialog
      v-if="alertOpen" :level="lamp.level" :text="lamp.text" :rules="RULES" :basis="lamp.basis"
      @close="closeAlert"
    />

    <!-- 主表盘：这一屏的主读数。44px 数字 + 迷你走纸，口径小字挂在读数行下面 -->
    <AsyncBlock :loading="loading && !ov" :err="mainTile?.err" :has="!!mainTile && mainTile.value !== '—'" :empty-text="blankNote">
      <div class="dial">
        <div class="dial-h">
          <h3>总请求</h3>
          <span class="dial-at"><template v-if="agg.on">全部账号合计 · </template>{{ rangeLabel }}<template v-if="updatedAt"> · 至 {{ updatedAt }}</template></span>
        </div>
        <div class="dial-v">
          <b class="dial-n">{{ mainTile?.value ?? "—" }}</b>
          <span class="dial-u">{{ mainTile?.unit || "次" }}</span>
        </div>
        <div class="dial-d" :class="mainDelta.tone">{{ mainDelta.text }}</div>
        <div class="spark" v-if="sparkPoints.length > 1">
          <LineChart :points="sparkPoints" :height="34" :format="compact" bare />
        </div>
      </div>
    </AsyncBlock>

    <!-- 副表盘：其余 7 格横滑（手机上拇指扫，桌面上铺网格）。层级比主表盘低一档，靠字号区分，不靠染色 -->
    <div class="dials" v-if="shownTiles.length">
      <AsyncBlock
        v-for="t in shownTiles" :key="t.id"
        :loading="loading && !ov" :err="t.err" :has="t.value !== '—'"
        :empty-text="blankNote"
      >
        <MetricTile
          :label="t.label" :value="t.value" :unit="t.unit" :note="t.note" :caliber="t.caliber"
          :current="t.current" :prev="t.prev" :better-up="t.betterUp" hideable @hide="toggleTile(t.id)"
        />
      </AsyncBlock>
    </div>

    <!-- 显隐开关已挪到设置页（外观与更新 → 副表盘显示）。
         看板上不再摆一排"管理这个屏自己"的按钮 —— 那是配置，不是读数。 -->
    <div class="small muted" v-if="hidden.size" style="margin: 4px 2px 8px">
      副表盘已隐藏 {{ hidden.size }} 格 · 在「设置 → 外观与更新」里加回来
    </div>

    <!-- 介绍类的话从读数面撤到这里（10-11 他要求：「介绍给我删了要么丢进介绍页」）。
         默认收起；环比那一句和「两套口径对不齐」是**状态**不是介绍，所以跟着实时值走，
         而且收起时也在标题上留一句提示，别让人以为这里藏着广告。 -->
    <div class="notes">
      <button class="notes-h" :aria-expanded="notesOpen" @click="notesOpen = !notesOpen">
        <span>口径与说明</span>
        <span class="tw">{{ notesOpen ? "收起" : caliberNote ? "展开 · 卡片与曲线这次对不齐" : prevSkipped ? "展开 · 上一窗在 CF 保留期外" : prevAbsent ? "展开 · 环比：网关未提供" : "展开" }}</span>
      </button>
      <div class="notes-b" v-if="notesOpen">
        <div class="n" v-if="agg.on">
          合并视图发 {{ aggAccounts().length }} 条 /v1/overview（每账号一条），按自然日、时间点、状态码、国家分别相加。
          某个账号没取到时合计只含其余账号，缺谁写在上方状态条里 —— 不把缺的那份当 0 混进来。
        </div>
        <div class="n" v-if="caliberNote">{{ caliberNote }}</div>
        <div class="n">
          <template v-if="prevSkipped">
            环比：<strong>{{ prevSkipped }}</strong>，所以这一档四格都写「无环比」。
            要环比就把上面时间窗切到 24 小时或 7 天（上一窗分别是 2–4 天前和 7–14 天前，都还在保留期内）。
          </template>
          <template v-else-if="prevAbsent">
            环比：这一版网关的 <code>/v1/overview</code> 响应里<strong>没有 prev 这个字段</strong>，所以每格都写「网关未提供」。
            这不是取数失败，更不是「持平」；网关侧补上 prev 之后这里会自动变成真实涨跌。
          </template>
          <template v-else-if="prevObj">
            环比对比的是上一窗：<code>{{ prevRange || "网关没给上一窗描述" }}</code>，取自 <code>prev</code>（请求 / 流量 / 访客 / 威胁 四项）。
          </template>
          <template v-else>环比：概览没取到，等概览回来才有上一窗的值。</template>
        </div>
        <div class="n" v-for="(n, i) in NOTES" :key="i">{{ n }}</div>
      </div>
    </div>

    <!-- §5.1 第 5 行：图 + 图下「过去 %s 数据」提示；选哪张图会记住 -->
    <div class="card">
      <h3>图表</h3>
      <div class="row" style="margin-bottom: 8px">
        <button v-for="c in CHARTS" :key="c.k" class="chip" :class="{ on: chart === c.k }" @click="chart = c.k">{{ c.label }}</button>
      </div>

      <AsyncBlock
        v-if="chart === 'series'"
        :loading="loading && !ov" :err="seriesCardErr"
        :has="!blank && seriesPoints.length > 0"
        empty-text="这条 SQL 曲线这一窗返回 0 行（采样后确实没有点）"
      >
        <LineChart :points="seriesPoints" />
        <div class="small muted under">
          {{ rangeLabel }}数据 · {{ axisLabel }}（横轴格式随时间窗切换）· SQL 采样
          <template v-if="ov?.series?.value?.stats?.rows_read"> · 扫描行数 {{ num(ov.series.value.stats.rows_read) }} · {{ ov.series.value.stats.elapsed_ms }} ms</template>
        </div>
      </AsyncBlock>

      <AsyncBlock
        v-else-if="chart === 'daily'"
        :loading="loading && !ov" :err="totalsCardErr"
        :has="dailyItems.length > 0"
        empty-text="1dGroups 这一窗没返回任何自然日"
      >
        <BarList :items="dailyFold.shown" :format="compact" />
        <button v-if="dailyFold.rest" class="ghost fold-more" @click="dailyFold.open = !dailyFold.open">
          {{ dailyFold.label }}
        </button>
        <div class="small muted under">{{ rangeLabel }}数据 · GraphQL 1dGroups（控制台同口径，按自然日）</div>
      </AsyncBlock>

      <AsyncBlock
        v-else-if="chart === 'status'"
        :loading="loading && !ov" :err="statusCardErr"
        :has="statusItems.length > 0"
        empty-text="状态码这块这一窗没返回条目"
      >
        <BarList :items="statusFold.shown" :format="compact" />
        <button v-if="statusFold.rest" class="ghost fold-more" @click="statusFold.open = !statusFold.open">
          {{ statusFold.label }}
        </button>
        <div class="small muted under">{{ rangeLabel }}数据 · SQL edgeResponseStatus（Top 12 码，所以分母比 1dGroups 小）</div>
      </AsyncBlock>

      <AsyncBlock
        v-else
        :loading="loading && !ov" :err="countriesCardErr"
        :has="countryItems.length > 0"
        empty-text="国家分布这块这一窗没返回条目"
      >
        <WorldMap :rows="countryRows" />
        <BarList :items="countryItems" :format="compact" />
        <div class="small muted under">{{ rangeLabel }}数据 · GraphQL adaptive（采样）· 网关把这块与顶部卡片并成了同一条 query 出网</div>
      </AsyncBlock>
    </div>

    <!-- 二级页入口：补充指标（点了才取数）与下钻 Top 20 都是"深挖"，不该占首屏。
         搬走之后首屏只剩 主表盘 → 副表盘 → 图表，一屏能看完。 -->
    <RouterLink class="deep" to="/board/deep">
      <div class="deep-l">
        <span class="deep-t">深度分析</span>
        <span class="deep-s">补充指标（点了才取数）· 下钻 Top 20</span>
      </div>
      <span class="deep-a" aria-hidden="true">›</span>
    </RouterLink>
  </div>
</template>

<style scoped>
/* 合并视图的状态条：账号数 + 进度 + 逐账号错误，都在首屏顶部说清 */
.aggbar { border: 1px solid var(--accent-dim); border-radius: 12px; padding: 9px 11px;
  margin-bottom: 10px; background: rgb(var(--accent-rgb) / .06); }
.aggtop { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.aggt { font-size: 13px; font-weight: 650; color: var(--accent); }
.agg-err { color: var(--bad); margin-top: 3px; }
button.sm { padding: 4px 10px; font-size: 12px; }
/* 工具栏：时间窗分段控制（一体式分段，选中实底）+ 数据年龄 + 刷新 */
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.seg { display: inline-flex; background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 3px; gap: 2px; }
.seg-b { border: 0; background: none; color: var(--fg-2, inherit); font-size: 13px; padding: 6px 14px; border-radius: 8px; cursor: pointer; transition: background .12s, color .12s; }
.seg-b:hover { color: inherit; }
.seg-b.on { background: var(--accent); color: var(--on-accent, #fff); font-weight: 600; }
.tl { display: flex; align-items: center; gap: 10px; min-width: 0; }
.age { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* ---------- 状态条（替掉原来那张常驻状态卡）：一行，点开才看详情 ---------- */
.statline {
  display: flex; align-items: center; gap: 8px; width: 100%;
  margin: 2px 0 10px; padding: 9px 11px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
  text-align: left; font: inherit; color: var(--fg-2); cursor: pointer;
}
.statline.lv-ok { border-color: rgb(var(--ok-rgb) / .3); }
.statline.lv-warn { border-color: rgb(var(--warn-rgb) / .38); }
.statline.lv-bad { border-color: rgb(var(--bad-rgb) / .42); }
.sd { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted); }
.lv-ok .sd { background: var(--ok); }
.lv-warn .sd { background: var(--warn); }
.lv-bad .sd { background: var(--bad); }
/* 一句话最多两行：完整结论与判定规则在弹窗里 */
.st { flex: 1; min-width: 0; font-size: var(--t-xs); line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sa { flex: none; font-size: var(--t-2xs); color: var(--muted); text-decoration: underline; text-underline-offset: 3px; }

/* ---------- 二级页入口（补充指标 + 下钻） ---------- */
.deep {
  display: flex; align-items: center; gap: 10px; margin-top: 12px;
  padding: 12px 14px; border-radius: 16px;
  background: var(--panel); border: 1px solid var(--line-soft);
  color: var(--fg); text-decoration: none;
  box-shadow: var(--e-soft);
  transition: border-color .16s ease, transform .2s ease;
}
.deep:hover { border-color: var(--accent-dim); transform: translateY(-1px); }
.deep-l { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.deep-t { font-size: var(--t-sm); font-weight: 650; }
.deep-s { font-size: var(--t-2xs); color: var(--muted); }
.deep-a { margin-left: auto; font-size: 20px; color: var(--muted); line-height: 1; }

/* 图表卡里的「展开更多」：跟别处列表按钮同一语汇，不抢主行动 */
.fold-more { margin-top: 8px; }
.picks { margin-top: 4px; }
.tiles { margin-bottom: 4px; }

/* ---------- 主表盘（2026-10-25）：一屏只有一个"主读数"，44px 起 ----------
   和副表盘的区别只在字号与留白，不动颜色：这套界面的颜色已经被四态轨占满了，
   再给主表盘上色会让"橙 = 有真数"这条编码失效。 */
.dial {
  position: relative; background: var(--panel);
  border-radius: 20px; padding: 14px 16px 10px; margin-bottom: 12px;
  box-shadow: var(--e-soft), 0 0 0 1px var(--line-soft);
  overflow: hidden;
}
/* 主表盘不画左沿轨道：它本身就是"有数"，那道 2px 留给分块数据 */
.dial-h { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.dial-h h3 { margin: 0; font-size: var(--t-xs); color: var(--muted); font-weight: 600; letter-spacing: .06em; }
.dial-at { font-size: var(--t-2xs); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dial-v { display: flex; align-items: baseline; gap: 7px; margin-top: 6px; }
/* clamp：320px 窄屏上 "1,234,567" 用 44px 会溢出，按视口收，上限仍是 44 */
.dial-n { font-family: var(--font-num); font-size: clamp(32px, 11vw, 44px); line-height: 1.05;
  font-weight: 700; letter-spacing: -.03em; color: var(--fg); }
.dial-u { font-size: var(--t-sm); color: var(--muted); font-family: var(--font-num); }
.dial-d { margin-top: 3px; font-size: var(--t-xs); font-family: var(--font-num); font-variant-numeric: tabular-nums; }
.dial-d.up { color: var(--ok); }
.dial-d.down { color: var(--bad); }
.dial-d.warn { color: var(--warn); }
.dial-d.muted { color: var(--muted); }
.spark { margin-top: 8px; }
.spark :deep(.chart) { height: 34px !important; }

/* ---------- 副表盘：手机横滑，桌面上铺成网格 ---------- */
.dials {
  display: grid; gap: 10px;
  grid-auto-flow: column; grid-auto-columns: minmax(176px, 64%);
  overflow-x: auto; padding-bottom: 6px; margin-bottom: 6px;
  scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch;
}
.dials > * { scroll-snap-align: start; }
@media (min-width: 700px) {
  .dials {
    grid-auto-flow: row; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
    overflow: visible; scroll-snap-type: none;
  }
}
/* 「口径与说明」：介绍类的话都住在这里，默认收起，所以它不能长得像一块数据 */
.notes { margin: 12px 2px 0; border: 1px solid var(--line-soft); border-radius: var(--radius-s); background: var(--panel-2); }
.notes-h { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; width: 100%;
  padding: 9px 11px; background: none; border: 0; color: var(--fg-2); font-size: 12px; text-align: left; cursor: pointer; }
.notes-h .tw { font-size: 11px; color: var(--muted); text-decoration: underline; text-underline-offset: 3px; flex: none; }
.notes-b { padding: 0 11px 10px; font-size: 11.5px; line-height: 1.6; color: var(--muted); }
.notes-b .n { margin-top: 6px; padding-left: 9px; border-left: 2px solid var(--line); }
.under { margin-top: 6px; }
</style>
