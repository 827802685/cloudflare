<script lang="ts">
/**
 * 版本历史 + 版本详情弹窗（docs/13 §2.3、§2.4）。竞品的「版本」不是列表屏而是弹窗，
 * 而且「异步拉详情 = 先弹加载态、数据回来后原地替换」（§7.3）落在这里：
 * 点一行 → 这一行下面出现加载中 → 拿到数据原地换成字段表，不关弹窗、不跳页。
 *
 * 「运行中」的判定不在这，统一用 RunningBadge 导出的 runningModel()（§8.1 红线只允许一处实现）。
 */
export default { name: "VerVersionDialog" };
</script>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import ConfirmSheet from "../ConfirmSheet.vue";
import ErrorNote from "../ErrorNote.vue";
import AsyncBlock from "./AsyncBlock.vue";
import DialogShell from "./DialogShell.vue";
import RunningBadge, { CANONICAL_NOTE, byNumberDesc, runningModel } from "./RunningBadge.vue";
import { api, dropMem, GwError, gwWrite, type WritePreview } from "../../lib/api";
import { dt, shortId } from "../../lib/fmt";

const props = withDefaults(
  defineProps<{
    name: string;
    versions: any[];
    deployments?: any[];
    loading?: boolean;
    err?: GwError | { kind?: string; message?: string } | null;
    /** CF 给了 total 就以它为准（实测 result_info.total_count 存在） */
    total?: number | null;
    /** 指向本 Worker 的主机名（自定义域名 / Zone 路由），「访问」按钮只在运行中版本出现时用 */
    hosts?: { host: string; via: string }[];
  }>(),
  { deployments: () => [], loading: false, err: null, total: null, hosts: () => [] },
);
const emit = defineEmits<{ (e: "close"): void; (e: "retry"): void; (e: "changed"): void }>();

const run = computed(() => runningModel(props.deployments));
const note = computed(() => (run.value.note ? run.value.note : CANONICAL_NOTE));
const rowState = (id: unknown) => {
  const s = String(id ?? "");
  return { on: run.value.ids.includes(s), pct: run.value.pct[s] ?? null };
};

/** 版本号最大的一条 ≠ 最新部署指向的版本：这个矛盾要写出来，不许挑一个当"运行中" */
const mismatch = computed(() => {
  const ids = run.value.ids;
  if (!ids.length || !props.versions.length || run.value.ambiguous) return "";
  const newest = byNumberDesc(props.versions)[0];
  const nid = String(newest?.id ?? "");
  if (!nid || ids.includes(nid)) return "";
  const who = ids.map((i) => `${shortId(i, 8)} ${run.value.pct[i] ?? "?"}%`).join(" + ");
  return `版本列表最新的是 #${newest.number}（${shortId(nid, 8)}），但最新部署指向 ${who} —— 两者不一致。界面按部署指向判「运行中」，不拿最新版本冒充它在跑。`;
});

/* ---------- 详情：加载态 → 原地替换 ---------- */
const openId = ref("");
const detail = ref<any | null>(null);
const detailErr = ref<GwError | null>(null);
const detailLoading = ref(false);

async function openDetail(v: any) {
  const id = String(v?.id ?? "");
  if (!id) return;
  if (openId.value === id) { closeDetail(); return; }
  openId.value = id;
  detail.value = null;
  detailErr.value = null;
  detailLoading.value = true;
  try {
    detail.value = (await api.workerVersion(props.name, id)).result ?? null;
  } catch (e) {
    detailErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    detailLoading.value = false;
  }
}
function closeDetail() {
  openId.value = "";
  detail.value = null;
  detailErr.value = null;
}

/** 反向索引（CF 不给「版本 → 部署」，只能前端对号；取第一条命中的） */
const detailDeployment = computed(() => {
  const id = String(detail.value?.id ?? "");
  if (!id) return null;
  return (props.deployments ?? []).find((d: any) => (d?.versions ?? []).some((x: any) => x?.version_id === id)) ?? null;
});
const detailPct = computed(() => {
  const id = String(detail.value?.id ?? "");
  const hit: any = (detailDeployment.value?.versions ?? []).find((x: any) => x?.version_id === id);
  return hit ? Number(hit.percentage ?? 100) : null;
});

