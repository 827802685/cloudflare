<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { reloadTick } from "../lib/bus";
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

/** 宫格与 Worker 详情页的分区一一对应（9 张卡 9 个入口，不再有"这张卡没有入口"的情况） */
const workerCards = [
  { ico: "versions", label: "版本列表", c: "versions" },
  { ico: "deployments", label: "部署历史", c: "deployments" },
  { ico: "traffic", label: "流量归属", c: "traffic" },
  { ico: "globe", label: "自定义域名", c: "domains" },
  { ico: "settings", label: "配置信息", c: "settings" },
  { ico: "link", label: "绑定", c: "bindings" },
  { ico: "secrets", label: "Secret", c: "secrets" },
  { ico: "crons", label: "定时触发", c: "crons" },
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
/** 顶栏「刷新当前屏」（lib/bus）：各屏不再自备右上角刷新键 */
watch(reloadTick, () => { void refresh(); });
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
          :key="workerName(w)"
          :title="workerName(w)"
          :meta="`${rel(w.modified_on)} 修改 · ${dt(w.created_on, false)} 创建`"
          :max="6"
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

    <!-- 版本清理：低频运维功能，默认收起（2026-10-25）。
         收起之前它跟上面的 Worker 列表摆成"两份清单"，看着像重复数据。
         展开后仍是原来那块：候选必须手勾，默认空。 -->
    <details class="foldcard" v-if="kind !== 'pages'">
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

<style scoped>
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
