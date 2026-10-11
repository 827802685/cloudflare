<script lang="ts">
/**
 * 绑定四件套（docs/13 §6.5）：KV / R2 / D1 / service 的「看」和「改」。
 *
 * 读侧：全部来自 `/settings` 的 `bindings[]`（api.workerSettings 已有），按 type 分类渲染。
 * 改侧：CF 改绑定是 `PUT /accounts/:a/workers/scripts/:s/settings`，而且这个 PUT 是**全量覆盖** ——
 *       提交的 bindings 数组就是最终状态，漏一条等于删一条。所以编辑模式在本地维护完整数组，
 *       提交前把「覆盖后的完整清单」摆进确认抽屉。
 * 路由状态：PUT /v1/workers/:s/settings 网关还没有（待补路由清单第 4 条），请求体形状**没实测过**，
 *          所以界面明说这是未验形状，kind 原样显示，不假装成功。
 *
 * 目标目录（可选 KV / R2 / D1 列表）本应来自 GET /v1/kv/namespaces、/v1/r2/buckets、/v1/d1/databases，
 * 但：KV/D1 读权限令牌缺（实测 403），R2 账号没开通（实测 403 10042 serviceDisabled）。
 * 所以这里不塞假下拉，只让人手填 namespace_id / bucket_name / database_id，并说清为什么没有候选。
 */
export default { name: "VerBindingsPanel" };
</script>

<script setup lang="ts">
import { computed, ref } from "vue";
import ConfirmSheet from "../ConfirmSheet.vue";
import { GwError, gwWrite, writesOptIn, type WritePreview } from "../../lib/api";
import { shortId } from "../../lib/fmt";

const props = withDefaults(
  defineProps<{ name: string; bindings?: any[] | null; loading?: boolean; err?: GwError | { kind?: string; message?: string } | null }>(),
  { bindings: null, loading: false, err: null },
);
const emit = defineEmits<{ (e: "changed"): void }>();

const KIND_CN: Record<string, string> = {
  kv_namespace: "Workers KV",
  r2_bucket: "R2 存储桶",
  d1_database: "D1 数据库",
  service: "服务绑定（另一个 Worker）",
};

const CATS = [
  { type: "kv_namespace", title: "Workers KV", whyCatalog: "候选命名空间列表要 GET /v1/kv/namespaces，本网关没有这条路由，且当前令牌缺 KV 读权限（实测 403）——所以只能手填 namespace_id。" },
  { type: "r2_bucket", title: "R2 存储桶", whyCatalog: "候选桶列表要 GET /v1/r2/buckets，本网关没有这条路由，且这个账号没启用 R2（实测 403 code=10042 serviceDisabled）——所以这里没有任何可选桶，只能手填 bucket_name。" },
  { type: "d1_database", title: "D1 数据库", whyCatalog: "候选库列表要 GET /v1/d1/databases，本网关没有这条路由，且当前令牌缺 D1 读权限（实测 403）——所以只能手填 database_name。" },
  { type: "service", title: "服务绑定", whyCatalog: "可选的其它 Worker 名来自 Worker 列表（已有），但版本/环境路由信息接口不返回，这里按 service + environment 手填。" },
];

function ofType(type: string): any[] {
  return (props.bindings ?? []).filter((b: any) => b?.type === type);
}

/** 每类绑定在界面上的「一行摘要」，字段缺失就显示字段名，绝不编造 */
function labelOf(b: any): { head: string; sub: string } {
  const binding = String(b?.binding || b?.name || "（无绑定名）");
  switch (b?.type) {
    case "kv_namespace":
      return { head: binding, sub: `namespace_id ${shortId(b?.namespace_id, 10)}${b?.namespace_title ? " · " + b.namespace_title : ""}` };
    case "r2_bucket":
      return { head: binding, sub: `bucket ${b?.bucket_name || "（无 bucket_name）"}` };
    case "d1_database":
      return { head: binding, sub: `database ${b?.database_name || "（无 database_name）"}${b?.database_id ? " · " + shortId(b.database_id, 10) : ""}` };
    case "service":
      return { head: binding, sub: `→ ${b?.service || "（无 service）"} @ ${b?.environment || "production"}` };
    default:
      return { head: binding, sub: String(b?.type || "未知类型") };
  }
}

