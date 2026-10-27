<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { reloadTick, requestReload } from "../lib/bus";
import { useRouter } from "vue-router";
import ErrorNote from "../components/ErrorNote.vue";
import RowCard from "../components/RowCard.vue";
import ComputeBoard from "../components/compute/ComputeBoard.vue";
import WorkersQuota from "../components/ver/WorkersQuota.vue";
import CleanupPanel from "../components/ver/CleanupPanel.vue";
import { api, apiAs, forceFreshWindow, GwError, pageDeployed, pageLastActivity, workerName } from "../lib/api";
import { dt, rel } from "../lib/fmt";
import { labelOf, type CfAccount } from "../lib/accounts";
import { agg, aggAccounts, aggSkipped, focusAccount, mapLimit } from "../lib/aggregate";

const nav = useRouter();

/* ---------- 多账号合一（只读）：Workers / Pages 两份清单直接相加 ---------- */
const aggErrors = ref<Array<{ accName: string; label: string; err: GwError }>>([]);
const aggLoading = ref(false);
const aggDone = ref(0);

const arrOf = (r: any): any[] => (Array.isArray(r?.result) ? r.result : []);
const asGw = (e: unknown): GwError => (e instanceof GwError ? e : new GwError("unknown", 0, null, String((e as Error)?.message || e)));
const tagged = (items: any[], a: CfAccount): any[] => items.map((x) => ({ ...x, __acc: a.id, __accName: labelOf(a) }));

/**
 * 合并取数：账号之间并发 2；Workers / Pages 两条各自 catch ——
 * 一个账号缺 Pages 权限不该把它的 Worker 也一起抹掉。
 */
async function loadAgg() {
  aggLoading.value = true;
  aggDone.value = 0;
  workersLoading.value = true;
  pagesLoading.value = true;
  workersErr.value = null;
  pagesErr.value = null;
  aggErrors.value = [];
  const accs = aggAccounts();
  const outW: any[] = [];
  const outP: any[] = [];
  let done = 0;
  await mapLimit(accs, 2, async (a) => {
    const e = apiAs(a.id);
    const [wr, pr] = await Promise.allSettled([e.workers(), e.pages()]);
    if (wr.status === "fulfilled") outW.push(...tagged(arrOf(wr.value), a));
    else aggErrors.value.push({ accName: labelOf(a), label: "Workers", err: asGw(wr.reason) });
    if (pr.status === "fulfilled") outP.push(...tagged(arrOf(pr.value), a));
    else aggErrors.value.push({ accName: labelOf(a), label: "Pages", err: asGw(pr.reason) });
    aggDone.value = ++done;
  });
  workers.value = outW;
  pages.value = outP;
  workersLoading.value = false;
  pagesLoading.value = false;
  aggLoading.value = false;
}

/** 退出合并视图（顶栏下拉里也有同一个开关） */
function exitAgg() {
  agg.on = false;
  requestReload();
}

/* ---- Workers 列表 ---- */
const workers = ref<any[]>([]);
const workersErr = ref<GwError | null>(null);
const workersLoading = ref(false);
const wq = ref("");
const wsort = ref<"modified" | "name">("modified");

async function loadWorkers() {
  if (agg.on) return; // 合并模式由 loadAgg 统一取两列表
  workersLoading.value = true;
  workersErr.value = null;
  try {
    const r = await api.workers();
    workers.value = Array.isArray(r.result) ? r.result : [];
  } catch (e) {
    workersErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    workersLoading.value = false;
  }
}

const shownWorkers = computed(() => {
  const s = wq.value.trim().toLowerCase();
  const arr = s ? workers.value.filter((w) => workerName(w).toLowerCase().includes(s)) : [...workers.value];
  return wsort.value === "name"
    ? arr.sort((a, b) => workerName(a).localeCompare(workerName(b)))
    : arr.sort((a, b) => String(b.modified_on || "").localeCompare(String(a.modified_on || "")));
});

/** 宫格与 Worker 详情页的分区一一对应（9 张卡 9 个入口，不再有"这张卡没有入口"的情况） */
const workerCards = [
  { ico: "versions", label: "版本列表", c: "versions" },
  { ico: "deployments", label: "部署历史", c: "deployments" },
  { ico: "traffic", label: "流量归属", c: "traffic" },
  { ico: "globe", label: "自定义域名", c: "domains" },
  { ico: "settings", label: "配置信息", c: "settings" },
  { ico: "link", label: "绑定", c: "bindings" },
  { ico: "secrets", label: "变量与 Secret", c: "secrets" },
  { ico: "crons", label: "定时触发器", c: "crons" },
  { ico: "switch", label: "版本切换", c: "switch" },
];

