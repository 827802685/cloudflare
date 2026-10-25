import { reactive, watch } from "vue";

/**
 * 看板偏好：时间窗 / 当前图表 / 副表盘隐藏项。
 *
 * 为什么抽出来：这三项原来只住在 BoardView 里，2026-10-25 起"副表盘显示哪些"
 * 挪进了设置页 —— 如果两边各写一份 localStorage 逻辑，迟早出现
 * "设置页改了、看板不认"的分叉（这正是本轮要消灭的那类问题）。
 *
 * 结构版本 v2：图表默认改成「来源国家」。用户明确要求国家优先，所以老设备做一次性迁移
 * （只迁一次，迁移后打上 v2；此后用户自己切回时序会照常记住）。
 */
const KEY = "cfconsole.board.prefs.v1";
const V = 2;

export type RangeKey = "24h" | "7d" | "30d";
export type ChartKey = "series" | "daily" | "status" | "countries";
/** 下钻维度（2026-10-25 起跟着偏好一起存：切走再回来不该退回默认的「域名」） */
export type DrillDim = "host" | "path" | "bot" | "cache" | "device";

export const RANGES: Array<{ k: RangeKey; label: string }> = [
  { k: "24h", label: "24 小时" },
  { k: "7d", label: "7 天" },
  { k: "30d", label: "30 天" },
];

/** 顺序即默认优先级：一屏先回答"流量从哪来"，再回答"什么时候来的" */
export const CHARTS: Array<{ k: ChartKey; label: string }> = [
  { k: "countries", label: "来源国家" },
  { k: "series", label: "请求时序" },
  { k: "daily", label: "按天请求" },
  { k: "status", label: "状态码分布" },
];

export const DRILL_DIMS: Array<{ k: DrillDim; label: string }> = [
  { k: "host", label: "域名" },
  { k: "path", label: "路径" },
  { k: "bot", label: "Bot" },
  { k: "cache", label: "缓存状态" },
  { k: "device", label: "设备类型" },
];

interface Prefs {
  v: number;
  range: RangeKey;
  chart: ChartKey;
  hidden: string[];
  drillDim: DrillDim;
}

const fallback = (): Prefs => ({ v: V, range: "7d", chart: "countries", hidden: [], drillDim: "host" });

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback();
    const p = JSON.parse(raw) as Partial<Prefs>;
    const range = RANGES.some((r) => r.k === p.range) ? (p.range as RangeKey) : "7d";
    const stale = Number(p.v ?? 1) < V;
    // 老结构（v1）不认它存的 chart，直接落到新的默认项
    const chart = !stale && CHARTS.some((c) => c.k === p.chart) ? (p.chart as ChartKey) : "countries";
    const hidden = Array.isArray(p.hidden) ? p.hidden.map(String) : [];
    const drillDim = DRILL_DIMS.some((d) => d.k === p.drillDim) ? (p.drillDim as DrillDim) : "host";
    const next: Prefs = { v: V, range, chart, hidden, drillDim };
    // 迁移必须当场落盘：否则每次冷启都会把用户后来切过的 chart 又掰回 countries
    if (stale) { try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 隐私模式 */ } }
    return next;
  } catch {
    return fallback();
  }
}

export const boardPrefs = reactive<Prefs>(read());

// 改哪一项都落盘（reactive 初始化不算变化，所以首屏不会凭空写一次）
watch(
  boardPrefs,
  (v) => {
    try { localStorage.setItem(KEY, JSON.stringify({ ...v, v: V })); } catch { /* 隐私模式：本次会话内仍有效 */ }
  },
  { deep: true, flush: "post" },
);

/** 副表盘某一格的显示/隐藏（看板的 chip 与设置页的开关都走这一条） */
export function toggleSubTile(id: string): void {
  const i = boardPrefs.hidden.indexOf(id);
  if (i >= 0) boardPrefs.hidden.splice(i, 1);
  else boardPrefs.hidden.push(id);
}

/** 设置页要列出的副表盘项（与 BoardView 的 tiles 同 id，但不依赖那一屏的取数状态） */
export const SUB_TILE_LABELS: Array<{ id: string; label: string }> = [
  { id: "bytes", label: "出口带宽" },
  { id: "visits", label: "独立访客" },
  { id: "threats", label: "威胁拦截" },
  { id: "encShare", label: "HTTPS 加密率" },
  { id: "plainHttp", label: "HTTP 明文请求" },
  { id: "errorRate", label: "边缘错误率" },
  { id: "avgBytes", label: "平均响应体积" },
];
