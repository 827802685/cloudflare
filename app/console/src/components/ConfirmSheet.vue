<script lang="ts">
/**
 * 写操作的确认抽屉。它是**公共件**，放在 console-data 分支上，因为 Workers / 域名 / 看板三个包
 * 都要用，谁先建谁就会把另外两个的改动盖掉（docs/13 §7.5 的「点名对象 + 说明后果 + 按钮用动词」）。
 *
 * 为什么非要有它：docs/09 §B5 实测过 CF 对 purge 的非法 payload 是**照收并执行**，
 * 所以「我们以为会被拒」不能当成安全依据，唯一可靠的闸门是让人在发出去之前看见真要发的东西。
 * 这里显示的路径与请求体就是 gwWrite() 要用的同一个对象，不是第二套文案。
 */
export default { name: "ConfirmSheet" };
</script>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { WritePreview } from "../lib/api";

const props = defineProps<{
  preview: WritePreview | null;
  /** 已经发出去了：按钮变成转圈并禁用，避免连点变成两次真写 */
  busy?: boolean;
  /** 上一次尝试的失败原因；成功后由调用方关掉本抽屉 */
  error?: string;
}>();
const emit = defineEmits<{ (e: "confirm"): void; (e: "cancel"): void }>();

/** 不可撤销的动作要人把对象名再敲一遍，敲错就不给确认（竞品删记录不带名字，是反面教材） */
const NAME_TARGET = "要删除的记录";
const typed = ref("");
const needTyping = computed(() => props.preview?.danger === "irreversible");
const targetName = computed(() => props.preview?.lines.find((l) => l.k === NAME_TARGET)?.v ?? "");
const canConfirm = computed(() => !props.busy && (!needTyping.value || (targetName.value.length > 0 && typed.value.trim() === targetName.value)));

watch(() => props.preview, () => { typed.value = ""; });

const consequence = computed(() => {
  if (!props.preview) return "";
  if (props.preview.danger === "irreversible") return "此操作不可撤销：记录删掉后只能重新添加，已生效的解析会立刻失效。";
  if (props.preview.method === "POST" && props.preview.path.endsWith("purge_cache")) return "缓存清掉后访客要回源站取，短时间内的命中率会下降，不影响站点可用性。";
  return "改动立即生效，Cloudflare 全球节点会在几十秒内同步。";
});
</script>