/* ---------- 删除单个版本（走 ConfirmSheet + gwWrite；网关这条路由还没加白） ---------- */
const preview = ref<WritePreview | null>(null);
const pending = ref<any | null>(null);
const busy = ref(false);
const sheetErr = ref("");
/** 每次尝试都留一行可读结果，不做一闪而过的 toast（docs/13 §8.2） */
const log = ref<{ text: string; ok: boolean }[]>([]);

function askDelete(v: any) {
  const id = String(v?.id ?? "");
  if (!id || rowState(id).on || run.value.ambiguous) return;
  pending.value = v;
  sheetErr.value = "";
  preview.value = {
    method: "DELETE",
    path: `/v1/workers/${encodeURIComponent(props.name)}/versions/${encodeURIComponent(id)}`,
    body: undefined,
    title: `删除版本 #${v.number}`,
    lines: [
      { k: "Worker", v: props.name },
      // ConfirmSheet 的「再敲一遍对象名」闸门读这一行；放 8 位短 ID，手机上敲得动
      { k: "要删除的记录", v: shortId(id, 8) },
      { k: "完整版本 ID", v: id },
      { k: "创建时间", v: dt(v?.metadata?.created_on) },
      { k: "当前流量", v: "不在最新部署的 versions[] 里（0%）" },
      { k: "后果", v: "版本删除不可恢复：脚本本体与其它版本不受影响，但这一版再也部署不回来。" },
      { k: "路由状态", v: "⚠️ 2026-10-19 实测：CF 对 API Token 删版本一律 405（这条端点只认 Global API Key）。路由会照实把请求发上去；用普通 Token 会收到 405，想删版本请换 Global Key 或去 Dashboard 操作。删部署记录不受限（清理面板那条可用）。" },
    ],
    danger: "irreversible",
  };
}

async function confirmDelete() {
  const v = pending.value;
  const p = preview.value;
  if (!v || !p || busy.value) return;
  busy.value = true;
  sheetErr.value = "";
  const id = String(v.id);
  try {
    // 真的 await：竞品那种 delay(500) 再无条件报成功是反面样本（docs/13 §8.2）
    await gwWrite("DELETE", p.path);
    log.value.unshift({ text: `#${v.number} ${shortId(id, 8)} 已删除（网关确认 200）`, ok: true });
    preview.value = null;
    pending.value = null;
    if (openId.value === id) closeDetail();
    dropMem("/v1/workers/" + encodeURIComponent(props.name));
    emit("changed");
  } catch (e) {
    const g = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
    const text = `#${v.number} ${shortId(id, 8)} 删除失败 · kind=${g.kind}${g.code ? " · code=" + g.code : ""} · ${g.message}`;
    sheetErr.value = `${text}\n${g.hint}`;
    log.value.unshift({ text, ok: false });
  } finally {
    busy.value = false;
  }
}
function cancelDelete() {
  preview.value = null;
  pending.value = null;
  sheetErr.value = "";
}

/* ---------- 回滚 / 灰度：形状已在 rin-server 实测（docs/14 §7），走 gwWrite 真发 ---------- */
const showRollback = ref(false);
const canary = ref(100);
const rolling = ref(false);
const rbErr = ref<GwError | null>(null);
const rbTarget = computed(() => String(detail.value?.id ?? openId.value ?? ""));
const rbOther = computed(() => run.value.ids.find((i) => i !== rbTarget.value) || "");
const rollbackBody = computed(() => {
  const id = rbTarget.value;
  const p = Math.min(100, Math.max(1, Number(canary.value) || 100));
  // 与两层校验同契约（0.2.1 修正）：strategy 由后端构造，客户端不传。
  // 全量 = 单版本形状 {version_id}；灰度 = 双版本数组、占比合计 100（50/50 已实测）。
  if (p >= 100 || !rbOther.value) return { version_id: id, annotations: { "workers/message": "从手机发起" } };
  return {
    versions: [
      { version_id: id, percentage: p },
      { version_id: rbOther.value, percentage: 100 - p },
    ],
    annotations: { "workers/message": "从手机发起" },
  };
});
async function confirmRollback() {
  const id = rbTarget.value;
  if (!id || rolling.value) return;
  rolling.value = true;
  rbErr.value = null;
  try {
    await gwWrite("POST", `/v1/workers/${encodeURIComponent(props.name)}/deployments`, rollbackBody.value);
    log.value.unshift({
      text: `已切换：#${dash(detail.value?.number)} ${shortId(id, 8)} → ${canary.value >= 100 || !rbOther.value ? "100" : canary.value}%（200 确认）`,
      ok: true,
    });
    dropMem("/v1/workers/" + encodeURIComponent(props.name));
    emit("changed");
    showRollback.value = false;
  } catch (e) {
    rbErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    rolling.value = false;
  }
}

