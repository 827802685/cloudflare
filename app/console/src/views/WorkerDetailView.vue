<script setup lang="ts">
import { computed, onMounted, ref, watch, type Ref } from "vue";
import { useRoute } from "vue-router";
import ConfirmSheet from "../components/ConfirmSheet.vue";
import ErrorNote from "../components/ErrorNote.vue";
import FoldNote from "../components/FoldNote.vue";
import CronPanel from "../components/ver/CronPanel.vue";
import VarsPanel from "../components/ver/VarsPanel.vue";
import BindingsPanel from "../components/ver/BindingsPanel.vue";
import VersionDialog from "../components/ver/VersionDialog.vue";
import { useFold } from "../lib/lists";
import {
  api,
  forceFreshWindow,
  GwError,
  previewWorkerDomainAttach,
  previewWorkerDomainDetach,
  previewWorkerSubdomain,
  setWritesOptIn,
  writesOptIn,
  type WritePreview,
} from "../lib/api";
import { dt, num, rel, shortId } from "../lib/fmt";

const route = useRoute();
const name = computed(() => String(route.params.s ?? ""));

type Slot<T> = { data: T | null; err: GwError | null; loading: boolean };
const mk = <T,>(): Slot<T> => ({ data: null, err: null, loading: false });
const versions = ref<Slot<any[]>>(mk());
const deployments = ref<Slot<any[]>>(mk());
const settings = ref<Slot<any>>(mk());
/** 与 settings 是两条不同 CF 路由：observability 只有这条返回（docs/08 §6.1） */
const scriptSettings = ref<Slot<any>>(mk());
/** 脚本级 workers.dev 开关 */
const subdomain = ref<Slot<any>>(mk());
const secrets = ref<Slot<any[]>>(mk());
const crons = ref<Slot<any[]>>(mk());
/** 自定义域名（全部 Worker，过滤出本脚本）与可选 zone（绑定时要 zone_id 归属） */
const domains = ref<Slot<any[]>>(mk());
const zones = ref<Slot<any[]>>(mk());
/** 绑定表单：目标 zone + 前缀（zone_id 必须属于本账号，上游按它校验归属） */
const domPrefix = ref("");
const domZone = ref("");
const domErr = ref("");

/** 版本分页：CF 这个列表**给** total（`result_info.total_count`，网关透传为 `total`），以它为准；
 *  total 缺失时才退回"拿不满一页就当到底了"。 */
const PER_PAGE = 25;
const vPage = ref(0);
const vTotal = ref<number | null>(null);
const vExhausted = ref(false);
const vMoreLoading = ref(false);
/** 版本列表折叠：条数读全局偏好（设置页那条旋钮），点"展开更多"才全显 */
const visibleVersions = useFold(() => versions.value.data ?? []);
/** 部署历史同理 —— 以前这里写死 slice(0, 12)，多看几条只能改代码 */
const visibleDeps = useFold(() => deployments.value.data ?? []);

/** 流量归属：hostname → service（docs/01 §5 的替代方案，因为 Worker 级用量接口全不可用，docs/09 §D4） */
const traffic = ref<Slot<{ rows: Array<{ host: string; reqs: number; mine: boolean; via: string }>; myHosts: Array<{ host: string; via: string }> }>>(mk());
const TRAFFIC_RANGE = "7d";

async function grab<T>(slot: Ref<Slot<T>>, fn: () => Promise<T>) {
  slot.value = { ...slot.value, loading: true, err: null };
  try {
    const d = await fn();
    slot.value = { data: d, err: null, loading: false };
  } catch (e) {
    slot.value = { data: slot.value.data, err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)), loading: false };
  }
}

