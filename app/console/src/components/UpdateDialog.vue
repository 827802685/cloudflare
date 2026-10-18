<script setup lang="ts">
/**
 * 冷启动静默检查到新版本后的弹窗。下载给两条路：加速（构建时注入的域名前缀）
 * 和直连（GitHub 原始地址）—— 加速域名偶尔抽风，双通道二选一，别把人堵死在一条路上。
 * 「稍后」只关本次，下次冷启动有更新还会再弹（不记忆忽略，版本提示不该被永久静音）。
 */
import type { UpdateInfo } from "../lib/version";

const props = defineProps<{ info: UpdateInfo }>();
defineEmits<{ close: [] }>();
const sizeText = props.info.size ? `${Math.round((props.info.size / 1024 / 1024) * 10) / 10} MB` : "";
</script>

<template>
  <div class="upd-mask" role="dialog" aria-modal="true" aria-label="发现新版本">
    <div class="upd">
      <h3>发现新版本 v{{ info.version }}</h3>
      <p class="small muted">
        当前版本较旧{{ sizeText ? ` · 新包 ${sizeText}` : "" }}。下载后覆盖安装即可（同签名密钥，数据不丢）。
      </p>
      <div class="btns">
        <a v-if="info.apkUrl" class="primary" :href="info.apkUrl" target="_blank" rel="noopener">加速下载</a>
        <a v-if="info.apkUrlDirect" class="ghost" :href="info.apkUrlDirect" target="_blank" rel="noopener">直连下载</a>
        <a class="ghost" :href="info.notesUrl" target="_blank" rel="noopener">发行说明</a>
      </div>
      <p v-if="!info.apkUrl" class="small muted">资产清单没读到（atom 兜底），从发行说明页手动下载。</p>
      <button class="later" @click="$emit('close')">稍后再说</button>
    </div>
  </div>
</template>

<style scoped>
.upd-mask { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; background: rgb(0 0 0 / .45); padding: 20px; }
.upd { width: min(360px, 92vw); background: var(--panel, #fff); border: 1px solid var(--line, #ddd); border-radius: 14px; padding: 22px; box-shadow: 0 12px 40px rgb(0 0 0 / .25); }
.upd h3 { margin: 0 0 6px; font-size: 16px; }
.btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.btns a { display: inline-block; padding: 9px 14px; border-radius: 8px; font-size: 13px; text-decoration: none; cursor: pointer; }
.btns a.primary { background: var(--accent, #2f9e5f); color: #fff; font-weight: 600; }
.btns a.ghost { border: 1px solid var(--line, #ccc); color: inherit; }
.later { margin-top: 12px; background: none; border: 0; color: var(--muted, #888); font-size: 12px; cursor: pointer; text-decoration: underline; }
</style>
