<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import ErrorNote from "../components/ErrorNote.vue";
import ConfirmSheet from "../components/ConfirmSheet.vue";
import DnsRecordList from "../components/dns/DnsRecordList.vue";
import DnsRecordForm from "../components/dns/DnsRecordForm.vue";
import DnsPurgeForm from "../components/dns/DnsPurgeForm.vue";
import DnsSetupWizard from "../components/dns/DnsSetupWizard.vue";
import UnifiedDomains from "../components/dns/UnifiedDomains.vue";
import ZoneStatusCard from "../components/dns/ZoneStatusCard.vue";
import {
  api,
  dropMem,
  forceFreshWindow,
  GwError,
  previewDnsDelete,
  previewZoneRoute,
  setWritesOptIn,
  writesOptIn,
  type RouteInput,
  type Waf,
  type WritePreview,
} from "../lib/api";
import { dt, shortId } from "../lib/fmt";

type Slot<T> = { data: T | null; err: GwError | null; loading: boolean };
const mk = <T,>(): Slot<T> => ({ data: null, err: null, loading: false });

const domains = ref<Slot<any[]>>(mk());
const zones = ref<Slot<any[]>>(mk());
const records = ref<Slot<any[]>>(mk());
const routes = ref<Slot<any[]>>(mk());
const waf = ref<Slot<Waf>>(mk());
/** 账户级 workers.dev 前缀（域名页那行 `*.前缀.workers.dev`）；CF 只返回前缀，不返回开关 */
const sub = ref<Slot<{ subdomain?: string }>>(mk());
const zoneId = ref("");
/** 当前选中 zone 的名称（用于写侧 preview* 回显） */
const currentZoneName = computed(() => {
  const arr = zones.value.data ?? [];
  const z = arr.find((x: any) => String(x.id) === String(zoneId.value));
  return z?.name || "";
});

/** 面板开合：写侧三块（新增/编辑、清缓存、向导）默认收起，一屏不塞满 */
const editorOpen = ref(false);
const purgeOpen = ref(false);
const wizardOpen = ref(false);
/** 编辑器的当前对象：record=编辑、preset=向导带过来的新增预填、都空=空白新增 */
const editorRecord = ref<Record<string, any> | null>(null);
const editorPreset = ref<{ type?: string; name?: string } | null>(null);

/** 本机写开关：关了根本不出网（api 里 gwWrite 先查它）。默认关，符合 docs/13 §7.5「别摆没放行的入口」 */
const writesOn = ref(writesOptIn());
function toggleWrites(v: boolean) {
  setWritesOptIn(v);
  writesOn.value = writesOptIn();
}

/** 确认抽屉状态 + 确认后要执行的那一次真写 */
const sheet = ref<{ preview: WritePreview | null; busy: boolean; error: string }>({ preview: null, busy: false, error: "" });
let runWrite: (() => Promise<unknown>) | null = null;
const doneMsg = ref("");

async function grab<T>(slot: { value: Slot<T> }, fn: () => Promise<T>) {
  slot.value = { ...slot.value, loading: true, err: null };
  try { slot.value = { data: await fn(), err: null, loading: false }; }
  catch (e) { slot.value = { data: slot.value.data, loading: false, err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)) }; }
}

async function loadTop() {
  await Promise.allSettled([
    grab(domains, async () => { const r: any = await api.domains(); return Array.isArray(r.result) ? r.result : (r.result ?? []); }),
    grab(zones, async () => { const r = await api.zones(); return Array.isArray(r.result) ? r.result : []; }),
    grab(sub, async () => (await api.accountSubdomain()).result ?? null),
  ]);
  const arr = zones.value.data ?? [];
  if (!zoneId.value && arr.length) zoneId.value = String(arr[0].id);
}

