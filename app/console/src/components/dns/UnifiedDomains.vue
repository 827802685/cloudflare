<script lang="ts">
/**
 * 统一域名视图（docs/13 §6.15 / §4 的 UnifiedDomain 合并 +「→ 类型:」前缀）。
 * 把 Worker / Pages / R2 三类自定义域名合并成**一列**，用箭头前缀区分绑定类型。
 *
 * 三类的可得性不一样，必须如实分开表达（这是 §8.2「没返回 ≠ 没有」那条硬规矩）：
 *  - Worker：数据现成（/v1/domains，网关已注册）—— 逐条列出。
 *  - Pages：网关已有 GET /v1/pages 与 GET /v1/pages/:p/domains（2026-10-22 实测），
 *    按项目逐条取；没项目 / 项目里 0 条 / 单项目取失败三种情况分开写。
 *  - R2：本账号未开通 R2（403 10042）→ 显示「没取到，不是没有」。
 *  - workers.dev 子域：账户级 <code>GET /v1/workers/subdomain</code>（网关已注册，2026-10-11 实测 200），
 *    拿到前缀才拼 `*.前缀.workers.dev`；取数中 / 没取到 / 取到了三种状态分开写，
 *    前缀本身不附带"开关"信息（CF 那个信封里只有 subdomain 一个字段）。
 */
export default { name: "UnifiedDomains" };
</script>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

const nav = useRouter();

/**
 * 跨屏联动（2026-10-25）：这一列本来就是"资源之间的血缘"清单 ——
 * 每行都写着它属于哪个 Worker / 哪个 Pages 项目。既然写得出归属，就该点得过去；
 * 以前整行只做「复制域名」，等于把这份关系摊在纸上却不让用。
 * 复制挪到行尾的小键上，行的主体变成跳转。
 * 落点带 ?c= 对应卡片：跳到 Worker 的「自定义域名」那一张、Pages 的「自定义域名」那一张。
 */
function goWorker(d: any) {
  const s = String(d?.service ?? "").trim();
  if (!s) return;
  nav.push(`/workers/${encodeURIComponent(s)}?c=domains`);
}
function goProject(p: string) {
  const name = String(p ?? "").trim();
  if (!name) return;
  nav.push(`/pages/${encodeURIComponent(name)}?c=domains`);
}

const props = defineProps<{
  /** /v1/domains 的 Worker 自定义域名（可用） */
  workerDomains: any[];
  /** Pages：按项目分组的域名；单项目失败时该组带 err */
  pagesGroups?: Array<{ project: string; domains: any[]; err?: any }>;
  pagesLoading?: boolean;
  pagesErr?: string | null;
  /** 账户级 workers.dev 前缀；空串 = 还没拿到值（是"没取到"还是"取数中"看下面两个状态） */
  subdomain?: string;
  /** 这一条还在路上 —— 这时候不能说"没取到"，也不能把旧值当新值显示 */
  subLoading?: boolean;
  /** 取失败的原因（GwError.hint 那种一句话）；有它就是"没取到" */
  subErr?: string | null;
}>();

const copied = ref("");
async function copy(text: string, label: string) {
  if (!text) { copied.value = label + "：没有可复制的内容"; return; }
  try { await navigator.clipboard.writeText(text); copied.value = "已复制 " + label; }
  catch { copied.value = "浏览器不让网页写剪贴板，" + label + " 只能手抄：" + text.slice(0, 60); }
}

const subHost = () => (props.subdomain ? `*.${props.subdomain}.workers.dev` : "");
const pagesGroupList = computed(() => props.pagesGroups ?? []);
const pagesTotal = computed(() => pagesGroupList.value.reduce((n, g) => n + (g.domains?.length ?? 0), 0));
const pagesAnyErr = computed(() => pagesGroupList.value.some((g) => !!g.err));
const pageHost = (d: any) => String(d?.name ?? d?.domain ?? d?.hostname ?? "");
</script>

