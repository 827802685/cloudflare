<script lang="ts">
/**
 * Pages 部署详情（docs/13 §6.9 / §6.10 / §6.12）。三态容器搭好，但**不拼假数据**：
 * 账号里 0 个 Pages 项目（docs/09 §A1），且下面三条读路由网关都还没注册、形状全部未验证：
 *   - GET /v1/pages/:p/deployments/:d    （构建阶段 + 环境变量的载体）
 *   - GET /v1/pages/:p/deployments/:d/logs → CF 尾巴是 /history/logs（构建日志）
 *   - GET /v1/pages/:p/domains           （域名行 + 专属错误文本）
 * 所以：拿得到就按下面的配色/掩码渲染；拿不到就把「为什么空 + 缺哪条路由」写死在界面上。
 * 这是展示件：自己不发起任何请求（也没有可发的 api），全部数据靠父级 props 传进来。
 *
 * 诚实边界（docs/13 §8.3）：这里不做「生产/预览」切换。Pages 接口会同时更新两个环境，
 * 给个假开关比不给更危险；要显示环境只能在文案上明说「同时影响两个环境」。
 */
export default { name: "DeploymentDetail" };
</script>

<script setup lang="ts">
import { computed } from "vue";
import EnvVars from "./EnvVars.vue";
import PagesDomains from "./PagesDomains.vue";
import { bytes, dt, shortId } from "../../lib/fmt";

const props = defineProps<{
  project: string;
  /** 来自 /v1/pages/:p/deployments 的行（可用），只含摘要字段 */
  deployment: Record<string, any>;
  /** 来自未注册路由 GET …/deployments/:d —— 现在恒为 null */
  detail?: Record<string, any> | null;
  /** 来自未注册路由 GET …/domains —— 现在恒为 null */
  domains?: Record<string, any>[] | null;
  /** 来自未注册路由 GET …/logs —— 现在恒为 null */
  logs?: string | null;
}>();

/** 构建阶段：官方/竞品未给统一键名，这里按 [{name,status}] 的假设形状渲染（未验证）。取不到就整块显示缺路由 */
const STAGE: Record<string, { cls: string; text: string }> = {
  success: { cls: "ok", text: "成功" },
  failed: { cls: "bad", text: "失败" },
  error: { cls: "bad", text: "失败" },
  queued: { cls: "warn", text: "排队中" },
  in_progress: { cls: "warn", text: "进行中" },
  running: { cls: "warn", text: "进行中" },
  skipped: { cls: "muted", text: "跳过" },
};
const stages = computed<any[]>(() => (Array.isArray(props.detail?.build_stages) ? props.detail.build_stages : Array.isArray(props.detail?.stages) ? props.detail.stages : []));
const envVars = computed<any[]>(() => {
  const v = props.detail?.env_vars ?? props.detail?.environment_variables ?? props.detail?.deployment?.env_vars;
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.entries(v).map(([key, val]: [string, any]) => ({ key, ...(typeof val === "object" ? val : { value: val }) }));
  return [];
});
function stageInfo(s: any) {
  const st = String(s?.status ?? s?.result ?? "").toLowerCase();
  return STAGE[st] ?? { cls: "muted", text: st || "未知" };
}

const hasDetailRoute = computed(() => !!props.detail);
const hasDomainRoute = computed(() => Array.isArray(props.domains));
</script>

