<script setup lang="ts">
/**
 * D1 那一块：左栏选库，右栏看它的表 / 字段 / 跑 SQL（排列学自竞品截图，见 StoreSplit 文件头）。
 *
 * 一处**口径改动**必须先记下来，因为它改变了界面上写着的数字：
 * CF 列表接口每个库都带 `num_tables`，但这个账号 5 个库实测**全部返回 0**，
 * 而真查 `sqlite_master` 是 2 / 14 / 14 / 31 / 13 张（2026-10-11 网关实测）。
 * 所以这里的表数不再用 num_tables，改成选中哪个库就发**一条** sqlite_master 查询真数出来。
 *
 * 那为什么不顺手把每张表的「字段数」也显示出来（竞品每行都写了「字段数: 24」）：
 * D1 拒绝带列引用的 pragma —— `SELECT … FROM pragma_table_info(s.name)` 回
 * `400 7500 not authorized: SQLITE_AUTH`，只有字面量表名可以。要凑齐 N 张表的字段数就得发
 * N 条查询，为了一行徽章把免费档的配额烧掉不值。折中：**表名一次查，字段数点开那张表才查**。
 */
import { computed, onMounted, ref, watch } from "vue";
import AsyncBlock from "../board/AsyncBlock.vue";
import ErrorNote from "../ErrorNote.vue";
import RowCard from "../RowCard.vue";
import StoreSplit from "./StoreSplit.vue";
import { api, forceFreshWindow, GwError, type D1Database, type D1QueryResult } from "../../lib/api";
import { dt, bytes } from "../../lib/fmt";

type Slot<T> = { data: T | null; err: GwError | null; loading: boolean };
const mk = <T,>(): Slot<T> => ({ data: null, err: null, loading: false });

const dbs = ref<Slot<D1Database[]>>(mk());
const selectedId = ref("");
/** 窄屏两栏只放得下一栏：点左栏进右栏，右栏顶部返回 */
const pane = ref<"list" | "detail">("list");

const dbDetail = ref<Slot<D1Database>>(mk());
const tables = ref<Slot<string[]>>(mk());
const cols = ref<Slot<{ table: string; rows: any[] }>>(mk());

const querySql = ref("SELECT name FROM sqlite_master WHERE type='table' LIMIT 20");
const queryResult = ref<Slot<D1QueryResult>>(mk());
const queryRunning = ref(false);
const copied = ref("");

async function grab<T>(slot: { value: Slot<T> }, fn: () => Promise<T>) {
  slot.value = { ...slot.value, loading: true, err: null };
  try { slot.value = { data: await fn(), err: null, loading: false }; }
  catch (e) { slot.value = { data: slot.value.data, loading: false, err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)) }; }
}

/** 一次查询拿全表清单。`sqlite_%` 是 SQLite 自己的内部表，不是用户的表，滤掉 */
const TABLES_SQL =
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";

async function loadDbs() {
  await grab(dbs, () => api.d1Databases().then((r) => Array.isArray(r.result) ? r.result : []));
  if (!selectedId.value && dbs.value.data?.length) selectedId.value = dbs.value.data[0].uuid;
}

/** 切库 = 右栏整个换血：表、字段、上一次查询结果全部清掉，绝不允许"标题是 A 内容是 B" */
async function loadDetail() {
  if (!selectedId.value) return;
  cols.value = mk();
  queryResult.value = mk();
  await Promise.allSettled([
    grab(dbDetail, () => api.d1Database(selectedId.value).then((r) => r.result)),
    grab(tables, async () => {
      const r = await api.d1Query(selectedId.value, TABLES_SQL);
      return ((r.result?.[0]?.results ?? []) as { name: string }[]).map((x) => x.name);
    }),
  ]);
}

/** 字段数只有点开那张表才查 —— 见文件头那条 D1 拒绝关联 pragma 的实测 */
async function openCols(t: string) {
  cols.value = { data: { table: t, rows: [] }, err: null, loading: true };
  try {
    const r = await api.d1Query(selectedId.value, 'PRAGMA table_info("' + t.replace(/"/g, '""') + '")');
    cols.value = { data: { table: t, rows: (r.result?.[0]?.results ?? []) as any[] }, err: null, loading: false };
  } catch (e) {
    cols.value = { data: null, loading: false, err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)) };
  }
}

async function runQuery() {
  if (!selectedId.value || !querySql.value.trim()) return;
  queryRunning.value = true;
  queryResult.value = { data: null, err: null, loading: true };
  try {
    queryResult.value = { data: await api.d1Query(selectedId.value, querySql.value), err: null, loading: false };
  } catch (e) {
    queryResult.value = { data: null, loading: false, err: e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)) };
  } finally {
    queryRunning.value = false;
  }
}

