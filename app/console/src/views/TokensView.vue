<script setup lang="ts">
/**
 * 账户级 API Token 管理（APK 直连专属）。
 *
 * 为什么只做直连：OAuth 的 refresh token 只在系统钥匙串里，网关拿不到、也不该拿；
 * 网页模式没有可用的 OAuth 通道（docs/16 §1）。所以这一屏在浏览器里只显示一句说明。
 *
 * 三条硬约束：
 *  1. **建出来的令牌明文只出现一次**（上游只在 create / rotate 的响应里给 `value`）。
 *     这里只放内存，关掉弹层就没了 —— 不写 localStorage、不进日志。
 *  2. 建/删/轮转都是真写操作，和 DNS 一样受**本机写开关**管辖（直连模式这是唯一闸门）。
 *  3. 发出去之前把完整请求体摊开给人看：资源范围与权限组 id 都是上游要逐字匹配的东西，
 *     "以为会拒"不能当依据（docs/09 §B5 同一课）。
 *
 * 端点（官方文档 2026-10-21 核对，direct.ts 同源）：
 *   GET    /accounts/{id}/tokens
 *   GET    /accounts/{id}/tokens/permission_groups
 *   POST   /accounts/{id}/tokens
 *   PUT    /accounts/{id}/tokens/{tid}/value
 *   DELETE /accounts/{id}/tokens/{tid}
 */
import { computed, onMounted, ref } from "vue";
import ErrorNote from "../components/ErrorNote.vue";
import { GwError, isNativeApp, requireDirectCtx, setWritesOptIn, writesOptIn } from "../lib/api";
import {
  accountTokensDirect,
  createAccountTokenDirect,
  deleteAccountTokenDirect,
  permissionGroupsDirect,
  rotateAccountTokenDirect,
  type AccountToken,
  type NewAccountToken,
  type TokenResources,
} from "../lib/direct";
import { acctState, findAccount, labelOf } from "../lib/accounts";
import { dt } from "../lib/fmt";
import { loadConfig } from "../lib/config";

const native = isNativeApp();
const HEX32 = /^[0-9a-f]{32}$/i;

const toErr = (e: unknown) => (e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)));

/** 当前账号：直连模式下所有请求都绑定到 settings 里选中的那个 */
const account = computed(() => {
  const cfg = loadConfig();
  return (cfg.account ? findAccount(cfg.account) : null) || acctState.list[0] || null;
});
const accountId = computed(() => account.value?.id || "");
const accountName = computed(() => (account.value ? labelOf(account.value) : "没选账号"));

const tokens = ref<AccountToken[] | null>(null);
const listErr = ref<GwError | null>(null);
const loading = ref(false);
const busy = ref(false);
const actErr = ref<GwError | null>(null);

const groups = ref<any[] | null>(null);
const groupsErr = ref<GwError | null>(null);

const allowed = ref(writesOptIn());
function openWrites() {
  setWritesOptIn(true);
  allowed.value = true;
}

async function loadTokens() {
  if (!native || !accountId.value) return;
  loading.value = true;
  listErr.value = null;
  try {
    const ctx = await requireDirectCtx();
    tokens.value = (await accountTokensDirect(ctx)).result;
  } catch (e) {
    listErr.value = toErr(e);
  } finally {
    loading.value = false;
  }
}

async function loadGroups() {
  if (!native || !accountId.value || groups.value) return;
  try {
    const ctx = await requireDirectCtx();
    groups.value = (await permissionGroupsDirect(ctx)).result;
  } catch (e) {
    groupsErr.value = toErr(e);
  }
}

onMounted(() => {
  loadTokens();
  loadGroups();
});

/* ============================================================================
 * 新建
 * ========================================================================== */
const name = ref("");
const expires = ref("");
const scopeMode = ref<"account" | "zones">("account");
const zoneIds = ref("");
const groupQ = ref("");
const picked = ref<string[]>([]);
const manualGroups = ref("");
const preview = ref<NewAccountToken | null>(null);
const createErr = ref<GwError | null>(null);

const shownGroups = computed(() => {
  const s = groupQ.value.trim().toLowerCase();
  const arr = groups.value ?? [];
  return s ? arr.filter((g) => `${g.name ?? ""} ${g.scopes ?? ""} ${g.id}`.toLowerCase().includes(s)) : arr;
});

function toggleGroup(id: string) {
  const i = picked.value.indexOf(id);
  if (i >= 0) picked.value.splice(i, 1);
  else picked.value.push(id);
}