<template>
  <div class="dd">
    <div class="hd">
      <span class="mono id">{{ shortId(deployment.id, 8) }}</span>
      <span v-if="deployment.latest_deploy" class="badge live">当前</span>
      <span class="badge">{{ deployment.status || deployment.build_result?.status || '—' }}</span>
    </div>
    <div class="muted small">
      {{ deployment.branch || '无分支' }} · {{ dt(deployment.created_on || deployment.modified_on) }}
      · 产物 {{ bytes(deployment.build_result?.bytes ?? 0) }}
      · 来源 {{ deployment.source ?? deployment.deployment_trigger?.metadata?.source ?? '（未取到）' }}
    </div>

    <!-- 构建阶段：分状态配色（拿到才画） -->
    <div class="sec">
      <div class="sec-h">构建阶段</div>
      <div v-if="stages.length" class="stages">
        <div v-for="(s, i) in stages" :key="i" class="stg">
          <span class="dotc" :class="stageInfo(s).cls"></span>
          <span class="stg-n">{{ s.name || s.stage || ('阶段 ' + (i + 1)) }}</span>
          <span class="badge" :class="stageInfo(s).cls">{{ stageInfo(s).text }}</span>
        </div>
      </div>
      <div v-else-if="hasDetailRoute" class="empty">这次部署没有分阶段记录。</div>
      <div v-else class="pend">
        未取到 —— 阶段列表要 <code>GET /v1/pages/{{ project }}/deployments/&lt;id&gt;</code>，
        这条读路由网关还没注册、CF 返回里的阶段键名也<b>未验证</b>，所以这里不给假数据。
      </div>
    </div>

    <!-- 环境变量：secret 掩码 + 加密标签（拿到才画） -->
    <div class="sec">
      <div class="sec-h">环境变量</div>
      <EnvVars v-if="envVars.length" :vars="envVars" />
      <div v-else-if="hasDetailRoute" class="empty">这次部署没有环境变量。</div>
      <div v-else class="pend">
        未取到 —— 环境变量同样来自 <code>…/deployments/&lt;id&gt;</code>（未注册、未验证）。
        secret 值接口不会回明文，届时按「•••••••• + 加密标签」显示。
      </div>
    </div>

    <!-- 构建日志入口 -->
    <div class="sec">
      <div class="sec-h">构建日志</div>
      <div v-if="logs" class="logbox mono">{{ logs }}</div>
      <div v-else class="pend">
        无入口 —— 日志要 <code>GET /v1/pages/{{ project }}/deployments/&lt;id&gt;/logs</code>
        （CF 真实尾巴是 <code>…/history/logs</code>）。网关没这条路由，且返回可能是纯文本，形状未验证。
      </div>
    </div>

    <!-- 域名行（含专属错误文本） -->
    <div class="sec">
      <div class="sec-h">域名</div>
      <PagesDomains v-if="hasDomainRoute" :domains="domains!" :preview-url="deployment.url" />
      <div v-else class="pend">
        未取到 —— 域名要 <code>GET /v1/pages/{{ project }}/domains</code>（网关未注册、条目形状与 <code>verification_errors</code> 键名未验证）。
        首行 pages.dev 预览域内置不可删；自定义域验证失败会在行下常驻一行错误文本，不做一闪而过的提示。
      </div>
    </div>

    <p class="muted tiny note">
      回滚 / 重试 / 删除这类写动作会同时作用于生产与预览两个环境（Pages 接口不分环境），
      因此这里不放「生产/预览」切换 —— 竞品那种装饰性 chip 是 docs/13 §8.3 点名的反面做法。
    </p>
  </div>
</template>

<style scoped>
.dd { display: flex; flex-direction: column; gap: 12px; }
.hd { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.id { font-size: 14px; font-weight: 600; }
.mono { font-family: ui-monospace, Consolas, monospace; }
.sec { display: flex; flex-direction: column; gap: 6px; }
.sec-h { font-size: 12px; color: var(--muted); font-weight: 600; }
.stages { display: flex; flex-direction: column; gap: 1px; background: var(--line); border-radius: 10px; overflow: hidden; }
.stg { background: var(--panel); padding: 8px 12px; display: flex; align-items: center; gap: 8px; }
.stg-n { flex: 1; font-size: 13px; }
.dotc { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
.dotc.ok { background: var(--ok); }
.dotc.bad { background: var(--bad); }
.dotc.warn { background: var(--warn); }
.badge.ok { color: var(--ok); border-color: rgb(var(--ok-rgb) / .4); }
.badge.warn { color: var(--warn); border-color: rgb(var(--warn-rgb) / .4); }
.badge.bad { color: var(--bad); border-color: rgb(var(--bad-rgb) / .45); }
.badge.live { color: var(--ok); border-color: rgb(var(--ok-rgb) / .4); }
.pend { font-size: 12px; line-height: 1.6; color: var(--warn); background: rgb(var(--warn-rgb) / .08); border-left: 3px solid var(--warn); border-radius: 6px; padding: 8px 10px; }
.pend code { font-family: ui-monospace, Consolas, monospace; color: var(--fg); }
.logbox { white-space: pre-wrap; word-break: break-all; font-size: 11.5px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; max-height: 240px; overflow: auto; }
.note { margin: 0; }
.tiny { font-size: 11px; }
</style>
