<script setup lang="ts">
/**
 * 冷启动静默检查到新版本后的弹窗。下载入口就一个按钮：打开 Releases 页面让人挑包 ——
 * 不再直链 APK 文件（文件名带 sha，直链拼错一次就是 404，0.1.7/0.1.8 各栽过一次）。
 * 「稍后」只关本次，下次冷启动有更新还会再弹（不记忆忽略，版本提示不该被永久静音）。
 */
import type { UpdateInfo } from "../lib/version";

defineProps<{ info: UpdateInfo }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <div class="upd-mask" role="dialog" aria-modal="true" aria-label="发现新版本">
    <div class="upd">
      <h3>发现新版本 v{{ info.version }}</h3>
      <p class="small muted">当前版本较旧。打开下载页挑最新的 APK 装上即可（同签名密钥覆盖安装，数据不丢）。</p>
      <div class="btns">
        <a class="primary" :href="info.downloadUrl" target="_blank" rel="noopener">打开下载页</a>
        <a class="ghost" :href="info.notesUrl" target="_blank" rel="noopener">发行说明</a>
      </div>
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
