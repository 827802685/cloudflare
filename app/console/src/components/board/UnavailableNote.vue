<script setup lang="ts">
/**
 * 「取不到」清单 —— 那 15 个指标 tile 里有几项，我们的任何路由都给不了。
 * gap-checklist E-17 B 档查实的结论：这几项不是「还没做」，是**数据面本身没有**
 * （数据集里没有这个字段 / 被套餐挡 / 服务未开通）。
 *
 * 所以这一块刻意不摆空瓦片、不显示 0、也不显示「—」，而是把「为什么拿不到」写成人能读的一句话
 * （docs/13 §8.2 L332、docs/09 §E16 的硬规矩：接口没返回 ≠ 值是 0）。
 *
 * 位置：原来挂在看板最底下，10-11 他要求「介绍别摆在读数面上，丢进设置里」，所以整块搬来这一屏。
 * 也正因为这是详情屏不是读数屏，proof（实测出处）重新上屏了 —— 在这里它是要被查阅的，不是干扰。
 */
const ITEMS: Array<{ name: string; why: string; proof: string }> = [
  {
    name: "已节省流量（savedBytes）",
    why: "Analytics GraphQL 里没有这个字段，实测报 unknown field；它是 CF 控制台侧另算的口径。",
    proof: "docs/01-API-流量分析.md §4-§5 字段实测表（标 ❌ 的那几行）",
  },
  {
    name: "人均浏览 / 子请求数",
    why: "httpRequests1dGroups 与 adaptive 两个数据集都没有这两列，任何现有路由都拼不出来。",
    proof: "docs/01 §4-§5 + docs/10-API-全量清单.md 流量段",
  },
  {
    name: "Workers 调用数",
    why: "workers_* 五个数据集在本账号实测全是 unknown field（要另开 Workers Analytics Engine 才有数）。",
    proof: "docs/01 §5 账号级字段实测（docs/evidence/graphql-account-fields.json）",
  },
  {
    name: "独立访客精确值",
    why: "只有 adaptive.visits 这一个采样估算值可用，看板已经上了这一格并写明是采样，不给「精确访客数」。",
    proof: "docs/01 §5 adaptive 采样口径说明",
  },
  {
    name: "按分钟粒度（1mGroups）/ WAF 事件明细",
    why: "被套餐挡住：本账号免费档实测取不到。",
    proof: "docs/01 §5 套餐限制那两行",
  },
  {
    name: "源站流量（字节）",
    why: "/v1/traffic/origin 那条 SQL 只 SELECT 了 count 和 avg(originResponseDurationMs)，没有源站字节数，所以看板的「补充指标」里摆的是源站响应请求数而不是 GB。",
    proof: "app/gateway/src/catalog.ts 的 traffic.origin()",
  },
  {
    name: "30 天窗的环比",
    why: `CF 只保留最近 32 天的分析数据（本账号实测报 "older than 4w4d"），而 30 天窗的上一窗落在 30–60 天前，整段在保留期外。网关因此直接跳过这条请求，看板上这四格写「无环比」。`,
    proof: "app/gateway/src/catalog.ts 的 RETENTION_DAYS / prevTotals()",
  },
];
</script>

<template>
  <div class="card">
    <h3>这几项取不到，所以没做成瓦片</h3>
    <dl class="list">
      <div v-for="i in ITEMS" :key="i.name" class="row2">
        <dt>{{ i.name }}</dt>
        <dd>{{ i.why }}<span class="proof">依据：{{ i.proof }}</span></dd>
      </div>
    </dl>
    <div class="small muted" style="margin-top: 8px">
      这些要真上界面，得先让网关侧补出能取到该字段的数据面并跑一次实测；实测之前摆上瓦片就是编数。
    </div>
  </div>
</template>

<style scoped>
.list { margin: 0; display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.row2 { border-left: 3px solid var(--muted); background: var(--panel-2); border-radius: 8px; padding: 8px 10px; }
.row2 dt { color: var(--fg); font-weight: 600; margin-bottom: 3px; }
.row2 dd { margin: 0; color: var(--muted); line-height: 1.5; }
.proof { display: block; margin-top: 4px; font-size: 11px; color: var(--muted); opacity: .85; }
</style>