async function loadZone() {
  if (!zoneId.value) return;
  await Promise.allSettled([
    grab(records, async () => { const x = await api.dnsRecords(zoneId.value); return Array.isArray(x.result) ? x.result : []; }),
    grab(routes, async () => { const x = await api.zoneRoutes(zoneId.value); return Array.isArray(x.result) ? x.result : []; }),
    grab(waf, () => api.zoneWaf(zoneId.value)),
  ]);
}

onMounted(async () => { await loadTop(); await loadZone(); });

/* ---------- 站点下拉：展开/收起 + 点外面关闭 ---------- */
const zopen = ref(false);
const zddEl = ref<HTMLElement | null>(null);
function onDocClick(e: MouseEvent) {
  if (zopen.value && zddEl.value && !zddEl.value.contains(e.target as Node)) zopen.value = false;
}
onMounted(() => document.addEventListener("click", onDocClick));
onUnmounted(() => document.removeEventListener("click", onDocClick));

/** 「刷新」= 这一屏全部绕过两层缓存重来；平时进这屏只发命中的那几条 */
async function refresh() { forceFreshWindow(); await loadTop(); await loadZone(); }
watch(zoneId, () => { editorOpen.value = false; editorRecord.value = null; editorPreset.value = null; routeOpen.value = false; routeEditing.value = null; loadZone(); });

const zoneName = computed(() => (zones.value.data ?? []).find((z: any) => String(z.id) === zoneId.value)?.name ?? "");
const currentZone = computed(() => (zones.value.data ?? []).find((z: any) => String(z.id) === zoneId.value) ?? null);

/** 三种"没有规则"的文案必须分开，这是实测出来的形状（docs/04 §8）：没配过 ≠ 没权限 ≠ 套餐不认 */
const WAF_STATE: Record<string, { text: string; live: boolean }> = {
  ok: { text: "有规则集", live: true },
  empty: { text: "没配过规则", live: false },
  unsupported: { text: "本套餐不认这个 phase", live: false },
  denied: { text: "缺权限", live: false },
  error: { text: "读取失败", live: false },
};
const wafPhases = computed(() => waf.value.data?.phases ?? []);

/* ---------- 写侧：表单/清缓存 → 预览 → ConfirmSheet → api → dropMem + 重取 ---------- */

function openCreate() { editorRecord.value = null; editorPreset.value = null; editorOpen.value = true; purgeOpen.value = false; doneMsg.value = ""; }
function openEdit(r: any) { editorRecord.value = r; editorPreset.value = null; editorOpen.value = true; doneMsg.value = ""; }

/** 表单/清缓存交来的预览：先开抽屉给人逐字段核对，run 闭包留到确认时真发 */
function onFormPreview(p: { preview: WritePreview; action: { kind: "create" | "update"; input: any; id?: string } }) {
  editorOpen.value = false;
  openSheet(p.preview, () =>
    p.action.kind === "create"
      ? api.createDnsRecord(zoneId.value, p.action.input)
      : api.updateDnsRecord(zoneId.value, p.action.id!, p.action.input),
  );
}
function onPurgePreview(p: { preview: WritePreview; action: { kind: "purge"; files: string[] } }) {
  openSheet(p.preview, () => api.purgeUrls(zoneId.value, p.action.files));
}
/** 删除：从列表直接生成不可撤销预览，ConfirmSheet 会要求手打记录名 */
function onDelete(r: any) {
  doneMsg.value = "";
  try {
    openSheet(previewDnsDelete(zoneId.value, currentZoneName.value, String(r.id), String(r.name)), () => api.deleteDnsRecord(zoneId.value, String(r.id)));
  } catch (e) {
    doneMsg.value = e instanceof GwError ? e.hint : String((e as Error)?.message || e);
  }
}
/** 向导「照此新增」：切到该记录所属 Zone，带类型/名称打开新增表单（内容仍要人填、发送仍要确认） */
function onWizardSuggest(s: { zoneId: string; type: string; name: string }) {
  wizardOpen.value = false;
  if (s.zoneId && s.zoneId !== zoneId.value) {
    zoneId.value = s.zoneId; // watch 会 loadZone 并把编辑器关掉，所以下一步用 microtask 再开
    setTimeout(() => { editorRecord.value = null; editorPreset.value = { type: s.type, name: s.name }; editorOpen.value = true; }, 0);
  } else {
    editorRecord.value = null; editorPreset.value = { type: s.type, name: s.name }; editorOpen.value = true;
  }
}

