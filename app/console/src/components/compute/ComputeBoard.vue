<script setup lang="ts">
/**
 * Workers + Pages 二合一看看板（2026-10-27）。
 *
 * 计算页的「全部」原来是两张完整列表上下拼起来：数量、时间、状态各写两遍，
 * 一屏根本看不完。这里改成一块真正的看板 —— 4 格合计 + 一份按「最近改动」
 * 并起来的清单，点行进对应详情。
 *
 * 口径约束（与全站一致）：
 *  · **只用父屏已经取到的两条列表**（/v1/workers、/v1/pages），本组件不发任何请求，
 *    也不做"每个 Pages 项目再去查一次域名"那种 N+1；
 *  · 没取到 ≠ 0：对应那几格写「—」+ 原因，不拿 0 顶上；
 *  · 「最近改动」两种资源不同源：Worker 用 modified_on，Pages 用最新部署的
 *    modified_on / created_on（列表里没有部署时退回项目 created_on）。
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import type { GwError } from "../../lib/api";
import { pageDeployed, pageLastActivity, workerName } from "../../lib/api";
import { num, rel } from "../../lib/fmt";

const props = defineProps<{
  workers: any[];
  pages: any[];
  wErr: GwError | null;
  pErr: GwError | null;
  loading?: boolean;
}>();

const nav = useRouter();

type Kind = "worker" | "pages";
interface BoardRow {
  key: string;
  kind: Kind;
  name: string;
  /** 原始时间戳（ISO）；空 = 接口没给 */
  last: string;
  /** 这个时间是什么：Worker 的修改 / Pages 的部署或创建（没有部署记录时只能是创建） */
  lastWord: string;
  /** 排序用；0 = 时间未知，永远沉底 */
  lastMs: number;
  /** Worker 恒为 null（能列出来就是在跑）；Pages 才有"已部署/还没部署过" */
  deployed: boolean | null;
  /** 灰字里的补充碎片（静态资源 / 分支 / 子域 …） */
  bits: string[];
  acts: Array<{ label: string; c: string }>;
}

function ms(v: unknown): number {
  const s = String(v ?? "");
  if (!s) return 0;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
}

const rows = computed<BoardRow[]>(() => {
  const out: BoardRow[] = [];
  for (const w of props.workers) {
    const name = workerName(w);
    if (!name) continue;
    const last = String(w?.modified_on ?? w?.created_on ?? "");
    const bits: string[] = [];
    if (w?.has_assets) bits.push("静态资源");
    if (w?.placement?.mode === "smart") bits.push("智能放置");
    if (w?.tail_consumers?.length) bits.push("实时日志消费者");
    out.push({
      key: "w:" + name,
      kind: "worker",
      name,
      last,
      lastWord: "修改",
      lastMs: ms(last),
      deployed: null,
      bits,
      acts: [
        { label: "部署", c: "deployments" },
        { label: "域名", c: "domains" },
        { label: "配置", c: "settings" },
      ],
    });
  }
  for (const p of props.pages) {
    const name = String(p?.name ?? "").trim();
    if (!name) continue;
    const deployed = pageDeployed(p);
    // 没有部署记录时只能拿项目创建时间，措辞也要跟着改成「创建」，别把创建说成部署
    const last = deployed ? pageLastActivity(p) : String(p?.created_on ?? "");
    const bits: string[] = [];
    const branch = String(p?.production_branch ?? "").trim();
    if (branch) bits.push("分支 " + branch);
    const sub = String(p?.subdomain ?? "").trim();
    if (sub) bits.push(sub);
    out.push({
      key: "p:" + name,
      kind: "pages",
      name,
      last,
      lastWord: deployed ? "部署" : "创建",
      lastMs: ms(last),
      deployed,
      bits,
      acts: [
        { label: "部署", c: "deps" },
        { label: "域名", c: "domains" },
        { label: "变量", c: "env" },
      ],
    });
  }
  return out;
});

