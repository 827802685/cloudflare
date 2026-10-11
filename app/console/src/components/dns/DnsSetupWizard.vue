<script lang="ts">
/**
 * DNS 配置向导（docs/13 §6.14 / §4.3 的 showDnsConfigDialog）。
 *
 * 【关键诚实边界】竞品这条是「按 validation.method 自动写 TXT/CNAME，成功后不问用户直接改 DNS」。
 * 但 gap-checklist 与 docs/09 §E 已查明：我们实测到的 /v1/domains 响应里**根本没有 validation.method 字段**，
 * 竞品那条判定我们不能照搬。所以这里的「该填什么记录」是我们**自己按记录名/类型形状推的**（apex→A/AAAA，子域→CNAME），
 * 界面上把这条推断规则明写出来、让人可否决，绝不伪装成 Cloudflare 给的字段，也绝不自动写 ——
 * 只提供一个「照此去新增」的入口，最终仍由父级走 preview→ConfirmSheet 人工确认。
 */
export default { name: "DnsSetupWizard" };
</script>

<script setup lang="ts">
import { computed } from "vue";
import { shortId } from "../../lib/fmt";

const props = defineProps<{
  /** /v1/domains 返回的 Worker 自定义域名 */
  domains: any[];
  /** /v1/zones，用于把 zone_id 映射回站点名并判断这条域名是否属于当前可选的 Zone */
  zones: any[];
}>();
const emit = defineEmits<{ (e: "suggest", payload: { zoneId: string; type: string; name: string }): void }>();

const zoneNameById = computed(() => {
  const m = new Map<string, string>();
  for (const z of props.zones || []) m.set(String(z.id), String(z.name));
  return m;
});

/**
 * 自研推断（**不是** Cloudflare 字段）：
 *  - 主机名等于 zone 本身（apex）→ CNAME 建在 apex 上通常不被支持，给 A/AAAA 方向；
 *  - 否则（子域）→ 给 CNAME。
 * 这只是「先按形状猜个类型」，具体值/是否 TXT 要人去 Cloudflare 后台的验证提示核对。
 */
function infer(d: any): { zoneId: string; zoneName: string; type: string; name: string; apex: boolean; known: boolean } {
  const zoneId = String(d?.zone_id ?? "");
  const zoneName = zoneNameById.value.get(zoneId) ?? String(d?.zone_name ?? "");
  const host = String(d?.hostname ?? "").toLowerCase();
  const apex = !!zoneName && (host === zoneName || host === "@" + zoneName || host === "@");
  const type = apex ? "A" : "CNAME";
  const known = !!zoneId && zoneNameById.value.has(zoneId);
  return { zoneId, zoneName, type, name: host, apex, known };
}
</script>

<template>
  <div class="wiz">
    <p class="disc">
      <b>这条判断是我们自己按记录名/类型推的，不是 Cloudflare 给的字段。</b>
      实测里 <code>validation.method</code> 这个字段在我们的接口响应中不存在，所以做不了「自动写 TXT/CNAME」，只能把要填的记录列给你。
      正确做法：到 Cloudflare 后台看该域名要求的那条验证记录，再回来照此新增。这里只按形状给个起点（apex → A/AAAA，子域 → CNAME），不替你写。
    </p>

    <div v-if="!domains.length" class="empty">没有待配置的 Worker 自定义域名。</div>

    <div class="list" v-else>
      <div v-for="d in domains" :key="d.id" class="row2">
        <div class="lead">
          <div class="host">{{ d.hostname }}</div>
          <div class="muted small">
            → Worker: {{ d.service }} @ {{ d.environment }} · 站点 {{ infer(d).zoneName || "未知" }}
            <span class="badge" :class="{ live: !!d.cert_id }">{{ d.cert_id ? "有证书记录" : "无证书记录" }}</span>
          </div>
          <div class="muted tiny mono">推断：{{ infer(d).apex ? "apex → 建议 A/AAAA" : "子域 → 建议 CNAME" }} · 域名 ID {{ shortId(d.id, 6) }}</div>
        </div>
        <button
          class="ghost sm"
          type="button"
          :disabled="!infer(d).known"
          @click="emit('suggest', { zoneId: infer(d).zoneId, type: infer(d).type, name: infer(d).name })"
        >
          {{ infer(d).known ? "照此新增记录" : "该站点不在可选项" }}
        </button>
      </div>
    </div>
    <p class="muted tiny">点「照此新增记录」只是把类型/名称带进新增表单，内容仍要你填，发送前仍要逐字段确认。</p>
  </div>
</template>

<style scoped>
.wiz { display: flex; flex-direction: column; gap: 10px; }
.disc { margin: 0; font-size: 12px; line-height: 1.6; color: var(--warn); background: rgb(var(--warn-rgb) / .08); border-left: 3px solid var(--warn); border-radius: 6px; padding: 8px 10px; }
.disc code { font-family: ui-monospace, Consolas, monospace; }
.row2 { background: var(--panel); padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.lead { min-width: 0; }
.host { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tiny { font-size: 11px; }
.mono { font-family: ui-monospace, Consolas, monospace; }
.badge.live { color: var(--ok); border-color: rgb(var(--ok-rgb) / .4); }
</style>
