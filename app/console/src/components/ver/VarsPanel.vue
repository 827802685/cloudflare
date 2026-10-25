<script lang="ts">
/**
 * 变量 + Secret（docs/13 §6.5、§6.6）：
 *  - 普通变量 plain_text：值可读，来自 `/settings` 的 `bindings[]`；改它走 `PUT /settings` 全量覆盖。
 *  - Secret secret_text：**只写不读** —— CF 的读接口只回 `{name,type}`，永远不回值。界面必须把这句话说出来，
 *    不能显示空值框让人以为值是空的。改/删 Secret 走独立路由：POST /secrets、DELETE /secrets/:name。
 *
 * JSON 类型校验（§6.5「变量 JSON type validation」）：用户在变量里塞 JSON 字符串很常见，
 * 存进去是一整串文本、代码里再 JSON.parse。这里对「看起来是 JSON 却解析不了」的值当场报错，
 * 不静默保存（竞品对非法 TTL 静默当 1 处理是反面样本）。
 */
export default { name: "VerVarsPanel" };
</script>

<script setup lang="ts">
import { computed, ref } from "vue";
import ConfirmSheet from "../ConfirmSheet.vue";
import WriteGate from "../WriteGate.vue";
import { GwError, gwWrite, writesOptIn, type WritePreview } from "../../lib/api";

const props = withDefaults(
  defineProps<{
    name: string;
    bindings?: any[] | null;
    secrets?: any[] | null;
    loading?: boolean;
    err?: GwError | { kind?: string; message?: string } | null;
  }>(),
  { bindings: null, secrets: null, loading: false, err: null },
);
const emit = defineEmits<{ (e: "changed"): void }>();

const plain = computed<any[]>(() => (props.bindings ?? []).filter((b: any) => b?.type === "plain_text"));
const secretNames = computed<string[]>(() => {
  const s = new Set<string>();
  for (const b of props.bindings ?? []) if (b?.type === "secret_text" && (b.name || b.binding)) s.add(String(b.name || b.binding));
  for (const x of props.secrets ?? []) if (x?.name) s.add(String(x.name));
  return [...s].sort();
});

/* ---------- 值类型判定 + JSON 校验 ---------- */
type ValKind = "string" | "number" | "boolean" | "json" | "empty";
function guessKind(v: string): ValKind {
  const t = v.trim();
  if (t === "") return "empty";
  if (t === "true" || t === "false") return "boolean";
  if (t !== "" && !isNaN(Number(t)) && /^-?\d+(\.\d+)?$/.test(t)) return "number";
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) return "json";
  return "string";
}
/** 返回错误文案；空串表示通过。JSON 形状但不合法才拦，其它类型原样存文本没问题 */
function validateVal(v: string): string {
  const t = v.trim();
  if (guessKind(v) === "json") {
    try { JSON.parse(t); } catch (e) { return `看起来是 JSON，但解析失败：${(e as Error).message}`; }
  }
  return "";
}
const KIND_TAG: Record<ValKind, string> = { string: "文本", number: "数字", boolean: "布尔", json: "JSON", empty: "空串" };

function previewValue(v: string): string {
  if (v === "" || v === undefined || v === null) return "（空串）";
  return v.length > 60 ? v.slice(0, 60) + `…（共 ${v.length} 字符）` : v;
}

/* ---------- 普通变量编辑：本地 draft，提交时 PUT 全量覆盖 ---------- */
const editingVars = ref(false);
const vDraft = ref<{ name: string; value: string }[]>([]);
const vErr = ref("");
const addName = ref("");
const addVal = ref("");