function workerActionsFor(w: any) {
  return [
    ...workerCards.map((k) => ({ ico: k.ico, label: k.label, go: `${k.c}|${workerName(w)}` })),
    {
      ico: "logs",
      label: "日志",
      go: "logs",
      why: "实时日志走 WebSocket 中继（tail.developers.workers.dev），这一版没实现，所以这里没有数据可看。",
    },
  ];
}

function onWorkerGo(a: any, w: any) {
  if (!a.go.includes("|")) return;
  const [c] = a.go.split("|");
  if (agg.on && w.__acc) focusAccount(String(w.__acc)); // 详情页读"当前账号"，先切过去
  nav.push(`/workers/${encodeURIComponent(workerName(w))}?c=${c}`);
}
function openWorker(w: any) {
  if (agg.on && w.__acc) focusAccount(String(w.__acc));
  nav.push("/workers/" + encodeURIComponent(workerName(w)));
}

/* ---- Pages 列表 ---- */
const pages = ref<any[]>([]);
const pagesErr = ref<GwError | null>(null);
const pagesLoading = ref(false);

async function loadPages() {
  if (agg.on) return; // 合并模式由 loadAgg 统一取两列表
  pagesLoading.value = true;
  pagesErr.value = null;
  try {
    const r = await api.pages();
    pages.value = Array.isArray(r.result) ? r.result : [];
  } catch (e) {
    pagesErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    pagesLoading.value = false;
  }
}

const hasProject = computed(() => pages.value.length > 0);

/** 项目详情拆成与 Workers 详情同一套分区：点行进详情，动作宫格直接落到对应卡片 */
const pageCards = [
  { ico: "settings", label: "概览", c: "overview" },
  { ico: "deployments", label: "部署历史", c: "deps" },
  { ico: "traffic", label: "自定义域名", c: "domains" },
  { ico: "secrets", label: "环境变量", c: "env" },
  { ico: "buildlog", label: "构建日志", c: "logs" },
];
const projectActions = pageCards.map((k) => ({ ico: k.ico, label: k.label, go: `${k.c}|${k.c}` }));

function pagePath(p: any) {
  return "/pages/" + encodeURIComponent(String(p.name ?? ""));
}
function openProject(p: any) {
  if (agg.on && p.__acc) focusAccount(String(p.__acc));
  nav.push(pagePath(p));
}
function onProjectGo(p: any, a: any) {
  if (!a.go.includes("|")) return;
  if (agg.on && p.__acc) focusAccount(String(p.__acc));
  nav.push(pagePath(p) + "?c=" + a.go.split("|")[0]);
}

/** 「刷新」绕过两层缓存真出一次 */
const quotaTick = ref(0);
/** 顶栏「刷新当前屏」（lib/bus）：各屏不再自备右上角刷新键 */
watch(reloadTick, () => { void refresh(); });
function refresh() {
  forceFreshWindow();
  quotaTick.value++;
  if (agg.on) { void loadAgg(); return; }
  void loadWorkers();
  void loadPages();
}

onMounted(() => {
  if (agg.on) { void loadAgg(); return; }
  void loadWorkers();
  void loadPages();
});

/** 顶部分段：默认「看板」= Workers + Pages 二合一（一块看板读完两类资源）；
 *  「Workers」/「Pages」两档才是逐项动手的完整列表。 */
const kind = ref<"all" | "workers" | "pages">("all");

/** 版本清理面板要处理的 Worker 集合：默认空，必须手动勾，绝不默认全选 */
const cleanSel = ref<string[]>([]);
function toggleClean(w: string) {
  cleanSel.value = cleanSel.value.includes(w) ? cleanSel.value.filter((x) => x !== w) : [...cleanSel.value, w];
}
</script>

