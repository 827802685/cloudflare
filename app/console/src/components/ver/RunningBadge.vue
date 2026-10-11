<script lang="ts">
/**
 * 「运行中版本」的唯一判定 + 徽章（docs/13 §8.1 那条红线只允许有一处实现）。
 *
 * 竞品用 `versions.firstOrNull()?.id` 猜当前版本，我们反过来：
 *   真相 = 「`created_on` 最新的那条 deployment 的 `versions[]` + 每条的 percentage」。
 *   `canonical_version` 字段现有网关路由里**没有一条返回**（实测 /versions、/versions/{v}、
 *   /deployments、/settings 四种响应都没有它；证据 docs/evidence/responses.sample.json），
 *   所以只能标成"未取到"，不许拿列表第一条冒充它。
 *   判不出来（多条部署时间戳并列）时**宁可什么都不标**，也不挑一个当"运行中"。
 *
 * 下面三个纯函数是 SFC 普通 script 块里的具名导出，详情页 / 版本弹窗 / 批量清理三处共用，
 * 免得各写一套又变成"各挑一个当运行中"。
 */
export type RunningModel = {
  /** 按 created_on 判定的最新一条 deployment；并列时是 null */
  deployment: any | null;
  /** version_id → 百分比 */
  pct: Record<string, number>;
  /** 正在承接流量的版本（percentage > 0） */
  ids: string[];
  /** 判定本身的毛病（并列 / 没有部署记录），界面要原样显示 */
  note: string;
  ambiguous: boolean;
};

/** canonical_version 这件事不能藏，界面常驻一行 */
export const CANONICAL_NOTE =
  "「运行中」只认最新一条 deployment 指向的版本与它的流量占比。CF 的 canonical_version 字段现有网关路由没有一条返回（待补路由清单第 6 条），这里不冒充它，也不用「列表第一条」猜（docs/13 §8.1）。";

export function runningModel(deployments: any[] | null | undefined): RunningModel {
  const list = (deployments ?? []).filter((d) => d && Array.isArray(d.versions));
  const sorted = [...list].sort((a, b) => String(b.created_on ?? "").localeCompare(String(a.created_on ?? "")));
  if (!sorted.length) return { deployment: null, pct: {}, ids: [], ambiguous: false, note: "没有部署记录，判不出运行版本，所以这一屏不显示「运行中」徽章。" };
  const top = sorted[0];
  const tie = sorted.slice(1).filter((d) => String(d.created_on ?? "") === String(top.created_on ?? ""));
  if (tie.length) {
    return {
      deployment: null,
      pct: {},
      ids: [],
      ambiguous: true,
      note: `有 ${tie.length + 1} 条部署记录的 created_on 完全相同，判不出哪条最新 —— 这一屏不标「运行中」，请以 Cloudflare 后台为准。`,
    };
  }
  const pct: Record<string, number> = {};
  for (const v of top.versions ?? []) {
    const id = String((v as any)?.version_id ?? "");
    if (id) pct[id] = Number((v as any).percentage ?? 100);
  }
  return { deployment: top, pct, ids: Object.keys(pct).filter((k) => (pct[k] ?? 0) > 0), note: "", ambiguous: false };
}

/** CF 的 `number` 是单调版本号，排序只认它；数组顺序不保证按时间（竞品就是靠顺序猜的） */
export function byNumberDesc(versions: any[] | null | undefined): any[] {
  return [...(versions ?? [])].sort((a, b) => {
    const d = Number(b?.number ?? 0) - Number(a?.number ?? 0);
    return d !== 0 ? d : String(b?.metadata?.created_on ?? "").localeCompare(String(a?.metadata?.created_on ?? ""));
  });
}

export type Candidate = {
  version: any;
  id: string;
  number: number;
  created_on: string;
  pct: number | null;
  /** false = 不给勾，reason 说明为什么 */
  deletable: boolean;
  reason: string;
};

/**
 * 批量清理的候选表（docs/13 §6.3：保留 N 个 + 逐脚本输出结果）。
 * 保留窗口之外**还额外强制保留**任何还在承接流量的版本 —— 竞品那侧靠"运行中不显示删除按钮"，
 * 我们这里把原因写进 reason，界面上要能读出来。
 */
export function cleanupCandidates(versions: any[] | null | undefined, keep: number, run: RunningModel): { candidates: Candidate[]; newest: any | null; kept: number } {
  const sorted = byNumberDesc(versions);
  const k = Math.max(1, Math.floor(Number(keep) || 0) || 1);
  const keptIds = new Set(sorted.slice(0, k).map((v) => String(v?.id ?? "")));
  const candidates: Candidate[] = [];
  for (const v of sorted) {
    const id = String(v?.id ?? "");
    if (!id || keptIds.has(id)) continue;
    const running = run.ids.includes(id);
    const pct = run.pct[id];
    candidates.push({
      version: v,
      id,
      number: Number(v?.number ?? 0),
      created_on: String(v?.metadata?.created_on ?? ""),
      pct: pct === undefined ? null : pct,
      deletable: !running,
      reason: running ? `正在承接流量 ${pct ?? 100}%，不给删` : "在保留窗口之外，且没有流量占比记录",
    });
  }
  return { candidates, newest: sorted[0] ?? null, kept: Math.min(k, sorted.length) };
}

export default { name: "VerRunningBadge" };
</script>

<script setup lang="ts">
import { computed } from "vue";

/** 徽章本体：`on` 与 `pct` 由 runningModel() 的结果算出来再传进来，组件自己不做判定 */
const props = withDefaults(defineProps<{ on?: boolean; pct?: number | null; text?: string }>(), { on: false, pct: null, text: "" });

const isCanary = computed(() => props.pct !== null && props.pct !== undefined && props.pct < 100);
const label = computed(() => {
  if (props.text) return props.text;
  // 红线要求的原话：这一版在跑，但流量配比不是 100%
  return props.pct === null || props.pct === undefined || isCanary.value === false ? "运行中" : `运行中 · 占 ${props.pct}%`;
});
</script>

<template>
  <span v-if="on" class="badge" :class="isCanary ? 'roll' : 'live'">{{ label }}</span>
</template>