/** 八块分别抓：任何一块 403/404 都不会让整页白屏（这是网关 overview 用 allSettled 的同一套思路） */
async function loadAll() {
  const s = name.value;
  vPage.value = 1;
  vExhausted.value = false;
  await Promise.allSettled([
    grab(versions, async () => {
      const r = await api.workerVersions(s, 1, PER_PAGE);
      // 实测：这个列表**有** `result_info.total_count`（rin-server = 148），网关把它透传成 `total`。
      // 之前我误判成"CF 不给 total"，只靠"不满一页=到底"，所以这里以 total 为准、短页只兜底。
      vTotal.value = typeof r.total === "number" && r.total > 0 ? r.total : null;
      const items = r.result ?? [];
      vExhausted.value = vTotal.value != null ? items.length >= vTotal.value : items.length < PER_PAGE;
      return items;
    }),
    loadTraffic(),
    grab(deployments, async () => {
      const r = await api.workerDeployments(s);
      const raw: any = r.result;
      return Array.isArray(raw) ? raw : (raw?.deployments ?? []);
    }),
    grab(settings, () => api.workerSettings(s).then((r) => r.result)),
    grab(scriptSettings, () => api.workerScriptSettings(s).then((r) => r.result)),
    grab(subdomain, () => api.workerSubdomain(s).then((r) => r.result)),
    grab(secrets, async () => {
      const r = await api.workerSecrets(s);
      return Array.isArray(r.result) ? r.result : (r.result?.secrets ?? []);
    }),
    grab(crons, async () => {
      const r = await api.workerCrons(s);
      const raw: any = r.result;
      return Array.isArray(raw) ? raw : (raw?.schedules ?? []);
    }),
    grab(domains, async () => {
      const r = await api.domains();
      return Array.isArray(r.result) ? r.result : [];
    }),
    grab(zones, async () => {
      const r = await api.zones();
      return Array.isArray(r.result) ? r.result : [];
    }),
  ]);
  if (!domZone.value && zones.value.data?.length) domZone.value = String(zones.value.data[0].id);
}
onMounted(loadAll);

/** 「刷新」= 这 8 块全部绕过缓存重来；平时切进切出走缓存，不再重复打 CF */
function refresh() { forceFreshWindow(); loadAll(); }

/** 列表页动作宫格跳进来时带 ?c=versions，滚到那张卡并闪一下。竞品用的是弹窗，我们是长页，锚点少一层状态 */
function jump() {
  const c = String(route.query.c || "");
  if (!c) return;
  const el = document.getElementById("c-" + c);
  if (!el) return;
  el.scrollIntoView({ block: "start" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1400);
}
onMounted(jump);
watch(() => route.query.c, jump);

async function loadMoreVersions() {
  if (vMoreLoading.value || vExhausted.value) return;
  vMoreLoading.value = true;
  try {
    const r = await api.workerVersions(name.value, vPage.value + 1, PER_PAGE);
    const got: any[] = r.result ?? [];
    if (got.length) {
      vPage.value += 1;
      const seen = new Set((versions.value.data ?? []).map((v: any) => v.id));
      versions.value = { data: [...(versions.value.data ?? []), ...got.filter((v) => !seen.has(v.id))], err: null, loading: false };
    }
    if (got.length < PER_PAGE) vExhausted.value = true;
    if (vTotal.value != null && (versions.value.data?.length ?? 0) >= vTotal.value) vExhausted.value = true;
  } catch (e) {
    versions.value = { ...versions.value, err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)) };
    vExhausted.value = true;
  } finally {
    vMoreLoading.value = false;
  }
}

/**
 * 这个 Worker 被访问了多少 —— CF 没有 Worker 级用量接口，所以按"哪些主机名落到本 Worker"归属：
 *   1) 自定义域名：/v1/domains 里 service === 本 Worker 的 hostname
 *   2) Zone 路由：/v1/zones/:z/routes 里 script === 本 Worker 的 pattern（blog.acct.example.com 这类就走这条路）
 * 再拿 /v1/traffic/top?dim=host（Analytics SQL 采样、Top 20）对号。只走已有白名单路由，不新增任何 CF 面。
 */
async function loadTraffic() {
  traffic.value = { data: traffic.value.data, err: null, loading: true };
  try {
    const [dm, tp, zs] = await Promise.all([api.domains(), api.top(TRAFFIC_RANGE, "host"), api.zones()]);
    const myHosts = new Map<string, string>();
    for (const d of (dm.result ?? []) as any[]) {
      if (d.service === name.value && d.hostname) myHosts.set(String(d.hostname).toLowerCase(), "自定义域名");
    }
    // 只有一个 zone 时直接取第一个；多站点要用户在顶部选择（这版账号里就 1 个站点）
    const zoneId = (zs.result ?? [])[0]?.id;
    if (zoneId) {
      const rt = await api.zoneRoutes(zoneId);
      for (const r of (rt.result ?? []) as any[]) {
        if (r.script !== name.value || !r.pattern) continue;
        // pattern 实测形如 `*blog.acct.example.com/*`（星号后没有点）或 `*.example.com/*`，两种前缀都要剥掉
        const host = String(r.pattern).split("/")[0].replace(/^\*\.?/, "").toLowerCase();
        if (host) myHosts.set(host, "Zone 路由");
      }
    }
    const set = new Set(myHosts.keys());
    const rows = ((tp.rows ?? []) as any[]).map((r) => ({
      host: String(r.k),
      reqs: Number(r.reqs || 0),
      mine: set.has(String(r.k).toLowerCase()),
      via: myHosts.get(String(r.k).toLowerCase()) || "",
    }));
    traffic.value = {
      data: { rows, myHosts: [...myHosts.entries()].map(([h, via]) => ({ host: h, via })) },
      err: null,
      loading: false,
    };
  } catch (e) {
    traffic.value = { data: null, err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)), loading: false };
  }
}