<template>
  <div class="ud">
    <!-- 首行：workers.dev 子域。蓝徽章 + 点击复制（拿得到真子域才给复制） -->
    <div class="urow subrow" :class="{ tap: !!subdomain }" @click="subHost() && copy(subHost(), 'workers.dev 泛域名')">
      <div class="lead">
        <div class="host">{{ subHost() || "workers.dev 子域" }}<span class="badge blue">workers.dev</span></div>
        <div class="muted small">
          <template v-if="subdomain">整账号 Worker 的默认访问域名 · 点击复制（这行只给前缀，CF 那个接口不返回开关）</template>
          <template v-else-if="subLoading">取数中…（<code>GET /v1/workers/subdomain</code>）</template>
          <template v-else-if="subErr">没取到：<span>{{ subErr }}</span> —— <b>不是"没开"</b>，这条请求失败了；刷新本页可重试。</template>
          <template v-else>没取到：请求回来了但没有 subdomain 这个值 —— <b>不是"没开"</b>，也不是"你没有子域"。</template>
        </div>
      </div>
      <span class="kind">→ 类型: 子域</span>
    </div>

    <!-- Worker 自定义域名：数据现成。点行进那个 Worker 的详情（自定义域名那张卡） -->
    <div
      v-for="d in workerDomains"
      :key="d.id"
      class="urow tap"
      :title="'进入 Worker ' + (d.service || '') + ' 的自定义域名'"
      @click="goWorker(d)"
    >
      <div class="lead">
        <div class="host">{{ d.hostname }}</div>
        <div class="muted small">
          → Worker: {{ d.service }} @ {{ d.environment }} · {{ d.zone_name }}
          <span class="badge" :class="{ live: !!d.cert_id }">{{ d.cert_id ? "有证书" : "无证书记录" }}</span>
        </div>
      </div>
      <span class="kind">
        <button class="mini" type="button" @click.stop="copy(d.hostname, d.hostname)">复制</button>
      </span>
    </div>

    <!-- Pages 域名：按项目分组；没项目 / 0 条 / 取失败三种状态分开 -->
    <div class="urow na" v-if="pagesLoading && !pagesGroupList.length">
      <div class="lead">
        <div class="host muted">Pages 自定义域名</div>
        <div class="muted small">取数中…（<code>GET /v1/pages</code> → 每个项目 <code>GET …/domains</code>）</div>
      </div>
      <span class="badge">取数中</span>
    </div>

    <div class="urow na" v-else-if="pagesErr">
      <div class="lead">
        <div class="host muted">Pages 自定义域名</div>
        <div class="muted small">没取到：{{ pagesErr }} —— <b>不是"没有"</b>，这条请求失败了；刷新本页可重试。</div>
      </div>
      <span class="badge">没取到</span>
    </div>

    <div class="urow na" v-else-if="pagesGroupList.length === 0">
      <div class="lead">
        <div class="host muted">Pages 自定义域名</div>
        <div class="muted small">账号里没有 Pages 项目（<code>GET /v1/pages</code> 返回 []）——这才能说"没有"。</div>
      </div>
      <span class="badge">0 个项目</span>
    </div>

    <template v-else>
      <div v-for="g in pagesGroupList" :key="g.project">
        <div v-for="(d, i) in g.domains" :key="g.project + ':' + i" class="urow tap" :title="'进入 Pages 项目 ' + g.project" @click="goProject(g.project)">
          <div class="lead">
            <div class="host">
              {{ pageHost(d) || "（这条没有域名值）" }}
              <span class="badge blue">Pages</span>
            </div>
            <div class="muted small">
              → Pages: {{ g.project }}
              <span v-if="d.status" class="badge" :class="{ live: d.status === 'active' }">{{ d.status === "active" ? "已生效" : d.status }}</span>
              <span v-if="d.created_on" class="muted"> · 绑定于 {{ d.created_on.slice(0, 10) }}</span>
            </div>
          </div>
          <span class="kind">
            <button class="mini" type="button" @click.stop="copy(pageHost(d), pageHost(d))">复制</button>
          </span>
        </div>
        <div v-if="g.err" class="urow na">
          <div class="lead">
            <div class="host muted">{{ g.project }} 的域名</div>
            <div class="muted small">没取到（项目 {{ g.project }}）：{{ g.err.message || g.err }} —— <b>不是"这个项目没有域名"</b>。</div>
          </div>
          <span class="badge">没取到</span>
        </div>
      </div>
      <div v-if="pagesTotal === 0 && !pagesAnyErr" class="urow na">
        <div class="lead">
          <div class="host muted">Pages 自定义域名</div>
          <div class="muted small">{{ pagesGroupList.length }} 个项目都返回空列表 —— 这是"真的没有自定义域名"，不是没取到。</div>
        </div>
        <span class="badge">0 条</span>
      </div>
    </template>

    <!-- R2 域名：服务未开通 -->
    <div class="urow na">
      <div class="lead">
        <div class="host muted">R2 域名</div>
        <div class="muted small">没取到，<b>不是没有</b>：本账号未开通 R2（读取返回 <code>403 10042</code> 一类），不是「你有 0 个 R2 域名」。</div>
      </div>
      <span class="badge">未开通</span>
    </div>

    <p v-if="copied" class="whyline">{{ copied }}</p>
  </div>
</template>

<style scoped>
.ud { display: flex; flex-direction: column; gap: 1px; background: var(--line); border-radius: var(--radius); overflow: hidden; }
.urow { background: var(--panel); padding: 11px 13px; display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.urow.tap { cursor: pointer; }
.urow.na { opacity: .95; }
/* 修饰类叫 subrow 不叫 sub：全局顶栏有一条 .sub（nowrap + max-width:55%），
   同名会把这一行拽成不换行的横条（10-11 截图里那行溢出就是这么来的）。 */
.urow.subrow { background: var(--panel-2); }
.lead { flex: 1 1 auto; min-width: 0; }
.host { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.host .badge { margin-left: 6px; }
.kind { color: var(--muted); font-size: 12px; text-align: right; flex: none; max-width: 34%; overflow: hidden; text-overflow: ellipsis; }
.badge.blue { color: var(--pending-ink); border-color: rgb(var(--pending-rgb) / .45); background: rgb(var(--pending-rgb) / .1); }
.badge.live { color: var(--ok); border-color: rgb(var(--ok-rgb) / .4); }
/* 行尾的复制键：行的主体已经改成"跳到那个资源"，复制让位成一个小键 */
.mini {
  background: var(--panel-2); border: 1px solid var(--line); color: var(--muted);
  font-size: var(--t-2xs); line-height: 1; padding: 4px 9px; border-radius: 999px; cursor: pointer;
  transition: color .18s ease, border-color .18s ease;
}
.mini:hover { color: var(--accent); border-color: var(--accent-dim); }
code { font-family: var(--font-num); }
</style>
