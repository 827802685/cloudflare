<script lang="ts">
/**
 * 站点状态与 nameserver 卡（docs/13 §5.2 / §6.18）。
 * 这些数据全在 /v1/zones 的响应里（实测含 status / plan / name_servers / vanity_name_servers / id），
 * 零新路由即可渲染 —— 之前只是把它们压成了一个下拉而已。
 */
export default { name: "ZoneStatusCard" };
</script>

<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{ zone: Record<string, any> }>();

/** Zone 状态各自配色：active=正常绿，pending/initializing=待办黄，paused/deactivated=红，paired=中性 */
const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "已激活", cls: "ok" },
  pending: { label: "待激活", cls: "warn" },
  initializing: { label: "初始化中", cls: "warn" },
  paused: { label: "已暂停", cls: "bad" },
  deactivated: { label: "已停用", cls: "bad" },
  paired: { label: " Secondary 配对", cls: "muted" },
};
const statusInfo = computed(() => STATUS[String(props.zone?.status ?? "").toLowerCase()] ?? { label: String(props.zone?.status ?? "未知"), cls: "muted" });
const planName = computed(() => String(props.zone?.plan?.name ?? props.zone?.plan?.legacy_id ?? "未知套餐"));

const names = computed(() => {
  const vanity = Array.isArray(props.zone?.vanity_name_servers) ? props.zone.vanity_name_servers : [];
  const ns = Array.isArray(props.zone?.name_servers) ? props.zone.name_servers : [];
  return vanity.length ? vanity : ns;
});

const copied = ref("");
async function copyNs() {
  const text = names.value.join("\n");
  if (!text) { copied.value = "这个 Zone 没有返回 nameserver（可能是 CNAME 接入的 Secondary）"; return; }
  try {
    await navigator.clipboard.writeText(text);
    copied.value = "已复制 " + names.value.length + " 个 nameserver";
  } catch {
    copied.value = "浏览器不让网页写剪贴板，只能手抄上面的地址";
  }
}
</script>

<template>
  <div class="zc">
    <div class="top">
      <div class="nm">{{ zone?.name || "—" }}</div>
      <span class="badge" :class="statusInfo.cls">{{ statusInfo.label }}</span>
      <span class="badge plan">{{ planName }}</span>
    </div>
    <div class="zid muted small">
      zone id <code>{{ zone?.id || "—" }}</code>
    </div>

    <button type="button" class="ns" :disabled="!names.length" @click="copyNs">
      <div class="ns-h"><span>Nameserver（整卡点击复制）</span><span class="muted small">{{ names.length ? '点击复制' : '无' }}</span></div>
      <div class="ns-list mono">
        <div v-for="n in names" :key="n">{{ n }}</div>
        <div v-if="!names.length" class="muted">—</div>
      </div>
    </button>
    <p v-if="copied" class="copied muted small">{{ copied }}</p>
    <p v-if="zone?.paused" class="warnline">这个 Zone 当前处于 paused：所有代理记录会退回直接解析源站。</p>
  </div>
</template>

<style scoped>
.zc { display: flex; flex-direction: column; gap: 8px; }
.top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.nm { font-size: 15px; font-weight: 600; word-break: break-all; }
.zid { margin: 0; }
.zid code { font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
.badge.ok { color: var(--ok); border-color: rgb(var(--ok-rgb) / .4); }
.badge.warn { color: var(--warn); border-color: rgb(var(--warn-rgb) / .4); }
.badge.bad { color: var(--bad); border-color: rgb(var(--bad-rgb) / .45); }
.badge.muted { color: var(--muted); }
.badge.plan { color: var(--accent); border-color: rgb(var(--accent-rgb) / .4); }
.ns { display: block; width: 100%; text-align: left; padding: 10px 12px; border-radius: 12px; background: var(--panel-2); border: 1px solid var(--line); color: var(--fg); cursor: pointer; }
.ns:disabled { cursor: default; opacity: .7; }
.ns-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; margin-bottom: 6px; }
.ns-list { display: flex; flex-direction: column; gap: 2px; font-size: 13px; word-break: break-all; }
.copied { margin: 0; }
.warnline { margin: 0; color: var(--warn); font-size: 12px; }
</style>