const myTraffic = computed(() => (traffic.value.data?.rows ?? []).filter((r) => r.mine));
const myTotalReqs = computed(() => myTraffic.value.reduce((s, r) => s + r.reqs, 0));
const missingHosts = computed(() =>
  (traffic.value.data?.myHosts ?? []).filter((m) => !traffic.value.data?.rows.some((r) => r.host.toLowerCase() === m.host)),
);

/* ---------- 写侧：自定义域名绑定 / 解绑，脚本级 workers.dev 开关 ---------- */
const myDomains = computed(() => (domains.value.data ?? []).filter((d: any) => String(d.service) === name.value));
const domZoneName = computed(() => String((zones.value.data ?? []).find((z: any) => String(z.id) === domZone.value)?.name ?? ""));
/**
 * 只填前缀、zone 从账号里选 —— 后缀由所选 zone 自动补上。
 * 也兼容直接把整段域名粘进来：已经以当前 zone 结尾就不再重复拼一次。
 */
const domFull = computed(() => {
  const p = domPrefix.value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!p) return "";
  const z = domZoneName.value.toLowerCase();
  if (z && (p === z || p.endsWith(`.${z}`))) return p;
  return z ? `${p}.${z}` : p;
});

const optIn = ref(writesOptIn());
function toggleOptIn(v: boolean) {
  setWritesOptIn(v);
  optIn.value = writesOptIn();
}

const preview = ref<WritePreview | null>(null);
const busy = ref(false);
const sheetErr = ref("");
const doneMsg = ref("");
let pendingRun: (() => Promise<unknown>) | null = null;
let pendingMsg = "";

function openSheet(p: WritePreview, run: () => Promise<unknown>, msg: string) {
  preview.value = p;
  pendingRun = run;
  pendingMsg = msg;
  sheetErr.value = "";
  doneMsg.value = "";
}
function cancelSheet() {
  preview.value = null;
  pendingRun = null;
  sheetErr.value = "";
}
async function confirmWrite() {
  if (!pendingRun || busy.value) return;
  busy.value = true;
  sheetErr.value = "";
  try {
    await pendingRun();
    preview.value = null;
    pendingRun = null;
    doneMsg.value = pendingMsg;
    refresh();
  } catch (e) {
    const err = e instanceof GwError ? e : new GwError("unknown", 0, null, String((e as Error)?.message || e));
    sheetErr.value = `[${err.kind} · HTTP ${err.http}] ${err.message} —— ${err.hint}`;
  } finally {
    busy.value = false;
  }
}

function askAttachDomain() {
  domErr.value = "";
  const h = domFull.value;
  if (!domPrefix.value.trim()) { domErr.value = "先填前缀（例如 api，会自动拼成 api.所选域名）"; return; }
  if (!domZone.value) { domErr.value = "先选一个 zone（域名必须属于它）"; return; }
  try {
    const pv = previewWorkerDomainAttach(domZone.value, domZoneName.value, h, name.value);
    openSheet(pv, () => api.workerDomainAttach({ hostname: h, zone_id: domZone.value, service: name.value }), `已绑定 ${h}`);
  } catch (e) {
    domErr.value = e instanceof GwError ? e.message : String((e as Error)?.message || e);
  }
}
function askDetachDomain(d: any) {
  domErr.value = "";
  try {
    const pv = previewWorkerDomainDetach(d);
    openSheet(pv, () => api.workerDomainDetach(String(d.id)), `已解绑 ${String(d.hostname ?? d.id)}`);
  } catch (e) {
    domErr.value = e instanceof GwError ? e.message : String((e as Error)?.message || e);
  }
}
function askSubdomain(nextEnabled: boolean, nextPreviews: boolean) {
  const pv = previewWorkerSubdomain(name.value, nextEnabled, nextPreviews);
  openSheet(
    pv,
    () => api.workerSubdomainSet(name.value, nextEnabled, nextPreviews),
    `workers.dev 已${nextEnabled ? "启用" : "关闭"}，预览子域已${nextPreviews ? "启用" : "关闭"}`,
  );
}

const current = computed(() => deployments.value.data?.[0] ?? null);
const currentVersions = computed<any[]>(() => current.value?.versions ?? []);
// strategy 字段一直是 "percentage"，真正的灰度信号是"版本条数 > 1 或首条 percentage < 100"
const isRollout = computed(() => {
  const vs = currentVersions.value;
  return vs.length > 1 || (vs.length === 1 && Number(vs[0]?.percentage ?? 100) < 100);
});