onMounted(loadDbs);
watch(selectedId, loadDetail);

function pick(db: D1Database) {
  selectedId.value = db.uuid;
  pane.value = "detail";
}

function refresh() { forceFreshWindow(); loadDbs(); if (selectedId.value) loadDetail(); }

const selectedDb = computed(() => (dbs.value.data ?? []).find((d) => d.uuid === selectedId.value));
const listState = computed(() =>
  dbs.value.loading && !dbs.value.data ? "st-pending"
  : dbs.value.err ? "st-error"
  : (dbs.value.data?.length ?? 0) ? "st-data" : "st-empty" as const);
const detailState = computed(() =>
  !selectedId.value ? "st-empty"
  : tables.value.loading && !tables.value.data ? "st-pending"
  : tables.value.err ? "st-error"
  : (tables.value.data?.length ?? 0) ? "st-data" : "st-empty" as const);

const queryRows = computed(() => queryResult.value.data?.result?.[0]?.results ?? []);
const queryMeta = computed(() => queryResult.value.data?.result?.[0]?.meta);
const queryCols = computed(() => (queryRows.value.length ? Object.keys(queryRows.value[0]) : []));

async function copyContent(text: string) {
  try { await navigator.clipboard.writeText(text); copied.value = "已复制"; }
  catch { copied.value = "剪贴板被拒绝"; }
  setTimeout(() => { copied.value = ""; }, 2000);
}
</script>

