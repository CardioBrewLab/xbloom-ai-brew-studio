/**
 * 简易 Service Worker：缓存静态壳（App Shell 策略）。
 * - install：预缓存外壳资源（一律 no-store 请求，防升级混壳，任务 #65）
 * - fetch：导航请求 network-first（优先最新 index.html）；其余同源 GET cache-first
 * - activate：清理旧版本缓存
 * 注意：/api 请求一律放行网络，不做缓存。
 */
const CACHE = "xbloom-shell-v31"; // v31：桌面工作台主动作固定可见、结果动作集中、模型接口本机设置与历史载入状态清理。
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./icon-maskable.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        // no-store 绕过 HTTP 缓存与旧 SW 拦截：防止把旧 index.html 回填进新缓存版本
        cache.addAll(SHELL.map((url) => new Request(url, { cache: "no-store" }))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  // API 请求不缓存，保证数据实时性
  if (url.pathname.startsWith("/api/")) return;

  // 导航请求 network-first（任务 #65）：优先取最新 index.html 并回填缓存，网络失败才回退缓存壳
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(event.request).then((cached) => cached ?? caches.match("./index.html")),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ??
        fetch(event.request)
          .then((res) => {
            if (res.ok && res.type === "basic") {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            }
            return res;
          })
          .catch(() => caches.match("./index.html")),
    ),
  );
});
