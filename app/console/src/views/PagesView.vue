<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import ErrorNote from "../components/ErrorNote.vue";
import FoldNote from "../components/FoldNote.vue";
import { useFold } from "../lib/lists";
import RowCard from "../components/RowCard.vue";
import DeploymentDetail from "../components/pages/DeploymentDetail.vue";
import { api, forceFreshWindow, GwError } from "../lib/api";
import { bytes, dt, rel, shortId } from "../lib/fmt";

/** 写侧与缺失路由的点名文案：不说"没权限"，因为缺的是实现（docs/13 §0.2 的对照结论） */
const WHY_WRITE = "回滚要发 POST，网关的非 GET 现在一律 501（WRITE_ENABLED 没开）——缺的是我这边的实现，不是你的令牌权限。";
const WHY_DETAIL = "构建阶段 / 环境变量 / 域名 / 日志这几块要的是 GET …/deployments/{id}、…/domains、…/history/logs —— 网关都还没注册、CF 返回形状也未验证，所以详情里这几块只给结构不给假数据。";

/**
 * Pages 这一块整体是"纸面功能"：账号里 0 个项目（docs/09 风险 A1），
 * 所以界面按"能显示就显示、显示不了就讲清楚为什么"来做，不假装已经验证过。
 */
const projects = ref<any[]>([]);
const err = ref<GwError | null>(null);
const loading = ref(false);
const open = ref("");
const deps = ref<any[]>([]);
const depErr = ref<GwError | null>(null);
/** 部署历史折叠：条数读全局偏好（设置页那条旋钮） */
const visibleDeps = useFold(() => deps.value);
/** 部署详情：整行点击展开这一条的 DeploymentDetail（数据靠 props，这里不额外请求） */
const openDep = ref("");

async function load() {
  loading.value = true;
  err.value = null;
  try {
    const r = await api.pages();
    projects.value = Array.isArray(r.result) ? r.result : [];
  } catch (e) {
    err.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  } finally {
    loading.value = false;
  }
}
onMounted(load);

/** 「刷新」绕过两层缓存真出一次；0 个项目时这块界面上的数字不该被说成"刚取过" */
function refresh() { forceFreshWindow(); load(); }

async function openDeps(p: any) {
  const name = String(p.name ?? "");
  openDep.value = "";
  if (open.value === name) { open.value = ""; return; }
  open.value = name;
  deps.value = [];
  depErr.value = null;
  try {
    const r = await api.pageDeployments(name);
    const raw: any = r.result;
    deps.value = Array.isArray(raw) ? raw : (raw?.deployments ?? []);
  } catch (e) {
    depErr.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String(e));
  }
}

function toggleDep(id: string) { openDep.value = openDep.value === id ? "" : id; }

const hasProject = computed(() => projects.value.length > 0);

const projectActions = [
  { ico: "deployments", label: "部署历史", go: "deps" },
  { ico: "rollback", label: "回滚", go: "rollback", why: WHY_WRITE },
  { ico: "retry", label: "重试构建", go: "retry", why: WHY_WRITE },
  { ico: "buildlog", label: "构建详情", go: "detail", why: WHY_DETAIL },
];

function onProjectGo(p: any, a: any) {
  if (a.go === "deps") openDeps(p);
}
</script>

<template>
  <div>
    <div class="row" style="justify-content: space-between; margin-bottom: 10px">
      <span class="muted small">Pages 项目共 {{ projects.length }} 个</span>
      <button class="ghost" :disabled="loading" @click="refresh">{{ loading ? "加载中" : "刷新" }}</button>
    </div>

    <ErrorNote :err="err" />

    <div class="card" v-if="!hasProject && !loading && !err">
      <h3>这个账号里没有 Pages 项目</h3>
      <div class="small muted">
        已实测：令牌能到 Pages 路由（假项目名回 <code>404 8000007</code>，鉴权与路由都过了），缺的是数据，不是权限。
      </div>
      <FoldNote label="这一块为什么还没做满">
        列表接口的分页也和别处不同——<code>per_page</code> 上限实测是 10，超过就 <code>400 8000024</code>，网关已经按 10 一页翻。
        <br /><br />
        你在后台建一个项目（Git 或 Direct Upload 都行），这一块立刻就有真数据；
        「版本查看与切换」的具体交互要等那时再定，现在写死等于赌。
        <br /><br />
        下面的部署详情已经按「构建阶段（分状态配色）/ 环境变量（secret 掩码+加密标签）/ 构建日志 / 域名行（含专属错误文本）」
        搭好三态容器，但那几条读路由网关还没注册、形状也未验证，所以这几块只显示结构与「为什么是空的」，不拼假数据。
      </FoldNote>
    </div>

    <div class="rows" v-if="hasProject">
      <div v-for="p in projects" :key="p.name">
        <RowCard
          :title="String(p.name)"
          :meta="`${p.production_branch || '无分支'} • ${p.subdomain || '—'} • ${rel(p.deployments?.[0]?.modified_on || p.created_on)}`"
          :badges="[{ text: p.deployment_id ? '已部署' : '无部署', cls: p.deployment_id ? 'live' : undefined }]"
          :actions="projectActions"
          @open="openDeps(p)"
          @go="(a) => onProjectGo(p, a)"
        />
        <div v-if="open === p.name" style="padding: 8px 0 0">
          <ErrorNote :err="depErr" />
          <div class="list" v-if="deps.length">
            <div v-for="d in visibleDeps.shown" :key="d.id" class="depwrap">
              <div class="item tap" @click="toggleDep(String(d.id))">
                <div style="min-width: 0">
                  <div class="k">{{ shortId(d.id, 6) }}
                    <span class="badge live" v-if="d.latest_deploy">当前版本</span>
                  </div>
                  <div class="small muted">{{ dt(d.created_on) }} · {{ d.branch }} · {{ d.build_result?.status || d.status }}</div>
                </div>
                <div class="v">{{ bytes(d.build_result?.bytes ?? 0) }}<div class="small">{{ openDep === String(d.id) ? "收起" : "详情" }}</div></div>
              </div>
              <div v-if="openDep === String(d.id)" class="detail">
                <DeploymentDetail :project="String(p.name)" :deployment="d" />
              </div>
            </div>
          </div>
          <div class="row" style="margin-top: 8px; gap: 8px; align-items: center" v-if="visibleDeps.rest">
            <button class="ghost" @click="visibleDeps.open = !visibleDeps.open">{{ visibleDeps.label }}</button>
          </div>
          <div v-else-if="!depErr" class="empty">{{ loading ? "加载中" : "没有部署记录" }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.depwrap { display: flex; flex-direction: column; }
.detail { padding: 10px 12px; background: var(--panel-2); border-top: 1px solid var(--line); }
</style>
