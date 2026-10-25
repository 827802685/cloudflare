<script lang="ts">
/**
 * 绑定四件套（docs/13 §6.5）：KV / R2 / D1 / service 的「看」和「改」。
 *
 * 读侧：全部来自 `/settings` 的 `bindings[]`（api.workerSettings 已有），按 type 分类渲染。
 * 改侧：CF 改绑定是 `PUT /accounts/:a/workers/scripts/:s/settings`，而且这个 PUT 是**全量覆盖** ——
 *       提交的 bindings 数组就是最终状态，漏一条等于删一条。所以编辑模式在本地维护完整数组，
 *       提交前把「覆盖后的完整清单」摆进确认抽屉。
 * 路由状态：PUT /v1/workers/:s/settings 两层都已接通（网关侧转上游 PATCH + multipart part=settings，
 *          2026-10-20 实测 200）；客户端只发 bindings 数组，覆盖语义与确认抽屉保持一致。
 *
 * 目标目录：KV 用 GET /v1/kv 的命名空间列表、D1 用 GET /v1/d1 的库列表、service 用 GET /v1/workers 的脚本名，
 * 都是本机已有的读接口，进编辑模式时取一次；取不到就退回手填，并说明为什么。
 * R2 账号没开通（实测 403 10042 serviceDisabled），没有候选，只能手填桶名。
 */
export default { name: "VerBindingsPanel" };
</script>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import ConfirmSheet from "../ConfirmSheet.vue";
import { api, GwError, gwWrite, workerName, writesOptIn, type D1Database, type KvNamespace, type WritePreview } from "../../lib/api";
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
  { type: "kv_namespace", title: "Workers KV", whyCatalog: "候选来自 GET /v1/kv（命名空间列表），取不到时退回手填 namespace_id。" },
  { type: "r2_bucket", title: "R2 存储桶", whyCatalog: "这个账号没启用 R2（实测 403 code=10042 serviceDisabled），候选桶必然是空，只能手填 bucket_name。" },
  { type: "d1_database", title: "D1 数据库", whyCatalog: "候选来自 GET /v1/d1（库列表），取不到时退回手填 database_name。" },
  { type: "service", title: "服务绑定", whyCatalog: "候选来自 GET /v1/workers（脚本名）；环境按 production 填，可手改。" },
];

/**
 * 跨屏联动（2026-10-25）：绑定这一栏就是"这个 Worker 牵着哪些资源"的清单，
 * 写得出来归属就该点得过去 —— KV/D1/R2 落到数据库页对应分段，service 绑定落到另一个 Worker。
 * 以前这里只有文字：看得到"绑了哪个库"，却走不到那个库。
 */
const nav = useRouter();
function canGo(b: any): boolean {
  if (b?.type === "service") return !!String(b?.service ?? "").trim();
  return b?.type === "kv_namespace" || b?.type === "r2_bucket" || b?.type === "d1_database";
}
function goBinding(b: any) {
  switch (b?.type) {
    case "kv_namespace": nav.push("/database?store=kv"); return;
    case "r2_bucket": nav.push("/database?store=r2"); return;
    case "d1_database": nav.push("/database?store=d1"); return;
    case "service": {
      const s = String(b?.service ?? "").trim();
      if (s) nav.push(`/workers/${encodeURIComponent(s)}`);
      return;
    }
    default:
      return;
  }
}

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
  loadCats();
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

/* ---------- 候选：进编辑模式时取一次，取不到就手填 ---------- */
const cats = ref<{ kv: KvNamespace[]; d1: D1Database[]; workers: string[]; err: string }>({ kv: [], d1: [], workers: [], err: "" });
const catsLoading = ref(false);
async function loadCats() {
  if (catsLoading.value || cats.value.kv.length || cats.value.d1.length || cats.value.workers.length || cats.value.err) return;
  catsLoading.value = true;
  try {
    const [kv, d1, ws] = await Promise.all([api.kvNamespaces(), api.d1Databases(), api.workers()]);
    cats.value = {
      kv: kv.result ?? [],
      d1: d1.result ?? [],
      workers: (ws.result ?? []).map((w: any) => workerName(w)),
      err: "",
    };
  } catch (e) {
    cats.value = { ...cats.value, err: e instanceof GwError ? `${e.kind} ${e.message}` : String(e) };
  } finally {
    catsLoading.value = false;
  }
}

/** 当前类型能给的候选；R2 永远为空（账号没开通） */
const options = computed<{ value: string; label: string }[]>(() => {
  if (addType.value === "kv_namespace") return cats.value.kv.map((n) => ({ value: n.id, label: `${n.title || "(无标题)"} · ${n.id}` }));
  if (addType.value === "d1_database") return cats.value.d1.map((d) => ({ value: d.name, label: `${d.name} · ${shortId(d.uuid, 10)}` }));
  if (addType.value === "service") return cats.value.workers.filter((w) => w !== props.name).map((w) => ({ value: w, label: w }));
  return [];
});

const whyNow = computed(() => {
  if (addType.value === "r2_bucket") return (CATS.find((c) => c.type === addType.value) || CATS[0]).whyCatalog;
  if (cats.value.err) return `候选列表没取到（${cats.value.err}），只能手填。`;
  if (catsLoading.value) return "正在取候选列表…";
  if (!options.value.length) return "这个账号下没有候选，只能手填；也可能是当前授权读不到列表。";
  return `候选来自 ${addType.value === "kv_namespace" ? "GET /v1/kv" : addType.value === "d1_database" ? "GET /v1/d1" : "GET /v1/workers"}，共 ${options.value.length} 个。`;
});

/** 换类型时把上一类的目标清掉，避免把 namespace_id 当成库名提交 */
watch(addType, () => { addTarget.value = ""; addErr.value = ""; loadCats(); });

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
      { k: "路由状态", v: "上游形状 2026-10-19 实测（6 个绑定原样回写 200）：上游是 PATCH settings 且必须 multipart（JSON 415），part 名 settings —— 转换在两层里做，客户端只发 PUT {bindings}" },
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
          <div
            v-for="(b, i) in ofType(c.type)" :key="c.type + i" class="item"
            :class="{ tap: canGo(b) }"
            :title="canGo(b) ? '点一下去看这个资源' : undefined"
            @click="goBinding(b)"
          >
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
          <select v-if="options.length" v-model="addTarget" class="field" style="max-width: 240px">
            <option value="" disabled>{{ addType === "kv_namespace" ? "选择命名空间" : addType === "d1_database" ? "选择数据库" : "选择 Worker" }}</option>
            <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <input v-else v-model="addTarget" class="field" :placeholder="addType === 'kv_namespace' ? 'namespace_id' : addType === 'r2_bucket' ? 'bucket_name' : addType === 'd1_database' ? 'database_name' : '被调用的 Worker 名'" spellcheck="false" />
          <button class="chip" type="button" @click="addDraft">添加</button>
        </div>
        <p class="small errtext" v-if="addErr">{{ addErr }}</p>
        <p class="small muted">{{ whyNow }}</p>
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
