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
import AsyncBlock from "../components/board/AsyncBlock.vue";
import ExtraMetrics from "../components/board/ExtraMetrics.vue";
import MetricTile, { type PrevState } from "../components/board/MetricTile.vue";
import StatusLamp from "../components/board/StatusLamp.vue";
import WorldMap from "../components/board/WorldMap.vue";
import BarList from "../components/BarList.vue";
import ErrorNote from "../components/ErrorNote.vue";
import LineChart from "../components/LineChart.vue";
import { api, forceFreshWindow, gwMeta, GwError, type Overview } from "../lib/api";
import { countryName } from "../lib/country";
import { bytes, compact, dt, hourLabel, num } from "../lib/fmt";

type RangeKey = "24h" | "7d" | "30d";
type ChartKey = "series" | "daily" | "status" | "countries";

const RANGES: Array<{ k: RangeKey; label: string }> = [
  { k: "24h", label: "24 小时" },
  { k: "7d", label: "7 天" },
  { k: "30d", label: "30 天" },
];
const CHARTS: Array<{ k: ChartKey; label: string }> = [
  { k: "series", label: "请求时序" },
  { k: "daily", label: "按天请求" },
  { k: "status", label: "状态码分布" },
  { k: "countries", label: "来源国家" },
];

/* ---------------- 偏好持久化（竞品是 dashboard_prefs，这里用 localStorage） ---------------- */
/** 键名跟 api.ts 里那套内存缓存键同一风格；只存「选了哪个窗 / 哪张图 / 藏了哪些瓦片」，不存数据 */
const PREF_KEY = "cfconsole.board.prefs.v1";
interface BoardPrefs { range: RangeKey; chart: ChartKey; hidden: string[] }
function readPrefs(): BoardPrefs {
  const fallback: BoardPrefs = { range: "7d", chart: "series", hidden: [] };
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<BoardPrefs>;
    const range = RANGES.some((r) => r.k === p.range) ? (p.range as RangeKey) : fallback.range;
    const chart = CHARTS.some((c) => c.k === p.chart) ? (p.chart as ChartKey) : fallback.chart;
    const hidden = Array.isArray(p.hidden) ? p.hidden.map(String) : [];
    return { range, chart, hidden };
  } catch {
    return fallback;
  }
}
const prefs = readPrefs();
const range = ref<RangeKey>(prefs.range);
const chart = ref<ChartKey>(prefs.chart);
const hidden = ref<Set<string>>(new Set(prefs.hidden));
/** 只在用户真的改过之后才写盘：首屏初始化那一次不该产生动作 */
let prefsReady = false;
onMounted(() => { prefsReady = true; });
watch([range, chart, hidden], () => {
  if (!prefsReady) return;
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ range: range.value, chart: chart.value, hidden: [...hidden.value] }));
  } catch {
    /* 隐私模式存不下也不影响功能，本次会话内偏好仍然有效 */
  }
}, { flush: "post" });

const rangeLabel = computed(() => "过去 " + (RANGES.find((r) => r.k === range.value)?.label ?? ""));
const axisLabel = computed(() => (range.value === "24h" ? "横轴按小时" : "横轴按天"));

/* ---------------- 数据：首屏就这一条网关请求 ---------------- */
const ov = ref<Overview | null>(null);
const err = ref<GwError | null>(null);
const loading = ref(false);
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
    ov.value = await api.overview(range.value);
  } catch (e) {
    err.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    loading.value = false;
  }
}
/** 首屏正好一次：onMounted 里 load() 一次，watch 不带 immediate；换时间 chip 才再发一次（也仍是 1 条） */
onMounted(load);
watch(range, load);

