<script lang="ts">
/**
 * 批量清理旧**部署记录**（docs/13 §6.3、§2.5「管理版本」那一行）。
 * 竞品的形状：单选模式 + 「保留 N 个」输入（默认 10）+ 结果按脚本逐行输出。
 *
 * 三处我们故意和竞品不一样：
 *  1. **默认不勾选任何候选**（任务要求，也比"默认全选"更难误删）；
 *  2. 包含承接流量版本的部署记录一律排除并写明原因（docs/13 §8.1）；
 *  3. 每条删除都 `await` 真结果，失败把返回的 kind 留在行上，不做 delay(500) 假成功（§8.2）。
 *
 * 为什么删的是部署记录而不是版本本体（2026-10-19 真机实测定型）：
 *  - DELETE …/deployments/{id}：API Token **可用**，实测 200 —— 这条是清理的正路；
 *  - DELETE …/versions/{id}：CF 对 API Token 一律 405 "Method not allowed for this authentication
 *    scheme"（实测 3 次），只认 Global API Key —— 路由两层都留了透传，用户换 Global Key 也能用，
 *    但本面板默认走部署记录这条路，保证普通 Token 就能真清理。
 */
export default { name: "VerCleanupPanel" };
</script>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import ConfirmSheet from "../ConfirmSheet.vue";
import type { RunningModel } from "./RunningBadge.vue";
import { runningModel } from "./RunningBadge.vue";
import { api, dropMem, GwError, gwWrite, setWritesOptIn, writesOptIn, type WritePreview } from "../../lib/api";
import { dt, shortId } from "../../lib/fmt";

const props = defineProps<{ workers: string[] }>();
const emit = defineEmits<{ (e: "progress", v: { running: boolean; text: string; done: number; total: number }): void; (e: "changed"): void }>();

const PER_PAGE = 50;
const MAX_PAGES = 4; // 200 条封顶：再多的版本不在分析范围内，界面上会写清楚

type WState = {
  worker: string;
  phase: "idle" | "loading" | "ready" | "error";
  errText: string;
  errKind: string;
  versions: any[];
  total: number | null;
  pages: number;
  truncated: boolean;
  run: RunningModel | null;
  candidates: Candidate[];
  checked: Record<string, boolean>;
};

/** 候选 = 部署记录：CF 的 deployments 接口 id 形状（32 hex 或 UUID），删的是部署历史条目、不碰版本本体 */
type Candidate = { id: string; number: number; created_on: string; pct: number | null; deletable: boolean; reason: string };

/** 从部署记录算候选：最新 keepN 条保留；其余里凡是包含承接流量版本的排除（实测：删部署记录 200，版本本体 405） */
function deploymentCandidates(deps: any[], keepN: number, run: RunningModel | null): Candidate[] {
  const list: Candidate[] = [];
  const n = deps.length;
  deps.forEach((d, i) => {
    const vs: any[] = d.versions || [];
    const pct = vs.reduce((sum: number, v: any) => sum + (Number(v?.percentage) || 0), 0);
    const touchesActive = !!run && vs.some((v: any) => (Number(v?.percentage) || 0) > 0 && run.ids.includes(String(v.version_id)));
    list.push({
      id: String(d.id ?? ""),
      number: n - i,
      created_on: String(d.created_on ?? ""),
      pct: pct || null,
      deletable: i >= keepN && !touchesActive,
      reason: i < keepN ? `在保留窗口内（最新 ${keepN} 条）` : touchesActive ? "包含承接流量的版本" : "超出保留窗口的旧部署记录",
    });
  });
  return list;
}

const states = reactive<WState[]>([]);
const keep = ref(10);
const keepErr = ref("");
const analyzing = ref(false);
const armed = ref(false);
const log = ref<{ text: string; ok: boolean }[]>([]);

/** 本机写开关：默认关（api.ts 的写侧契约第 3 条 —— 关着就根本不出网） */
const optIn = ref(writesOptIn());
function toggleOptIn(v: boolean) {
  setWritesOptIn(v);
  optIn.value = writesOptIn();
}

function syncSelection() {
  // 选中集变了就重建面板状态，默认全部未勾选
  const keepPrev = new Map(states.map((s) => [s.worker, s]));
  states.length = 0;
  for (const w of props.workers ?? []) {
    const prev = keepPrev.get(w);
    if (prev) states.push(prev);
    else states.push({ worker: w, phase: "idle", errText: "", errKind: "", versions: [], total: null, pages: 0, truncated: false, run: null, candidates: [], checked: {} });
  }
  armed.value = false;
}