function startVars() {
  vDraft.value = plain.value.map((b: any) => ({ name: String(b.name || b.binding || ""), value: String(b.value ?? "") }));
  vErr.value = "";
  editingVars.value = true;
}
function cancelVars() {
  editingVars.value = false;
  vDraft.value = [];
  addName.value = "";
  addVal.value = "";
  vErr.value = "";
}
function addVar() {
  vErr.value = "";
  const n = addName.value.trim();
  if (!n) { vErr.value = "变量名不能为空"; return; }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) { vErr.value = `变量名「${n}」不合法：要用字母或下划线开头、只含字母数字下划线`; return; }
  if (vDraft.value.some((x) => x.name === n)) { vErr.value = `变量「${n}」已经在了`; return; }
  const bad = validateVal(addVal.value);
  if (bad) { vErr.value = `变量「${n}」的值：${bad}`; return; }
  vDraft.value.push({ name: n, value: addVal.value });
  addName.value = "";
  addVal.value = "";
}
function removeVar(i: number) { vDraft.value.splice(i, 1); }

/* ---------- Secret 只写不读：新增 / 删除 ---------- */
const secName = ref("");
const secVal = ref("");
const secErr = ref("");
function askAddSecret() {
  secErr.value = "";
  const n = secName.value.trim();
  if (!n) { secErr.value = "Secret 名不能为空"; return; }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) { secErr.value = `Secret 名「${n}」不合法`; return; }
  if (secVal.value === "") { secErr.value = "Secret 值不能为空（CF 不接受空 secret，要清空请用删除）"; return; }
  sheetErr.value = "";
  preview.value = {
    method: "POST",
    path: `/v1/workers/${encodeURIComponent(props.name)}/secrets`,
    // 值确实要发出去，所以这就是真要发的 body；ConfirmSheet 会原样显示（这正是它的用途：发之前让人看全）
    body: { name: n, text: secVal.value, type: "secret_text" },
    title: `新增/更新 Secret ${n}`,
    lines: [
      { k: "Worker", v: props.name },
      { k: "Secret 名", v: n },
      { k: "值", v: previewValue(secVal.value) + "（完整值见下方请求体）" },
      { k: "读取说明", v: "CF 的 Secret 读接口只返回名字与类型、从不返回值，所以这一屏无法显示它当前的值，也无法回显对比；这是 API 的限制，不是没读到" },
      { k: "路由状态", v: "上游形状 2026-10-19 实测（真建真删自清理）：客户端 POST → 上游 PUT secrets {name,text,type}，201 确认" },
    ],
    danger: "normal",
  };
  pending.value = { kind: "addSecret" };
}

function askDeleteSecret(name: string) {
  sheetErr.value = "";
  preview.value = {
    method: "DELETE",
    path: `/v1/workers/${encodeURIComponent(props.name)}/secrets/${encodeURIComponent(name)}`,
    body: undefined,
    title: `删除 Secret ${name}`,
    lines: [
      { k: "Worker", v: props.name },
      { k: "要删除的记录", v: name },
      { k: "后果", v: `删除后脚本里对 secret_text「${name}」的读取会得到 undefined，可能导致运行时报错` },
      { k: "路由状态", v: "上游形状 2026-10-19 实测（建后即删自清理）：DELETE secrets/{name} → 200" },
    ],
    danger: "irreversible",
  };
  pending.value = { kind: "delSecret", name };
}