function buildPreview() {
  createErr.value = null;
  preview.value = null;

  const n = name.value.trim();
  if (!n) { createErr.value = new GwError("badQuery", 422, null, "先给令牌起个名字"); return; }
  if (!accountId.value) { createErr.value = new GwError("badQuery", 422, null, "还没选账号"); return; }

  const resources: TokenResources = {};
  if (scopeMode.value === "account") {
    resources[`com.cloudflare.api.account.${accountId.value}`] = "*";
  } else {
    const ids = zoneIds.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length) { createErr.value = new GwError("badQuery", 422, null, "指定站点范围时至少要填一个 Zone ID"); return; }
    for (const z of ids) {
      if (!HEX32.test(z)) { createErr.value = new GwError("badQuery", 422, null, `Zone ID 得是 32 位十六进制：${z}`); return; }
      resources[`com.cloudflare.api.account.zone.${z}`] = "*";
    }
  }

  const manual = manualGroups.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  for (const id of manual) {
    if (!HEX32.test(id)) { createErr.value = new GwError("badQuery", 422, null, `权限组 id 得是 32 位十六进制：${id}`); return; }
  }
  const groupIds = [...new Set([...picked.value, ...manual])];
  if (!groupIds.length) { createErr.value = new GwError("badQuery", 422, null, "至少选一个权限组（决定这把令牌能做什么）"); return; }

  let expiresOn: string | undefined;
  if (expires.value) {
    // 日期输入只有天：取当天 23:59:59Z，避免"选了明天却按今天零点过期"
    const t = Date.parse(`${expires.value}T23:59:59Z`);
    if (!Number.isFinite(t) || t <= Date.now()) { createErr.value = new GwError("badQuery", 422, null, "到期时间必须晚于现在"); return; }
    expiresOn = new Date(t).toISOString();
  }

  preview.value = {
    name: n,
    policies: [{ effect: "allow", resources, permission_groups: groupIds.map((id) => ({ id })) }],
    ...(expiresOn ? { expires_on: expiresOn } : {}),
  };
}

/* ============================================================================
 * 一次性明文
 * ========================================================================== */
const created = ref<{ name: string; value: string } | null>(null);
const copied = ref("");
async function copyValue() {
  if (!created.value) return;
  try {
    await navigator.clipboard.writeText(created.value.value);
    copied.value = "已复制";
  } catch {
    copied.value = "复制失败，请长按选中";
  }
}
function dismissCreated() {
  created.value = null;
  copied.value = "";
}

async function doCreate() {
  if (!preview.value || busy.value) return;
  busy.value = true;
  actErr.value = null;
  try {
    const ctx = await requireDirectCtx();
    const r = await createAccountTokenDirect(ctx, preview.value);
    // 明文只在这一刻存在：先落到内存态，再把表单清掉
    if (r?.value) created.value = { name: String(r.name ?? preview.value.name), value: String(r.value) };
    preview.value = null;
    name.value = "";
    expires.value = "";
    zoneIds.value = "";
    picked.value = [];
    manualGroups.value = "";
    await loadTokens();
  } catch (e) {
    actErr.value = toErr(e);
  } finally {
    busy.value = false;
  }
}

/* ============================================================================
 * 删除 / 轮转：都要求二次确认（轮转会让旧值立刻失效，和删除同级）
 * ========================================================================== */
const confirmDel = ref("");
const confirmRot = ref("");
/** 删除要求把名称敲一遍（不可逆动作的最小摩擦） */
const typedDel = ref("");

async function doDelete(t: AccountToken) {
  if (busy.value) return;
  busy.value = true;
  actErr.value = null;
  try {
    const ctx = await requireDirectCtx();
    await deleteAccountTokenDirect(ctx, t.id);
    confirmDel.value = "";
    await loadTokens();
  } catch (e) {
    actErr.value = toErr(e);
  } finally {
    busy.value = false;
  }
}

async function doRotate(t: AccountToken) {
  if (busy.value) return;
  busy.value = true;
  actErr.value = null;
  try {
    const ctx = await requireDirectCtx();
    const r = await rotateAccountTokenDirect(ctx, t.id);
    if (r?.value) created.value = { name: String(r.name ?? t.name ?? t.id.slice(0, 8)), value: String(r.value) };
    confirmRot.value = "";
    await loadTokens();
  } catch (e) {
    actErr.value = toErr(e);
  } finally {
    busy.value = false;
  }
}

const listEmpty = computed(() => !loading.value && tokens.value?.length === 0 && !listErr.value);
</script>