const keepValue = computed(() => {
  const n = Math.floor(Number(keep.value));
  if (!Number.isFinite(n) || n < 1) { keepErr.value = "保留数量必须是 ≥ 1 的整数（不会静默当成 1）"; return null; }
  keepErr.value = "";
  return n;
});

// 选中集一变就重建状态（默认全部未勾选），并清掉上一轮的执行结果，避免拿着旧 log 说本轮删了什么
watch(() => props.workers.join("\u0000"), syncSelection, { immediate: true });

async function analyze() {
  const k = keepValue.value;
  if (k === null) return;
  if (!states.length) return;
  analyzing.value = true;
  log.value = [];
  armed.value = false;
  let done = 0;
  const total = states.length;
  try {
    for (const s of states) {
      s.phase = "loading";
      emit("progress", { running: true, text: `分析 ${s.worker}（${done + 1}/${total}）`, done, total });
      try {
        const [versions, deployments] = await Promise.all([loadVersions(s), api.workerDeployments(s.worker)]);
        const rawDep: any = deployments.result;
        const deps: any[] = Array.isArray(rawDep) ? rawDep : (rawDep?.deployments ?? []);
        s.run = runningModel(deps);
        s.candidates = deploymentCandidates(deps, k, s.run);
        s.checked = {};
        s.phase = "ready";
      } catch (e) {
        const g = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
        s.phase = "error";
        s.errText = g.message;
        s.errKind = g.kind;
      }
      done += 1;
      emit("progress", { running: true, text: `已分析 ${done}/${total}`, done, total });
    }
  } finally {
    analyzing.value = false;
    emit("progress", { running: false, text: "", done: 0, total: 0 });
  }
}

async function loadVersions(s: WState): Promise<any[]> {
  const all: any[] = [];
  const seen = new Set<string>();
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    const r = await api.workerVersions(s.worker, page, PER_PAGE);
    const items: any[] = r.result ?? [];
    s.total = typeof r.total === "number" && r.total > 0 ? r.total : null;
    for (const it of items) {
      const id = String(it?.id ?? "");
      if (id && !seen.has(id)) { seen.add(id); all.push(it); }
    }
    if (items.length < PER_PAGE) break;
    if (s.total !== null && all.length >= s.total) break;
  }
  s.pages = page - 1;
  s.versions = all;
  s.truncated = s.total !== null && all.length < s.total;
  return all;
}

const chosen = computed(() => {
  const out: { worker: string; cand: Candidate; path: string }[] = [];
  for (const s of states) {
    for (const c of s.candidates) {
      if (c.deletable && s.checked[c.id]) {
        out.push({ worker: s.worker, cand: c, path: `/v1/workers/${encodeURIComponent(s.worker)}/deployments/${encodeURIComponent(c.id)}` });
      }
    }
  }
  return out;
});
const blockedCount = computed(() => states.reduce((n, s) => n + s.candidates.filter((c) => !c.deletable).length, 0));

function checkAllIn(s: WState, on: boolean) {
  for (const c of s.candidates) if (c.deletable) s.checked[c.id] = on;
  armed.value = false;
}

/* ---------- 确认抽屉：批量就是"逐条 DELETE"的清单，路径模板 + 每一条的真实路径都列出来 ---------- */
const preview = ref<WritePreview | null>(null);
const busy = ref(false);
const sheetErr = ref("");

function askBatch() {
  const list = chosen.value;
  if (!list.length) return;
  sheetErr.value = "";
  preview.value = {
    method: "DELETE",
    path: "/v1/workers/{worker}/deployments/{deployment_id}",
    body: undefined,
    title: `批量删除 ${list.length} 条旧部署记录`,
    lines: [
      { k: "保留策略", v: `每个 Worker 保留最新 ${keep.value} 条部署记录；包含承接流量版本的记录已全部排除（共 ${blockedCount.value} 条不给勾）` },
      { k: "执行方式", v: `按下面顺序逐条发送 ${list.length} 个 DELETE，一条失败不中断其余，结果逐行输出` },
      { k: "请求路径模板", v: "DELETE /v1/workers/{worker}/deployments/{deployment_id}（无请求体）" },
      ...list.map((x, i) => ({ k: `${i + 1}/${list.length}`, v: `${x.worker} · 记录 #${x.cand.number} · ${shortId(x.cand.id, 8)} · ${dt(x.cand.created_on)}` })),
      { k: "后果", v: "删的是部署历史条目：不影响版本本体与运行中的服务，但删掉的记录找不回来。" },
      { k: "路由状态", v: "上游形状 2026-10-19 实测：删部署记录 API Token 可用（200）；删版本本体 CF 只认 Global Key（Token 一律 405，实测 3 次），版本本体想删得换 Global Key 令牌。" },
    ],
    danger: "normal",
  };
}