function askSaveVars() {
  vErr.value = "";
  for (const v of vDraft.value) {
    const bad = validateVal(v.value);
    if (bad) { vErr.value = `变量「${v.name}」：${bad}`; return; }
  }
  // 全量覆盖：保留非 plain_text 的绑定，替换 plain_text 部分
  const nonPlain = (props.bindings ?? []).filter((b: any) => b?.type !== "plain_text");
  const newPlain = vDraft.value.map((v) => ({ type: "plain_text", name: v.name, binding: v.name, value: v.value }));
  const nextBindings = [...nonPlain, ...newPlain];
  sheetErr.value = "";
  preview.value = {
    method: "PUT",
    path: `/v1/workers/${encodeURIComponent(props.name)}/settings`,
    body: { bindings: nextBindings },
    title: "保存普通变量（全量覆盖）",
    lines: [
      { k: "Worker", v: props.name },
      { k: "语义", v: "CF 改变量走 PUT /settings 全量覆盖 bindings：漏掉的绑定（含 KV/R2/D1/service）会被一并删除" },
      { k: "覆盖后变量", v: vDraft.value.length ? vDraft.value.map((v) => `${v.name}=${previewValue(v.value)}`).join(" ｜ ") : "无普通变量" },
      { k: "覆盖后其它绑定", v: `${nonPlain.length} 项（保持原样一起提交）` },
      { k: "路由状态", v: "上游形状 2026-10-19 实测（6 个绑定原样回写 200）：上游是 PATCH settings 且必须 multipart（JSON 415），part 名 settings —— 转换在两层里做，客户端只发 PUT {bindings}" },
    ],
    danger: "normal",
  };
  pending.value = { kind: "saveVars", after: () => { editingVars.value = false; vDraft.value = []; } };
}

/* ---------- 统一写侧状态 ---------- */
const preview = ref<WritePreview | null>(null);
const busy = ref(false);
const sheetErr = ref("");
const log = ref<{ text: string; ok: boolean }[]>([]);
const pending = ref<{ kind: "addSecret" | "delSecret" | "saveVars"; name?: string; after?: () => void } | null>(null);
const optIn = ref(writesOptIn());

