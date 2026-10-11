<script lang="ts">
/**
 * Pages 域名行（docs/13 §6.12）：首行 pages.dev 预览域不可删；自定义域行含状态彩色徽章、
 * 「验证方式 %s • 创建于 %s」、以及**一行常驻的专属错误文本**（验证失败原因，不是一闪而过的 toast）。
 * 纯展示件。数据来自 GET /v1/pages/:p/domains —— 网关未注册、条目形状与 verification_errors 键名未验证，
 * 所以拿不到时父级走空态，这里只负责拿到后怎么渲染。
 */
export default { name: "PagesDomains" };
</script>

<script setup lang="ts">
const props = defineProps<{ domains: Record<string, any>[]; previewUrl?: string }>();

const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "已生效", cls: "ok" },
  pending: { label: "待验证", cls: "warn" },
  initializing: { label: "初始化中", cls: "warn" },
  failed: { label: "验证失败", cls: "bad" },
  verified_pending: { label: "已验证待签发", cls: "warn" },
};
function statusOf(d: Record<string, any>) {
  const s = String(d.status ?? "").toLowerCase();
  return STATUS[s] || { label: String(d.status ?? "未知"), cls: "" };
}
/** 错误文本未验证键名：verification_errors / errors / status 里找，取到就常驻显示 */
function errOf(d: Record<string, any>): string {
  const e = d.verification_errors ?? d.errors;
  if (Array.isArray(e) && e.length) return e.map((x: any) => (typeof x === "string" ? x : x?.message || x?.code)).join("；");
  if (d.error) return String(d.error);
  return String(d.status ?? "").toLowerCase() === "failed" ? "验证未通过（详情未取到）" : "";
}
</script>

<template>
  <div class="pd">
    <!-- 首行：pages.dev 预览域，明确标「不可删」 -->
    <div v-if="previewUrl" class="pr row">
      <div class="lead">
        <div class="host">{{ previewUrl }}</div>
        <div class="muted small">pages.dev 预览域 · 内置，不可删除</div>
      </div>
      <span class="badge">预览</span>
    </div>

    <div v-for="(d, i) in domains" :key="String(d.id) + i" class="row">
      <div class="lead">
        <div class="host">{{ d.hostname }}</div>
        <div class="muted small">验证方式 {{ d.validation?.method ?? d.method ?? "（未取到）" }} • 创建于 {{ d.created_on ?? "—" }}</div>
        <div v-if="errOf(d)" class="derr">{{ errOf(d) }}</div>
      </div>
      <span class="badge" :class="statusOf(d).cls">{{ statusOf(d).label }}</span>
    </div>

    <div v-if="!domains.length && !previewUrl" class="empty">这个 Pages 项目还没有域名数据。</div>
  </div>
</template>

<style scoped>
.pd { display: flex; flex-direction: column; gap: 1px; background: var(--line); border-radius: 10px; overflow: hidden; }
.row { background: var(--panel); padding: 10px 12px; display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.lead { min-width: 0; }
.host { font-size: 14px; word-break: break-all; }
.derr { margin-top: 5px; font-size: 12px; color: var(--bad); background: rgb(var(--bad-rgb) / .1); border-left: 3px solid var(--bad); border-radius: 6px; padding: 6px 8px; word-break: break-all; }
.badge.ok { color: var(--ok); border-color: rgb(var(--ok-rgb) / .4); }
.badge.warn { color: var(--warn); border-color: rgb(var(--warn-rgb) / .4); }
.badge.bad { color: var(--bad); border-color: rgb(var(--bad-rgb) / .45); }
</style>