/* ---------- 4 格合计：全部由那两条列表派生 ---------- */
const blank = computed(() => !!props.loading && rows.value.length === 0);
const wCount = computed(() => (props.wErr ? null : props.workers.length));
const pCount = computed(() => (props.pErr ? null : props.pages.length));
const assets = computed(() => props.workers.filter((w) => !!w?.has_assets).length);
const deployedN = computed(() => props.pages.filter(pageDeployed).length);
/** 最近一次改动：两类资源放一起比 */
const latestRow = computed<BoardRow | null>(() =>
  rows.value.reduce<BoardRow | null>((a, b) => (b.lastMs > (a?.lastMs ?? -1) ? b : a), null),
);
const WEEK = 7 * 24 * 60 * 60 * 1000;
const recent7 = computed(() => rows.value.filter((r) => r.lastMs > 0 && Date.now() - r.lastMs <= WEEK).length);

/* ---------- 搜索 + 排序（与计算页列表同一套语汇，不另造控件） ---------- */
const q = ref("");
const sort = ref<"recent" | "name">("recent");
const shownRows = computed(() => {
  const s = q.value.trim().toLowerCase();
  const arr = s
    ? rows.value.filter((r) => r.name.toLowerCase().includes(s) || r.bits.join(" ").toLowerCase().includes(s))
    : rows.value;
  return [...arr].sort(
    sort.value === "name"
      ? (a, b) => a.name.localeCompare(b.name)
      : (a, b) => b.lastMs - a.lastMs,
  );
});

function open(r: BoardRow, c?: string) {
  const base = r.kind === "worker" ? "/workers/" : "/pages/";
  nav.push(base + encodeURIComponent(r.name) + (c ? "?c=" + c : ""));
}
</script>

<template>
  <div class="card board">
    <div class="bh">
      <h3>Workers + Pages 看板</h3>
      <span class="small muted">共 {{ rows.length }} 项 • 按最近改动并成一份</span>
    </div>

    <div v-if="blank" class="empty">加载中…</div>

    <template v-else>
      <!-- 4 格合计。每格都标了它自己的取数状态：没取到写「—」，不写 0 -->
      <div class="bstats">
        <div class="bstat">
          <span class="bl">Worker</span>
          <b class="bn">{{ wCount === null ? "—" : num(wCount) }}</b>
          <span class="bs">{{ wErr ? "没取到（看下方错误）" : `${assets} 个带静态资源` }}</span>
        </div>
        <div class="bstat">
          <span class="bl">Pages 项目</span>
          <b class="bn">{{ pCount === null ? "—" : num(pCount) }}</b>
          <span class="bs">{{ pErr ? "没取到（看下方错误）" : `${deployedN} 个已部署` }}</span>
        </div>
        <div class="bstat">
          <span class="bl">最近一次改动</span>
          <b class="bn small-num">{{ latestRow ? rel(latestRow.last) : "—" }}</b>
          <span class="bs">{{ latestRow ? latestRow.name : "两类资源都没有时间字段" }}</span>
        </div>
        <div class="bstat">
          <span class="bl">近 7 天有改动</span>
          <b class="bn">{{ num(recent7) }}</b>
          <span class="bs">合计 {{ rows.length }} 项</span>
        </div>
      </div>

      <div class="btool">
        <input v-model="q" class="field" style="max-width: 200px" placeholder="搜索名称 / 分支 / 子域" />
        <button
          class="chip"
          :title="sort === 'recent' ? '当前按最近改动排序，点一下改成按名称' : '当前按名称排序，点一下改成按最近改动'"
          @click="sort = sort === 'recent' ? 'name' : 'recent'"
        >{{ sort === "recent" ? "按最近改动" : "按名称" }}</button>
      </div>

      <div class="blist">
        <div v-for="r in shownRows" :key="r.key" class="brow" @click="open(r)">
          <span class="bp" :class="r.kind" :title="r.kind === 'worker' ? 'Worker' : 'Pages 项目'">{{ r.kind === "worker" ? "W" : "P" }}</span>
          <div class="bm">
            <div class="bt">{{ r.name }}</div>
            <div class="bmeta">
              <span v-if="r.last" class="last">{{ rel(r.last) }} {{ r.lastWord }}</span>
              <span v-else class="last">{{ r.kind === "worker" ? "没有修改时间字段" : "没有部署 / 创建时间" }}</span>
              <span class="dot">•</span>
              <span v-for="(b, i) in r.bits" :key="i">{{ b }}<span v-if="i < r.bits.length - 1"> · </span></span>
              <span v-if="!r.bits.length" class="muted">—</span>
            </div>
          </div>
          <div class="br">
            <span v-if="r.deployed !== null" class="badge" :class="{ live: r.deployed }">{{ r.deployed ? "已部署" : "无部署" }}</span>
            <span class="bacts">
              <button v-for="a in r.acts" :key="a.c" class="blk" @click.stop="open(r, a.c)">{{ a.label }}</button>
            </span>
            <span class="bchev" aria-hidden="true">›</span>
          </div>
        </div>
      </div>

      <div v-if="!shownRows.length" class="empty">
        <template v-if="q">没有匹配「{{ q }}」的资源</template>
        <template v-else>这个账号还没有 Worker 或 Pages 项目（不是没取到：两条列表都返回了空）</template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.board { margin-bottom: 12px; }