async function confirmWrite() {
  const p = preview.value;
  const pd = pending.value;
  if (!p || !pd || busy.value) return;
  busy.value = true;
  sheetErr.value = "";
  try {
    await gwWrite(p.method, p.path, p.body);
    const done = pd.kind === "addSecret" ? `Secret「${secName.value.trim()}」已提交（网关确认 200）`
      : pd.kind === "delSecret" ? `Secret「${pd.name}」已删除（网关确认 200）`
      : "普通变量已保存（网关确认 200）";
    log.value.unshift({ text: done, ok: true });
    if (pd.kind === "addSecret") { secName.value = ""; secVal.value = ""; }
    pd.after?.();
    preview.value = null;
    pending.value = null;
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
  pending.value = null;
  sheetErr.value = "";
}
</script>

<template>
  <div class="vars">
    <!-- 原来这里只有一行"已打开/未打开"的文字，看得见却开不了；换成同一个开关组件，就地能开 -->
    <WriteGate v-model="optIn" variant="inline" />
    <p class="small muted" v-if="!optIn">关着时点保存只会准备请求、不发出。</p>

    <div class="small errtext" v-if="err && !loading">这块没读出来：{{ (err as any).message || "读取失败" }}</div>
    <div class="empty" v-else-if="loading">加载中…</div>

    <template v-else>
      <!-- 普通变量 -->
      <section class="block">
        <div class="row" style="justify-content: space-between">
          <h4 class="ttl">普通变量 plain_text · {{ plain.length }}</h4>
          <div class="row" style="gap: 8px">
            <button v-if="!editingVars" class="ghost sm" type="button" @click="startVars">编辑变量</button>
            <template v-else>
              <button class="ghost sm" type="button" @click="cancelVars">取消</button>
              <button class="ghost sm" type="button" @click="askSaveVars">保存并确认</button>
            </template>
          </div>
        </div>
        <p class="small muted">值可从接口读出；看起来是 JSON 的值会当场校验能否解析，解析不了不给存。</p>

        <div v-if="!editingVars">
          <div v-if="!plain.length" class="empty">没有普通变量（接口返回的 plain_text 为空）</div>
          <div class="list" v-else>
            <div v-for="(b, i) in plain" :key="'p' + i" class="item">
              <div style="min-width: 0">
                <div class="k mono">{{ b.name || b.binding }}</div>
                <div class="small muted mono">{{ previewValue(String(b.value ?? "")) }}</div>
              </div>
              <div class="v"><span class="badge">{{ KIND_TAG[guessKind(String(b.value ?? ""))] }}</span></div>
            </div>
          </div>
        </div>

        <div v-else class="editbox">
          <div v-if="!vDraft.length" class="empty">这份清单现在是空的——保存后这个 Worker 将不再有任何普通变量</div>
          <div v-for="(v, i) in vDraft" :key="'v' + i" class="vrow">
            <div class="row" style="gap: 6px; justify-content: space-between">
              <span class="k mono">{{ v.name }}</span>
              <span>
                <span class="badge">{{ KIND_TAG[guessKind(v.value)] }}</span>
                <button class="ghost sm danger" type="button" @click="removeVar(i)">移除</button>
              </span>
            </div>
            <textarea v-model="v.value" class="field ta" rows="2" spellcheck="false" />
          </div>
          <div class="row gen" style="margin-top: 8px">
            <input v-model="addName" class="field" placeholder="新变量名" spellcheck="false" />
            <input v-model="addVal" class="field" placeholder="值（JSON 会当场校验）" spellcheck="false" />
            <button class="chip" type="button" @click="addVar">添加</button>
          </div>
          <p class="small errtext" v-if="vErr">{{ vErr }}</p>
        </div>
      </section>

      <!-- Secret -->
      <section class="block">
        <h4 class="ttl">Secret secret_text · {{ secretNames.length }}</h4>
        <p class="small muted">
          <b>只写不读</b>：CF 的 Secret 读接口只返回名字与类型，<b>从不返回值</b>。所以下面只有名字、没有值，也回显不了当前值——这是 API 本身的限制。
        </p>
        <div v-if="!secretNames.length" class="empty">没有 Secret</div>
        <div class="list" v-else>
          <div v-for="n in secretNames" :key="n" class="item">
            <div style="min-width: 0"><div class="k mono">{{ n }}</div><div class="small muted">值：接口不返回（只写不读）</div></div>
            <div class="v"><button class="ghost sm danger" type="button" @click="askDeleteSecret(n)">删除</button></div>
          </div>
        </div>

        <div class="editbox" style="margin-top: 8px">
          <div class="row gen">
            <input v-model="secName" class="field" placeholder="Secret 名" spellcheck="false" autocomplete="off" />
            <input v-model="secVal" class="field" type="password" placeholder="Secret 值（写入后无法再读回）" spellcheck="false" autocomplete="off" />
            <button class="chip" type="button" @click="askAddSecret">写入</button>
          </div>
          <p class="small errtext" v-if="secErr">{{ secErr }}</p>
        </div>
      </section>
    </template>

    <div class="log" v-if="log.length">
      <div class="small muted">提交结果：</div>
      <div v-for="(l, i) in log" :key="i" :class="l.ok ? 'ok' : 'no'">{{ l.text }}</div>
    </div>

    <ConfirmSheet :preview="preview" :busy="busy" :error="sheetErr" @confirm="confirmWrite" @cancel="cancelWrite" />
  </div>
</template>

<style scoped>
.vars { display: flex; flex-direction: column; gap: 12px; }
.block { display: flex; flex-direction: column; gap: 6px; }
.ttl { margin: 0; font-size: 12px; color: var(--muted); font-weight: 600; }
.mono { font-family: var(--font-num); }
.errtext { color: var(--bad); }
button.sm { padding: 4px 10px; font-size: 12px; }
button.danger { color: var(--bad); border-color: rgb(var(--bad-rgb) / .45); }
.editbox { padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--panel-2); display: flex; flex-direction: column; gap: 8px; }
.vrow { display: flex; flex-direction: column; gap: 4px; padding-bottom: 6px; border-bottom: 1px dashed var(--line); }
.ta { font-family: var(--font-num); font-size: 12px; resize: vertical; }
.gen { flex-wrap: wrap; gap: 6px; }
.gen .field { max-width: 180px; }
.log { display: flex; flex-direction: column; gap: 3px; }
.log .ok { color: var(--ok); font-size: 12px; }
.log .no { color: var(--bad); font-size: 12px; word-break: break-all; }
</style>
