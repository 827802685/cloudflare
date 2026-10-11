<script lang="ts">
/**
 * 按 URL 清理缓存（docs/13 §6.18 + §5.2 的缓存清理组）。
 *
 * 这条的红线原因写在 api.ts 写侧契约里：CF 对 `files:[123]` 这种非法 payload 是**真的执行**，
 * 不会当失败拒掉（docs/09 §B5 实测）。所以「回显给人看」是唯一可靠闸门 —— 这里绝不预填任何 URL，
 * 提交一定走 previewPurge → ConfirmSheet，把逐条完整 URL 摊到人眼前再发。
 * 上限 PURGE_LIMIT=30，实时计数，超限当场标红并禁止提交。
 */
export default { name: "DnsPurgeForm" };
</script>

<script setup lang="ts">
import { computed, ref } from "vue";
import ErrorNote from "../ErrorNote.vue";
import { PURGE_LIMIT, previewPurge, GwError, type WritePreview } from "../../lib/api";

const props = defineProps<{ zoneId: string; zoneName: string }>();
const emit = defineEmits<{
  (e: "preview", payload: { preview: WritePreview; action: { kind: "purge"; files: string[] } }): void;
}>();

const raw = ref("");
/** 拆行、去空白、去空行 —— 不做任何预填，也不去重（去重交给 validatePurgeFiles） */
const lines = computed(() => raw.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
const over = computed(() => lines.value.length > PURGE_LIMIT);
const countCls = computed(() => (over.value ? "cnt bad" : lines.value.length ? "cnt ok" : "cnt"));

const err = ref<GwError | null>(null);

function submit() {
  err.value = null;
  if (over.value) {
    err.value = new GwError("badQuery", 422, null, `一次最多 ${PURGE_LIMIT} 条 URL（现在是 ${lines.value.length} 条），请删减后再清。`);
    return;
  }
  try {
    const files = lines.value;
    const preview = previewPurge(props.zoneId, props.zoneName, files);
    emit("preview", { preview, action: { kind: "purge", files } });
  } catch (e) {
    err.value = e instanceof GwError ? e : new GwError("unknown", 0, null, String((e as Error)?.message || e));
  }
}
</script>

<template>
  <div class="pf">
    <div class="head">
      <span class="muted small">每行一个完整 https 地址；默认不预填，清哪几条自己敲。</span>
      <span :class="countCls">{{ lines.length }} / {{ PURGE_LIMIT }}</span>
    </div>
    <textarea
      v-model="raw"
      class="field urls"
      rows="6"
      spellcheck="false"
      autocomplete="off"
      placeholder="https://example.com/a.html&#10;https://example.com/img/cover.png"
    ></textarea>
    <ErrorNote :err="err" />
    <div class="foot">
      <button type="submit" class="primary" :disabled="!lines.length || over" @click="submit">核对这些 URL</button>
    </div>
    <p class="muted small">
      只接受完整 https 地址、不能带通配符 *；提交前会在确认抽屉里逐条回显 —— 缓存清掉后访客要回源站取，短时命中率下降，但不动源站。
    </p>
  </div>
</template>

<style scoped>
.pf { display: flex; flex-direction: column; gap: 10px; }
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.urls { width: 100%; resize: vertical; font-family: var(--font-num); font-size: 12.5px; line-height: 1.6; }
.cnt { font-size: 12.5px; font-variant-numeric: tabular-nums; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--line); }
.cnt.ok { color: var(--ok); border-color: rgb(var(--ok-rgb) / .4); }
.cnt.bad { color: var(--bad); border-color: rgb(var(--bad-rgb) / .5); background: rgb(var(--bad-rgb) / .1); font-weight: 600; }
.foot { display: flex; justify-content: flex-end; }
</style>