<template>
  <div>
    <!-- Workers / Pages 分段：默认看板（二合一），另两档是逐项动手的完整列表。
         原来这三档叫「全部 / Workers / Pages」，而「全部」只是把两张表上下拼起来，
         数量与时间各写一遍 —— 现在「看板」真的是一块合并后的读数面。 -->
    <div class="row" style="gap: 4px; margin-bottom: 10px">
      <button class="chip" :class="{ on: kind === 'all' }" @click="kind = 'all'">看板</button>
      <button class="chip" :class="{ on: kind === 'workers' }" @click="kind = 'workers'">Workers</button>
      <button class="chip" :class="{ on: kind === 'pages' }" @click="kind = 'pages'">Pages</button>
    </div>

    <!-- 合并视图（只读）：账号数、取数进度、逐账号失败都在这里说清 -->
    <div v-if="agg.on" class="aggbar">
      <div class="aggtop">
        <span class="aggt">合并视图 · {{ aggAccounts().length }} 个账号 · 只读</span>
        <button class="ghost sm" @click="exitAgg">退出合并</button>
      </div>
      <div class="small muted" v-if="aggLoading">
        正在取数：{{ aggDone }}/{{ aggAccounts().length }} 个账号已就绪
      </div>
      <div class="small muted" v-else>点条目会先切到它所属账号再进详情；写操作请在单账号下进行。</div>
      <div class="small muted" v-if="aggSkipped().length">网页模式跳过 {{ aggSkipped().length }} 个 OAuth 账号（拿不到令牌）。</div>
      <div v-for="(x, i) in aggErrors" :key="i" class="small agg-err">
        {{ x.accName }} · {{ x.label }}：{{ x.err.hint }}
      </div>
    </div>

    <!-- 每日额度：接口只给事件数，请求数与上限的来源在这块内部各自标清（docs/09 §E16）。
         合并视图里额度只对当前账号有意义，故收起。 -->
    <WorkersQuota v-if="kind !== 'pages' && !agg.on" :tick="quotaTick" />

    <!-- 二合一看看板：4 格合计 + 一份按最近改动并起来的清单（只用上面两条列表，不发额外请求） -->
    <ComputeBoard
      v-if="kind === 'all'"
      :workers="workers"
      :pages="pages"
      :w-err="workersErr"
      :p-err="pagesErr"
      :loading="workersLoading || pagesLoading"
      :agg="agg.on"
    />

    <!-- Workers 区块（逐项动手时才展开） -->
    <div class="card" v-if="kind === 'workers'">
      <h3>Workers（{{ workers.length }} 个）</h3>
      <ErrorNote :err="workersErr" />
      <div v-if="workers.length" style="margin-bottom: 10px">
        <div class="row" style="margin-bottom: 8px">
          <input v-model="wq" class="field" style="max-width: 200px" placeholder="搜索 Worker 名称" />
          <!-- 排序并成一个键：两个 chip 只切一个状态，占一行不值当 -->
          <button
            class="chip"
            :title="wsort === 'modified' ? '当前按修改时间排序，点一下改成按名称' : '当前按名称排序，点一下改成按修改时间'"
            @click="wsort = wsort === 'modified' ? 'name' : 'modified'"
          >{{ wsort === "modified" ? "按修改时间" : "按名称" }}</button>
        </div>
      </div>
      <div class="empty" v-if="workersLoading && !shownWorkers.length">加载中…</div>
      <div class="rows" v-if="shownWorkers.length">
        <RowCard
          v-for="w in shownWorkers"
          :key="(w.__acc || '') + workerName(w)"
          :title="workerName(w)"
          :meta="`${rel(w.modified_on)} 修改 · ${dt(w.created_on, false)} 创建`"
          :max="6"
          :badges="[
            ...(w.__accName ? [{ text: w.__accName, title: '归属账号 ' + w.__acc }] : []),
            ...(w.tail_consumers && w.tail_consumers.length ? [{ text: '实时日志', title: '字段 tail_consumers：这个 Worker 挂了 Workers Tail 消费者（实时日志流）' }] : []),
            ...(w.logpush ? [{ text: '日志推送', title: '字段 logpush：日志往外推给第三方（Logpush）' }] : []),
            ...(w.has_assets ? [{ text: '静态资源', title: '字段 has_assets：绑了 Workers Static Assets，除代码还托管文件（页面/图片这类）' }] : []),
            ...(w.placement?.mode === 'smart' ? [{ text: '智能放置', cls: 'roll', title: 'Smart Placement：CF 把执行点放到离你的数据源（D1/KV/R2/源站）最近的边缘，而不是只就近访问者' }] : []),
          ]"
          :actions="workerActionsFor(w)"
          @open="openWorker(w)"
          @go="(a) => onWorkerGo(a, w)"
        />
      </div>
      <div v-else-if="!workersLoading && !workersErr" class="empty">
        {{ agg.on ? "这些账号里都没有 Worker" : "这个账号里没有 Worker" }}
      </div>
    </div>

    <!-- 版本清理：低频运维功能，默认收起（2026-10-25）。
         收起之前它跟上面的 Worker 列表摆成"两份清单"，看着像重复数据。
         展开后仍是原来那块：候选必须手勾，默认空。只看板不摆它，切到 Workers 档才出现。 -->
    <details class="foldcard" v-if="kind === 'workers' && !agg.on">
      <summary>
        <span>版本清理</span>
        <span class="fc-s">批量删旧部署记录</span>
      </summary>
      <div class="fc-body">
        <div class="small muted" style="margin-bottom: 8px">
          勾选要清理的 Worker → 「分析」→ 只删超出保留窗口、且不包含运行中版本的<b>部署记录</b>。
          删除版本本体那条路由 CF 对 API Token 一律 405，所以这里不走它。
        </div>
        <div class="row" style="flex-wrap: wrap; gap: 4px; margin-bottom: 10px">
          <button
            v-for="w in workers"
            :key="workerName(w)"
            class="chip"
            :class="{ on: cleanSel.includes(workerName(w)) }"
            type="button"
            @click="toggleClean(workerName(w))"
          >{{ workerName(w) }}</button>
        </div>
        <CleanupPanel :workers="cleanSel" @changed="refresh" />
      </div>
    </details>

    <!-- Pages 区块（逐项动手时才展开） -->
    <div class="card" v-if="kind === 'pages'">
      <h3>Pages 项目（{{ pages.length }} 个）</h3>
      <ErrorNote :err="pagesErr" />

      <div class="small muted" style="margin: 6px 0 10px">
        点项目行或下方任一动作进入项目详情：概览、部署历史（含回滚 / 重试 / 构建日志）、自定义域名、环境变量与构建配置。
      </div>

      <div v-if="!hasProject && !pagesLoading && !pagesErr" class="small muted">
        {{ agg.on
          ? "这些账号里都没有 Pages 项目（不是没取到：两条列表都返回了空）"
          : "这个账号还没有 Pages 项目（不是没取到：令牌能过 Pages 路由，缺的是数据）。后台建一个，这块立刻就有内容。" }}
      </div>

      <div class="rows" v-if="hasProject">
        <RowCard
          v-for="p in pages"
          :key="(p.__acc || '') + String(p.name)"
          :title="String(p.name)"
          :meta="`${p.production_branch || '无分支'} • ${p.subdomain || '—'} • ${rel(pageLastActivity(p))}${pageDeployed(p) ? ' 部署' : ' 创建'}`"
          :badges="[
            ...(p.__accName ? [{ text: p.__accName, title: '归属账号 ' + p.__acc }] : []),
            { text: pageDeployed(p) ? '已部署' : '无部署', cls: pageDeployed(p) ? 'live' : undefined },
          ]"
          :actions="projectActions"
          @open="openProject(p)"
          @go="(a) => onProjectGo(p, a)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 合并视图状态条：与域名页同一套语汇（账号数 + 进度 + 逐账号错误） */
