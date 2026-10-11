<script setup lang="ts">
/**
 * 数据库屏的双栏骨架 —— 学的是竞品截图里的**排列方式**（左：容器 / 右：容器里的东西），
 * 不学它的紫色手写皮肤：我们的观感口径是 main.css 那套「边缘网络读数仪」。
 *
 * 三种存储共用这一个骨架，所以 D1 / KV / R2 三段的"哪里是列表、哪里是内容、内容属于谁"
 * 是同一个位置，换类型不用重新学一遍界面：
 *   D1：左 = 数据库   → 右 = 数据表 + 字段 + SQL
 *   KV：左 = 命名空间 → 右 = Key 列表
 *   R2：左 = 存储桶   → 右 = 桶内对象（这条网关还没接，右栏如实说，不假装有）
 *
 * 宽屏（≥760px）两栏并排、各自独立滚；窄屏只放一栏，点左栏进右栏、右栏顶部有「‹ 返回」。
 * 这条不是审美选择，是**防串号**：竞品那张截图正是双栏没做好同步 —— 标题写着
 * `数据表（rssworker-db）`，下面列的却是 cloud-mail 的表（那 8 张表在 cloud-mail 库里，
 * rssworker-db 实测只有 _cf_KV 和 items 两张）。标题和内容说的不是同一个库，比没有这个
 * 功能更害人。所以这里右栏标题只从"当前选中项"派生，且切库时把右栏状态整个清掉。
 */
const props = withDefaults(
  defineProps<{
    /** 左栏标题，如「D1 数据库」 */
    listTitle: string;
    /** 右栏标题，如「数据表（cloud-mail）· 14 张」；没选中时给「未选择」类文案 */
    detailTitle: string;
    /** 窄屏当前该看哪一栏。宽屏两栏都在，这个值不参与布局 */
    pane?: "list" | "detail";
    /** 两栏各自的读数轨状态（沿用 main.css 的 st-* 口径，不另发明一套） */
    listState?: "st-pending" | "st-data" | "st-empty" | "st-error" | "st-partial";
    detailState?: "st-pending" | "st-data" | "st-empty" | "st-error" | "st-partial";
    /** 给了这个文案，左栏顶部就出搜索框；搜索词由父级用 v-model:search 拿（筛什么、怎么筛是父级的事） */
    searchPlaceholder?: string;
  }>(),
  { pane: "list", listState: "st-pending", detailState: "st-pending", searchPlaceholder: "" },
);

const emit = defineEmits<{ (e: "back"): void }>();

/** 只在界面上过滤已经取回来的那一份，不另发请求 —— 免费档的配额口径不变 */
const search = defineModel<string>("search", { default: "" });
</script>

<template>
  <div class="split" :class="pane === 'detail' ? 'p-detail' : 'p-list'">
    <section class="pane" :class="listState">
      <header class="pane-h">
        <span class="h-t">{{ props.listTitle }}</span>
        <slot name="list-tools" />
      </header>
      <div class="pane-b">
        <div class="find" v-if="props.searchPlaceholder">
          <input
            v-model="search" type="search" autocomplete="off" spellcheck="false"
            :placeholder="props.searchPlaceholder" :aria-label="props.searchPlaceholder"
          />
          <button class="clr" v-if="search" @click="search = ''">清空</button>
        </div>
        <slot />
      </div>
    </section>

    <section class="pane pane-d" :class="detailState">
      <header class="pane-h">
        <button class="back" @click="emit('back')">‹ 返回</button>
        <span class="h-t ell">{{ props.detailTitle }}</span>
      </header>
      <div class="pane-b"><slot name="detail" /></div>
    </section>
  </div>
</template>

<style scoped>
.split { display: grid; gap: 10px; align-items: start; }
.pane {
  position: relative; background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); overflow: hidden;
}
/* 左沿那道 2px 轨：颜色由外层 st-* 通过 --rail 打进来，和全站四态口径同一份事实 */
.pane::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
  background: var(--rail, transparent);
}
.pane.st-data { --rail: var(--rail-data); }
.pane.st-pending { --rail: var(--rail-pending); }
.pane.st-empty { --rail: repeating-linear-gradient(180deg, var(--rail-empty) 0 4px, transparent 4px 8px); }
.pane.st-error { --rail: repeating-linear-gradient(180deg, var(--rail-error) 0 4px, transparent 4px 8px); }
.pane.st-partial { --rail: repeating-linear-gradient(180deg, var(--rail-partial) 0 4px, transparent 4px 8px); }
.pane.st-pending::after {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
  background-image: linear-gradient(180deg, transparent, var(--rail-pending), transparent);
  background-size: 100% 200%; animation: split-feed 1.4s linear infinite;
}
@keyframes split-feed { from { background-position: 0 -100%; } to { background-position: 0 100%; } }

.pane-h {
  display: flex; align-items: center; gap: 8px; padding: 9px 11px 9px 14px;
  background: var(--panel-2); border-bottom: 1px solid var(--line-soft);
  font-size: 12px; color: var(--muted); letter-spacing: .02em;
}
.h-t { font-weight: 650; color: var(--fg-2); }
.ell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pane-h .pane-tools, .pane-h > :last-child { margin-left: auto; }
.pane-b { padding: 10px 11px 12px 14px; }

/* 搜索行走 sticky：长列表滚起来时筛选框不跟着跑掉。左边只让开 2px，别盖住那道读数轨 */
.find {
  position: sticky; top: 0; z-index: 1;
  display: flex; align-items: center; gap: 6px;
  margin: -10px -11px -8px -12px; padding: 9px 11px 8px 14px;
  background: var(--panel); border-bottom: 1px solid var(--line-soft);
}
.find input {
  flex: 1; min-width: 0; background: var(--panel-2); color: var(--fg);
  border: 1px solid var(--line); border-radius: 8px; padding: 6px 9px;
  font-family: inherit; font-size: 12px; outline: none; appearance: none; -webkit-appearance: none;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.find input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgb(var(--accent-rgb) / .18); }
/* 自带的那个 × 藏掉：清空走下面这颗字明确定的按钮，一个框里不留两套清除 */
.find input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; display: none; }
.find .clr {
  flex: none; background: none; border: 0; color: var(--muted); font-family: inherit;
  font-size: 11px; padding: 3px 2px; cursor: pointer;
}
.find .clr:hover { color: var(--accent); }

.back {
  display: none; background: none; border: 0; color: var(--accent); font-family: inherit;
  font-size: 13px; padding: 0 4px 0 0; cursor: pointer; flex: none;
}

/* 窄屏：一屏只给一栏，选完自动进右栏，右栏顶部出返回 —— 见文件头"防串号"那段 */
@media (max-width: 759px) {
  .split.p-list .pane-d { display: none; }
  .split.p-detail .pane:not(.pane-d) { display: none; }
  .back { display: block; }
}
/* 宽屏：并排 + 各自独立滚，长列表不能把整页撑高（竞品那张截图的两栏就是各滚各的） */
@media (min-width: 760px) {
  .split { grid-template-columns: minmax(210px, 33%) minmax(0, 1fr); }
  .pane { display: flex; flex-direction: column; max-height: calc(100dvh - 190px); }
  .pane-b { overflow: auto; }
}
</style>
