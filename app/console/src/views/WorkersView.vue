<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import ErrorNote from "../components/ErrorNote.vue";
import RowCard from "../components/RowCard.vue";
import { api, forceFreshWindow, GwError, workerName } from "../lib/api";
import { dt, rel } from "../lib/fmt";

const nav = useRouter();
const list = ref<any[]>([]);
const err = ref<GwError | null>(null);
const loading = ref(false);
const q = ref("");
const sort = ref<"modified" | "name">("modified");

async function load() {
  loading.value = true;
  err.value = null;
  try {
    const r = await api.workers();
    list.value = Array.isArray(r.result) ? r.result : [];
  } catch (e) {
    err.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    loading.value = false;
  }
}
onMounted(load);

/** 「刷新」= 绕过两层 5 分钟缓存真出新数据；日常切屏走缓存，不再重复打 CF */
function refresh() { forceFreshWindow(); load(); }

/** 过滤在前端做：全量就 7 个左右，不值得为搜索再打一次网关 */
const shown = computed(() => {
  const s = q.value.trim().toLowerCase();
  const arr = s ? list.value.filter((w) => workerName(w).toLowerCase().includes(s)) : [...list.value];
  return sort.value === "name"
    ? arr.sort((a, b) => workerName(a).localeCompare(workerName(b)))
    : arr.sort((a, b) => String(b.modified_on || "").localeCompare(String(a.modified_on || "")));
});

/** 详情里那 8 张卡的锚点，和 WorkerDetailView 的 id 一一对应 */
const cards = [
  { ico: "versions", label: "版本列表", c: "versions" },
  { ico: "deployments", label: "部署历史", c: "deployments" },
  { ico: "settings", label: "配置信息", c: "settings" },
  { ico: "secrets", label: "Secret", c: "secrets" },
  { ico: "crons", label: "定时触发", c: "crons" },
  { ico: "traffic", label: "流量归属", c: "traffic" },
  { ico: "switch", label: "版本切换", c: "switch" },
];

function actionsFor(w: any) {
  return [
    ...cards.map((k) => ({ ico: k.ico, label: k.label, go: `${k.c}|${workerName(w)}` })),
    {
      ico: "logs",
      label: "日志",
      go: "logs",
      // 网关侧 Tail 要另起一条 wss 中继，没做就不是"权限缺"，得说清缺的是实现
      why: "实时日志走 WebSocket 中继（tail.developers.workers.dev），这一版没实现，所以这里没有数据可看。",
    },
  ];
}

function onGo(a: any, name: string) {
  if (!a.go.includes("|")) return;
  const [c] = a.go.split("|");
  nav.push(`/workers/${encodeURIComponent(name)}?c=${c}`);
}
</script>

<template>
  <div>
    <div class="row" style="justify-content: space-between; margin-bottom: 10px">
      <input v-model="q" class="field" style="max-width: 200px" placeholder="搜索 Worker 名称" />
      <button class="ghost" :disabled="loading" @click="refresh">{{ loading ? "加载中" : "刷新" }}</button>
    </div>
    <div class="row" style="margin-bottom: 10px">
      <button class="chip" :class="{ on: sort === 'modified' }" @click="sort = 'modified'">按修改时间</button>
      <button class="chip" :class="{ on: sort === 'name' }" @click="sort = 'name'">按名称排序</button>
      <span class="small muted" v-if="shown.length">共 {{ shown.length }} 个</span>
    </div>

    <ErrorNote :err="err" can-retry @retry="load" />
    <div class="empty" v-if="loading && !shown.length">加载中…</div>

    <div class="rows" v-if="shown.length">
      <RowCard
        v-for="w in shown"
        :key="workerName(w)"
        :title="workerName(w)"
        :meta="`${rel(w.modified_on)} 修改 · ${dt(w.created_on, false)} 创建`"
        :badges="[
          ...(w.tail_consumers && w.tail_consumers.length ? [{ text: 'tail' }] : []),
          ...(w.logpush ? [{ text: 'logpush' }] : []),
          ...(w.has_assets ? [{ text: 'assets' }] : []),
          ...(w.placement?.mode === 'smart' ? [{ text: 'smart', cls: 'roll' }] : []),
        ]"
        :actions="actionsFor(w)"
        @open="nav.push('/workers/' + encodeURIComponent(workerName(w)))"
        @go="(a) => onGo(a, workerName(w))"
      />
    </div>
    <div v-else-if="!loading && !err" class="empty">这个账号里没有 Worker</div>
  </div>
</template>