/* ---------- 站点 Workers 路由：新增 / 改 / 删 ----------
 * 上游 POST/PUT/DELETE `/zones/{z}/workers/routes`，body {pattern, script|null}。
 * 这条写需要令牌带 Workers Routes Write（docs/05）；缺权限时 CF 回 403，错误原样留在抽屉里。 */
const routeOpen = ref(false);
const routeEditing = ref<any | null>(null);
const routePattern = ref("");
const routeScript = ref("");
const routeErr = ref("");

function openRouteCreate() {
  routeEditing.value = null;
  routePattern.value = "";
  routeScript.value = "";
  routeErr.value = "";
  routeOpen.value = true;
  doneMsg.value = "";
}
function openRouteEdit(r: any) {
  routeEditing.value = r;
  routePattern.value = String(r?.pattern ?? "");
  routeScript.value = String(r?.script ?? "");
  routeErr.value = "";
  routeOpen.value = true;
  doneMsg.value = "";
}
function routeInput(): RouteInput {
  return { pattern: routePattern.value.trim(), script: routeScript.value.trim() ? routeScript.value.trim() : null };
}
function askSaveRoute() {
  routeErr.value = "";
  doneMsg.value = "";
  try {
    const input = routeInput();
    const editing = routeEditing.value;
    const pv = previewZoneRoute(zoneId.value, currentZoneName.value, editing ? "update" : "create", editing ? { ...input, id: String(editing.id) } : input);
    openSheet(pv, () =>
      editing ? api.zoneRouteUpdate(zoneId.value, String(editing.id), input) : api.zoneRouteCreate(zoneId.value, input),
    );
  } catch (e) {
    routeErr.value = e instanceof GwError ? e.message : String((e as Error)?.message || e);
  }
}
function askDeleteRoute(r: any) {
  routeErr.value = "";
  doneMsg.value = "";
  try {
    openSheet(previewZoneRoute(zoneId.value, currentZoneName.value, "delete", r), () => api.zoneRouteDelete(zoneId.value, String(r.id)));
  } catch (e) {
    routeErr.value = e instanceof GwError ? e.message : String((e as Error)?.message || e);
  }
}

function openSheet(preview: WritePreview, run: () => Promise<unknown>) {
  runWrite = run;
  sheet.value = { preview, busy: false, error: "" };
}
function cancelSheet() { sheet.value = { preview: null, busy: false, error: "" }; runWrite = null; }
async function confirmSheet() {
  if (!runWrite || sheet.value.busy) return;
  sheet.value = { ...sheet.value, busy: true, error: "" };
  try {
    await runWrite();
    const kind = sheet.value.preview?.path.endsWith("purge_cache") ? "缓存" : sheet.value.preview?.path.includes("/routes") ? "路由" : "记录";
    sheet.value = { preview: null, busy: false, error: "" };
    runWrite = null;
    routeOpen.value = false;
    routeEditing.value = null;
    dropMem("/v1/zones/" + zoneId.value);
    await loadZone();
    doneMsg.value = kind + "写请求已成功返回，列表已重取。";
  } catch (e) {
    const err = e instanceof GwError ? e : new GwError("unknown", 0, null, String((e as Error)?.message || e));
    // 不谎报成功：把网关/本地的拒绝原因如实留在抽屉里，让人看清 501 / 权限 / 校验各是什么
    sheet.value = { ...sheet.value, busy: false, error: `[${err.kind} · HTTP ${err.http}] ${err.message} —— ${err.hint}` };
  }
}
</script>

