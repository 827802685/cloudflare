<script lang="ts">
/**
 * Pages 环境变量列表（docs/13 §6.9）。secret 类型显示为掩码并打「加密」标签，绝不回显明文。
 * 纯展示件：数据由父级传入。CF 这条来自 GET /v1/pages/:p/deployments/:d（网关未注册、形状未验证），
 * 所以父级拿不到时根本不会渲染到这里，这里只负责「拿到了怎么遮、怎么标」。
 */
export default { name: "EnvVars" };
</script>

<script setup lang="ts">
/** 未验证的形状假设：[{ key, value, type?:"plain_text"|"secret"|"encrypted" }]，键名以官方规格为准，实测后订正 */
const props = defineProps<{ vars: Record<string, any>[] }>();

const SECRET = new Set(["secret", "secret_text", "encrypted"]);
function isSecret(v: Record<string, any>): boolean {
  const t = String(v?.type ?? "").toLowerCase();
  if (SECRET.has(t)) return true;
  // 兜底：有些返回不带 type，只有加密值时才把明文藏起来，宁可多遮不可泄露
  return v?.value === null || v?.value === undefined;
}
</script>

<template>
  <div class="env">
    <div v-for="(v, i) in vars" :key="String(v.key) + i" class="er">
      <div class="ek">{{ v.key }}</div>
      <div class="ev mono">
        <template v-if="isSecret(v)"><span class="mask">••••••••</span><span class="badge lock">加密</span></template>
        <template v-else>{{ String(v.value ?? '') }}</template>
      </div>
    </div>
    <div v-if="!vars.length" class="empty">该项目/部署没有环境变量。</div>
  </div>
</template>

<style scoped>
.env { display: flex; flex-direction: column; gap: 1px; background: var(--line); border-radius: 10px; overflow: hidden; }
.er { background: var(--panel); padding: 9px 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ek { font-size: 13px; font-weight: 600; word-break: break-all; }
.ev { color: var(--muted); font-size: 12.5px; display: flex; align-items: center; gap: 6px; word-break: break-all; text-align: right; }
.mono { font-family: var(--font-num); }
.mask { letter-spacing: 2px; }
.badge.lock { color: var(--warn); border-color: rgb(var(--warn-rgb) / .4); }
</style>