/* ---------- 复制 ---------- */
const copied = ref("");
async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = `已复制 ${label}`;
  } catch {
    copied.value = `这个浏览器不让网页写剪贴板，只能手抄：${text.slice(0, 60)}`;
  }
}

const rows = computed(() => props.versions ?? []);
const moreHint = computed(() => {
  const t = props.total;
  if (typeof t !== "number" || t <= rows.value.length) return "";
  return `列表只载入了 ${rows.value.length} / ${t} 个版本，更早的版本不在这里（详情页的「加载更多」继续取）。`;
});

/** 列表重新加载时收起详情，避免带着上一轮的 detail 说这一轮的行 */
watch(
  () => props.loading,
  (l) => { if (l) closeDetail(); },
);

function dash(v: unknown): string {
  return v === undefined || v === null || v === "" ? "—" : String(v);
}
function sourceText(v: unknown): string {
  const k = String(v ?? "");
  return ({ wrangler: "wrangler 命令行", dashboard: "Cloudflare 后台", api: "API 调用" } as Record<string, string>)[k] || dash(k);
}
function strategyText(v: unknown): string {
  const k = String(v ?? "");
  return k === "percentage" ? "百分比部署" : dash(k);
}
</script>

<template>
  <DialogShell :title="`版本历史 · ${name}`" :sub="note" @close="emit('close')">
    <AsyncBlock :loading="loading" :err="err" :has="rows.length > 0" empty-text="暂无版本历史（接口返回空列表，不等于「版本都被删了」）" @retry="emit('retry')">
      <div class="row" style="justify-content: space-between; margin-bottom: 8px">
        <span class="small muted">已加载 {{ rows.length }} 个<span v-if="typeof total === 'number'"> / 共 {{ total }}</span></span>
        <button class="chip" type="button" @click="copy(rows.map((r: any) => String(r.id)).join('\n'), '全部版本 ID')">复制 ID 清单</button>
      </div>
      <p class="warnline" v-if="run.ambiguous">{{ run.note }}</p>
      <p class="warnline" v-else-if="mismatch">{{ mismatch }}</p>
      <p class="small muted" v-if="moreHint">{{ moreHint }}</p>

      <div class="list">
        <div v-for="v in rows" :key="String(v.id)" class="wrap">
          <div class="item tap" @click="openDetail(v)">
            <div style="min-width: 0">
              <div class="k">
                #{{ dash(v.number) }} <span class="muted">{{ shortId(v.id, 8) }}</span>
                <RunningBadge v-bind="rowState(v.id)" />
              </div>
              <div class="small muted">{{ dt(v.metadata?.created_on) }} • 来源: {{ sourceText(v.metadata?.source) }}</div>
            </div>
            <div class="v acts">
              <button v-if="!rowState(v.id).on && !run.ambiguous" class="ghost sm danger" type="button" @click.stop="askDelete(v)">删除</button>
              <span v-else-if="rowState(v.id).on" class="small muted">运行中不给删</span>
              <span v-else class="small muted">判定不可用</span>
              <span class="small caret">{{ openId === String(v.id) ? "收起" : "详情" }}</span>
            </div>
          </div>

          <div v-if="openId === String(v.id)" class="detail">
            <div class="empty" v-if="detailLoading && !detail">版本详情加载中…</div>
            <ErrorNote v-else-if="detailErr && !detail" :err="detailErr" can-retry @retry="openDetail(v)" />
            <template v-if="detail">
              <h4>基本信息</h4>
              <dl class="kv small">
                <dt>版本号</dt><dd>#{{ dash(detail.number) }}</dd>
                <dt>版本 ID</dt><dd style="word-break: break-all">{{ dash(detail.id) }}
                  <button class="chip sm" type="button" @click="copy(String(detail.id), '版本 ID')">复制</button></dd>
                <dt>创建时间</dt><dd>{{ dt(detail.metadata?.created_on) }}</dd>
                <dt>来源</dt><dd>{{ sourceText(detail.metadata?.source) }}</dd>
                <dt>URL</dt><dd class="muted">—（CF 的版本接口不返回 URL，历史版本的预览域名规则也没实测过，不拼出来当事实）</dd>
                <dt>作者</dt><dd>{{ dash(detail.metadata?.author_email) }}</dd>
                <dt>作者 ID</dt><dd>{{ shortId(detail.metadata?.author_id, 8) }}</dd>
                <dt>预览</dt><dd>{{ detail.metadata?.has_preview === true ? "已开启" : detail.metadata?.has_preview === false ? "未开启" : "接口没返回这个字段" }}</dd>
                <dt>部署消息</dt><dd>{{ dash(detail.annotations?.["workers/message"]) }}</dd>
                <dt>触发方式</dt><dd>{{ dash(detail.annotations?.["workers/triggered_by"]) }}</dd>
                <dt>运行状态</dt><dd>
                  <RunningBadge v-bind="rowState(detail.id)" />
                  <span v-if="!rowState(detail.id).on" class="muted">不在最新部署的 versions[] 里</span>
                </dd>
              </dl>

              <h4>部署区块</h4>
              <dl class="kv small" v-if="detailDeployment">
                <dt>部署 ID</dt><dd>{{ shortId(detailDeployment.id, 8) }}
                  <button class="chip sm" type="button" @click="copy(String(detailDeployment.id), '部署 ID')">复制</button></dd>
                <dt>部署时间</dt><dd>{{ dt(detailDeployment.created_on) }}</dd>
                <dt>来源</dt><dd>{{ sourceText(detailDeployment.source) }}</dd>
                <dt>策略</dt><dd>{{ strategyText(detailDeployment.strategy) }}</dd>
                <dt>流量占比</dt><dd>{{ detailPct === null ? "—" : detailPct + "%" }}
                  <span v-if="detailPct !== null && detailPct < 100" class="warn-inline">这一版在跑，但流量配比不是 100%</span></dd>
                <dt>部署作者</dt><dd>{{ dash(detailDeployment.author) }}<span v-if="!detailDeployment.author" class="muted">（实测部署响应没有 author 这个键，这一格标未取到）</span></dd>
              </dl>
              <p class="small muted" v-else>
                部署历史（这次只拿到 {{ (deployments ?? []).length }} 条，网关每脚本取最近 50 条）里没有对应记录 —— 不等于「没部署过」。
              </p>

              <h4>访问</h4>
              <template v-if="rowState(detail.id).on">
                <div class="list" v-if="hosts.length">
                  <div v-for="h in hosts" :key="h.host" class="item tap" @click="copy('https://' + h.host, h.host)">
                    <div style="min-width: 0"><div class="k">{{ h.host }}</div><div class="small muted">{{ h.via }} · 点名称复制</div></div>
                    <div class="v">https://</div>
                  </div>
                </div>
                <p class="small muted" v-else>自定义域名与 Zone 路由两张表里都没有指向本 Worker 的主机名；workers.dev 的完整地址要等账号子域名那条路由（见待补路由清单第 1 条）。</p>
                <p class="small ok" v-if="copied">{{ copied }}</p>
              </template>
              <p class="small muted" v-else>「访问」只在运行中的版本上出现：这一版现在不承接流量。</p>

              <h4>回滚 / 灰度到这一版</h4>
              <p class="small muted" v-if="rowState(detail.id).on && (detailPct === null || detailPct >= 100)">这一版已经在跑{{ detailPct === null ? "" : "且占 " + detailPct + "%" }}，不需要回滚到它自己。</p>
              <template v-else>
                <button class="ghost" type="button" @click="showRollback = !showRollback">{{ showRollback ? "收起" : "合成请求预览" }}</button>
                <div v-if="showRollback" class="rb">
                  <template v-if="rbOther">
                    <label class="lbl">切给这一版的流量：{{ canary }}%
                      <input v-model.number="canary" class="field" type="range" min="1" max="100" />
                    </label>
                    <p class="small muted">
                      {{ canary >= 100 ? "回滚 = 把 100% 流量切到这一版" : `灰度：剩下的 ${100 - canary}% 自动给当前承接流量的版本 ${shortId(rbOther, 8)}` }}
                      （两种形状都已在 rin-server 实测，docs/14 §7）。
                    </p>
                  </template>
                  <p v-else class="small muted">这个脚本只有一个版本，没有可分流的对象 —— 只能整版切换（100%）。想灰度请先部署出新版本。</p>
                  <div class="mono cmd">POST /v1/workers/{{ encodeURIComponent(name) }}/deployments</div>
                  <pre class="mono body">{{ JSON.stringify(rollbackBody, null, 2) }}</pre>
                  <div class="row" style="margin-top: 10px">
                    <button class="primary" type="button" :disabled="rolling" @click="confirmRollback">{{ rolling ? "发送中…" : "确认切换" }}</button>
                    <button class="ghost" type="button" @click="showRollback = false">先不切</button>
                  </div>
                  <ErrorNote v-if="rbErr" :err="rbErr" style="margin-top: 8px" />
                  <p class="small muted" v-if="rbErr?.kind === 'writesDisabled'">网关模式的写闸门没开（本机开关 + 网关 WRITE_ENABLED 两道）；直连模式只受本机开关管辖。</p>
                </div>
              </template>

              <div class="row" style="margin-top: 12px">
                <button v-if="!rowState(detail.id).on && !run.ambiguous" class="ghost danger" type="button" @click="askDelete(detail)">删除这个版本</button>
                <span v-else-if="rowState(detail.id).on" class="small muted">运行中的版本不给删，这一版正在承接流量。。</span>
                <span v-else class="small muted">{{ run.note }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div class="log" v-if="log.length">
        <div class="small muted">删除尝试记录（离开这一屏会清空，失败原因不会自动消失）：</div>
        <div v-for="(l, i) in log" :key="i" :class="l.ok ? 'ok' : 'no'">{{ l.text }}</div>
      </div>
    </AsyncBlock>

    <template #foot>
      <button class="ghost" type="button" @click="emit('close')">关闭</button>
    </template>

    <ConfirmSheet :preview="preview" :busy="busy" :error="sheetErr" @confirm="confirmDelete" @cancel="cancelDelete" />
  </DialogShell>
</template>

<style scoped>
.wrap { background: var(--panel); }
.caret { margin-left: 8px; color: var(--accent); }
.acts { display: flex; align-items: center; gap: 8px; flex: none; max-width: none; text-align: right; }
.detail { padding: 10px 13px 14px; border-top: 1px dashed var(--line); background: var(--panel-2); }
.detail h4 { margin: 14px 0 6px; font-size: 12px; color: var(--muted); font-weight: 600; }
.detail h4:first-child { margin-top: 0; }
.warnline { font-size: 12.5px; color: var(--warn); background: rgb(var(--warn-rgb) / .1); border-left: 3px solid var(--warn); border-radius: 6px; padding: 8px 10px; margin: 0 0 8px; line-height: 1.55; }
.warn-inline { display: block; color: var(--warn); font-size: 11.5px; margin-top: 2px; }
button.sm { padding: 4px 10px; font-size: 12px; }
.chip.sm { padding: 2px 8px; font-size: 11px; margin-left: 6px; }
button.danger { color: var(--bad); border-color: rgb(var(--bad-rgb) / .45); }
.log { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
.log .ok { color: var(--ok); font-size: 12px; }
.log .no { color: var(--bad); font-size: 12px; word-break: break-all; }
.mono { font-family: var(--font-num); }
.cmd { font-size: 12px; padding: 7px 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); word-break: break-all; }
.body { font-size: 11.5px; margin: 8px 0 0; white-space: pre-wrap; word-break: break-all; color: var(--muted); }
.rb { margin-top: 8px; }
.ok { color: var(--ok); }
</style>