<template>
  <div>
    <div class="row" style="justify-content: space-between; margin-bottom: 10px; gap: 10px">
      <!-- 站点切换器：折叠式下拉（跟旧版 select 一样收着），展开后带状态点与状态文字 -->
      <div class="zdd" ref="zddEl">
        <button class="zbtn" :aria-expanded="zopen" aria-haspopup="listbox" @click.stop="zopen = !zopen">
          <i class="zdot" :data-s="currentZone?.status || 'unknown'" />
          <span class="zname">{{ currentZone?.name || (zones.loading ? "加载中…" : "选择站点") }}</span>
          <i class="chev" :class="{ up: zopen }">▾</i>
        </button>
        <div class="zpanel" v-if="zopen" role="listbox" aria-label="选择站点">
          <button
            v-for="z in zones.data || []" :key="z.id"
            class="zopt" :class="{ on: String(z.id) === zoneId }"
            role="option" :aria-selected="String(z.id) === zoneId"
            @click="zoneId = String(z.id); zopen = false"
          >
            <i class="zdot" :data-s="z.status || 'unknown'" />
            <span class="zopt-name">{{ z.name }}</span>
            <span class="zopt-st">{{ z.status || "" }}</span>
          </button>
        </div>
      </div>
      <button class="ghost" @click="refresh">刷新</button>
    </div>

    <ErrorNote :err="domains.err || zones.err" />

    <!-- 本机写开关：关时写操作根本不出网；开时真发（网关侧 WRITE_ENABLED 关会 501，原因如实显示） -->
    <label class="wsw">
      <input type="checkbox" class="switch" :checked="writesOn" @change="toggleWrites(($event.target as HTMLInputElement).checked)" />
      <span>
        <b>本机写开关：{{ writesOn ? "已打开" : "关（默认）" }}</b>
        <span class="muted small">{{ writesOn ? "变更请求会真的发出，发出前逐条确认。" : "写操作在这台设备上就被拦下，不发请求。" }}</span>
      </span>
    </label>

    <!-- 站点状态 + nameserver（数据全在 /v1/zones 里，零新路由） -->
    <div class="card" v-if="currentZone">
      <h3>站点状态</h3>
      <ZoneStatusCard :zone="currentZone" />
    </div>

    <!-- 统一域名视图：Worker / Pages / R2 合并一列，用「→ 类型:」区分 -->
    <div class="card">
      <h3>统一域名视图（Worker / Pages / R2）</h3>
      <ErrorNote :err="domains.err" />
      <UnifiedDomains
        :worker-domains="domains.data || []"
        :subdomain="sub.data?.subdomain || ''"
        :sub-loading="sub.loading"
        :sub-err="sub.err?.hint ?? null"
      />
    </div>

    <!-- DNS 记录：整行点=编辑，新增走表单 → 预览 → 确认 -->
    <div class="card" v-if="zoneName">
      <div class="hd">
        <h3>DNS 记录（{{ (records.data || []).length }} 条）· {{ zoneName }}</h3>
        <button class="primary sm" :disabled="!zoneId" @click="openCreate">新增记录</button>
      </div>
      <ErrorNote :err="records.err" />

      <div v-if="editorOpen" class="editor">
        <h4>{{ editorRecord ? '编辑记录' : '新增记录' }}</h4>
        <DnsRecordForm
          :key="String(editorRecord?.id || editorPreset?.name || 'new')"
          :zone-id="zoneId"
          :zone-name="currentZoneName"
          :record="editorRecord"
          :preset="editorPreset"
          @preview="onFormPreview"
          @cancel="editorOpen = false"
        />
      </div>

      <DnsRecordList v-if="(records.data || []).length" :records="records.data!" @edit="openEdit" @del="onDelete" />
      <div v-else-if="!records.err && !records.loading" class="empty">没有记录</div>
      <div v-else-if="records.loading" class="empty">加载中…</div>
      <div class="whyline" v-if="doneMsg">{{ doneMsg }}</div>
      <!-- 交互说明（点行编辑 / 删除点名 / 501 原因）见 docs/14 §8 -->
    </div>

    <!-- 按 URL 清理缓存 -->
    <div class="card" v-if="zoneName">
      <div class="hd">
        <h3>按 URL 清理缓存</h3>
        <button class="ghost sm" @click="purgeOpen = !purgeOpen">{{ purgeOpen ? "收起" : "展开" }}</button>
      </div>
      <div v-if="purgeOpen" style="margin-top: 8px">
        <DnsPurgeForm :zone-id="zoneId" :zone-name="currentZoneName" @preview="onPurgePreview" />
      </div>
      <div v-else class="small muted">上限 30 条 URL，逐条回显后再发；默认不预填任何 URL。</div>
    </div>

    <!-- DNS 配置向导（自研判定，非 Cloudflare 字段） -->
    <div class="card">
      <div class="hd">
        <h3>DNS 配置向导</h3>
        <button class="ghost sm" @click="wizardOpen = !wizardOpen">{{ wizardOpen ? "收起" : "展开" }}</button>
      </div>
      <DnsSetupWizard v-if="wizardOpen" :domains="domains.data || []" :zones="zones.data || []" @suggest="onWizardSuggest" />
      <div v-else class="small muted">给自定义域名验证提示该填什么记录；判定规则是本控制台自研，界面上会写清。</div>
    </div>

    <div class="card" v-if="zoneName">
      <div class="hd">
        <h3 style="margin: 0">{{ zoneName }} · Workers 路由（{{ (routes.data || []).length }}）</h3>
        <button class="primary sm" :disabled="!zoneId || !writesOn" @click="openRouteCreate">新增路由</button>
      </div>
      <ErrorNote :err="routes.err" />

      <div v-if="routeOpen" class="editor">
        <h4>{{ routeEditing ? "修改路由" : "新增路由" }}</h4>
        <div class="row gen">
          <input v-model="routePattern" class="field" placeholder="example.com/*" spellcheck="false" autocomplete="off" />
          <input v-model="routeScript" class="field" placeholder="Worker 名（留空 = 仅记录，不跑 Worker）" spellcheck="false" autocomplete="off" />
        </div>
        <p class="small muted">
          pattern 必须属于 {{ zoneName }}，并以 <code>*</code> 结尾；上游 POST/PUT/DELETE 三条同一路径。
          这条写需要令牌带 Workers Routes Write，缺权限时 CF 回 403，会原样显示。
        </p>
        <p class="small errtext" v-if="routeErr">{{ routeErr }}</p>
        <div class="row" style="gap: 8px">
          <button class="ghost sm" :disabled="!writesOn" @click="askSaveRoute">预览并确认</button>
          <button class="ghost sm" @click="routeOpen = false">取消</button>
        </div>
      </div>

      <div class="list" v-if="(routes.data || []).length">
        <div v-for="r in routes.data" :key="r.id" class="item">
          <div class="k">{{ r.pattern }}</div>
          <div class="v">
            {{ r.script || "仅记录" }}
            <div class="small">{{ shortId(r.id, 6) }}</div>
            <div class="row" style="gap: 6px; margin-top: 4px">
              <button class="ghost sm" :disabled="!writesOn" @click="openRouteEdit(r)">编辑</button>
              <button class="ghost sm danger" :disabled="!writesOn" @click="askDeleteRoute(r)">删除</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else-if="!routes.err" class="empty">这个站点没有 Workers 路由</div>
      <p class="small muted" style="margin-top: 8px" v-if="!writesOn">上面「本机写开关」没打开，路由的增删改按钮是灰的。</p>
    </div>

    <div class="card" v-if="zoneName">
      <h3>WAF / 防火墙规则（只读，共 {{ waf.data?.ruleCount ?? 0 }} 条）</h3>
      <ErrorNote :err="waf.err" />
      <div class="list">
        <div v-for="p in wafPhases" :key="p.phase" class="item" style="align-items: flex-start">
          <div style="min-width: 0">
            <div class="k">{{ p.label }}</div>
            <div class="small muted">{{ p.note || (p.rules.length ? `规则集 ${p.name} · 版本 ${p.version} · 最后修改于 ${dt(p.last_updated)}` : "规则集为空") }}</div>
            <div v-for="r in p.rules" :key="String(r.id)" style="margin-top: 6px">
              <div class="small">
                <span class="badge" :class="{ live: r.enabled }">{{ r.action }}{{ r.enabled ? "" : " · 已停用" }}</span>
                {{ r.description || "无描述" }}
              </div>
              <div class="small" style="word-break: break-all"><code>{{ r.expression }}</code></div>
            </div>
          </div>
          <div class="v">
            <span class="badge" :class="{ live: WAF_STATE[p.state]?.live }">{{ WAF_STATE[p.state]?.text || p.state }}</span>
            <div class="small">{{ p.rules.length }} 条</div>
          </div>
        </div>
      </div>
      <div class="small muted" style="margin-top: 8px">
        只读展示，不含命中次数（原因见 docs/14 §8）。
      </div>
    </div>

    <ConfirmSheet :preview="sheet.preview" :busy="sheet.busy" :error="sheet.error" @confirm="confirmSheet" @cancel="cancelSheet" />
  </div>
