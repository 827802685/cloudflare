/*
 * 极简 SW：只缓存"壳"，绝不缓存数据。
 * 理由：/v1/* 返回的是账号实时数据与设备令牌鉴权结果，缓存下来既会泄露又会让刷新失效。
 * 发布前端要更新时把下面的 v1 手工加一位（壳里的 JS/CSS 带 hash，会经 /assets 规则自动换新）。
 */
const PREFIX = "cfconsole-shell-";
const SHELL = PREFIX + "v1";
const CORE = ["/", "/board", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(CORE)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== SHELL).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 数据一律直连网络：出错也不回退到旧缓存，宁可显示错误卡片（错误卡里有 kind 和处置建议）
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) return;

  // 构建产物带 hash，可放心 cache-first
  if (url.origin === self.location.origin && /\/assets\//.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy));
        return res;
      })),
    );
    return;
  }

  // 页面导航：离线时回退到缓存的壳，让 App 自己显示"连不上网关"而不是浏览器错误页
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/board").then((hit) => hit || Response.error())));
  }
});
