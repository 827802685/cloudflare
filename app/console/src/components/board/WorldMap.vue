<script setup lang="ts">
/**
 * 按国家/地区请求数的世界地图热力（choropleth）。
 *
 * 数据一条都不新取：用的就是看板 `/v1/overview` 里 countries 那块（GraphQL adaptive，采样），
 * `dimensions.clientCountryName` 实测是 ISO 3166-1 alpha-2 两位码 —— 跟底图 `world-map.json`
 * 的区域 id 同键，所以这里不需要名字匹配、不需要 d3、不需要 topojson。
 *
 * 三条口径上的硬规矩：
 *  1. **没数据的国家是灰的，不是 0**（docs/09 §E16）。图例里灰那一格明写"这一窗没有条目"，
 *     跟"取回来了但确实没有"是同一件事，绝不染成橙色档；
 *  2. 填色走**对数档**：国家请求数跨 3–4 个数量级（实测美国 1.37 万、日本 196），
 *     线性填色会把第二名往后全压成同一个颜色，等于没画；
 *  3. 底图是**懒加载的独立 chunk**（gzip 约 143KB），所以它有自己的加载中/加载失败两态，
 *     不能假装成"数据没取到"——数据早就在屏幕上，缺的只是这张图。
 *
 * 配色跟着全站那条「白底黑字打底 + 彩色只留给带意义的控件」：底面全灰，只有"有请求的国家"这一件事用橙。
 *
 * 缩放/平移（10-11 新增，纯观感层）：不改数据、不改着色口径，只给 `<g>` 套一层
 * `translate(x y) scale(k)`。滚轮以光标为锚缩放、拖动平移、双击放大、右上按钮微调 + 复位。
 * 平移/滚轮期间关过渡、按钮/复位开过渡；`prefers-reduced-motion` 下动效整段关闭。
 */
import { computed, onMounted, ref } from "vue";
import { countryName } from "../../lib/country";

const props = defineProps<{
  /** 来自 countries 卡的原始行（两位国家码 + 请求数），名字在这里自己翻 */
  rows: Array<{ code: string; value: number }>;
}>();

interface Geo {
  viewBox: string;
  locations: Array<{ i: string; p: string }>;
}
const geo = ref<Geo | null>(null);
const geoErr = ref("");
const geoLoading = ref(true);

onMounted(async () => {
  try {
    const m: any = await import("../../assets/world-map.json");
    geo.value = (m.default ?? m) as Geo;
  } catch (e) {
    geoErr.value = String((e as Error)?.message || e);
  } finally {
    geoLoading.value = false;
  }
});

/** 同一个码可能出在多行（理论上不该，但真出现就合计，别让它在图上只算一次） */
const byCode = computed(() => {
  const m = new Map<string, number>();
  for (const r of props.rows) {
    const k = String(r.code ?? "").trim().toLowerCase();
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + (Number(r.value) || 0));
  }
  return m;
});
const total = computed(() => [...byCode.value.values()].reduce((a, b) => a + b, 0));
const max = computed(() => Math.max(0, ...byCode.value.values()));

const norm = (v: number) => (v > 0 && max.value > 0 ? Math.log(1 + v) / Math.log(1 + max.value) : 0);
/**
 * 只有**有数据**的国家才调透明度（橙得深浅 = 请求数多少）；没数据的必须是 1 ——
 * 给 0 等于把陆地本身涂没，屏幕上只剩几个漂浮的橙色块，完全读不出「这是一张世界地图」，实测踩过一次。
 * 另外白底上橙色档位的可用区间比深色窄：地板压到 .16 时，橙铺在浅灰陆地上跟陆地本身差不到 20 个亮度，
 * 最浅那两三档看起来就是"没上色"。所以 .3 起、1.0 止，图例用同一个常数反推，两边永远对得上。
 */
const O_MIN = 0.3;
const opacityOf = (id: string) => {
  const v = byCode.value.get(id);
  return v === undefined ? 1 : O_MIN + (1 - O_MIN) * norm(v);
};

