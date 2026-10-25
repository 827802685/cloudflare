<script setup lang="ts">
/**
 * Pages 项目详情（2026-10-21 新增，2026-10-22 补齐信息密度）。
 *
 * 为什么要有这一屏：此前 Pages 只有列表行 + 一段内联部署历史，而那段用的是**不存在的字段**
 * （`d.branch`、`d.build_result`）——真接口回的是 `deployment_trigger` / `latest_stage` / `stages`，
 * 于是界面上永远显示 undefined。现在按 Workers 详情的信息密度补齐：
 * 概览、线上部署、部署历史（逐条展开 + 回滚 / 重试 / 构建日志）、自定义域名、环境变量与构建配置。
 *
 * 上游形状全部在临时项目上实测（建→发两次直传部署→回滚→删项目，自清理完成）：
 *  - GET  …/pages/projects/{p}                   → 200，含 canonical_deployment / latest_deployment / deployment_configs
 *  - GET  …/pages/projects/{p}/domains            → 200，空项目 result=[]（pages.dev 子域不在里面）
 *  - GET  …/pages/projects/{p}/deployments        → 200，字段见下
 *  - POST …/deployments/{id}/rollback（空体）      → 200，result 是回滚后的部署对象
 *  - POST …/deployments/{id}/retry（空体）         → 400 code 8000055：直传部署不能重试，路由存在
 *
 * 构建日志：`…/history/logs` 路由实测存在；直传部署返回的 data 是空数组（没有日志行）。
 * 所以入口保留、如实显示"这次没有日志"，而不是假装有数据。
 */
import { computed, nextTick, onMounted, ref, watch, type Ref } from "vue";
import { reloadTick } from "../lib/bus";
import { useRoute, useRouter } from "vue-router";
import ConfirmSheet from "../components/ConfirmSheet.vue";
import ErrorNote from "../components/ErrorNote.vue";
import WriteGate from "../components/WriteGate.vue";
import { useFold } from "../lib/lists";
import {
  api,
  forceFreshWindow,
  GwError,
  previewPageDomainAdd,
  previewPageDomainDelete,
  previewPageEnv,
  writesOptIn,
  type PageEnvironment,
  type PageEnvVars,
  type WritePreview,
} from "../lib/api";
import { dt, rel, shortId } from "../lib/fmt";

const route = useRoute();
const nav = useRouter();
const name = computed(() => String(route.params.p ?? ""));

type Slot<T> = { data: T | null; err: GwError | null; loading: boolean };
const mk = <T,>(): Slot<T> => ({ data: null, err: null, loading: false });

const proj = ref<Slot<any>>(mk());
const deps = ref<Slot<any[]>>(mk());
const domains = ref<Slot<any[]>>(mk());

async function grab<T>(slot: Ref<Slot<T>>, fn: () => Promise<T>) {
  slot.value = { ...slot.value, loading: true, err: null };
  try {
    slot.value = { data: await fn(), err: null, loading: false };
  } catch (e) {
    slot.value = {
      data: slot.value.data,
      loading: false,
      err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)),
    };
  }
}

/** 三块分开抓：域名 403 不该把概览也弄成空白 */
async function loadAll() {
  const p = name.value;
  if (!p) return;
  await Promise.allSettled([
    grab(proj, () => api.pageProject(p).then((r) => r.result)),
    grab(deps, async () => {
      const r = await api.pageDeployments(p);
      const raw: any = r.result;
      return Array.isArray(raw) ? raw : (raw?.deployments ?? []);
    }),
    grab(domains, () => api.pageDomains(p).then((r) => r.result ?? [])),
    grab(zones, () => api.zones().then((r) => r.result ?? [])),
  ]);
  if (!domainZone.value && zones.value.data?.length) domainZone.value = String(zones.value.data[0].id);
  await nextTick();
  jump();
}

onMounted(loadAll);
watch(name, loadAll);

const visibleDeps = useFold(() => deps.value.data ?? []);

/* ---------- 展示口径 ---------- */
const pj = computed(() => proj.value.data ?? null);
const canonical = computed(() => pj.value?.canonical_deployment ?? null);
const latest = computed(() => pj.value?.latest_deployment ?? null);
const productionEnv = computed(() => pj.value?.deployment_configs?.production ?? null);
const previewEnv = computed(() => pj.value?.deployment_configs?.preview ?? null);

/** 当前线上部署 id：项目级 canonical_deployment 优先，缺了再退回 deployment_id */
const currentId = computed(() => String(canonical.value?.id ?? pj.value?.deployment_id ?? ""));

/** env_vars 在接口里是明文；这里只列键名、不给值，避免截图/投屏把密钥带出去 */
function envKeys(env: any): string[] {
  const v = env?.env_vars;
  return v && typeof v === "object" ? Object.keys(v).sort() : [];
}