.bh { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }

/* 4 格合计：与详情页的 kv 同一密度，数字用等宽字体对齐 */
.bstats {
  display: grid; gap: 8px; margin: 10px 0 12px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
@media (min-width: 640px) { .bstats { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.bstat {
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
  padding: 9px 11px; border-radius: var(--radius-s);
  background: var(--panel-2); border: 1px solid var(--line-soft);
}
.bl { font-size: var(--t-2xs); color: var(--muted); letter-spacing: .04em; }
.bn { font-family: var(--font-num); font-size: 22px; line-height: 1.15; font-weight: 700; letter-spacing: -.02em; }
.bn.small-num { font-size: 16px; }
.bs {
  font-size: var(--t-2xs); color: var(--muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.btool { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
/* 不用全局 .rows：它带 8px gap，这里要的是连续行 + 分隔线 */
.blist { display: flex; flex-direction: column; }

/* 一行一项：左类型标 + 名称/灰字 + 右侧状态与动作 */
.brow {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 2px; border-top: 1px solid var(--line-soft);
  cursor: pointer; transition: background .14s ease;
}
.brow:first-child { border-top: 0; }
.brow:hover { background: var(--panel-3); }
.bp {
  flex: none; width: 20px; height: 20px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-num); font-size: 11px; font-weight: 700;
  color: var(--muted); background: var(--panel-2); border: 1px solid var(--line);
}
.bp.worker { color: var(--accent); border-color: var(--accent-dim); }
.bm { flex: 1; min-width: 0; }
.bt {
  font-size: var(--t-sm); font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bmeta {
  display: flex; align-items: baseline; gap: 4px; flex-wrap: wrap;
  font-size: var(--t-2xs); color: var(--muted); margin-top: 1px;
}
.bmeta .dot { opacity: .5; }
.bmeta .last { font-family: var(--font-num); }
.br { display: flex; align-items: center; gap: 6px; flex: none; }
.bacts { display: inline-flex; gap: 2px; }
.blk {
  border: 0; background: none; padding: 2px 4px; border-radius: 6px;
  font: inherit; font-size: var(--t-2xs); color: var(--muted);
  text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
}
.blk:hover { color: var(--accent); background: var(--panel-2); }
.bchev { color: var(--muted); font-size: 18px; line-height: 1; }

@media (max-width: 420px) {
  /* 窄屏把动作收进第二行，避免把名称挤成省略号 */
  .br { flex-wrap: wrap; justify-content: flex-end; }
  .bacts { order: 3; width: 100%; justify-content: flex-end; }
}
</style>