<template>
  <div class="tk">
    <div class="card wide">
      <h3>API 令牌（账户级）</h3>

      <template v-if="!native">
        <div class="small muted">
          这一屏只在 <b>APK 直连模式</b>可用：OAuth 凭据保存在系统钥匙串里、请求直连 Cloudflare，
          浏览器模式没有这条通道（也没有系统钥匙串）。网页端请继续用 API Token 方式。
        </div>
      </template>

      <template v-else>
        <div class="small muted">
          当前账号：<b>{{ accountName }}</b> · <code class="mono">{{ accountId ? accountId.slice(0, 8) + "…" : "—" }}</code>
          <br />
          建出来的令牌明文<b>只显示一次</b>，本应用不保存；用到它的地方请当场复制走。
        </div>

        <div v-if="!allowed" class="row" style="margin-top: 12px; align-items: center">
          <button class="primary" @click="openWrites">打开本机写开关</button>
          <span class="small muted">创建 / 轮转 / 删除都会真实改变账号上的令牌，先开闸。</span>
        </div>

        <div class="row" style="margin-top: 12px">
          <button class="ghost" :disabled="loading" @click="loadTokens">{{ loading ? "读取中…" : "刷新列表" }}</button>
          <router-link class="chip" to="/settings">回设置</router-link>
        </div>
        <ErrorNote :err="listErr || undefined" />
      </template>
    </div>

    <!-- ============ 一次性明文 ============ -->
    <div v-if="created" class="card wide secret">
      <h3>只显示这一次</h3>
      <div class="small">
        令牌「{{ created.name }}」的明文如下。关掉这块就再也看不到 —— 丢了只能轮转或重建。
      </div>
      <div class="mono val">{{ created.value }}</div>
      <div class="row">
        <button class="primary" @click="copyValue">{{ copied || "复制令牌" }}</button>
        <button class="ghost" @click="dismissCreated">我已保存，关掉</button>
      </div>
    </div>

    <!-- ============ 新建 ============ -->
    <div v-if="native" class="card wide">
      <h3>新建令牌</h3>
      <fieldset :disabled="!allowed || busy" class="plain">
        <label class="lbl">名称</label>
        <input v-model="name" class="field" placeholder="例如：只读巡检 / CI 部署" spellcheck="false" />

        <label class="lbl" style="margin-top: 10px">到期时间（可选，留空 = 长期）</label>
        <input v-model="expires" class="field" type="date" />

        <div class="opt">
          <div class="opt-h">资源范围</div>
          <div class="row">
            <button class="chip" :class="{ on: scopeMode === 'account' }" @click="scopeMode = 'account'">整个账号</button>
            <button class="chip" :class="{ on: scopeMode === 'zones' }" @click="scopeMode = 'zones'">指定站点</button>
          </div>
          <div v-if="scopeMode === 'account'" class="small muted" style="margin-top: 6px">
            资源键：<code class="mono">com.cloudflare.api.account.{{ accountId || "<account_id>" }}</code> = <code class="mono">*</code>
          </div>
          <template v-else>
            <input v-model="zoneIds" class="field" style="margin-top: 8px" placeholder="Zone ID，多个用逗号隔开" spellcheck="false" />
            <div class="small muted" style="margin-top: 6px">
              每项会展开成 <code class="mono">com.cloudflare.api.account.zone.&lt;id&gt;</code> = <code class="mono">*</code>
            </div>
          </template>
        </div>

        <div class="opt">
          <div class="opt-h">权限组（决定能做什么；至少一个）</div>
          <template v-if="groups?.length">
            <input v-model="groupQ" class="field" placeholder="筛选权限组名称 / scope / id" spellcheck="false" />
            <div class="groups">
              <button
                v-for="g in shownGroups"
                :key="g.id"
                class="chip"
                :class="{ on: picked.includes(g.id) }"
                @click="toggleGroup(g.id)"
              >
                {{ g.name || g.meta?.label || g.id.slice(0, 8) }}
                <span v-if="g.scopes" class="gs">{{ g.scopes }}</span>
              </button>
            </div>
            <div v-if="!shownGroups.length" class="small muted">筛选后没有匹配项。</div>
          </template>
          <template v-else>
            <ErrorNote v-if="groupsErr" :err="groupsErr" />
            <div class="small muted">
              {{ groupsErr ? "读不到权限组清单（多半是这把令牌 / OAuth 授权没带 Token 读权限）。可以直接填 id：" : "权限组清单读取中…" }}
            </div>
            <input v-model="manualGroups" class="field" style="margin-top: 8px" placeholder="权限组 id，多个用逗号隔开" spellcheck="false" />
          </template>
          <div v-if="picked.length" class="small muted" style="margin-top: 6px">已选 {{ picked.length }} 个。</div>
        </div>

        <div class="row" style="margin-top: 12px">
          <button class="primary" :disabled="!allowed || busy" @click="buildPreview">{{ busy ? "提交中…" : "预览请求体" }}</button>
        </div>
        <ErrorNote :err="createErr || undefined" />
        <ErrorNote :err="actErr || undefined" />
      </fieldset>

      <!-- 发出去之前把要发的每个字段摊开：资源键和权限组 id 都是上游逐字匹配的 -->
      <div v-if="preview" class="confirm">
        <div class="small"><b>即将发送</b> <code class="mono">POST /accounts/{{ accountId }}/tokens</code></div>
        <pre class="mono body">{{ JSON.stringify(preview, null, 2) }}</pre>
        <div class="row">
          <button class="primary" :disabled="busy" @click="doCreate">{{ busy ? "创建中…" : "确认创建" }}</button>
          <button class="ghost" :disabled="busy" @click="preview = null">先不发</button>
        </div>
      </div>
    </div>

    <!-- ============ 列表 ============ -->
    <div v-if="native" class="card wide">
      <h3>这个账号的令牌</h3>

      <div v-if="listEmpty" class="empty">这个账号下还没有令牌（或者这把凭据看不到）。</div>
      <div v-else-if="tokens?.length" class="list">
        <div v-for="t in tokens" :key="t.id" class="item">
          <div class="k">
            {{ t.name || t.id.slice(0, 8) }}
            <div class="small muted">
              <code class="mono">{{ t.id.slice(0, 8) }}…</code>
              <span v-if="t.status"> · {{ t.status }}</span>
              <span v-if="t.expires_on"> · 到期 {{ dt(Date.parse(t.expires_on)) }}</span>
            </div>
          </div>
          <div class="row">
            <button class="chip" :disabled="busy || !allowed" @click="confirmRot = t.id">轮转</button>
            <button class="chip" :disabled="busy || !allowed" @click="confirmDel = t.id">删除</button>
          </div>

          <!-- 轮转：旧值立刻失效，必须说清后果 -->
          <div v-if="confirmRot === t.id" class="confirm" style="grid-column: 1 / -1">
            <div class="small">
              轮转会给「{{ t.name || t.id.slice(0, 8) }}」换一把新值，<b>旧值立刻失效</b>。
              所有用到它的地方要同步换成新值，否则会 401。
            </div>
            <div class="row" style="margin-top: 8px">
              <button class="primary" :disabled="busy" @click="doRotate(t)">{{ busy ? "轮转中…" : "确认轮转" }}</button>
              <button class="ghost" :disabled="busy" @click="confirmRot = ''">先不转</button>
            </div>
          </div>

          <!-- 删除：不可逆，要求把名称敲一遍 -->
          <div v-if="confirmDel === t.id" class="confirm" style="grid-column: 1 / -1">
            <div class="small">
              删除「<b>{{ t.name || t.id.slice(0, 8) }}</b>」不可撤销，用到它的脚本 / CI 会立刻 401。
            </div>
            <div class="row" style="margin-top: 8px">
              <input v-model="typedDel" class="field" style="flex: 1" :placeholder="t.name || t.id.slice(0, 8)" spellcheck="false" />
              <button class="primary" :disabled="busy || typedDel.trim() !== (t.name || t.id.slice(0, 8))" @click="doDelete(t)">
                {{ busy ? "删除中…" : "确认删除" }}
              </button>
              <button class="ghost" :disabled="busy" @click="confirmDel = ''; typedDel = ''">先不删</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="small muted">{{ loading ? "读取中…" : "还没有取到列表。" }}</div>
    </div>
  </div>
</template>

<style scoped>
.tk { display: grid; gap: 12px; grid-template-columns: 1fr; align-items: start; }
@media (min-width: 880px) { .tk { grid-template-columns: 1fr 1fr; } .tk > .wide { grid-column: 1 / -1; } }
.tk > .card { margin-bottom: 0; }
.plain { border: 0; margin: 0; padding: 0; min-width: 0; }
.opt { margin-top: 12px; }
.opt-h { font-size: var(--t-xs); color: var(--muted); letter-spacing: .04em; margin-bottom: 6px; }
.groups { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; max-height: 220px; overflow: auto; }
.gs { font-size: 10.5px; opacity: .65; margin-left: 4px; }
.confirm { margin-top: 12px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; }
.body { margin: 8px 0 0; padding: 10px; border-radius: 8px; background: var(--bg-inset, #f7f7f7); font-size: 11.5px; overflow: auto; max-height: 320px; }
.secret .val { margin: 10px 0; padding: 10px; border-radius: 8px; border: 1px dashed var(--line); word-break: break-all; font-size: 12.5px; }
.item { flex-wrap: wrap; }
</style>