const buildCfg = computed(() => {
  const b = pj.value?.build_config ?? {};
  const rows = [
    ["构建命令", b.build_command],
    ["输出目录", b.destination_dir],
    ["根目录", b.root_dir],
  ].filter(([, v]) => v);
  return rows.length ? rows : null;
});

const STATUS_MAP: Record<string, string> = {
  success: "成功",
  active: "进行中",
  idle: "空闲",
  failure: "失败",
  error: "失败",
  queued: "排队中",
  canceled: "已取消",
  skipped: "已跳过",
};
function statusText(v: unknown): string {
  const k = String(v ?? "");
  return STATUS_MAP[k] ?? (k || "—");
}
function statusOf(d: any): { text: string; cls?: string } {
  const st = d?.latest_stage;
  if (!st) return { text: "—" };
  const key = String(st.status ?? "");
  return {
    text: `${st.name ?? "stage"} · ${statusText(key)}`,
    cls: key === "success" ? "live" : key === "failure" || key === "error" ? "roll" : undefined,
  };
}
function isBad(d: any): boolean {
  const k = String(d?.latest_stage?.status ?? "");
  return k === "failure" || k === "error" || k === "canceled";
}

function triggerOf(d: any): string {
  const t = d?.deployment_trigger;
  if (!t) return "—";
  const md = t.metadata ?? {};
  if (t.type === "ad_hoc") return "直传（ad_hoc）" + (md.branch ? ` · ${md.branch}` : "");
  if (t.type === "github") return `GitHub · ${md.branch || "?"} · ${String(md.commit_hash || "").slice(0, 7)}`;
  return String(t.type);
}
function triggerMd(d: any): any {
  return d?.deployment_trigger?.metadata ?? {};
}
function envOf(d: any): string {
  return d?.environment === "production" ? "生产" : d?.environment === "preview" ? "预览" : String(d?.environment ?? "—");
}

