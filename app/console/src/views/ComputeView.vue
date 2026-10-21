<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import ErrorNote from "../components/ErrorNote.vue";
import RowCard from "../components/RowCard.vue";
import ConfirmSheet from "../components/ConfirmSheet.vue";
import WorkersQuota from "../components/ver/WorkersQuota.vue";
import CleanupPanel from "../components/ver/CleanupPanel.vue";
import {
  api,
  forceFreshWindow,
  GwError,
  previewPagesRetry,
  previewPagesRollback,
  setWritesOptIn,
  workerName,
  writesOptIn,
  type WritePreview,
} from "../lib/api";
import { useFold } from "../lib/lists";
import { bytes, dt, rel, shortId } from "../lib/fmt";

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
const openPage = ref("");
const deps = ref<any[]>([]);
/** 展开某个 Pages 项目后的部署历史：条数读全局偏好 */
const visiblePageDeps = useFold(() => deps.value);
const depErr = ref<GwError | null>(null);

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

/** 本机写开关：默认关（api.ts 写侧契约第 3 条 —— 关着就根本不出网） */
const optIn = ref(writesOptIn());
function toggleOptIn(v: boolean) {
  setWritesOptIn(v);
  optIn.value = writesOptIn();
}

/** 回滚 / 重试走同一个确认抽屉：预览里的路径就是真要发的路径，不是第二套文案 */
const sheet = ref<{ preview: WritePreview | null; busy: boolean; error: string }>({ preview: null, busy: false, error: "" });
const pending = ref<{ kind: "rollback" | "retry"; project: string; depId: string } | null>(null);
const actionMsg = ref<{ ok: boolean; text: string } | null>(null);

/** 构建日志按部署展开（同一时刻只开一块，避免长列表被日志撑爆） */
const logsFor = ref("");
const logsRows = ref<Array<{ ts?: string; line?: string }>>([]);
const logsErr = ref<GwError | null>(null);
const logsLoading = ref(false);

async function loadDeps(name: string) {
  deps.value = [];
  depErr.value = null;
  try {
    const r = await api.pageDeployments(name);
    const raw: any = r.result;
    deps.value = Array.isArray(raw) ? raw : (raw?.deployments ?? []);
  } catch (e) {
    depErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  }
}

async function openDeps(p: any) {
  const name = String(p.name ?? "");
  if (openPage.value === name) { openPage.value = ""; return; }
  openPage.value = name;
  logsFor.value = "";
  await loadDeps(name);
}

function askRollback(project: string, d: any) {
  const id = String(d?.id ?? "");
  if (!project || !id) return;
  sheet.value.error = "";
  actionMsg.value = null;
  pending.value = { kind: "rollback", project, depId: id };
  try {
    sheet.value.preview = previewPagesRollback(project, d);
  } catch (e) {
    sheet.value.error = e instanceof GwError ? e.message : String(e);
  }
}

function askRetry(project: string, d: any) {
  const id = String(d?.id ?? "");
  if (!project || !id) return;
  sheet.value.error = "";
  actionMsg.value = null;
  pending.value = { kind: "retry", project, depId: id };
  try {
    sheet.value.preview = previewPagesRetry(project, d);
  } catch (e) {
    sheet.value.error = e instanceof GwError ? e.message : String(e);
  }
}

function cancelSheet() {
  if (sheet.value.busy) return;
  sheet.value.preview = null;
  sheet.value.error = "";
  pending.value = null;
}

async function confirmSheet() {
  const p = pending.value;
  if (!p || sheet.value.busy) return;
  sheet.value.busy = true;
  sheet.value.error = "";
  try {
    const r = p.kind === "rollback" ? await api.pageRollback(p.project, p.depId) : await api.pageRetry(p.project, p.depId);
    forceFreshWindow();
    await loadDeps(p.project);
    actionMsg.value = {
      ok: true,
      text: p.kind === "rollback"
        ? `已回滚：上游返回部署 ${shortId(String(r?.id ?? p.depId), 8)}（生产与预览已同时切换）`
        : `已触发重试：上游返回部署 ${shortId(String(r?.id ?? p.depId), 8)}`,
    };
    sheet.value.preview = null;
    pending.value = null;
  } catch (e) {
    const err = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
    // 上游业务判断原样上屏（例如 Direct Upload 部署 retry 的 400 8000055），不假装成功
    sheet.value.error = `${err.kind}${err.code ? " " + err.code : ""}：${err.message}${err.hint ? "\n" + err.hint : ""}`;
  } finally {
    sheet.value.busy = false;
  }
}

async function toggleLogs(project: string, d: any) {
  const id = String(d?.id ?? "");
  if (!project || !id) return;
  if (logsFor.value === id) { logsFor.value = ""; return; }
  logsFor.value = id;
  logsRows.value = [];
  logsErr.value = null;
  logsLoading.value = true;
  try {
    forceFreshWindow();
    const r = await api.pageBuildLogs(project, id);
    logsRows.value = Array.isArray(r.result?.data) ? r.result!.data : [];
  } catch (e) {
    logsErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    logsLoading.value = false;
  }
}