function bindingCount(v: any): string {
  const b: any[] = v?.resources?.bindings ?? [];
  if (!b.length) return "";
  const m = new Map<string, number>();
  for (const x of b) m.set(x.type, (m.get(x.type) || 0) + 1);
  return [...m.entries()].map(([k, n]) => `${k}×${n}`).join(" ");
}

/**
 * Observability 只有 `script-settings` 返回，而且实测返回的是 **null**（= 没显式配过，走账号默认）。
 * 之前这行用 `settings.data.observability?.enabled ? 开启 : 关闭` 渲染，undefined 走 falsy 分支显示"关闭"，
 * 那是把"接口没给我这个字段"说成了"这个功能是关的"（docs/09 §E16）。所以三态要分开写。
 */
function obsText(o: any): string {
  if (o === null || o === undefined) return "未显式配置（按默认行为）";
  if (typeof o === "object") {
    const rate = o.headsampling_rate ?? o.headSamplingRate;
    return o.enabled ? "开启" + (rate !== undefined && rate !== null ? ` · 头部采样 ${rate}` : "") : "关闭";
  }
  return o ? "开启" : "关闭";
}

/** null / [] / 缺字段是三种不同情况，不能都显示"无" */
function listText(v: any, unit = "个"): string {
  if (v === null || v === undefined) return "接口返回 null（未设置）";
  if (!Array.isArray(v)) return String(v);
  return v.length ? `${v.length} ${unit}` : "空数组（显式没有）";
}

/* ---- 版本行/版本详情的字段口径：按 docs/13 §2.3、§2.4 对齐，空值统一用"-" ---- */
const dash = (v: unknown) => (v === undefined || v === null || v === "" ? "—" : String(v));

/** 实测到的取值只有这几种，其余原样显示（不猜新枚举） */
function triggerText(v: unknown): string {
  const k = String(v ?? "");
  const m: Record<string, string> = {
    upload: "上传代码",
    version_upload: "上传版本",
    secret: "改 Secret",
    deployment: "部署动作",
    rollback: "回滚",
    dashboard: "后台操作",
  };
  return m[k] || dash(k);
}

function sourceText(v: unknown): string {
  const k = String(v ?? "");
  const m: Record<string, string> = { wrangler: "wrangler 命令行", dashboard: "Cloudflare 后台", api: "API 调用" };
  return m[k] || dash(k);
}

/** 实测 6 条部署记录的 strategy 全是 "percentage"，别的取值没见过，所以未知值原样显示 */
function strategyText(v: unknown): string {
  const k = String(v ?? "");
  return k === "percentage" ? "百分比部署" : dash(k);
}

/**
 * placement.mode 的中文口径。实测两种形状：开了是 `{"mode":"smart"}`，没开是 `{"mode":""}`
 * （rin-server vs mail）—— 空串是接口明确给的"没设置"，可以直说；字段整个没有才是"没取到"。
 */
function placementText(mode: unknown): string {
  if (mode === undefined) return "—（/settings 没给这个字段）";
  const k = String(mode);
  if (!k) return "没开（默认就近访问者执行）";
  if (k === "smart") return "智能放置（Smart Placement）：执行点跟着你的数据源走";
  return k;
}

/** 实测本账号三个 Worker + 账户默认全是 standard；bundled 是 CF 早年的打包口径，没见过就不猜新枚举 */
function usageModelText(v: unknown): string {
  const k = String(v ?? "");
  if (k === "standard") return "按量（Standard）";
  if (k === "bundled") return "打包（Bundled，旧口径）";
  return dash(k);
}

/** CF 不给"版本 → 部署"的反向索引，只能前端对号：部署历史按时间倒序，取第一条命中的 */
function deploymentFor(vid: string): any | null {
  return (deployments.value.data ?? []).find((d: any) => (d.versions ?? []).some((x: any) => x.version_id === vid)) ?? null;
}

/** 实测 Hono 这类框架会被 CF 算出 20 多个"入口"（每个导出都算一个），手机上刷屏，截断显示 */
function handlersText(v: any): string {
  const h: string[] = Array.isArray(v) ? v.filter(Boolean) : [];
  if (!h.length) return "—";
  return h.length <= 4 ? h.join(" / ") : h.slice(0, 4).join(" / ") + ` 等 ${h.length} 项`;
}

/** 这个版本当前占线上多少流量；没在部署记录里出现就是 0 */
function percentageFor(vid: string): number | null {
  const d = deploymentFor(vid);
  const hit = (d?.versions ?? []).find((x: any) => x.version_id === vid);
  return hit ? Number(hit.percentage ?? 100) : null;
}

