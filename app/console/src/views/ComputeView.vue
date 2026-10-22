<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import ErrorNote from "../components/ErrorNote.vue";
import RowCard from "../components/RowCard.vue";
import WorkersQuota from "../components/ver/WorkersQuota.vue";
import CleanupPanel from "../components/ver/CleanupPanel.vue";
import { api, forceFreshWindow, GwError, workerName } from "../lib/api";
import { dt, rel } from "../lib/fmt";

const nav = useRouter();

/* ---- Workers 列表 ---- */
const workers = ref<any[]>([]);
const workersErr = ref<GwError | null>(null);
const workersLoading = ref(false);
const wq = ref("");
const wsort = ref<"modified" | "name">("modified");

async function loadWorkers() {
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

const workerCards = [
  { ico: "versions", label: "版本列表", c: "versions" },
  { ico: "deployments", label: "部署历史", c: "deployments" },
  { ico: "settings", label: "配置信息", c: "settings" },
  { ico: "secrets", label: "Secret", c: "secrets" },
  { ico: "crons", label: "定时触发", c: "crons" },
  { ico: "traffic", label: "流量归属", c: "traffic" },
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

function onWorkerGo(a: any, name: string) {
  if (!a.go.includes("|")) return;
  const [c] = a.go.split("|");
  nav.push(`/workers/${encodeURIComponent(name)}?c=${c}`);
}

/* ---- Pages 列表 ---- */
const pages = ref<any[]>([]);
const pagesErr = ref<GwError | null>(null);
const pagesLoading = ref(false);

async function loadPages() {
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
  nav.push(pagePath(p));
}
function onProjectGo(p: any, a: any) {
  if (!a.go.includes("|")) return;
  nav.push(pagePath(p) + "?c=" + a.go.split("|")[0]);
}

/** 「刷新」绕过两层缓存真出一次 */
const quotaTick = ref(0);
function refresh() { forceFreshWindow(); loadWorkers(); loadPages(); quotaTick.value++; }

onMounted(() => { loadWorkers(); loadPages(); });

/** 顶部分段：Workers / Pages 各一屏太长，给一个明确的切换口，默认「全部」 */
const kind = ref<"all" | "workers" | "pages">("all");

/** 版本清理面板要处理的 Worker 集合：默认空，必须手动勾，绝不默认全选 */
const cleanSel = ref<string[]>([]);
function toggleClean(w: string) {
  cleanSel.value = cleanSel.value.includes(w) ? cleanSel.value.filter((x) => x !== w) : [...cleanSel.value, w];
}
</script>

<template>
  <div>
    <div class="row" style="justify-content: space-between; margin-bottom: 10px">
      <span class="muted small">计算资源：{{ workers.length }} 个 Worker · {{ pages.length }} 个 Pages 项目</span>
      <button class="ghost" :disabled="workersLoading || pagesLoading" @click="refresh">{{ (workersLoading || pagesLoading) ? "加载中" : "刷新" }}</button>
    </div>

    <!-- Workers / Pages 分段切换：两个区块不是同一类资源，但常要对着看，所以给「全部」也留着 -->
    <div class="row" style="gap: 4px; margin-bottom: 10px">
      <button class="chip" :class="{ on: kind === 'all' }" @click="kind = 'all'">全部</button>
      <button class="chip" :class="{ on: kind === 'workers' }" @click="kind = 'workers'">Workers</button>
      <button class="chip" :class="{ on: kind === 'pages' }" @click="kind = 'pages'">Pages</button>
    </div>

    <!-- Workers 每日额度：接口只给事件数，请求数与上限的来源在这块内部各自标清（docs/09 §E16） -->
    <WorkersQuota v-if="kind !== 'pages'" :tick="quotaTick" />

    <!-- Workers 区块 -->
    <div class="card" v-if="kind !== 'pages'">
      <h3>Workers（{{ workers.length }} 个）</h3>
      <ErrorNote :err="workersErr" />
      <div v-if="workers.length" style="margin-bottom: 10px">
        <div class="row" style="margin-bottom: 8px">
          <input v-model="wq" class="field" style="max-width: 200px" placeholder="搜索 Worker 名称" />
          <div class="row" style="gap: 4px">
            <button class="chip" :class="{ on: wsort === 'modified' }" @click="wsort = 'modified'">按修改时间</button>
            <button class="chip" :class="{ on: wsort === 'name' }" @click="wsort = 'name'">按名称排序</button>
          </div>
        </div>
      </div>
      <div class="empty" v-if="workersLoading && !shownWorkers.length">加载中…</div>
      <div class="rows" v-if="shownWorkers.length">
        <RowCard
          v-for="w in shownWorkers"
          :key="workerName(w)"
          :title="workerName(w)"
          :meta="`${rel(w.modified_on)} 修改 · ${dt(w.created_on, false)} 创建`"
          :badges="[
            ...(w.tail_consumers && w.tail_consumers.length ? [{ text: '实时日志', title: '字段 tail_consumers：这个 Worker 挂了 Workers Tail 消费者（实时日志流）' }] : []),
            ...(w.logpush ? [{ text: '日志推送', title: '字段 logpush：日志往外推给第三方（Logpush）' }] : []),
            ...(w.has_assets ? [{ text: '静态资源', title: '字段 has_assets：绑了 Workers Static Assets，除代码还托管文件（页面/图片这类）' }] : []),
            ...(w.placement?.mode === 'smart' ? [{ text: '智能放置', cls: 'roll', title: 'Smart Placement：CF 把执行点放到离你的数据源（D1/KV/R2/源站）最近的边缘，而不是只就近访问者' }] : []),
          ]"
          :actions="workerActionsFor(w)"
          @open="nav.push('/workers/' + encodeURIComponent(workerName(w)))"
          @go="(a) => onWorkerGo(a, workerName(w))"
        />
      </div>
      <div v-else-if="!workersLoading && !workersErr" class="empty">这个账号里没有 Worker</div>
    </div>

    <!-- 版本清理：批量删旧部署记录（不碰版本本体），候选必须手勾 -->
    <div class="card" v-if="kind !== 'pages'">
      <h3>版本清理（批量删旧部署记录）</h3>
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

    <!-- Pages 区块 -->
    <div class="card" v-if="kind !== 'workers'">
      <h3>Pages 项目（{{ pages.length }} 个）</h3>
      <ErrorNote :err="pagesErr" />

      <div class="small muted" style="margin: 6px 0 10px">
        点项目行或下方任一动作进入项目详情：概览、部署历史（含回滚 / 重试 / 构建日志）、自定义域名、环境变量与构建配置。
      </div>

      <div v-if="!hasProject && !pagesLoading && !pagesErr" class="small muted">
        这个账号还没有 Pages 项目（不是没取到：令牌能过 Pages 路由，缺的是数据）。后台建一个，这块立刻就有内容。
      </div>

      <div class="rows" v-if="hasProject">
        <RowCard
          v-for="p in pages"
          :key="p.name"
          :title="String(p.name)"
          :meta="`${p.production_branch || '无分支'} • ${p.subdomain || '—'} • ${rel(p.deployments?.[0]?.modified_on || p.created_on)}`"
          :badges="[{ text: p.deployment_id ? '已部署' : '无部署', cls: p.deployment_id ? 'live' : undefined }]"
          :actions="projectActions"
          @open="openProject(p)"
          @go="(a) => onProjectGo(p, a)"
        />
      </div>
    </div>
  </div>
</template>