/** 项目级动作只留「部署历史」——回滚/重试/日志都需要具体部署 id，放成项目级按钮会让人点空 */
const projectActions = [{ ico: "deployments", label: "部署历史", go: "deps" }];

function onProjectGo(p: any, a: any) {
  if (a.go === "deps") openDeps(p);
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

      <!-- 写侧两层闸门的第一层：本机开关。关着时连请求都不会离开设备 -->
      <div class="row" style="gap: 8px; margin: 6px 0 10px; flex-wrap: wrap">
        <label class="row" style="gap: 6px">
          <input type="checkbox" class="switch" :checked="optIn" @change="toggleOptIn(($event.target as HTMLInputElement).checked)" />
          <span class="small">本机写开关：{{ optIn ? "已打开" : "未打开" }}</span>
        </label>
        <span class="small muted">
          {{ optIn
            ? "回滚 / 重试确认后会真的发到 Cloudflare（网关那侧还有一道 WRITE_ENABLED）。"
            : "关着时 gwWrite 当场返回 writesDisabled，请求不会离开这台设备。" }}
        </span>
      </div>
      <div v-if="actionMsg" class="small" :style="{ color: actionMsg.ok ? 'var(--ok)' : 'var(--warn)' }">{{ actionMsg.text }}</div>

      <div class="card" v-if="!hasProject && !pagesLoading && !pagesErr" style="margin-top: 0; border: none; box-shadow: none">
        <div class="small muted">
          这个账号还没有 Pages 项目（不是没取到：令牌能过 Pages 路由，缺的是数据）。后台建一个，这块立刻就有内容。
        </div>
      </div>

      <div class="rows" v-if="hasProject">
        <div v-for="p in pages" :key="p.name">
          <RowCard
            :title="String(p.name)"
            :meta="`${p.production_branch || '无分支'} • ${p.subdomain || '—'} • ${rel(p.deployments?.[0]?.modified_on || p.created_on)}`"
            :badges="[{ text: p.deployment_id ? '已部署' : '无部署', cls: p.deployment_id ? 'live' : undefined }]"
            :actions="projectActions"
            @open="openDeps(p)"
            @go="(a) => onProjectGo(p, a)"
          />
          <div v-if="openPage === p.name" style="padding: 8px 0 0">
            <ErrorNote :err="depErr" />
            <div class="list" v-if="deps.length">
              <div v-for="d in visiblePageDeps.shown" :key="d.id" class="item">
                <div style="min-width: 0; flex: 1">
                  <div class="k">{{ shortId(d.id, 6) }}
                    <span class="badge live" v-if="d.latest_deploy">当前版本</span>
                  </div>
                  <div class="small muted">{{ dt(d.created_on) }} · {{ d.branch }} · {{ d.build_result?.status || d.status }} · {{ bytes(d.build_result?.bytes ?? 0) }}</div>
                  <div class="row" style="gap: 6px; margin-top: 6px; flex-wrap: wrap">
                    <button class="chip" type="button" v-if="!d.latest_deploy" @click="askRollback(String(p.name), d)">回滚到此</button>
                    <button class="chip" type="button" @click="askRetry(String(p.name), d)">重试构建</button>
                    <button class="chip" type="button" :class="{ on: logsFor === d.id }" @click="toggleLogs(String(p.name), d)">
                      {{ logsFor === d.id ? "收起日志" : "构建日志" }}
                    </button>
                  </div>
                  <div v-if="logsFor === d.id" style="margin-top: 8px">
                    <div v-if="logsLoading" class="small muted">构建日志加载中…</div>
                    <ErrorNote v-else-if="logsErr" :err="logsErr" />
                    <div v-else-if="logsRows.length" class="logbox mono">
                      <div v-for="(l, i) in logsRows" :key="i">{{ l.ts ? `[${l.ts}] ` : "" }}{{ l.line }}</div>
                    </div>
                    <div v-else class="small muted">这次部署没有构建日志（Direct Upload 部署通常只有一条部署完成记录）。</div>
                  </div>
                </div>
                <div class="v">{{ rel(d.created_on) }}</div>
              </div>
            </div>
            <div v-else-if="!depErr" class="empty">{{ pagesLoading ? "加载中" : "没有部署记录" }}</div>
            <button class="ghost" style="margin-top: 8px" v-if="visiblePageDeps.rest" @click="visiblePageDeps.open = !visiblePageDeps.open">
              {{ visiblePageDeps.label }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <ConfirmSheet :preview="sheet.preview" :busy="sheet.busy" :error="sheet.error" @confirm="confirmSheet" @cancel="cancelSheet" />
  </div>
</template>

<style scoped>
.logbox {
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 11.5px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  max-height: 240px;
  overflow: auto;
}
</style>