/** 「刷新」= 明确要新数据：绕过前端 5 分钟内存 + 网关 5 分钟缓存，两层一起破 */
function refresh() { forceFreshWindow(); load(); }

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
const shownTiles = computed(() => tiles.value.filter((t) => !hidden.value.has(t.id)));
function toggleTile(id: string) {
  const next = new Set(hidden.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  hidden.value = next;
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

/* ---- 下钻：默认不发请求，点了才发（限流约 1200 请求/5 分钟/IP） ---- */
/** host/path/bot 走 Analytics SQL；cache/device 只有 GraphQL adaptive 有这两列，网关内部换面 */
type Dim = "host" | "path" | "bot" | "cache" | "device";
const DIMS: Array<{ k: Dim; label: string }> = [
  { k: "host", label: "域名" },
  { k: "path", label: "路径" },
  { k: "bot", label: "Bot" },
  { k: "cache", label: "缓存状态" },
  { k: "device", label: "设备类型" },
];
const SQL_DIMS: Dim[] = ["host", "path", "bot"];
const dim = ref<Dim>("host");
const drill = ref<Array<{ k: string; reqs: number }> | null>(null);
const drillVia = ref("");
const drillErr = ref<GwError | null>(null);
const drillLoading = ref(false);
async function loadDrill() {
  drillLoading.value = true;
  drillErr.value = null;
  try {
    const r = SQL_DIMS.includes(dim.value)
      ? await api.top(range.value, dim.value as "host" | "path" | "bot")
      : await api.adaptive(range.value, dim.value as "cache" | "device");
    drill.value = r.rows as any;
    drillVia.value = "source" in r ? String((r as any).source) : "analytics-sql";
  } catch (e) {
    drillErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    drillLoading.value = false;
  }
}
const drillItems = computed(() => (drill.value ?? []).map((r) => ({ label: String(r.k ?? "(空)"), value: Number(r.reqs) })));

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
    <!-- 工具栏：时间窗分段控制 + 数据年龄 + 刷新，收进一张卡，读数区从它下面开始 -->
    <div class="card toolbar">
      <div class="seg" role="tablist" aria-label="时间窗">
        <button v-for="k in RANGES" :key="k.k" class="seg-b" :class="{ on: range === k.k }" role="tab" :aria-selected="range === k.k" @click="range = k.k">
          {{ k.label }}
        </button>
      </div>
      <div class="tl">
        <span v-if="updatedAt" class="age">{{ updatedAt }} · {{ sourceNote }}</span>
        <button class="ghost sm" :disabled="loading" @click="refresh">{{ loading ? "加载中" : "刷新" }}</button>
      </div>
    </div>

    <ErrorNote :err="err" />

    <!-- 状态总览卡：左边条按灯色着色，一眼分档 -->
    <div class="card hd" :class="'lv-' + lamp.level">
      <h3>仪表盘概览 · {{ rangeLabel }}</h3>
      <StatusLamp :level="lamp.level" :text="lamp.text" :rules="RULES" :basis="lamp.basis" />
    </div>

    <!-- §5.1 第 4 行：指标瓦片网格，每格 数值 + 单位 + 环比涨跌 -->
    <div class="row picks">
      <button
        v-for="t in tiles" :key="t.id" class="chip" :class="{ on: !hidden.has(t.id) }"
        :title="hidden.has(t.id) ? '显示这一格' : '隐藏这一格'" @click="toggleTile(t.id)"
      >{{ t.label }}</button>
    </div>
    <div class="small muted" style="margin: 4px 2px 8px">
      点名字收起/放开某一格（会记住）· 显示 {{ shownTiles.length }} / {{ tiles.length }}
    </div>

    <div class="grid tiles">
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

    <!-- 介绍类的话从读数面撤到这里（10-11 他要求：「介绍给我删了要么丢进介绍页」）。
         默认收起；环比那一句和「两套口径对不齐」是**状态**不是介绍，所以跟着实时值走，
         而且收起时也在标题上留一句提示，别让人以为这里藏着广告。 -->
    <div class="notes">
      <button class="notes-h" :aria-expanded="notesOpen" @click="notesOpen = !notesOpen">
        <span>口径与说明</span>
        <span class="tw">{{ notesOpen ? "收起" : caliberNote ? "展开 · 卡片与曲线这次对不齐" : prevSkipped ? "展开 · 上一窗在 CF 保留期外" : prevAbsent ? "展开 · 环比：网关未提供" : "展开" }}</span>
      </button>
      <div class="notes-b" v-if="notesOpen">
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
        <BarList :items="dailyItems" :format="compact" />
        <div class="small muted under">{{ rangeLabel }}数据 · GraphQL 1dGroups（控制台同口径，按自然日）</div>
      </AsyncBlock>

      <AsyncBlock
        v-else-if="chart === 'status'"
        :loading="loading && !ov" :err="statusCardErr"
        :has="statusItems.length > 0"
        empty-text="状态码这块这一窗没返回条目"
      >
        <BarList :items="statusItems" :format="compact" />
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

    <ExtraMetrics :range="range" :range-label="rangeLabel" />

    <div class="card">
      <h3>下钻 Top 20</h3>
      <div class="row" style="margin-bottom: 8px">
        <button v-for="d in DIMS" :key="d.k" class="chip" :class="{ on: dim === d.k }" @click="dim = d.k; drill = null">
          {{ d.label }}
        </button>
        <button class="ghost" :disabled="drillLoading" @click="loadDrill">{{ drillLoading ? "查询中" : drill ? "重新查询" : "开始查询" }}</button>
      </div>
      <!-- 同样是三态（`09` §E17）：还没查 / 正在查 / 查完确实为空，各说各的话，别共用一句口径说明 -->
      <AsyncBlock
        v-if="!!drill || drillLoading || !!drillErr"
        :loading="drillLoading" :err="drillErr" :has="drillItems.length > 0"
        loading-text="查询中…"
        empty-text="查询完成了，这一档确实没返回条目（采样后为空）"
      >
        <BarList :items="drillItems" :format="compact" />
      </AsyncBlock>
      <div v-else class="empty">
        还没查：{{ SQL_DIMS.includes(dim) ? "这一档来自 Analytics SQL（采样），数字与控制台会有几个百分点出入" : "这一档来自 GraphQL adaptive（采样）；SQL 面没有缓存/设备两列" }}
      </div>
      <div class="small muted" v-if="drillVia" style="margin-top: 6px">数据来源：{{ drillVia }}</div>
    </div>
  </div>
</template>

<style scoped>
/* 工具栏：时间窗分段控制（一体式分段，选中实底）+ 数据年龄 + 刷新 */
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.seg { display: inline-flex; background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 3px; gap: 2px; }
.seg-b { border: 0; background: none; color: var(--fg-2, inherit); font-size: 13px; padding: 6px 14px; border-radius: 8px; cursor: pointer; transition: background .12s, color .12s; }
.seg-b:hover { color: inherit; }
.seg-b.on { background: var(--accent); color: var(--on-accent, #fff); font-weight: 600; }
.tl { display: flex; align-items: center; gap: 10px; min-width: 0; }
.age { font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 状态总览卡：左边条 3px 按灯色着色（ok/warn/bad/unknown），与状态灯互证 */
.hd { border-left-width: 3px; }
.hd.lv-ok { border-left-color: var(--ok, #2f9e5f); }
.hd.lv-warn { border-left-color: #d29922; }
.hd.lv-bad { border-left-color: var(--bad, #d64545); }
.hd.lv-unknown { border-left-color: var(--line); }
.hd h3 { margin-bottom: 6px; }
.picks { margin-top: 4px; }
.tiles { margin-bottom: 4px; }
/* 「口径与说明」：介绍类的话都住在这里，默认收起，所以它不能长得像一块数据 */
.notes { margin: 12px 2px 0; border: 1px solid var(--line-soft); border-radius: var(--radius-s); background: var(--panel-2); }
.notes-h { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; width: 100%;
  padding: 9px 11px; background: none; border: 0; color: var(--fg-2); font-size: 12px; text-align: left; cursor: pointer; }
.notes-h .tw { font-size: 11px; color: var(--muted); text-decoration: underline; text-underline-offset: 3px; flex: none; }
.notes-b { padding: 0 11px 10px; font-size: 11.5px; line-height: 1.6; color: var(--muted); }
.notes-b .n { margin-top: 6px; padding-left: 9px; border-left: 2px solid var(--line); }
.under { margin-top: 6px; }
</style>