<template>
  <Teleport to="body">
    <div v-if="preview" class="sheet-mask" @click.self="emit('cancel')">
      <div class="sheet" role="dialog" aria-modal="true">
        <header class="sheet-head">
          <h3>{{ preview.title }}</h3>
          <button class="sheet-x" type="button" @click="emit('cancel')">取消</button>
        </header>

        <p class="sheet-target">
          即将对
          <b>{{ preview.lines.find((l) => l.k === 'Zone')?.v || preview.path }}</b>
          执行下面这条请求，发送前请核对每一个字段：
        </p>

        <div class="sheet-cmd mono">{{ preview.method }} {{ preview.path }}</div>

        <dl class="sheet-fields">
          <template v-for="l in preview.lines.filter((x) => x.k !== 'Zone')" :key="l.k">
            <dt>{{ l.k }}</dt>
            <dd class="mono">{{ l.v }}</dd>
          </template>
          <template v-if="preview.body">
            <dt>请求体</dt>
            <dd class="mono wrap">{{ JSON.stringify(preview.body) }}</dd>
          </template>
        </dl>

        <p class="sheet-warn">{{ consequence }}</p>

        <label v-if="needTyping" class="sheet-type">
          <span>请输入记录名 <b class="mono">{{ targetName }}</b> 以确认删除</span>
          <input v-model="typed" :placeholder="targetName" autocomplete="off" spellcheck="false" />
        </label>

        <p v-if="error" class="sheet-err">{{ error }}</p>

        <footer class="sheet-foot">
          <button class="btn ghost" type="button" :disabled="busy" @click="emit('cancel')">先不发</button>
          <button class="btn danger" type="button" :disabled="!canConfirm" @click="emit('confirm')">
            {{ busy ? '发送中…' : (preview.danger === 'irreversible' ? '删除这条记录' : (preview.path.endsWith('purge_cache') ? '清理这些 URL' : '提交这次改动')) }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sheet-mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, .45);
  display: flex; align-items: flex-end; justify-content: center; z-index: 60;
}
.sheet {
  width: 100%; max-width: 640px; max-height: 88vh; overflow: auto;
  background: var(--bg-elev, #ffffff); color: var(--fg, #111111);
  border-radius: 14px 14px 0 0; padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
  display: flex; flex-direction: column; gap: 10px;
}
.sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.sheet-head h3 { margin: 0; font-size: 16px; }
.sheet-x { background: none; border: 0; color: var(--fg-dim, #3d3d3d); font-size: 14px; padding: 6px 8px; }
.sheet-target { margin: 0; font-size: 13px; line-height: 1.6; color: var(--fg-dim, #3d3d3d); }
.sheet-cmd {
  font-size: 12px; padding: 8px 10px; border-radius: 8px;
  background: var(--bg-inset, #f7f7f7); border: 1px solid var(--line, #dcdcdc); word-break: break-all;
}
.sheet-fields { display: grid; grid-template-columns: 88px 1fr; gap: 6px 10px; margin: 0; font-size: 13px; }
.sheet-fields dt { color: var(--fg-dim, #3d3d3d); }
.sheet-fields dd { margin: 0; word-break: break-all; }
.sheet-fields dd.wrap { font-size: 11.5px; white-space: normal; }
.mono { font-family: var(--mono, ui-monospace, Consolas, monospace); }
.sheet-warn { margin: 0; font-size: 12.5px; color: var(--warn, #8a6100); line-height: 1.6; }
.sheet-type { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; color: var(--fg-dim, #3d3d3d); }
.sheet-type input {
  padding: 9px 10px; border-radius: 8px; font-size: 14px;
  border: 1px solid var(--line, #dcdcdc); background: var(--bg-inset, #f7f7f7); color: inherit;
}
.sheet-err {
  margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--err, #c0392b);
  padding: 8px 10px; border-radius: 8px; background: rgb(var(--bad-rgb) / .08);
}
.sheet-foot { display: flex; gap: 10px; justify-content: flex-end; margin-top: 2px; }
.btn { padding: 10px 16px; border-radius: 12px; font-size: 14px; border: none; cursor: pointer; }
/* 与 main.css 的 Yaya12085 皮肤对齐（scoped 特异性更高，不同步一遍这里就还是旧反馈）：
   次级键=柔光面白面，确认键=同族但铺强调色 + inset 双向柔光。 */
.btn.ghost {
  background: var(--panel); color: var(--fg-dim, #3d3d3d);
  box-shadow: inset 4px 4px 7px var(--neu-dark), inset -4px -4px 7px var(--panel), 0 0 0 1px var(--line);
  transition: color .25s ease, box-shadow .3s cubic-bezier(.4, 0, .2, 1), transform .3s cubic-bezier(.4, 0, .2, 1);
}
.btn.ghost:hover:not(:disabled) { color: var(--accent); transform: translateY(-2px); box-shadow: inset 3px 3px 6px var(--neu-dark), inset -3px -3px 6px var(--panel), 0 6px 14px rgb(0 0 0 / .07), 0 0 0 1px var(--accent); }
.btn.danger {
  background: linear-gradient(180deg, var(--accent-hi), var(--accent)); color: var(--on-accent); font-weight: 600;
  box-shadow: inset 5px 5px 9px rgb(0 0 0 / .14), inset -5px -5px 9px rgb(255 255 255 / .2), 0 0 0 2px var(--bg-elev), 0 8px 18px rgb(var(--accent-rgb) / .18);
  transition: transform .3s cubic-bezier(.4, 0, .2, 1), box-shadow .3s cubic-bezier(.4, 0, .2, 1);
}
.btn.danger:hover:not(:disabled) { transform: translateY(-2px); box-shadow: inset 4px 4px 8px rgb(0 0 0 / .12), inset -4px -4px 8px rgb(255 255 255 / .22), 0 0 0 2px var(--bg-elev), 0 14px 26px rgb(var(--accent-rgb) / .22); }
.btn.danger:active:not(:disabled) { transform: translateY(0); box-shadow: inset 4px 4px 8px rgb(0 0 0 / .22), inset -4px -4px 8px rgb(255 255 255 / .12), 0 0 0 2px var(--bg-elev); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
