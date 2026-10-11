<script setup lang="ts">
/**
 * Zero Trust（Cloudflare Access）只读屏。
 *
 * 为什么现在才做：docs/09 §F 把 Zero Trust 划出第一版范围时，依据是"账号没开通、接口打不通"。
 * 2026-10-11 复跑实测把这个前提推翻了 —— `GET /accounts/{a}/access/organizations` 是 **200**，
 * 组织（auth_domain / name / created_at）真在那儿；`access/apps`、`/groups`、`/policies`
 * 也全 200，只是**结果集为空**。反倒是 `/zerotrust/configuration`、`/zerotrust/rule/providers`
 * 这两条新路径 `400 7003`（要 ZT 的 uid 口径），所以这一屏只做 Access 这四块，
 * 不碰 Gateway / Browser Rendering / DLP —— 那些是真读不到，不是我没写。
 *
 * 四块各用自己的状态（和看板同一套约定）：一块 403 不拖累其余，"没取到"和"确实一条没配"
 * 必须是两句话（docs/09 §E16）。
 */
import { computed, onMounted, ref } from "vue";
import ErrorNote from "../components/ErrorNote.vue";
import RowCard from "../components/RowCard.vue";
import { api, forceFreshWindow, GwError } from "../lib/api";
import { dt } from "../lib/fmt";

type Slot<T> = { data: T | null; err: GwError | null; loading: boolean };
const mk = <T,>(): Slot<T> => ({ data: null, err: null, loading: false });
const toErr = (e: unknown) => (e instanceof GwError ? e : new GwError("unknown", 0, null, String(e)));

const org = ref<Slot<Awaited<ReturnType<typeof api.ztOrganization>>["result"]>>(mk());
const apps = ref<Slot<any[]>>(mk());
const groups = ref<Slot<any[]>>(mk());
const policies = ref<Slot<any[]>>(mk());

async function grab<T>(slot: { value: Slot<T> }, fn: () => Promise<T>) {
  slot.value = { ...slot.value, loading: true, err: null };
  try {
    slot.value = { data: await fn(), err: null, loading: false };
  } catch (e) {
    slot.value = { data: slot.value.data, loading: false, err: toErr(e) };
  }
}

async function load() {
  await Promise.allSettled([
    grab(org, () => api.ztOrganization().then((r) => r.result)),
    grab(apps, () => api.ztApps().then((r) => (Array.isArray(r.result) ? r.result : []))),
    grab(groups, () => api.ztGroups().then((r) => (Array.isArray(r.result) ? r.result : []))),
    grab(policies, () => api.ztPolicies().then((r) => (Array.isArray(r.result) ? r.result : []))),
  ]);
}

onMounted(load);
function refresh() {
  forceFreshWindow();
  load();
}

const anyErr = computed(() => [org, apps, groups, policies].some((s) => s.value.err));
/** 只有"读到了且是空数组"才配说"一条都没配"；没读到的那一块由各自的 ErrorNote 说话 */
const configuredNothing = computed(
  () => !anyErr.value && apps.value.data?.length === 0 && groups.value.data?.length === 0 && policies.value.data?.length === 0,
);
</script>

<template>
  <div>
    <div class="row" style="justify-content: space-between; margin-bottom: 10px">
      <span class="muted small">Zero Trust · Cloudflare Access（只读）</span>
      <button class="ghost" :disabled="org.loading" @click="refresh">{{ org.loading ? "加载中" : "刷新" }}</button>
    </div>

    <div class="card">
      <h3 style="margin-top:0">组织</h3>
      <ErrorNote :err="org.err" />
      <div class="empty" v-if="org.loading && !org.data">取数中…</div>
      <div class="kv" v-else-if="org.data">
        <dt>登录域名</dt><dd><code style="font-size:11px">{{ org.data.auth_domain || "—（接口没返回这个字段）" }}</code></dd>
        <dt>组织名</dt><dd>{{ org.data.name || "—" }}</dd>
        <dt>创建时间</dt><dd>{{ dt(org.data.created_at) }}</dd>
        <dt>后台只读锁</dt><dd>{{ org.data.is_ui_read_only === true ? "开启" : org.data.is_ui_read_only === false ? "关闭" : "没取到这个字段，不下结论" }}</dd>
      </div>
      <div class="small muted" style="margin-top:6px">
        走 <code>GET /accounts/{a}/access/organizations</code>，所需权限 <code>Zero Trust Read</code>。
        这一条能通就说明账号确实有 Zero Trust 组织；界面上的空列表因此是"没配"，不是"没开"。
      </div>
    </div>

    <div class="card" style="margin-top:8px">
      <h3 style="margin-top:0">Access 应用（{{ apps.data ? apps.data.length + " 个" : "—" }}）</h3>
      <ErrorNote :err="apps.err" />
      <div class="empty" v-if="apps.loading && !apps.data">取数中…</div>
      <div class="rows" v-else-if="apps.data?.length">
        <RowCard
          v-for="a in apps.data" :key="a.id || a.name"
          :title="a.name || a.domain || '（无名应用）'"
          :meta="[a.domain, a.type].filter(Boolean).join(' · ')"
        />
      </div>
      <div class="empty" v-else-if="!apps.err && apps.data && !apps.data.length">这个账号里一个 Access 应用都没配</div>
    </div>

    <div class="card" style="margin-top:8px">
      <h3 style="margin-top:0">用户组（{{ groups.data ? groups.data.length + " 个" : "—" }}）</h3>
      <ErrorNote :err="groups.err" />
      <div class="empty" v-if="groups.loading && !groups.data">取数中…</div>
      <div class="rows" v-else-if="groups.data?.length">
        <RowCard v-for="g in groups.data" :key="g.id" :title="g.name || '（无名组）'" />
      </div>
      <div class="empty" v-else-if="!groups.err && groups.data && !groups.data.length">没有用户组</div>
    </div>

    <div class="card" style="margin-top:8px">
      <h3 style="margin-top:0">访问策略（{{ policies.data ? policies.data.length + " 条" : "—" }}）</h3>
      <ErrorNote :err="policies.err" />
      <div class="empty" v-if="policies.loading && !policies.data">取数中…</div>
      <div class="rows" v-else-if="policies.data?.length">
        <RowCard
          v-for="p in policies.data" :key="p.id"
          :title="p.name || '（无名策略）'"
          :meta="[p.decision, p.precedence != null ? '优先级 ' + p.precedence : ''].filter(Boolean).join(' · ')"
        />
      </div>
      <div class="empty" v-else-if="!policies.err && policies.data && !policies.data.length">没有访问策略</div>
      <div class="small muted" v-if="configuredNothing" style="margin-top:8px">
        三块都读到了、也都是空的：<strong>这个账号开了 Zero Trust 但还没配 Access</strong>。
        后台建第一个应用之后点「刷新」就能看到，不是界面坏了。
      </div>
    </div>
  </div>
</template>