async function runBatch() {
  const list = chosen.value;
  if (!preview.value || busy.value || !list.length) return;
  busy.value = true;
  sheetErr.value = "";
  let ok = 0;
  let failed = 0;
  try {
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      emit("progress", { running: true, text: `删除 ${x.worker} #${x.cand.number}（${i + 1}/${list.length}）`, done: i, total: list.length });
      try {
        await gwWrite("DELETE", x.path);
        ok += 1;
        log.value.unshift({ text: `${x.worker} #${x.cand.number} ${shortId(x.cand.id, 8)} 已删除（网关确认 200）`, ok: true });
        markDeleted(x.worker, x.cand.id);
      } catch (e) {
        const g = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
        failed += 1;
        log.value.unshift({ text: `${x.worker} #${x.cand.number} ${shortId(x.cand.id, 8)} 失败 · kind=${g.kind}${g.code ? " · code=" + g.code : ""} · ${g.message}`, ok: false });
        sheetErr.value = `已发 ${i + 1} 条：成功 ${ok}、失败 ${failed}。最后一条：${g.kind} · ${g.message}\n${g.hint}`;
        // 第一条就被网关整体拒掉时不必把剩下的 N 条都撞一遍
        if (g.kind === "writesDisabled" || g.kind === "auth" || g.kind === "misconfigured") {
          for (let j = i + 1; j < list.length; j++) {
            const y = list[j];
            log.value.unshift({ text: `${y.worker} #${y.cand.number} ${shortId(y.cand.id, 8)} 未发送（前面的请求已被 ${g.kind} 拒绝）`, ok: false });
          }
          break;
        }
      }
    }
    if (ok > 0) {
      for (const s of states) dropMem("/v1/workers/" + encodeURIComponent(s.worker));
      emit("changed");
    }
    if (!sheetErr.value) preview.value = null;
  } finally {
    busy.value = false;
    emit("progress", { running: false, text: "", done: 0, total: 0 });
  }
}

function markDeleted(worker: string, id: string) {
  const s = states.find((x) => x.worker === worker);
  if (!s) return;
  s.candidates = s.candidates.filter((c) => c.id !== id);
  delete s.checked[id];
}

function cancelBatch() {
  preview.value = null;
  sheetErr.value = "";
}
</script>

