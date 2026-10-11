<script setup lang="ts">
/**
 * KV 那一块：左栏命名空间，右栏它的 Key（和 D1 用同一个 StoreSplit 骨架，两段的位置一致）。
 *
 * 竞品每行都写着一个总数，这里**故意不写**：CF 的命名空间列表接口不返回 key 数量，
 * 只有 `…/keys?limit=100` 回来才知道这一页有几条，而且它带 cursor、不给总数。
 * 所以右栏说的是「本页 N 条 · 还有下一页」，不是「N 个 Key」（docs/09 §E16 那条口径）。
 */
import { computed, onMounted, ref, watch } from "vue";
import AsyncBlock from "../board/AsyncBlock.vue";
import ErrorNote from "../ErrorNote.vue";
import RowCard from "../RowCard.vue";
import StoreSplit from "./StoreSplit.vue";
import { api, forceFreshWindow, GwError, type KvNamespace, type KvKeysResult } from "../../lib/api";

type Slot<T> = { data: T | null; err: GwError | null; loading: boolean };
const mk = <T,>(): Slot<T> => ({ data: null, err: null, loading: false });

const nss = ref<Slot<KvNamespace[]>>(mk());
const selectedId = ref("");
const pane = ref<"list" | "detail">("list");
const keys = ref<Slot<KvKeysResult>>(mk());
/** 翻页是"接着这一页往下"，所以只记游标，不清掉已渲染的列表 */
const paged = ref<{ cursor?: string; all: any[] }>({ all: [] });
const hasMore = ref(false);
const copied = ref("");

async function grab<T>(slot: { value: Slot<T> }, fn: () => Promise<T>) {
  slot.value = { ...slot.value, loading: true, err: null };
  try { slot.value = { data: await fn(), err: null, loading: false }; }
  catch (e) { slot.value = { data: slot.value.data, loading: false, err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)) }; }
}

async function loadNss() {
  await grab(nss, () => api.kvNamespaces().then((r) => Array.isArray(r.result) ? r.result : []));
  if (!selectedId.value && nss.value.data?.length) selectedId.value = nss.value.data[0].id;
}

async function loadKeys(append = false) {
  if (!selectedId.value) return;
  if (!append) { keys.value = { data: null, err: null, loading: true }; paged.value = { all: [] }; }
  else { keys.value = { ...keys.value, loading: true }; }
  try {
    const r = await api.kvKeys(selectedId.value, 100, append ? paged.value.cursor : undefined);
    paged.value = { cursor: r.cursor, all: append ? [...paged.value.all, ...(r.result ?? [])] : (r.result ?? []) };
    keys.value = { data: r, err: null, loading: false };
    hasMore.value = !!r.cursor;
  } catch (e) {
    keys.value = { data: append ? keys.value.data : null, loading: false, err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)) };
  }
}

async function loadMore() {
  if (!selectedId.value || !hasMore.value || keys.value.loading) return;
  await loadKeys(true);
}

onMounted(loadNss);
/** 切命名空间 = 右栏整个换血，绝不留着上一个 ns 的 key 列表（竞品截图就串过这个号） */
watch(selectedId, () => { keys.value = mk(); paged.value = { all: [] }; hasMore.value = false; loadKeys(); });

function pick(ns: KvNamespace) { selectedId.value = ns.id; pane.value = "detail"; }
function refresh() { forceFreshWindow(); loadNss(); if (selectedId.value) loadKeys(); }

const selectedNs = computed(() => (nss.value.data ?? []).find((n) => n.id === selectedId.value));
const rows = computed(() => paged.value.all);
const listState = computed(() =>
  nss.value.loading && !nss.value.data ? "st-pending"
  : nss.value.err ? "st-error"
  : (nss.value.data?.length ?? 0) ? "st-data" : "st-empty" as const);
const detailState = computed(() =>
  !selectedId.value ? "st-empty"
  : keys.value.loading && !keys.value.data ? "st-pending"
  : keys.value.err ? "st-error"
  : rows.value.length ? "st-data" : "st-empty" as const);