/* ---------- 编辑：本地维护一份「将要 PUT 回去的完整数组」 ---------- */
const editing = ref(false);
const draft = ref<any[]>([]);
function startEdit() {
  // 拷贝现有 bindings，编辑期间只改这份 draft；提交时原样 PUT
  draft.value = (props.bindings ?? []).map((b: any) => ({ ...b }));
  editing.value = true;
}
function cancelEdit() {
  editing.value = false;
  draft.value = [];
  addType.value = "kv_namespace";
  addBinding.value = "";
  addTarget.value = "";
  addErr.value = "";
}
function removeDraft(i: number) {
  draft.value.splice(i, 1);
}

const addType = ref<"kv_namespace" | "r2_bucket" | "d1_database" | "service">("kv_namespace");
const addBinding = ref("");
const addTarget = ref("");
const addErr = ref("");

function addDraft() {
  addErr.value = "";
  const b = addBinding.value.trim();
  const t = addTarget.value.trim();
  if (!b) { addErr.value = "绑定名（代码里用来访问它的那个名字）不能为空"; return; }
  if (!t) { addErr.value = addType.value === "service" ? "被调用的 Worker 名不能为空" : "目标 ID / 桶名 / 库名不能为空"; return; }
  if (draft.value.some((x: any) => x.binding === b || x.name === b)) { addErr.value = `绑定名「${b}」已经在这份清单里了，换个名或先删旧的`; return; }
  const nb: any = { type: addType.value, binding: b };
  if (addType.value === "kv_namespace") nb.namespace_id = t;
  else if (addType.value === "r2_bucket") nb.bucket_name = t;
  else if (addType.value === "d1_database") nb.database_name = t;
  else if (addType.value === "service") { nb.service = t; nb.environment = "production"; }
  draft.value.push(nb);
  addBinding.value = "";
  addTarget.value = "";
}

/* ---------- 写侧：PUT 全量覆盖 /settings 的 bindings ---------- */
const preview = ref<WritePreview | null>(null);
const busy = ref(false);
const sheetErr = ref("");
const log = ref<{ text: string; ok: boolean }[]>([]);
const optIn = ref(writesOptIn());

function draftSignature(b: any): string {
  const l = labelOf(b);
  return `${b?.type} · ${l.head} · ${l.sub}`;
}

function askSave() {
  addErr.value = "";
  if (!optIn.value) {
    sheetErr.value = "";
    log.value.unshift({ text: "本机写开关没打开：这次只准备了请求，没有发出", ok: false });
  }
  sheetErr.value = "";
  preview.value = {
    method: "PUT",
    path: `/v1/workers/${encodeURIComponent(props.name)}/settings`,
    body: { bindings: draft.value },
    title: "保存绑定（全量覆盖）",
    lines: [
      { k: "Worker", v: props.name },
      { k: "语义", v: "CF 这个接口是 PUT 全量覆盖：下面这份 bindings 就是保存后的最终状态，漏掉的绑定会被删除" },
      { k: "覆盖后绑定", v: draft.value.length ? draft.value.map(draftSignature).join(" ｜ ") : "空（这个 Worker 将不再有任何绑定）" },
      { k: "请求体", v: JSON.stringify({ bindings: draft.value.map((b) => b.binding ?? b.name) }) },
      { k: "路由状态", v: "网关还没有 PUT /v1/workers/:s/settings（待补路由清单第 4 条）；请求体形状未实测，被拒时 kind 原样显示" },
    ],
    danger: "normal",
  };
}

async function confirmWrite() {
  const p = preview.value;
  if (!p || busy.value) return;
  busy.value = true;
  sheetErr.value = "";
  try {
    await gwWrite(p.method, p.path, p.body);
    log.value.unshift({ text: `绑定已提交（网关确认 200）· 共 ${draft.value.length} 项`, ok: true });
    preview.value = null;
    editing.value = false;
    emit("changed");
  } catch (e) {
    const g = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
    const text = `提交失败 · kind=${g.kind}${g.code ? " · code=" + g.code : ""} · ${g.message}`;
    sheetErr.value = `${text}\n${g.hint}`;
    log.value.unshift({ text, ok: false });
  } finally {
    busy.value = false;
  }
}
function cancelWrite() {
  preview.value = null;
  sheetErr.value = "";
}

const noBindings = computed(() => !props.loading && !props.err && (props.bindings ?? []).length === 0);
</script>

