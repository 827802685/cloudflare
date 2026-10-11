<script setup lang="ts">
/**
 * 单色描边图标。为什么不用 emoji：卡片动作宫格原来是 🗂⚙️ 这类彩色 emoji，
 * 在「读数仪表」这套灰阶打底 + 语义色的界面里像贴了张卡通贴纸——颜色不受主题控制、
 * 深浅档下明暗也不跟着翻。换成 currentColor 描边后，图标跟着 .act 的字色走：
 * 可用态是强调橙、禁用态（.off）自动变灰，深浅两档一起翻，且 ≥3:1 非文本对比达标。
 *
 * 每个图标只是若干 stroke 元素（path/circle/rect），统一 24×24 视框、圆头圆角。
 * 新增图标就往 ICONS 里加一条语义键，别在调用处现画。
 */
type El = { t: "path" | "circle" | "rect"; a: Record<string, string> };

const ICONS: Record<string, El[]> = {
  // 版本列表：叠层
  versions: [
    { t: "path", a: { d: "M12 3 3 7.5 12 12l9-4.5L12 3Z" } },
    { t: "path", a: { d: "M3 12.5 12 17l9-4.5" } },
    { t: "path", a: { d: "M3 17 12 21.5 21 17" } },
  ],
  // 部署历史：云 + 上箭头（把代码推上去）
  deployments: [
    { t: "path", a: { d: "M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 6.98" } },
    { t: "path", a: { d: "M12 20v-8" } },
    { t: "path", a: { d: "M9 15l3-3 3 3" } },
  ],
  // 配置信息：三档滑杆
  settings: [
    { t: "path", a: { d: "M4 7h9M19 7h1M4 12h1M11 12h9M4 17h9M19 17h1" } },
    { t: "circle", a: { cx: "16", cy: "7", r: "2.2" } },
    { t: "circle", a: { cx: "8", cy: "12", r: "2.2" } },
    { t: "circle", a: { cx: "16", cy: "17", r: "2.2" } },
  ],
  // Secret：挂锁
  secrets: [
    { t: "rect", a: { x: "5", y: "10.5", width: "14", height: "10", rx: "2.2" } },
    { t: "path", a: { d: "M8 10.5V7.5a4 4 0 0 1 8 0v3" } },
    { t: "path", a: { d: "M12 14.5v2.5" } },
  ],
  // 定时触发：时钟
  crons: [
    { t: "circle", a: { cx: "12", cy: "12", r: "8.2" } },
    { t: "path", a: { d: "M12 7.5V12l3 2" } },
  ],
  // 流量归属：脉冲折线
  traffic: [{ t: "path", a: { d: "M3 12h4l2.5 7 5-14 2.5 7H21" } }],
  // 版本切换：双向箭头
  switch: [
    { t: "path", a: { d: "M4 8h13l-3.2-3.2" } },
    { t: "path", a: { d: "M20 16H7l3.2 3.2" } },
  ],
  // 日志：终端窗口 + 提示符
  logs: [
    { t: "rect", a: { x: "3", y: "4", width: "18", height: "16", rx: "2.2" } },
    { t: "path", a: { d: "M7 9.5l2.8 2.5L7 14.5" } },
    { t: "path", a: { d: "M12.5 15H17" } },
  ],
  // 回滚：回退箭头
  rollback: [
    { t: "path", a: { d: "M9 14 4 9l5-5" } },
    { t: "path", a: { d: "M4 9h11a5 5 0 0 1 0 10h-4" } },
  ],
  // 重试构建：循环刷新
  retry: [
    { t: "path", a: { d: "M4 5v4h4" } },
    { t: "path", a: { d: "M20 19v-4h-4" } },
    { t: "path", a: { d: "M19 9a7.5 7.5 0 0 0-13.1-2.1L4 9" } },
    { t: "path", a: { d: "M5 15a7.5 7.5 0 0 0 13.1 2.1L20 15" } },
  ],
  // 构建日志：折角文档 + 文字行
  buildlog: [
    { t: "path", a: { d: "M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" } },
    { t: "path", a: { d: "M14 3v4h4" } },
    { t: "path", a: { d: "M9 13h6M9 16.5h5" } },
  ],
};

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 });
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <component v-for="(e, i) in ICONS[props.name] || []" :is="e.t" :key="i" v-bind="e.a" />
  </svg>
</template>