function ts(v: unknown): number {
  const t = new Date(String(v ?? "")).getTime();
  return Number.isNaN(t) ? 0 : t;
}
/** 起止时间 → 人读耗时；缺一端就如实给 "—"，不拿当前时间凑 */
function durText(a: unknown, b: unknown): string {
  const start = ts(a);
  const end = ts(b);
  if (!start || !end || end < start) return "—";
  const s = Math.round((end - start) / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
function stagesOf(d: any): any[] {
  return Array.isArray(d?.stages) ? d.stages : [];
}

/** 部署历史汇总：只对接口确实给出的 latest_stage 计数 */
const depStats = computed(() => {
  const arr = deps.value.data ?? [];
  let prod = 0;
  let bad = 0;
  for (const d of arr) {
    if (d?.environment === "production") prod += 1;
    if (isBad(d)) bad += 1;
  }
  return {
    total: arr.length,
    prod,
    bad,
    last: arr[0]?.created_on ?? null,
  };
});

/* ---------- 作业区：锚点跳转（动作宫格进来时落到对应卡片） ---------- */
function jumpTo(c: string) {
  const el = document.getElementById("c-" + c);
  if (!el) return;
  el.scrollIntoView({ block: "start" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1400);
}
function jump() {
  const c = String(route.query.c || "");
  if (c) jumpTo(c);
}
/* 从计算页动作宫格进来时 q=c 在首次挂载就存在，watcher 不是 immediate —— 不主动跑一次就永远不滚 */
onMounted(() => nextTick(jump));
watch(() => route.query.c, jump);

/* ---------- 逐条展开部署详情 ---------- */
const openDep = ref("");
function toggleDep(d: any) {
  const id = String(d?.id ?? "");
  openDep.value = openDep.value === id ? "" : id;
  logFor.value = "";
}

/* ---------- 构建日志（按部署取；直传部署实测 data=[]） ---------- */
const logFor = ref("");
const logRows = ref<Array<{ ts?: string; line?: string }>>([]);
const logErr = ref<GwError | null>(null);
const logLoading = ref(false);

async function toggleLogs(d: any) {
  const id = String(d?.id ?? "");
  if (!id) return;
  if (logFor.value === id) {
    logFor.value = "";
    return;
  }
  logFor.value = id;
  logRows.value = [];
  logErr.value = null;
  logLoading.value = true;
  try {
    forceFreshWindow();
    const r = await api.pageBuildLogs(name.value, id);
    logRows.value = Array.isArray(r.result?.data) ? r.result!.data : [];
  } catch (e) {
    logErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    logLoading.value = false;
  }
}

/**
 * 部署详情里的「构建日志」按钮现在不再就地展开，而是跳到下面那张「构建日志」卡并顺手取这一次。
 * 原因（2026-10-25 联动修复）：顶部 chip「构建日志」跳到的那张卡原先只有一段说明文字 ——
 * 点了等于空跳转。现在那一张卡本身就是日志区：选部署、取日志、看得见结果。
 */
async function gotoLogs(d: any) {
  jumpTo("logs");
  if (logFor.value !== String(d?.id ?? "")) await toggleLogs(d);
}

/** 日志区可选的部署：最近 8 次（再多的没必要，日志是逐次看的） */
const logDeps = computed(() => ((deps.value?.data ?? []) as any[]).slice(0, 8));
const depLabel = (d: any) => `${shortId(String(d?.id ?? ""), 8)} · ${dt(d?.created_on)}`;

/* ---------- 写侧：回滚 / 重试（都归两道写闸门） ---------- */
/** 写开关状态只留给按钮 disabled 判断；读写与文案在 WriteGate 组件里 */
const optIn = ref(writesOptIn());

const preview = ref<WritePreview | null>(null);
type PendingAct =
  | { action: "rollback" | "retry"; id: string }
  | { action: "domainAdd"; name: string }
  | { action: "domainDelete"; name: string }
  | { action: "envPut"; environment: PageEnvironment; vars: PageEnvVars };
const pending = ref<PendingAct | null>(null);
/** 确认后真正要发的那一条写请求（闭包在 openSheet 里存） */
let runAct: (() => Promise<unknown>) | null = null;
const busy = ref(false);
const sheetErr = ref("");
const done = ref("");

function askRollback(d: any) {
  pending.value = { action: "rollback", id: String(d.id) };
  sheetErr.value = "";
  done.value = "";
  preview.value = {
    method: "POST",
    path: `/v1/pages/${encodeURIComponent(name.value)}/deployments/${encodeURIComponent(String(d.id))}/rollback`,
    body: undefined,
    title: `回滚「${name.value}」到 ${shortId(String(d.id), 8)}`,
    lines: [
      { k: "项目", v: name.value },
      { k: "目标部署", v: String(d.id) },
      { k: "目标环境", v: envOf(d) },
      { k: "部署时间", v: dt(d.created_on) },
      { k: "说明", v: "空请求体 POST；不会新建部署记录，只会把线上指向改到这个部署" },
    ],
    danger: "normal",
  };
}

function askRetry(d: any) {
  pending.value = { action: "retry", id: String(d.id) };
  sheetErr.value = "";
  done.value = "";
  preview.value = {
    method: "POST",
    path: `/v1/pages/${encodeURIComponent(name.value)}/deployments/${encodeURIComponent(String(d.id))}/retry`,
    body: undefined,
    title: `重试构建 ${shortId(String(d.id), 8)}`,
    lines: [
      { k: "项目", v: name.value },
      { k: "部署", v: String(d.id) },
      { k: "触发方式", v: triggerOf(d) },
      { k: "实测提醒", v: "直传部署会被 CF 拒（400 8000055），只有 git 构建能重试" },
    ],
    danger: "normal",
  };
}

function cancelSheet() {
  preview.value = null;
  pending.value = null;
  runAct = null;
  sheetErr.value = "";
}

/* ---------- 自定义域名增删（上游 2026-10-22 临时项目实测） ---------- */
/** 账号下的 zone 列表：域名后缀从这里选，用户只填前缀 */
const zones = ref<Slot<any[]>>(mk());
const domainZone = ref("");
const domainPrefix = ref("");
const domainErr = ref("");
const domainZoneName = computed(
  () => String((zones.value.data ?? []).find((z: any) => String(z.id) === domainZone.value)?.name ?? ""),
);
/** 只填前缀，后缀由所选 zone 补上；整段域名直接粘进来时不再重复拼 */
const domainFull = computed(() => {
  const p = domainPrefix.value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!p) return "";
  const z = domainZoneName.value.toLowerCase();
  if (z && (p === z || p.endsWith(`.${z}`))) return p;
  return z ? `${p}.${z}` : p;
});

function askAddDomain() {
  domainErr.value = "";
  done.value = "";
  const h = domainFull.value;
  if (!domainPrefix.value.trim()) { domainErr.value = "先填前缀（例如 www，会自动拼成 www.所选域名）"; return; }
  if (!domainZone.value) { domainErr.value = "先选一个域名（zone）"; return; }
  try {
    openSheet(previewPageDomainAdd(name.value, h), () => api.pageAddDomain(name.value, h.toLowerCase().replace(/\.+$/, "")));
    pending.value = { action: "domainAdd", name: h.toLowerCase().replace(/\.+$/, "") };
  } catch (e) {
    domainErr.value = e instanceof GwError ? e.message : String((e as Error)?.message || e);
  }
}

function askDeleteDomain(d: any) {
  domainErr.value = "";
  done.value = "";
  const n = String(d?.name ?? d?.domain ?? "");
  if (!n) { domainErr.value = "这条域名没有 name，不发删除请求"; return; }
  try {
    openSheet(previewPageDomainDelete(name.value, d), () => api.pageDeleteDomain(name.value, n));
    pending.value = { action: "domainDelete", name: n };
  } catch (e) {
    domainErr.value = e instanceof GwError ? e.message : String((e as Error)?.message || e);
  }
}

/* ---------- 环境变量编辑：整表覆盖，删除 = 不传这个键 ---------- */
type EnvRow = { key: string; value: string; type: "plain_text" | "secret_text" };
const envEdit = ref<{ environment: PageEnvironment; rows: EnvRow[] } | null>(null);
const envErr = ref("");
const envAdd = ref<{ key: string; value: string; type: "plain_text" | "secret_text" }>({ key: "", value: "", type: "plain_text" });

function envVarsOf(environment: PageEnvironment): Record<string, any> {
  const conf = pj.value?.deployment_configs?.[environment];
  const v = conf?.env_vars;
  return v && typeof v === "object" ? v : {};
}

function openEnv(environment: PageEnvironment) {
  envErr.value = "";
  done.value = "";
  const src = envVarsOf(environment);
  envEdit.value = {
    environment,
    rows: Object.keys(src).sort().map((k) => ({
      key: k,
      value: String(src[k]?.value ?? ""),
      type: src[k]?.type === "secret_text" ? "secret_text" : "plain_text",
    })),
  };
  envAdd.value = { key: "", value: "", type: "plain_text" };
}

function addEnvRow() {
  envErr.value = "";
  if (!envEdit.value) return;
  const k = envAdd.value.key.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { envErr.value = "变量名要用字母或下划线开头、只含字母数字下划线"; return; }
  if (envEdit.value.rows.some((r) => r.key === k)) { envErr.value = `变量 ${k} 已经在了`; return; }
  envEdit.value.rows.push({ key: k, value: envAdd.value.value, type: envAdd.value.type });
  envAdd.value = { key: "", value: "", type: "plain_text" };
}

function removeEnvRow(i: number) { envEdit.value?.rows.splice(i, 1); }

/** 变更摘要：新增/删除/改值，逐个点名；空串 = 没有实际差异 */
function envSummary(environment: PageEnvironment, rows: EnvRow[]): string {
  const before = envVarsOf(environment);
  const after = new Map(rows.map((r) => [r.key, r.value]));
  const added = rows.filter((r) => !(r.key in before)).map((r) => r.key);
  const removed = Object.keys(before).filter((k) => !after.has(k));
  const changed = rows.filter((r) => k_has(before, r.key) && String(before[r.key]?.value ?? "") !== r.value).map((r) => r.key);
  const parts = [
    added.length ? `新增 ${added.join("、")}` : "",
    removed.length ? `删除 ${removed.join("、")}` : "",
    changed.length ? `改值 ${changed.join("、")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("；") : "没有实际差异（整表原样重写）";
}
function k_has(o: Record<string, any>, k: string): boolean { return Object.prototype.hasOwnProperty.call(o, k); }

function askSaveEnv() {
  if (!envEdit.value) return;
  envErr.value = "";
  const { environment, rows } = envEdit.value;
  const vars: PageEnvVars = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { envErr.value = `变量名不合法：${k || "空"}`; return; }
    vars[k] = { value: r.value, type: r.type };
  }
  try {
    const pv = previewPageEnv(name.value, environment, vars, envSummary(environment, rows));
    openSheet(pv, () => api.pageEnvPut(name.value, environment, vars));
    pending.value = { action: "envPut", environment, vars };
  } catch (e) {
    envErr.value = e instanceof GwError ? e.message : String((e as Error)?.message || e);
  }
}

function openSheet(p: WritePreview, run: () => Promise<unknown>) {
  runAct = run;
  preview.value = p;
  sheetErr.value = "";
}

async function confirmAct() {
  if (!pending.value || busy.value) return;
  busy.value = true;
  sheetErr.value = "";
  const act = pending.value;
  try {
    if (!runAct) throw new GwError("unknown", 0, null, "没有待发送的写请求");
    await runAct();
    if (act.action === "rollback") done.value = `已回滚到 ${shortId(act.id, 8)}`;
    else if (act.action === "retry") done.value = `已请求重试 ${shortId(act.id, 8)}`;
    else if (act.action === "domainAdd") { done.value = `已添加域名 ${act.name}`; domainPrefix.value = ""; }
    else if (act.action === "domainDelete") done.value = `已移除域名 ${act.name}`;
    else if (act.action === "envPut") done.value = `已更新${act.environment === "production" ? "生产" : "预览"}环境变量（${Object.keys(act.vars).length} 个）`;
    preview.value = null;
    pending.value = null;
    runAct = null;
    if (act.action === "envPut") envEdit.value = null;
    forceFreshWindow();
    await loadAll();
  } catch (e) {
    sheetErr.value = e instanceof GwError ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/** 顶栏「刷新当前屏」（lib/bus）：各屏不再自备右上角刷新键 */
watch(reloadTick, () => { void refresh(); });
function refresh() {
  forceFreshWindow();
  loadAll();
}
</script>

<template>
  <div>
    <div class="row" style="justify-content: space-between; margin-bottom: 10px">
      <div class="row" style="gap: 8px; min-width: 0">
        <button class="ghost" type="button" @click="nav.push('/compute')">← 计算</button>
        <h2 style="margin: 0; font-size: 17px; overflow: hidden; text-overflow: ellipsis">{{ name }}</h2>
      </div>
    </div>

    <div class="row" style="gap: 6px; flex-wrap: wrap; margin-bottom: 10px">
      <button class="chip" type="button" @click="jumpTo('overview')">概览</button>
      <button class="chip" type="button" @click="jumpTo('deps')">部署历史 / 回滚</button>
      <button class="chip" type="button" @click="jumpTo('domains')">自定义域名</button>
      <button class="chip" type="button" @click="jumpTo('env')">环境变量</button>
      <button class="chip" type="button" @click="jumpTo('logs')">构建日志</button>
    </div>

    <div class="card" id="c-overview">
      <h3>概览</h3>
      <ErrorNote :err="proj.err" />
      <template v-if="pj">
        <div class="kv">
          <dt>项目名</dt><dd>{{ pj.name }}</dd>
          <dt>线上地址</dt>
          <dd>
            <a v-if="pj.subdomain" :href="'https://' + pj.subdomain" target="_blank" rel="noreferrer">{{ pj.subdomain }}</a>
            <span v-else class="muted">—</span>
          </dd>
          <dt>生产分支</dt><dd>{{ pj.production_branch || "—" }}</dd>
          <dt>框架</dt><dd>{{ pj.framework || "未识别" }}<span v-if="pj.framework_version" class="muted small"> · {{ pj.framework_version }}</span></dd>
          <dt>Functions</dt><dd>{{ pj.uses_functions ? "已启用" : "未启用" }}</dd>
          <dt>创建时间</dt><dd>{{ dt(pj.created_on) }}</dd>
          <dt>项目 ID</dt><dd class="small mono" style="word-break: break-all">{{ pj.id }}</dd>
          <dt>部署总数</dt><dd>{{ depStats.total }} 次<span class="muted small"> · 生产 {{ depStats.prod }} 次</span></dd>
          <dt>最近部署</dt><dd>{{ depStats.last ? dt(depStats.last) : "—" }}<span v-if="depStats.last" class="muted small"> · {{ rel(depStats.last) }}</span></dd>
          <dt>失败部署</dt>
          <dd>
            <span v-if="depStats.bad" class="badge roll">{{ depStats.bad }} 次</span>
            <span v-else class="muted">0 次</span>
            <span class="muted small"> · 按 latest_stage.status 统计</span>
          </dd>
        </div>

        <div class="kv" style="margin-top: 10px">
          <dt>线上部署</dt>
          <dd v-if="canonical">
            <span class="badge live">当前</span>
            <span class="mono"> {{ shortId(String(canonical.id), 8) }}</span>
            <span class="muted"> · {{ dt(canonical.created_on) }} · {{ envOf(canonical) }}</span>
            <div class="small muted">{{ triggerOf(canonical) }} · {{ statusText(canonical.latest_stage?.status) }}</div>
            <div class="small" v-if="canonical.url">
              <a :href="canonical.url" target="_blank" rel="noreferrer">{{ canonical.url }}</a>
            </div>
          </dd>
          <dd v-else-if="!proj.loading" class="muted">还没有线上部署。</dd>
          <dt>最近构建</dt>
          <dd v-if="latest">
            <span class="mono">{{ shortId(String(latest.id), 8) }}</span>
            <span class="muted"> · {{ dt(latest.created_on) }} · {{ envOf(latest) }}</span>
            <div class="small muted">{{ triggerOf(latest) }} · {{ statusOf(latest).text }}</div>
          </dd>
          <dd v-else class="muted">—</dd>
        </div>
      </template>
      <div v-else-if="!proj.loading && !proj.err" class="empty">没有取到项目详情</div>
    </div>

    <div class="card" id="c-deps">
      <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 10px">
        <h3 style="margin: 0">部署历史（{{ deps.data?.length ?? 0 }} 条）</h3>
        <WriteGate v-model="optIn" variant="inline" />
      </div>
      <div class="small muted" style="margin: 6px 0 8px">
        点部署行展开完整信息；回滚与重试都要过两道闸门：这台设备的写开关（上面）→ 网关的 WRITE_ENABLED。开关关着时请求不会发出。
      </div>
      <div v-if="done" class="small" style="margin-bottom: 8px; color: var(--ok)">{{ done }}</div>
      <ErrorNote :err="deps.err" />

      <div class="list" v-if="visibleDeps.shown.length">
        <div v-for="d in visibleDeps.shown" :key="d.id" class="item-wrap">
          <div class="item tap" @click="toggleDep(d)">
            <div style="min-width: 0">
              <div class="k">
                {{ shortId(String(d.id), 8) }}
                <span class="badge" :class="statusOf(d).cls">{{ statusOf(d).text }}</span>
                <span class="badge" v-if="String(d.id) === currentId">线上</span>
                <span class="badge" v-if="d.environment === 'production'">生产</span>
                <span class="badge" v-if="d.is_skipped">已跳过</span>
              </div>
              <div class="small muted">
                {{ dt(d.created_on) }} · {{ triggerOf(d) }}
                <span v-if="stagesOf(d).length"> · {{ stagesOf(d).length }} 个阶段</span>
              </div>
              <div class="small muted" v-if="d.url">
                <a :href="d.url" target="_blank" rel="noreferrer" @click.stop>{{ d.url }}</a>
              </div>
            </div>
            <div class="v small muted" style="display: flex; gap: 6px; align-items: center; white-space: nowrap">
              <button
                v-if="String(d.id) !== currentId"
                class="ghost sm"
                type="button"
                :disabled="!optIn || busy"
                @click.stop="askRollback(d)"
              >回滚到此</button>
              <span>{{ openDep === d.id ? "收起" : "详情" }}</span>
            </div>
          </div>

          <div v-if="openDep === d.id" class="depdetail">
            <div class="kv small">
              <dt>部署 ID</dt><dd class="mono" style="word-break: break-all">{{ d.id }}</dd>
              <dt>环境</dt><dd>{{ envOf(d) }}</dd>
              <dt>创建时间</dt><dd>{{ dt(d.created_on) }}<span class="muted"> · {{ rel(d.created_on) }}</span></dd>
              <dt>修改时间</dt><dd>{{ dt(d.modified_on) }}</dd>
              <dt>触发方式</dt><dd>{{ triggerOf(d) }}</dd>
              <dt v-if="triggerMd(d).branch">分支</dt><dd v-if="triggerMd(d).branch">{{ triggerMd(d).branch }}</dd>
              <dt v-if="triggerMd(d).commit_hash">提交</dt>
              <dd v-if="triggerMd(d).commit_hash" class="mono">{{ String(triggerMd(d).commit_hash).slice(0, 12) }}</dd>
              <dt>最新阶段</dt>
              <dd>
                {{ d.latest_stage?.name ?? "—" }} · {{ statusText(d.latest_stage?.status) }}
                <span class="muted">（{{ durText(d.latest_stage?.started_on, d.latest_stage?.ended_on) }}）</span>
              </dd>
              <dt>是否跳过</dt><dd>{{ d.is_skipped ? "是" : "否" }}</dd>
              <dt v-if="d.url">访问地址</dt>
              <dd v-if="d.url"><a :href="d.url" target="_blank" rel="noreferrer">{{ d.url }}</a></dd>
              <dt v-if="Array.isArray(d.aliases) && d.aliases.length">别名</dt>
              <dd v-if="Array.isArray(d.aliases) && d.aliases.length">{{ d.aliases.join("、") }}</dd>
            </div>

            <div v-if="stagesOf(d).length" class="stages">
              <div class="sec-h">构建阶段</div>
              <div v-for="(s, i) in stagesOf(d)" :key="i" class="stage">
                <span class="dotc" :class="{ ok: s.status === 'success', bad: s.status === 'failure' || s.status === 'error' }"></span>
                <span class="stage-n">{{ s.name || ("阶段 " + (i + 1)) }}</span>
                <span class="badge" :class="{ live: s.status === 'success', roll: s.status === 'failure' || s.status === 'error' }">{{ statusText(s.status) }}</span>
                <span class="small muted">{{ durText(s.started_on, s.ended_on) }}</span>
              </div>
            </div>

            <div class="row" style="gap: 6px; flex-wrap: wrap; margin-top: 10px">
              <button
                class="ghost"
                type="button"
                :disabled="!optIn || busy || d.deployment_trigger?.type === 'ad_hoc'"
                :title="d.deployment_trigger?.type === 'ad_hoc' ? '直传部署不能重试（实测 400 8000055）' : ''"
                @click.stop="askRetry(d)"
              >重试构建</button>
              <button class="ghost" type="button" @click.stop="gotoLogs(d)">
                构建日志
              </button>
            </div>
          </div>
        </div>
      </div>
      <div v-else-if="!deps.err" class="empty">{{ deps.loading ? "加载中" : "没有部署记录" }}</div>
      <button class="ghost" type="button" v-if="visibleDeps.rest" @click="visibleDeps.open = !visibleDeps.open">
        {{ visibleDeps.label }}
      </button>
    </div>

    <div class="card" id="c-domains">
      <h3>自定义域名（{{ domains.data?.length ?? 0 }} 个）</h3>
      <ErrorNote :err="domains.err || zones.err" />
      <div class="row gen" style="margin: 8px 0">
        <select v-model="domainZone" class="field sel" :disabled="!zones.data?.length">
          <option v-if="!zones.data?.length" value="">没有可见 zone</option>
          <option v-for="z in zones.data || []" :key="z.id" :value="String(z.id)">{{ z.name }}</option>
        </select>
        <div style="display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0">
          <input
            v-model="domainPrefix"
            class="field"
            style="flex: 1; min-width: 0"
            placeholder="只填前缀，例：www"
            spellcheck="false"
            autocomplete="off"
          />
          <span class="small muted" style="white-space: nowrap">{{ domainZoneName ? "." + domainZoneName : "" }}</span>
        </div>
        <button class="chip" type="button" :disabled="!optIn || busy" @click="askAddDomain">添加域名</button>
      </div>
      <p class="small muted" style="margin: 0 0 8px">最终域名：<code>{{ domainFull || "—" }}</code></p>
      <p class="small errtext" v-if="domainErr">{{ domainErr }}</p>
      <div class="list" v-if="domains.data?.length">
        <div v-for="(d, i) in domains.data" :key="i" class="item">
          <div style="min-width: 0">
            <div class="k">{{ d.name || d.domain || d.id || "—" }}</div>
            <div class="small muted">
              <span v-if="d.created_on">绑定于 {{ dt(d.created_on) }}</span>
              <span v-else>pages.dev 子域不在这份列表里，它始终可用</span>
            </div>
          </div>
          <div class="v small">
            <span v-if="d.status" class="badge" :class="{ live: d.status === 'active' }">{{ d.status === "active" ? "已生效" : statusText(d.status) }}</span>
            <button
              class="ghost sm danger"
              type="button"
              :disabled="!optIn || busy || !(d.name || d.domain)"
              @click.stop="askDeleteDomain(d)"
            >移除</button>
          </div>
        </div>
      </div>
      <div v-else-if="!domains.err" class="empty">
        {{ domains.loading ? "加载中" : "没有自定义域名。临时项目实测：空项目这里返回 []。" }}
      </div>
      <div class="small muted" style="margin-top: 8px">
        增删都要先打开「部署历史」卡片上的本机写开关；发出前 ConfirmSheet 会回显要发的请求，删除还要手打域名。
        上游形状 2026-10-22 在临时项目上实测（建后即删，无残留）。
      </div>
    </div>

    <div class="card" id="c-env">
      <h3>环境变量与构建配置</h3>
      <template v-if="pj">
        <div class="kv">
          <dt>生产环境变量</dt><dd>{{ envKeys(productionEnv).length ? envKeys(productionEnv).length + " 个：" + envKeys(productionEnv).join("、") : "无" }}</dd>
          <dt>预览环境变量</dt><dd>{{ envKeys(previewEnv).length ? envKeys(previewEnv).length + " 个：" + envKeys(previewEnv).join("、") : "无" }}</dd>
          <dt>兼容日期</dt><dd>{{ productionEnv?.compatibility_date || "—" }}</dd>
          <dt>兼容标志</dt><dd>{{ (productionEnv?.compatibility_flags ?? []).join("、") || "无" }}</dd>
          <dt v-if="productionEnv?.always_use_latest_compatibility_date !== undefined">始终最新兼容日期</dt>
          <dd v-if="productionEnv?.always_use_latest_compatibility_date !== undefined">
            {{ productionEnv.always_use_latest_compatibility_date ? "是" : "否" }}
          </dd>
          <dt v-if="productionEnv?.fail_open !== undefined">失败放行</dt>
          <dd v-if="productionEnv?.fail_open !== undefined">{{ productionEnv.fail_open ? "开" : "关" }}</dd>
          <dt>构建配置</dt><dd>{{ buildCfg ? "已配置" : "空（直传项目本来就没有构建步骤）" }}</dd>
        </div>
        <div class="row" style="gap: 6px; margin-top: 10px; flex-wrap: wrap">
          <button class="ghost sm" type="button" :disabled="!optIn || busy" @click="openEnv('production')">编辑生产变量</button>
          <button class="ghost sm" type="button" :disabled="!optIn || busy" @click="openEnv('preview')">编辑预览变量</button>
        </div>

        <div v-if="envEdit" class="editbox">
          <div class="row" style="justify-content: space-between; align-items: center">
            <b class="small">{{ envEdit.environment === "production" ? "生产" : "预览" }}环境变量（{{ envEdit.rows.length }} 个）</b>
            <div class="row" style="gap: 6px">
              <button class="ghost sm" type="button" :disabled="busy" @click="envEdit = null">取消</button>
              <button class="ghost sm" type="button" :disabled="busy" @click="askSaveEnv">保存并确认</button>
            </div>
          </div>
          <div v-if="!envEdit.rows.length" class="empty">这份清单现在是空的——保存后这个环境将没有任何变量</div>
          <div v-for="(r, i) in envEdit.rows" :key="r.key" class="vrow">
            <div class="row" style="gap: 6px; justify-content: space-between">
              <span class="k mono">{{ r.key }}</span>
              <span class="row" style="gap: 6px">
                <select v-model="r.type" class="field sel">
                  <option value="plain_text">plain_text</option>
                  <option value="secret_text">secret_text</option>
                </select>
                <button class="ghost sm danger" type="button" @click="removeEnvRow(i)">移除</button>
              </span>
            </div>
            <input v-model="r.value" class="field" :type="r.type === 'secret_text' ? 'password' : 'text'" spellcheck="false" autocomplete="off" />
          </div>
          <div class="row gen" style="margin-top: 8px">
            <input v-model="envAdd.key" class="field" placeholder="新变量名" spellcheck="false" autocomplete="off" />
            <input v-model="envAdd.value" class="field" :type="envAdd.type === 'secret_text' ? 'password' : 'text'" placeholder="值" spellcheck="false" autocomplete="off" />
            <select v-model="envAdd.type" class="field sel">
              <option value="plain_text">plain_text</option>
              <option value="secret_text">secret_text</option>
            </select>
            <button class="chip" type="button" @click="addEnvRow">添加</button>
          </div>
          <p class="small errtext" v-if="envErr">{{ envErr }}</p>
          <p class="small muted">
            保存是**整表覆盖**：不在表里的键会被删除（删除只能靠「不传这个键」，传 null 实测只是把值置空）。
            值从接口回显，secret_text 用密码框显示。
          </p>
        </div>
        <div class="small muted" style="margin-top: 8px" v-else>
          只列键名，不展示值：接口虽然回明文，但这一屏经常被截图/投屏。点上面的按钮才进编辑态。
        </div>
        <div class="list" v-if="buildCfg" style="margin-top: 10px">
          <div v-for="[k, v] in buildCfg" :key="String(k)" class="item">
            <div class="k">{{ k }}</div>
            <div class="v small mono">{{ v }}</div>
          </div>
        </div>
      </template>
    </div>

    <!-- 构建日志区（2026-10-25：原来这张卡只有一段说明文字，顶部 chip 跳过来等于空跳转。
         现在它就是日志区：选一次部署 → 取日志 → 结果就地显示。） -->
    <div class="card" id="c-logs">
      <h3>构建日志</h3>
      <div class="small muted">
        选一次部署取它的构建日志：<code>GET …/deployments/{id}/history/logs</code>，返回的 data 行原样上屏。
        直传（ad_hoc）部署实测 data=[]（没有日志行），所以那里会如实显示「这次没有返回日志」，
        不拿部署对象冒充日志。
      </div>

      <div class="row" style="margin-top: 8px; gap: 6px; flex-wrap: wrap" v-if="logDeps.length">
        <button
          v-for="d in logDeps" :key="d.id" class="chip" :class="{ on: logFor === d.id }"
          :disabled="logLoading" @click="toggleLogs(d)"
        >{{ depLabel(d) }}</button>
      </div>

      <div v-if="logFor" style="margin-top: 8px">
        <div v-if="logLoading" class="small muted">构建日志加载中…</div>
        <ErrorNote v-else-if="logErr" :err="logErr" />
        <div v-else-if="logRows.length" class="logbox mono">
          <div v-for="(l, i) in logRows" :key="i">{{ l.ts ? `[${l.ts}] ` : "" }}{{ l.line }}</div>
        </div>
        <div v-else class="small muted">
          这次部署没有返回构建日志行。直传（ad_hoc）部署实测 data=[]；git 构建的日志要等上游返回。
        </div>
      </div>
      <div v-else-if="!logDeps.length" class="empty">这个项目还没有部署记录，没有日志可取。</div>
    </div>
  </div>

  <ConfirmSheet :preview="preview" :busy="busy" :error="sheetErr" @confirm="confirmAct" @cancel="cancelSheet" />
</template>

<style scoped>
.kv a { color: var(--accent); text-decoration: none; }
.kv a:hover { text-decoration: underline; }
.mono { font-family: var(--font-num); }
.item-wrap { border-bottom: 1px solid var(--line); }
.item-wrap:last-child { border-bottom: none; }
.depdetail { padding: 4px 13px 14px; }
.stages { margin-top: 10px; display: flex; flex-direction: column; gap: 1px; background: var(--line); border-radius: 8px; overflow: hidden; }
.sec-h { font-size: 12px; color: var(--muted); font-weight: 600; padding: 8px 10px 4px; }
.stage { background: var(--panel); padding: 8px 10px; display: flex; align-items: center; gap: 8px; }
.stage-n { flex: 1; font-size: 13px; }
.dotc { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
.dotc.ok { background: var(--ok); }
.dotc.bad { background: var(--bad); }
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
button.sm { padding: 4px 10px; font-size: 12px; }
button.danger { color: var(--bad); border-color: rgb(var(--bad-rgb) / .45); }
.errtext { color: var(--bad); }
.editbox { padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel-2); display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.vrow { display: flex; flex-direction: column; gap: 4px; padding-bottom: 6px; border-bottom: 1px dashed var(--line); }
.gen { flex-wrap: wrap; gap: 6px; }
.gen .field { max-width: 200px; }
.sel { width: auto; }
</style>