/* ---- 版本详情按需展开 ---- */
const openId = ref("");
const detail = ref<Slot<any>>(mk());
async function toggle(v: any) {
  const id = v.id as string;
  if (openId.value === id) { openId.value = ""; return; }
  openId.value = id;
  detail.value = mk();
  await grab(detail, () => api.workerVersion(name.value, id).then((r) => r.result));
}

const bindingKinds = computed(() => {
  const b: any[] = settings.value.data?.bindings ?? [];
  const m = new Map<string, number>();
  for (const x of b) m.set(x.type, (m.get(x.type) || 0) + 1);
  return [...m.entries()].map(([k, n]) => `${k} ×${n}`);
});

/* ---- 版本切换 / 回滚：入口是下面卡片里的按钮，弹出 VerVersionDialog（内部是真发 POST …/deployments）---- */
const showSwitch = ref(false);
</script>

<template>
  <div>
    <div class="row" style="justify-content: space-between; margin-bottom: 10px">
      <h2 style="margin: 0; font-size: 17px">{{ name }}</h2>
      <button class="ghost" :disabled="versions.loading" @click="refresh">{{ versions.loading ? "加载中" : "刷新" }}</button>
    </div>

    <div class="card" id="c-current">
      <h3>当前生产版本</h3>
      <ErrorNote :err="deployments.err" />
      <template v-if="current">
        <div class="kv">
          <dt>版本 ID</dt><dd><span class="badge live">{{ currentVersions[0]?.version_id ? shortId(currentVersions[0].version_id) : "—" }}</span>
            <span class="badge roll" v-if="isRollout">灰度中</span></dd>
          <dt>部署策略</dt><dd>{{ current.strategy }}<span v-if="!isRollout"> · 全量</span></dd>
          <dt>来源</dt><dd>{{ current.source || "—" }} · {{ rel(current.modified_on || current.created_on) }}</dd>
          <dt>说明</dt><dd class="muted">{{ current.annotations?.["workers/message"] || "无说明" }}</dd>
        </div>
        <div v-if="isRollout" class="small" style="margin-top: 8px">
          <div v-for="v in currentVersions" :key="v.version_id" class="muted">
            {{ shortId(v.version_id) }} → {{ v.percentage ?? "剩余" }}%
          </div>
        </div>
      </template>
      <div v-else-if="!deployments.err" class="empty">没有部署记录</div>
    </div>

    <div class="card" id="c-traffic">
      <h3>流量归属（近 7 天 · 按主机名）</h3>
      <ErrorNote :err="traffic.err" />
      <template v-if="traffic.data">
        <div class="kv" v-if="myTraffic.length">
          <dt>合计请求数</dt><dd>{{ num(myTotalReqs) }} 次<span class="muted small">（采样口径，Top 20 内落到 {{ name }} 的主机名）</span></dd>
        </div>
        <div class="list" v-if="myTraffic.length">
          <div v-for="r in myTraffic" :key="r.host" class="item">
            <div style="min-width: 0">
              <div class="k">{{ r.host }}</div>
              <div class="small muted">{{ r.via }}</div>
            </div>
            <div class="v">{{ num(r.reqs) }}</div>
          </div>
        </div>
        <div class="empty" v-else>这个 Worker 的主机名没进最近 7 天的 Top 20</div>
        <div class="small muted" v-if="missingHosts.length" style="margin-top: 8px">
          绑定了但没上榜（不等于 0，只是排在 20 名之外）：{{ missingHosts.map((m) => m.host + "（" + m.via + "）").join("、") }}
        </div>
        <div class="small muted" style="margin-top: 8px">
          CF 没有 Worker 级用量接口（docs/09 §D4），这里把「自定义域名 + Zone 路由」里指向本 Worker 的主机名拿去对号，
          数字来自 Analytics SQL 采样且只取 Top 20；挂在 workers.dev / pages.dev 上的流量不在这张表里。
          路径级路由（形如 <code>example.com/api/*</code>）按主机名整体归属，这种条目数字会偏大。
        </div>
      </template>
      <div class="empty" v-else-if="!traffic.err && traffic.loading">加载中…</div>
    </div>

    <div class="card" id="c-domains">
      <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 10px">
        <h3 style="margin: 0">自定义域名（{{ myDomains.length }} 个）</h3>
        <label class="small muted" style="display: flex; align-items: center; gap: 6px; white-space: nowrap">
          <input type="checkbox" :checked="optIn" @change="toggleOptIn(($event.target as HTMLInputElement).checked)" />
          本机写开关
        </label>
      </div>
      <ErrorNote :err="domains.err || zones.err" />
      <div class="small muted" style="margin: 6px 0 8px">
        上游 2026-10-22 实测：绑定是 <code>PUT /accounts/{a}/workers/domains</code>（客户端发 POST，两层转换），
        解绑 DELETE 回空 200。开关关着时下面的按钮不会发请求。
      </div>
      <div v-if="doneMsg" class="small" style="margin-bottom: 8px; color: var(--ok)">{{ doneMsg }}</div>

      <div class="list" v-if="myDomains.length">
        <div v-for="d in myDomains" :key="d.id" class="item">
          <div style="min-width: 0">
            <div class="k">{{ d.hostname }}</div>
            <div class="small muted">
              {{ d.zone_name || "—" }} · {{ d.environment || "production" }}
              <span class="badge" :class="{ live: !!d.cert_id }">{{ d.cert_id ? "有证书" : "无证书记录" }}</span>
            </div>
          </div>
          <div class="v small">
            <button class="ghost sm danger" type="button" :disabled="!optIn || busy" @click="askDetachDomain(d)">解绑</button>
          </div>
        </div>
      </div>
      <div v-else-if="!domains.loading && !domains.err" class="empty">这个 Worker 还没有自定义域名</div>

      <div class="editbox">
        <div class="row gen">
          <select v-model="domZone" class="field sel" :disabled="!zones.data?.length">
            <option v-if="!zones.data?.length" value="">没有可见 zone</option>
            <option v-for="z in zones.data || []" :key="z.id" :value="String(z.id)">{{ z.name }}</option>
          </select>
          <div style="display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0">
            <input
              v-model="domPrefix"
              class="field"
              style="flex: 1; min-width: 0"
              placeholder="只填前缀，例：api"
              spellcheck="false"
              autocomplete="off"
            />
            <span class="small muted" style="white-space: nowrap">{{ domZoneName ? "." + domZoneName : "" }}</span>
          </div>
          <button class="chip" type="button" :disabled="!optIn || busy" @click="askAttachDomain">绑定域名</button>
        </div>
        <p class="small muted" style="margin: 0">
          最终域名：<code>{{ domFull || "—" }}</code>
        </p>
        <p class="small errtext" v-if="domErr">{{ domErr }}</p>
      </div>
    </div>
    <div class="card" id="c-versions">
      <h3>版本列表（已加载 {{ versions.data?.length || 0 }}<span v-if="vTotal"> / 共 {{ vTotal }} 版</span>）</h3>
      <ErrorNote :err="versions.err" />
      <div class="list" v-if="visibleVersions.shown.length">
        <div v-for="v in visibleVersions.shown" :key="v.id" style="background: var(--panel)">
          <div class="item tap" @click="toggle(v)">
            <div style="min-width: 0">
              <div class="k">#{{ v.number }} <span class="muted">{{ shortId(v.id, 8) }}</span>
                <span class="badge live" v-if="currentVersions.some((c: any) => c.version_id === v.id)">运行中</span>
              </div>
              <div class="small muted">{{ dt(v.metadata?.created_on) }} • {{ sourceText(v.metadata?.source) }}</div>
            </div>
            <div class="v">{{ triggerText(v.annotations?.["workers/triggered_by"]) }}</div>
          </div>
          <div v-if="openId === v.id" style="padding: 0 13px 12px">
            <ErrorNote :err="detail.err" />
            <div class="kv small" v-if="detail.data">
              <dt>版本号</dt><dd>#{{ detail.data.number }}</dd>
              <dt>版本 ID</dt><dd style="word-break: break-all">{{ detail.data.id }}</dd>
              <dt>创建时间</dt><dd>{{ dt(detail.data.metadata?.created_on) }}</dd>
              <dt>来源</dt><dd>{{ sourceText(detail.data.metadata?.source) }}</dd>
              <dt>作者</dt><dd>{{ dash(detail.data.metadata?.author_email) }}</dd>
              <dt>作者 ID</dt><dd>{{ shortId(detail.data.metadata?.author_id, 8) }}</dd>
              <dt>预览</dt><dd>{{ detail.data.metadata?.has_preview ? "已开启" : "未开启" }}</dd>
              <dt>部署消息</dt><dd>{{ dash(detail.data.annotations?.["workers/message"]) }}</dd>
              <dt>触发方式</dt><dd>{{ triggerText(detail.data.annotations?.["workers/triggered_by"]) }}</dd>
              <dt>运行状态</dt><dd>
                <span class="badge live" v-if="currentVersions.some((c: any) => c.version_id === detail.data.id)">运行中 · 占 {{ percentageFor(detail.data.id) }}%</span>
                <span v-else class="muted">未在当前部署里</span>
              </dd>
              <dt>compat</dt><dd>{{ dash(detail.data.resources?.script_runtime?.compatibility_date) }}
                <span class="muted">{{ (detail.data.resources?.script_runtime?.compatibility_flags || []).join(" · ") }}</span></dd>
              <dt>用量模式</dt><dd>{{ usageModelText(detail.data.resources?.script_runtime?.usage_model) }}</dd>
              <dt>入口</dt><dd>{{ handlersText(detail.data.resources?.script?.handlers) }}</dd>
              <dt>绑定</dt><dd>{{ (detail.data.resources?.bindings || []).length }} 项<span class="muted" v-if="bindingCount(detail.data)"> · {{ bindingCount(detail.data) }}</span></dd>
            </div>
            <div class="kv small" v-if="detail.data" style="margin-top: 8px">
              <dt>部署区块</dt>
              <dd v-if="deploymentFor(detail.data.id)" style="min-width: 0">
                {{ shortId(deploymentFor(detail.data.id).id, 8) }} · {{ dt(deploymentFor(detail.data.id).created_on) }}<br />
                {{ sourceText(deploymentFor(detail.data.id).source) }} · 策略 {{ strategyText(deploymentFor(detail.data.id).strategy) }} ·
                流量占比 {{ (deploymentFor(detail.data.id).versions || []).map((x: any) => (x.version_id === detail.data.id ? (x.percentage ?? 100) + "%" : null)).filter(Boolean).join("+") || "—" }}
              </dd>
              <dd v-else class="muted">部署历史（只取最近 {{ (deployments.data?.length ?? 0) }} 条）里没找到这个版本对应的部署记录</dd>
            </div>
            <FoldNote v-if="detail.data" label="为什么没有 URL 和源码下载">
              URL 这一格竞品有、我们没有：CF 的版本接口不返回 URL，历史版本的预览域名规则也没实测过，不拼就是"—"（不是漏字段）。
              源码下载同样不在第一版范围内：CF 没有"下载指定历史版本"的公开接口，路径后缀会被回落成父资源（docs/09 §E7）。
            </FoldNote>
          </div>
        </div>
      </div>
      <div class="row" style="margin-top: 10px; gap: 8px; align-items: center" v-if="versions.data?.length">
        <button class="ghost" v-if="!vExhausted" :disabled="vMoreLoading" @click="loadMoreVersions">
          {{ vMoreLoading ? "加载中" : "加载更多 25 条" }}
        </button>
        <span class="small muted" v-else>到底了<span v-if="vTotal">（{{ versions.data?.length }} / {{ vTotal }}，{{ vTotal === versions.data?.length ? "已全部加载" : "已加载完可部署版本，其余见 CF 控制台" }}）</span></span>
        <button class="ghost" v-if="visibleVersions.rest" @click="visibleVersions.open = !visibleVersions.open">
          {{ visibleVersions.label }}
        </button>
      </div>
    </div>

    <div class="card" id="c-deployments">
      <h3>部署历史</h3>
      <ErrorNote :err="deployments.err" />
      <div class="list" v-if="deployments.data?.length">
        <div v-for="d in visibleDeps.shown" :key="d.id" class="item">
          <div style="min-width: 0">
            <div class="k">{{ strategyText(d.strategy) }} · <span class="muted">{{ shortId((d.versions || [])[0]?.version_id, 8) }}</span></div>
            <div class="small muted">{{ dt(d.created_on) }} · {{ sourceText(d.source) }} · {{ triggerText(d.annotations?.["workers/triggered_by"]) }}</div>
          </div>
          <div class="v">{{ d.versions?.length > 1 ? d.versions.length + " 个版本" : ((d.versions || [])[0]?.percentage ?? "100") + "%" }}</div>
        </div>
      </div>
      <button class="ghost" style="margin-top: 8px" v-if="visibleDeps.rest" @click="visibleDeps.open = !visibleDeps.open">
        {{ visibleDeps.label }}
      </button>
    </div>

    <div class="card" id="c-settings">
      <h3>配置信息</h3>
      <ErrorNote :err="settings.err || scriptSettings.err" />
      <div class="kv" v-if="settings.data || scriptSettings.data">
        <dt>compat</dt><dd>{{ settings.data?.compatibility_date }} <span class="muted small">{{ (settings.data?.compatibility_flags || []).join(" · ") }}</span></dd>
        <dt>用量模式</dt><dd>{{ usageModelText(settings.data?.usage_model) }}</dd>
        <dt>放置模式</dt><dd>{{ placementText(settings.data?.placement?.mode) }}</dd>
        <dt>绑定</dt><dd>{{ bindingKinds.length ? bindingKinds.join("、") : "无" }}</dd>
        <dt>可观测性</dt><dd>{{ obsText(scriptSettings.data?.observability) }}</dd>
        <dt>日志推送</dt><dd>{{ scriptSettings.data ? (scriptSettings.data.logpush ? "开启" : "关闭") : "—" }}</dd>
        <dt>tail 消费者</dt><dd>{{ listText(settings.data?.tail_consumers, "条") }}</dd>
        <dt>标签</dt><dd>{{ listText(settings.data?.tags, "个") }}</dd>
        <dt>workers.dev</dt><dd>
          <span v-if="subdomain.data" class="badge" :class="{ live: subdomain.data.enabled }">{{ subdomain.data.enabled ? "已启用" : "已关闭" }}</span>
          <span v-if="subdomain.data" class="muted small">预览 {{ subdomain.data.previews_enabled ? "开" : "关" }} · 你的网络访问不到 *.workers.dev（docs/00）</span>
          <span v-else>—</span>
          <div class="row" style="gap: 6px; margin-top: 4px" v-if="subdomain.data">
            <button
              class="ghost sm"
              type="button"
              :disabled="!optIn || busy"
              @click="askSubdomain(!subdomain.data.enabled, !!subdomain.data.previews_enabled)"
            >{{ subdomain.data.enabled ? "关闭 workers.dev" : "启用 workers.dev" }}</button>
            <button
              class="ghost sm"
              type="button"
              :disabled="!optIn || busy"
              @click="askSubdomain(!!subdomain.data.enabled, !subdomain.data.previews_enabled)"
            >{{ subdomain.data.previews_enabled ? "关闭预览子域" : "启用预览子域" }}</button>
          </div>
          <div class="small muted" v-if="!optIn">本机写开关没打开（在「自定义域名」卡片上打开）。</div>
        </dd>
      </div>
      <FoldNote label="这些字段各来自哪条路由">
        compat / placement / usage_model / tail_consumers / tags 来自 <code>/settings</code>，
        observability 与 logpush 只来自 <code>/script-settings</code> —— 两条不同路由，实测字段几乎不重叠（docs/08 §6.1）。
        同一个 <code>tags</code> 在 <code>/settings</code> 里是空数组、在 <code>/script-settings</code> 里是 <code>null</code>，所以这里标的是"哪种空"而不是统一写"无"。
      </FoldNote>
    </div>

    <div class="card" id="c-secrets">
      <h3>变量与 Secret</h3>
      <VarsPanel
        :name="name"
        :bindings="settings.data?.bindings ?? []"
        :secrets="secrets.data ?? []"
        :loading="settings.loading || secrets.loading"
        :err="secrets.err || settings.err"
        @changed="refresh"
      />
    </div>

    <div class="card" id="c-bindings">
      <h3>绑定（KV / R2 / D1 / Service）</h3>
      <BindingsPanel
        :name="name"
        :bindings="settings.data?.bindings ?? []"
        :loading="settings.loading"
        :err="settings.err"
        @changed="refresh"
      />
    </div>

    <div class="card" id="c-crons">
      <h3>定时触发器</h3>
      <CronPanel
        :name="name"
        :crons="crons.data"
        :loading="crons.loading"
        :err="crons.err"
        @retry="loadAll"
        @changed="refresh"
      />
    </div>

    <div class="card" id="c-switch">
      <h3>版本切换 / 回滚</h3>
      <div class="small muted" style="margin-bottom: 10px">
        入口就是下面这个按钮：打开版本历史，进某个版本的详情，滑杆选流量占比，确认后真发
        <code>POST …/deployments</code>。直连模式（APK）即时生效；网关模式还需网关侧
        <code>WRITE_ENABLED</code> 放行，关着会如实报 <code>501 writesDisabled</code>。
      </div>
      <button class="ghost" type="button" @click="showSwitch = true">打开版本历史 / 回滚</button>
    </div>

    <VersionDialog
      v-if="showSwitch"
      :name="name"
      :versions="versions.data ?? []"
      :deployments="deployments.data ?? []"
      :loading="versions.loading"
      :err="versions.err"
      :total="vTotal"
      :hosts="myTraffic"
      @close="showSwitch = false"
      @retry="refresh"
      @changed="refresh"
    />

    <ConfirmSheet :preview="preview" :busy="busy" :error="sheetErr" @confirm="confirmWrite" @cancel="cancelSheet" />
  </div>
</template>

<style scoped>
button.sm { padding: 4px 10px; font-size: 12px; }
button.danger { color: var(--bad); border-color: rgb(var(--bad-rgb) / .45); }
.errtext { color: var(--bad); }
.editbox { padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel-2); display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.gen { flex-wrap: wrap; gap: 6px; }
.gen .field { max-width: 280px; }
.sel { width: auto; }
</style>