const sel = ref("");
/* ---------- 缩放/平移状态（只影响 <g> 的 transform，不碰数据/着色） ---------- */
const svgEl = ref<SVGSVGElement | null>(null);
const dragging = ref(false);
const smooth = ref(true);
const view = ref({ k: 1, x: 0, y: 0 });
const MIN_K = 1;
const MAX_K = 14;
/** viewBox 拆成数值：平移夹取、以光标为锚缩放都要用到它的宽高与原点 */
const VB = computed(() => {
  const p = (geo.value?.viewBox || "0 0 1 1").trim().split(/[\s,]+/).map(Number);
  return { x: p[0] || 0, y: p[1] || 0, w: p[2] || 1, h: p[3] || 1 };
});
const tf = computed(() => `translate(${view.value.x} ${view.value.y}) scale(${view.value.k})`);

const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));
/** 平移夹取：放大后不让陆地缩出可视框（内容始终盖满 viewBox），k=1 时退回原点 */
function clampXY(k: number, x: number, y: number) {
  const { w, h, x: vx, y: vy } = VB.value;
  const loX = (vx + w) * (1 - k), hiX = vx * (1 - k);
  const loY = (vy + h) * (1 - k), hiY = vy * (1 - k);
  return { x: Math.min(hiX, Math.max(loX, x)), y: Math.min(hiY, Math.max(loY, y)) };
}
/** 屏幕坐标 → viewBox 用户坐标（含当前 CTM，自动处理 meet/居中留白） */
function clientToView(clientX: number, clientY: number) {
  const svg = svgEl.value;
  const ctm = svg?.getScreenCTM();
  if (!svg || !ctm || typeof DOMPoint === "undefined") return null;
  const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y, a: ctm.a || 1, d: ctm.d || 1 };
}
function zoomAt(clientX: number, clientY: number, factor: number, animate: boolean) {
  const at = clientToView(clientX, clientY);
  if (!at) return;
  const v = view.value;
  const nk = clampK(v.k * factor);
  if (nk === v.k) return;
  // 保持光标下的那个数据点不动：d = (p - x)/k，再反解新平移
  const dx = (at.x - v.x) / v.k, dy = (at.y - v.y) / v.k;
  smooth.value = animate;
  view.value = { k: nk, ...clampXY(nk, at.x - dx * nk, at.y - dy * nk) };
}
function zoomBy(factor: number) {
  const r = svgEl.value?.getBoundingClientRect();
  if (!r) return;
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor, true);
}
function reset() {
  smooth.value = true;
  view.value = { k: 1, x: 0, y: 0 };
}
function onWheel(e: WheelEvent) {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.18 : 1 / 1.18, false);
}
function onDblClick(e: MouseEvent) {
  zoomAt(e.clientX, e.clientY, 1.7, true);
}
let drag: { sx: number; sy: number; ox: number; oy: number; a: number; d: number } | null = null;
let suppressClick = false;
function onDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const at = clientToView(e.clientX, e.clientY);
  if (!at) return;
  drag = { sx: e.clientX, sy: e.clientY, ox: view.value.x, oy: view.value.y, a: at.a, d: at.d };
  suppressClick = false;
  dragging.value = true;
  smooth.value = false;
  (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
}
function onMove(e: PointerEvent) {
  if (!drag) return;
  const dx = (e.clientX - drag.sx) / drag.a, dy = (e.clientY - drag.sy) / drag.d;
  if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) suppressClick = true;
  view.value = { k: view.value.k, ...clampXY(view.value.k, drag.ox + dx, drag.oy + dy) };
}
function onUp(e: PointerEvent) {
  if (!drag) return;
  drag = null;
  dragging.value = false;
  (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
}
function pick(id: string) {
  if (suppressClick) return; // 刚拖过一下，别把平移误判成"点了这个国家"
  sel.value = sel.value === id ? "" : id;
}
/** 选中国家的轮廓路径（只描边，不重新填色 —— 热力深浅是数据，不能因为被点了一下就改掉） */
const selD = computed(() => geo.value?.locations.find((l) => l.i === sel.value)?.p ?? "");
const selLine = computed(() => {
  if (!sel.value) return "";
  const v = byCode.value.get(sel.value);
  const name = countryName(sel.value);
  if (v === undefined) return `${name}：这一窗没有条目（灰 = 没数据，不是 0）`;
  const share = total.value ? ((v / total.value) * 100).toFixed(1) + "%" : "算不出占比";
  return `${name} · ${v.toLocaleString("zh-CN")} 次 · 占返回国家合计 ${share}`;
});

function compact(v: number): string {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + " 亿";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + " 万";
  return String(Math.round(v));
}
/** 图例按对数档反推：给出四档真实请求数，别写"低/中/高"这种没法核对的词 */
const legend = computed(() => {
  if (!max.value) return [];
  return [0.25, 0.5, 0.75, 1].map((f) => {
    const v = Math.round(Math.pow(max.value + 1, f) - 1);
    return { o: O_MIN + (1 - O_MIN) * f, label: "≥ " + compact(v) };
  });
});
/** 底图上有、但我们没有对应国家的码：说明这份数据里有码没被地图认出来，不静默吞掉 */
const unmatched = computed(() => {
  const g = geo.value;
  if (!g) return [];
  return [...byCode.value.keys()].filter((k) => !g.locations.some((l) => l.i === k));
});
</script>

<template>
  <div class="map">
    <div class="skeleton small muted" v-if="geoLoading">底图加载中（约 143 KB，只下一次）…</div>
    <div class="skeleton small muted" v-else-if="geoErr">底图没加载出来：{{ geoErr }}（下面的排行条不受影响）</div>

    <template v-else-if="geo">
      <div class="mapwrap" :class="{ dragging }">
        <svg
          ref="svgEl"
          :viewBox="geo.viewBox"
          role="img"
          aria-label="按国家/地区着色的世界地图，可缩放平移"
          preserveAspectRatio="xMidYMid meet"
          @wheel="onWheel"
          @dblclick="onDblClick"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
        >
          <g class="gmap" :class="{ smooth }" :transform="tf">
            <path
              v-for="l in geo.locations"
              :key="l.i"
              :d="l.p"
              :class="{ hit: byCode.has(l.i) }"
              :style="{ fillOpacity: opacityOf(l.i) }"
              @click="pick(l.i)"
            ><title>{{ countryName(l.i) }}{{ byCode.has(l.i) ? " · " + byCode.get(l.i) + " 次" : " · 这一窗没有条目" }}</title></path>
            <!-- 选中环单独画在最后：SVG 按顺序着色，画在原位的描边会被邻国盖掉半圈 -->
            <path v-if="selD" class="ring" :d="selD" />
          </g>
        </svg>

        <div class="zoombar" role="group" aria-label="地图缩放">
          <button type="button" class="zb" aria-label="放大" @click="zoomBy(1.4)">+</button>
          <button type="button" class="zb" aria-label="缩小" @click="zoomBy(1 / 1.4)">−</button>
          <button type="button" class="zb txt" aria-label="复位" :disabled="view.k === 1" @click="reset">复位</button>
        </div>
        <span class="zlvl small muted" v-if="view.k > 1.01">{{ view.k.toFixed(1) }}×</span>
      </div>

      <div class="row legend">
        <span class="lg none" />
        <span class="small muted">没有条目</span>
        <span v-for="(g, i) in legend" :key="i" class="lgw">
          <i class="lg" :style="{ opacity: g.o }" />
          <span class="small muted">{{ g.label }}</span>
        </span>
      </div>

      <div class="sel small" v-if="selLine">{{ selLine }}</div>
      <div class="small muted cap" v-else>点一个国家看它的数 · 滚轮/双击缩放、按住拖动平移（地图是采样面，跟下面那条排行条同源）</div>
      <div class="small muted cap" v-if="unmatched.length">地图上没有这些码，只在条里出现：{{ unmatched.join("、") }}</div>
    </template>
  </div>
</template>

<style scoped>
/* 地图两档灰走全局 token（main.css --map-land/--map-edge），深浅两档各自调过：
   陆地比面板暗/亮一档、又与数据橙拉开；国界不能是白，否则只剩漂浮的橙色块。 */
.map { --land: var(--map-land); --edge: var(--map-edge); display: block; }
.mapwrap { position: relative; max-width: 860px; margin-inline: auto; }
/* 地图按 1010:666 铺满就会在桌面档撑成 700px 高的一块墙，限宽并居中：它是个读数，不是海报 */
svg { display: block; width: 100%; height: auto; background: var(--bg-inset); border-radius: var(--radius-s); cursor: grab; touch-action: none; overflow: hidden; }
.mapwrap.dragging svg { cursor: grabbing; }
/* 没数据的国家：纯灰底面，不掺任何色相 —— 灰 = "这一窗没有条目"，不是 0 */
path { fill: var(--land); stroke: var(--edge); stroke-width: .5; vector-effect: non-scaling-stroke; }
path.hit { fill: var(--accent); cursor: pointer; }
.ring { fill: none; stroke: var(--fg); stroke-width: 1.8; vector-effect: non-scaling-stroke; pointer-events: none; }

/* 缩放控件：浮在地图右上角的一小条，吃控件 token，深浅两档都读得清 */
.zoombar { position: absolute; top: 8px; right: 8px; display: flex; flex-direction: column; gap: 4px; }
.zb { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 8px;
  background: rgb(var(--bg-rgb) / .86); backdrop-filter: blur(6px); color: var(--fg-2); font-size: 17px; line-height: 1; cursor: pointer;
  box-shadow: var(--e-1); }
.zb.txt { font-size: 11px; width: 30px; height: auto; padding: 5px 0; letter-spacing: .02em; }
.zb:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.zb:disabled { opacity: .4; cursor: default; }
.zlvl { position: absolute; left: 8px; top: 8px; font-family: var(--font-num); background: rgb(var(--bg-rgb) / .8); border-radius: 6px; padding: 1px 6px; }

.skeleton { padding: 26px 2px; text-align: center; border: 1px dashed var(--line); border-radius: var(--radius-s); background: var(--panel-2); }
.legend { flex-wrap: wrap; gap: 10px; margin-top: 8px; align-items: center; }
.lg { display: inline-block; width: 14px; height: 10px; border-radius: 2px; background: var(--accent); }
.lg.none { background: var(--land); opacity: 1; }
.lgw { display: inline-flex; align-items: center; gap: 4px; }
.sel { margin-top: 7px; color: var(--fg-2); font-family: var(--font-num); }
.cap { margin-top: 5px; }

/* 特效只在允许动效时开：按钮/复位/双击走平滑过渡，拖动与滚轮期间 .smooth 被摘掉即时跟手；
   hover 给有数据的国家一点辉光、选中环做呼吸、底图入场淡入。reduced-motion 下整段不生效。 */
@media (prefers-reduced-motion: no-preference) {
  .gmap.smooth { transition: transform .3s cubic-bezier(.22, .61, .36, 1); }
  .gmap path.hit { transition: filter .15s ease; }
  .gmap path.hit:hover { filter: drop-shadow(0 1px 3px rgb(var(--accent-rgb) / .55)) brightness(1.06); }
  .ring { animation: ringPulse 1.6s ease-in-out infinite; }
  svg { animation: mapIn .5s ease both; }
}
@keyframes ringPulse { 0%, 100% { stroke-opacity: .5; } 50% { stroke-opacity: 1; } }
@keyframes mapIn { from { opacity: 0; } to { opacity: 1; } }
</style>