<template>
  <StoreSplit
    list-title="D1 数据库"
    :detail-title="selectedDb ? `数据表（${selectedDb.name}）· ${(tables.data || []).length} 张` : '未选择数据库'"
    :pane="pane" :list-state="listState" :detail-state="detailState"
    @back="pane = 'list'"
  >
    <template #list-tools>
      <span class="small muted">{{ dbs.data ? dbs.data.length + ' 个' : dbs.err ? '没取到' : '取数中' }}</span>
      <button class="ghost" :disabled="dbs.loading" @click="refresh">{{ dbs.loading ? "加载中" : "刷新" }}</button>
    </template>

    <ErrorNote :err="dbs.err" />
    <div class="empty" v-if="dbs.loading && !dbs.data?.length">取数中…</div>
    <div class="rows" v-if="dbs.data?.length">
      <RowCard
        v-for="db in dbs.data" :key="db.uuid"
        :title="db.name"
        :meta="`${dt(db.created_at, false)} · ${bytes(db.file_size)}`"
        :badges="[...(db.jurisdiction ? [{ text: db.jurisdiction, cls: 'roll' }] : []),
                  ...(db.uuid === selectedId ? [{ text: '当前', cls: 'roll' }] : [])]"
        @open="pick(db)"
      />
    </div>
    <div v-else-if="!dbs.loading && !dbs.err" class="empty">这个账号里没有 D1 数据库（不是没取到）</div>

    <template #detail>
      <div v-if="!selectedId" class="empty">左边选一个库，这里就出它的表。</div>

      <template v-else>
        <!-- 表清单：一条 sqlite_master 查询真数出来的，不用 CF 那个谎报 0 的 num_tables -->
        <div class="card">
          <h3>数据表 · {{ (tables.data || []).length }} 张</h3>
          <div class="small muted" style="margin-bottom:6px">
            表数是真查 <code>sqlite_master</code> 得到的。CF 列表接口那个 <code>num_tables</code> 字段
            在这个账号 5 个库上<strong>全部返回 0</strong>（实际 2/14/14/31/13 张），所以这里不采用它。
            字段数要点表名才查：D1 不允许 <code>pragma_table_info(列引用)</code>，一次查不齐所有表。
          </div>
          <AsyncBlock :loading="tables.loading && !tables.data" :err="tables.err" :has="!!(tables.data || []).length"
            :can-retry="!!tables.err" empty-text="这个库里确实没有表（不是没取到）" @retry="loadDetail">
            <div class="tbls">
              <button v-for="t in tables.data" :key="t" class="tbl" :class="{ on: cols.data?.table === t }" @click="openCols(t)">
                {{ t }}
              </button>
            </div>
          </AsyncBlock>
          <ErrorNote :err="cols.err" style="margin-top:6px" />
          <div v-if="cols.loading" class="empty" style="margin-top:6px">字段取数中…</div>
          <div v-else-if="cols.data" class="cols" style="margin-top:6px">
            <div class="small muted" style="margin-bottom:4px">{{ cols.data.table }} · {{ cols.data.rows.length }} 个字段</div>
            <table>
              <thead><tr><th>#</th><th>字段</th><th>类型</th><th>非空</th><th>主键</th></tr></thead>
              <tbody>
                <tr v-for="c in cols.data.rows" :key="c.cid ?? c.name">
                  <td>{{ c.cid }}</td><td><code>{{ c.name }}</code></td><td class="muted">{{ c.type || '—' }}</td>
                  <td class="muted">{{ c.notnull ? '是' : '否' }}</td><td class="muted">{{ c.pk ? '是' : '—' }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="!cols.data.rows.length" class="empty">这张表没有普通字段（虚表或外部表）</div>
          </div>
        </div>

        <!-- 库的静态信息：只留"这库是谁"，不占一整张卡 -->
        <div class="card" style="margin-top:8px">
          <h3>{{ selectedDb?.name }} · 基本信息</h3>
          <div class="kv">
            <dt>UUID</dt>
            <dd><code style="font-size:11px">{{ selectedId }}</code> <button class="ghost" style="font-size:11px;padding:2px 6px" @click="copyContent(selectedId)">复制</button></dd>
            <dt>创建时间</dt><dd>{{ dt(dbDetail.data?.created_at || selectedDb?.created_at || '') }}</dd>
            <dt>版本</dt><dd>{{ dbDetail.data?.version || selectedDb?.version }}</dd>
            <dt>大小</dt><dd>{{ bytes(dbDetail.data?.file_size ?? selectedDb?.file_size ?? 0) }}</dd>
            <dt v-if="selectedDb?.jurisdiction">管辖区域</dt><dd v-if="selectedDb?.jurisdiction">{{ selectedDb.jurisdiction }}</dd>
          </div>
          <div v-if="copied" class="small" style="color:var(--ok)">{{ copied }}</div>
        </div>

        <!-- SQL 查询：结果表宽，所以放在表清单下面而不是弹层 -->
        <div class="card" style="margin-top:8px">
          <h3>SQL 查询</h3>
          <div class="small muted" style="margin-bottom:6px">
            走网关 <code>GET /v1/d1/{id}/query?sql=…</code>，网关再按 CF 规格 <code>POST …/d1/database/{id}/query</code> 出网，
            所需权限 <code>D1 Read</code>（当前令牌已含）。SQL 长度上限 2000 字符；结果缓存 5 分钟。
          </div>
          <textarea v-model="querySql" class="field" rows="3"
            style="font-family:monospace;font-size:12px;resize:vertical;margin-bottom:6px"
            placeholder="SELECT * FROM ... LIMIT 20"
          ></textarea>
          <div class="row" style="gap:6px;align-items:center">
            <button class="primary" :disabled="queryRunning || !querySql.trim()" @click="runQuery">
              {{ queryRunning ? "查询中" : "执行" }}
            </button>
            <span class="small muted" v-if="queryMeta">耗时 {{ (queryMeta.duration * 1000).toFixed(1) }}ms · 读 {{ queryMeta.rows_read }} 行</span>
          </div>
          <ErrorNote :err="queryResult.err" style="margin-top:6px" />
          <div v-if="queryRows.length" style="margin-top:6px">
            <div class="small muted" style="margin-bottom:4px">{{ queryRows.length }} 行 · {{ queryCols.length }} 列</div>
            <div style="overflow-x:auto">
              <table>
                <thead>
                  <tr><th v-for="c in queryCols" :key="c" style="white-space:nowrap">{{ c }}</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(row, ri) in queryRows" :key="ri">
                    <td v-for="c in queryCols" :key="c" style="word-break:break-all;max-width:160px">{{ row[c] ?? "null" }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <!-- 四态分开说（docs/09 §E16）：还没跑 / 跑完确实 0 行，不能共用一句 -->
          <div v-else-if="queryResult.data" class="empty" style="margin-top:6px">查询跑完了，返回 0 行（不是没取到）</div>
          <div v-else-if="!queryResult.err && !queryResult.loading" class="empty" style="margin-top:6px">点「执行」跑查询</div>
        </div>
      </template>
    </template>
  </StoreSplit>
</template>

<style scoped>
textarea.field {
  width: 100%; box-sizing: border-box;
  border: 1px solid var(--border); border-radius: 6px; padding: 8px;
  background: var(--input-bg); color: var(--text); font-family: monospace;
}
table { width: 100%; font-size: 11px; border-collapse: collapse; }
table th { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--border); background: var(--panel-2); }
table td { padding: 3px 6px; border-bottom: 1px solid var(--border-light); }

/* 表名做成可点的胶囊：一行能塞三四个，比一屏只放得下 6 行的列表省地方 */
.tbls { display: flex; flex-wrap: wrap; gap: 5px; }
.tbl {
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 999px;
  color: var(--fg-2); font-family: var(--font-num); font-size: 11.5px; padding: 4px 9px; cursor: pointer;
}
.tbl.on { border-color: var(--accent); color: var(--accent); background: rgb(var(--accent-rgb) / .09); }
</style>