<template>
  <div class="cp">
    <div class="row" style="gap: 8px; align-items: flex-end">
      <label class="lbl keep">保留最新
        <input v-model="keep" class="field" type="number" min="1" step="1" />
      </label>
      <button class="ghost" type="button" :disabled="!states.length || analyzing" @click="analyze">{{ analyzing ? "分析中" : `分析 ${states.length} 个 Worker` }}</button>
    </div>
    <p class="small errtext" v-if="keepErr">{{ keepErr }}</p>
    <p class="small muted">
      分析只读：每个 Worker 取最近 {{ PER_PAGE }} × {{ MAX_PAGES }} = {{ PER_PAGE * MAX_PAGES }} 条版本和部署记录来算候选，**不发任何写请求**。
      候选默认一条都不勾，要自己勾。
    </p>

    <div class="switchline">
      <label class="row" style="gap: 6px">
        <input type="checkbox" class="switch" :checked="optIn" @change="toggleOptIn(($event.target as HTMLInputElement).checked)" />
        <span>本机写开关：{{ optIn ? "已打开" : "未打开" }}</span>
      </label>
      <span class="small muted">{{ optIn ? "确认后请求会真的发到网关（网关那一侧还有一道 WRITE_ENABLED 闸门）。" : "关着的时候 gwWrite 会当场返回 writesDisabled，请求不会离开这台设备。" }}</span>
    </div>

    <div class="empty" v-if="!states.length">先在下面列表里勾选要处理的 Worker（工具条「管理版本」进入选择模式）。</div>

    <div v-for="s in states" :key="s.worker" class="wsec">
      <div class="whead">
        <b>{{ s.worker }}</b>
        <span class="small muted" v-if="s.phase === 'idle'">未分析</span>
        <span class="small muted" v-else-if="s.phase === 'loading'">分析中…</span>
        <span class="small errtext" v-else-if="s.phase === 'error'">分析失败 · kind={{ s.errKind }} · {{ s.errText }}</span>
        <template v-else>
          <span class="small muted">
            已载入 {{ s.versions.length }} 个版本<span v-if="s.total !== null"> / 共 {{ s.total }}</span><span v-if="s.truncated">（只分析了最近 {{ PER_PAGE * MAX_PAGES }} 条，更早的版本不在候选里）</span>
          </span>
        </template>
      </div>

      <template v-if="s.phase === 'ready'">
        <p class="small warnline" v-if="s.run && (s.run.ambiguous || s.run.note)">{{ s.run.note }}</p>
        <p class="small muted" v-else-if="s.run?.ids.length">运行中的版本：{{ s.run.ids.map((i) => shortId(i, 8) + " " + (s.run!.pct[i] ?? "?") + "%").join(" · ") }}（已排除）</p>
        <p class="small muted" v-else>没有版本被标为运行中（按最新部署判定），候选仍会排除它拿不到的情况。</p>

        <div class="row" style="gap: 6px; margin: 6px 0" v-if="s.candidates.length">
          <button class="chip" type="button" @click="checkAllIn(s, true)">全选可删候选</button>
          <button class="chip" type="button" @click="checkAllIn(s, false)">清空勾选</button>
          <span class="small muted">{{ Object.keys(s.checked).filter((k) => s.checked[k]).length }} / {{ s.candidates.filter((c) => c.deletable).length }} 条已勾</span>
        </div>

        <div class="list" v-if="s.candidates.length">
          <div v-for="c in s.candidates" :key="c.id" class="item cand" :class="{ off: !c.deletable }">
            <label class="row" style="gap: 8px; min-width: 0" :class="{ taplabel: c.deletable }">
              <input type="checkbox" :disabled="!c.deletable" v-model="s.checked[c.id]" @change="armed = false" />
              <span style="min-width: 0">
                <span class="k">#{{ c.number }} {{ shortId(c.id, 8) }}</span>
                <span class="small muted block">{{ dt(c.created_on) }} · {{ c.reason }}</span>
              </span>
            </label>
            <span class="v">{{ c.pct !== null ? c.pct + "%" : "0%" }}</span>
          </div>
        </div>
        <div class="empty" v-else>这个 Worker 的版本都在保留窗口内，没有可清理的候选。</div>
      </template>
    </div>

    <div class="batchbar" v-if="states.some((s) => s.phase === 'ready')">
      <label class="row" style="gap: 8px" v-if="chosen.length">
        <input type="checkbox" :checked="armed" @change="armed = ($event.target as HTMLInputElement).checked" />
        <span class="small">我已逐条核对以上 {{ chosen.length }} 条部署记录（{{ states.filter((s) => s.phase === 'ready').length }} 个 Worker，共排除 {{ blockedCount }} 条不给勾）</span>
      </label>
      <button class="ghost danger" type="button" :disabled="!chosen.length || !armed || busy" @click="askBatch">清理这 {{ chosen.length }} 条旧部署记录</button>
    </div>
    <p class="small muted" v-if="chosen.length && !armed">勾完候选还要打勾确认「已逐条核对」，按钮才会亮。删除不给一键全选的捷径。</p>

    <div class="log" v-if="log.length">
      <div class="small muted">执行结果（逐条，成功以网关真的 200 为准）：</div>
      <div v-for="(l, i) in log" :key="i" :class="l.ok ? 'ok' : 'no'">{{ l.text }}</div>
    </div>

    <ConfirmSheet :preview="preview" :busy="busy" :error="sheetErr" @confirm="runBatch" @cancel="cancelBatch" />
  </div>
</template>

<style scoped>
.cp { display: flex; flex-direction: column; gap: 8px; }
.keep { display: flex; align-items: center; gap: 8px; margin: 0; }
.keep input { width: 84px; }
.errtext { color: var(--bad); }
.warnline { color: var(--warn); }
.switchline { display: flex; flex-direction: column; gap: 3px; font-size: 12.5px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel-2); }
.wsec { border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; background: var(--panel); }
.whead { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; justify-content: space-between; }
.cand { gap: 10px; align-items: flex-start; }
.cand.off { opacity: .55; }
.cand .k { display: block; }
.block { display: block; white-space: normal; -webkit-line-clamp: unset; }
.batchbar { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding-top: 6px; border-top: 1px dashed var(--line); }
button.danger { color: var(--bad); border-color: rgb(var(--bad-rgb) / .45); }
button:disabled { opacity: .45; }
.log { display: flex; flex-direction: column; gap: 3px; }
.log .ok { color: var(--ok); font-size: 12px; }
.log .no { color: var(--bad); font-size: 12px; word-break: break-all; }
</style>