async function copyContent(text: string) {
  try { await navigator.clipboard.writeText(text); copied.value = "已复制 " + text.slice(0, 30); }
  catch { copied.value = "剪贴板被拒绝"; }
  setTimeout(() => { copied.value = ""; }, 2000);
}
</script>

<template>
  <StoreSplit
    list-title="KV 命名空间"
    :detail-title="selectedNs ? `Key（${selectedNs.title}）· 本页 ${rows.length} 条` : '未选择命名空间'"
    :pane="pane" :list-state="listState" :detail-state="detailState"
    @back="pane = 'list'"
  >
    <template #list-tools>
      <span class="small muted">{{ nss.data ? nss.data.length + ' 个' : nss.err ? '没取到' : '取数中' }}</span>
      <button class="ghost" :disabled="nss.loading" @click="refresh">{{ nss.loading ? "加载中" : "刷新" }}</button>
    </template>

    <ErrorNote :err="nss.err" />
    <div class="empty" v-if="nss.loading && !nss.data?.length">取数中…</div>
    <div class="rows" v-if="nss.data?.length">
      <RowCard
        v-for="ns in nss.data" :key="ns.id"
        :title="ns.title" :meta="ns.id.slice(0, 8) + '…'"
        :badges="[{ text: ns.supports_url_encoding ? 'URL编码' : '—' },
                  ...(ns.id === selectedId ? [{ text: '当前', cls: 'roll' }] : [])]"
        @open="pick(ns)"
      />
    </div>
    <div v-else-if="!nss.loading && !nss.err" class="empty">这个账号里没有 KV 命名空间（不是没取到）</div>

    <template #detail>
      <div v-if="!selectedId" class="empty">左边选一个命名空间，这里就出它的 Key。</div>
      <div v-else class="card">
        <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
          <h3 style="margin:0">{{ selectedNs?.title }} · Key</h3>
          <button class="ghost" style="font-size:12px" :disabled="keys.loading || !hasMore" @click="loadMore">
            {{ keys.loading ? "加载中" : hasMore ? "加载下一页" : "到底了" }}
          </button>
        </div>
        <div class="small muted" style="margin-bottom:6px">
          走 <code>GET /accounts/{a}/storage/kv/namespaces/{id}/keys?limit=100</code>，所需权限
          <code>Workers KV Storage Read</code>。每页 100 条；CF 这个接口<strong>不给总数</strong>，所以这里只说本页几条、还有没有下一页。
        </div>
        <AsyncBlock :loading="keys.loading && !keys.data" :err="keys.err" :has="rows.length > 0"
          :can-retry="!!keys.err" empty-text="这个命名空间里确实没有 Key（不是没取到）" @retry="loadKeys()">
          <div style="overflow-x:auto">
            <table>
              <thead><tr><th>Key</th><th>过期时间</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="k in rows" :key="k.name">
                  <td style="word-break:break-all;max-width:200px">{{ k.name }}</td>
                  <td style="white-space:nowrap">
                    <span v-if="k.expiration">{{ new Date(k.expiration * 1000).toLocaleString('zh-CN') }}</span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td style="white-space:nowrap">
                    <button class="ghost" style="font-size:11px;padding:2px 6px" @click="copyContent(k.name)">复制</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="hasMore" class="small muted" style="margin-top:4px">还有下一页（已显示 {{ rows.length }} 条，CF 不返回总数）</div>
        </AsyncBlock>
        <div v-if="copied" class="small" style="margin-top:6px;color:var(--ok)">{{ copied }}</div>
      </div>
    </template>
  </StoreSplit>
</template>

<style scoped>
table { width: 100%; font-size: 11px; border-collapse: collapse; }
table th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); background: var(--panel-2); }
table td { padding: 4px 8px; border-bottom: 1px solid var(--border-light); }
</style>