.aggbar { border: 1px solid var(--accent-dim); border-radius: 12px; padding: 9px 11px;
  margin-bottom: 10px; background: rgb(var(--accent-rgb) / .06); }
.aggtop { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.aggt { font-size: 13px; font-weight: 650; color: var(--accent); }
.agg-err { color: var(--bad); margin-top: 3px; }
/* 版本清理的折叠卡：低频运维功能默认收起，展开后内容与原来那张卡一致。
   折叠壳不画卡片壳（只一个眉题 + 浅底），里面的内容仍走全局 .card 的读数轨语义。 */
.foldcard { border: 1px solid var(--line-soft); border-radius: 14px; background: var(--panel-2); margin-bottom: 12px; overflow: hidden; }
.foldcard > summary {
  display: flex; align-items: center; gap: 8px; padding: 11px 13px;
  cursor: pointer; list-style: none; font-size: var(--t-sm); font-weight: 650; color: var(--fg-2);
}
.foldcard > summary::-webkit-details-marker { display: none; }
.foldcard > summary::before {
  content: ""; width: 6px; height: 6px; flex: none;
  border-right: 1.6px solid var(--muted); border-bottom: 1.6px solid var(--muted);
  transform: rotate(-45deg); transition: transform .18s ease;
}
.foldcard[open] > summary::before { transform: rotate(45deg); }
.fc-s { margin-left: auto; font-size: var(--t-2xs); font-weight: 400; color: var(--muted); }
.fc-body { padding: 0 12px 12px; }
</style>