</template>

<style scoped>
/* 站点切换器：折叠下拉。收起 = 一个带状态点的按钮；展开 = 浮层面板（状态点 + 状态文字） */
.zdd { position: relative; min-width: 0; }
.zbtn { display: inline-flex; align-items: center; gap: 9px; padding: 9px 14px; border-radius: 10px;
  border: 1px solid var(--line); background: var(--panel); color: inherit; font-size: 14px; cursor: pointer;
  max-width: 70vw; transition: border-color .12s; }
.zbtn:hover, .zbtn[aria-expanded="true"] { border-color: var(--accent); }
.zname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.chev { font-style: normal; font-size: 10px; color: var(--muted); transition: transform .15s; }
.chev.up { transform: rotate(180deg); }
.zpanel { position: absolute; top: calc(100% + 6px); left: 0; z-index: 30; min-width: 260px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 6px;
  box-shadow: 0 10px 30px rgb(0 0 0 / .18); }
.zopt { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 10px; border: 0;
  border-radius: 8px; background: none; color: inherit; font-size: 13px; cursor: pointer; text-align: left; }
.zopt:hover { background: var(--panel-2); }
.zopt.on { background: var(--panel-2); font-weight: 600; }
.zopt-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zopt-st { font-size: 11px; color: var(--muted); flex: none; }
.zdot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
.zdot[data-s="active"] { background: var(--ok, #2f9e5f); }
.zdot[data-s="pending"] { background: #d29922; }
.hd { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
.hd h3 { margin: 0; }
.wsw { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); margin-bottom: 10px; cursor: pointer; }
.wsw input { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--accent); flex: none; }
.wsw b { font-size: 13px; }
.editor { border: 1px solid var(--line); border-radius: 12px; padding: 12px; margin: 10px 0; background: var(--panel-2); }
.editor h4 { margin: 0 0 10px; font-size: 13px; color: var(--muted); }
.whyline.ok { color: var(--ok); background: rgb(var(--ok-rgb) / .08); border-left-color: var(--ok); }
.errtext { color: var(--bad); }
button.sm { padding: 4px 10px; font-size: 12px; }
button.danger { color: var(--bad); border-color: rgb(var(--bad-rgb) / .45); }
.gen { flex-wrap: wrap; gap: 6px; }
.gen .field { max-width: 280px; }
</style>