<template>
  <div class="bind">
    <div class="small muted">
      绑定来自 <code>/settings</code> 的 <code>bindings[]</code>，按类型分类显示。编辑走 <code>PUT /settings</code> 的<b>全量覆盖</b>语义，提交前会在确认抽屉里摆出覆盖后的完整清单。
    </div>

    <div class="row" style="justify-content: flex-end; gap: 8px">
      <button v-if="!editing" class="ghost sm" type="button" @click="startEdit">编辑绑定</button>
      <template v-else>
        <button class="ghost sm" type="button" @click="cancelEdit">取消</button>
        <button class="ghost sm" type="button" @click="askSave">保存并确认</button>
      </template>
    </div>

    <div class="small errtext" v-if="err">这块没读出来：{{ (err as any).message || "读取失败" }}</div>
    <div class="empty" v-else-if="loading">加载中…</div>
    <div class="empty" v-else-if="noBindings && !editing">当前脚本没有任何 KV / R2 / D1 / service 绑定（接口返回的 bindings 为空数组）</div>

    <!-- 只读视图 -->
    <template v-if="!editing">
      <section v-for="c in CATS" :key="c.type" v-show="ofType(c.type).length" class="cat">
        <h4 class="ttl">{{ c.title }} · {{ ofType(c.type).length }}</h4>
        <div class="list">
          <div v-for="(b, i) in ofType(c.type)" :key="c.type + i" class="item">
            <div style="min-width: 0">
              <div class="k mono">{{ b.binding || b.name || "（无绑定名）" }}</div>
              <div class="small muted">{{ labelOf(b).sub }}</div>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- 编辑视图：一份完整 draft 数组 + 添加表单 -->
    <template v-else>
      <div class="cat">
        <h4 class="ttl">覆盖后将保留的绑定 · {{ draft.length }}</h4>
        <div v-if="!draft.length" class="empty">这份清单现在是空的——保存后这个 Worker 将不再有任何绑定</div>
        <div class="list">
          <div v-for="(b, i) in draft" :key="'d' + i" class="item">
            <div style="min-width: 0">
              <div class="k mono">{{ labelOf(b).head }}</div>
              <div class="small muted">{{ b.type }} · {{ labelOf(b).sub }}</div>
            </div>
            <div class="v"><button class="ghost sm danger" type="button" @click="removeDraft(i)">移除</button></div>
          </div>
        </div>
      </div>

      <div class="addbox">
        <div class="row gen">
          <select v-model="addType" class="field">
            <option value="kv_namespace">KV</option>
            <option value="r2_bucket">R2</option>
            <option value="d1_database">D1</option>
            <option value="service">服务</option>
          </select>
          <input v-model="addBinding" class="field" placeholder="绑定名 binding" spellcheck="false" />
          <input v-model="addTarget" class="field" :placeholder="addType === 'kv_namespace' ? 'namespace_id' : addType === 'r2_bucket' ? 'bucket_name' : addType === 'd1_database' ? 'database_name' : '被调用的 Worker 名'" spellcheck="false" />
          <button class="chip" type="button" @click="addDraft">添加</button>
        </div>
        <p class="small errtext" v-if="addErr">{{ addErr }}</p>
        <p class="small muted">{{ (CATS.find((c) => c.type === addType) || CATS[0]).whyCatalog }}</p>
      </div>
    </template>

    <div class="log" v-if="log.length">
      <div class="small muted">提交结果：</div>
      <div v-for="(l, i) in log" :key="i" :class="l.ok ? 'ok' : 'no'">{{ l.text }}</div>
    </div>

    <ConfirmSheet :preview="preview" :busy="busy" :error="sheetErr" @confirm="confirmWrite" @cancel="cancelWrite" />
  </div>
</template>

<style scoped>
.bind { display: flex; flex-direction: column; gap: 10px; }
.cat { display: flex; flex-direction: column; gap: 4px; }
.ttl { margin: 6px 0 0; font-size: 12px; color: var(--muted); font-weight: 600; }
.mono { font-family: var(--font-num); }
.errtext { color: var(--bad); }
button.sm { padding: 4px 10px; font-size: 12px; }
button.danger { color: var(--bad); border-color: rgb(var(--bad-rgb) / .45); }
.gen { flex-wrap: wrap; gap: 6px; }
.gen .field { max-width: 150px; }
.addbox { padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel-2); display: flex; flex-direction: column; gap: 6px; }
.log { display: flex; flex-direction: column; gap: 3px; }
.log .ok { color: var(--ok); font-size: 12px; }
.log .no { color: var(--bad); font-size: 12px; word-break: break-all; }
</style>
