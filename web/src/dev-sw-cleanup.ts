// 开发服务启动时移除同源旧版 PWA 壳缓存，避免历史 Service Worker 拦截 Vite 模块造成白屏。
if (import.meta.env.DEV && "serviceWorker" in navigator) {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    if (registrations.length > 0) {
      await Promise.all(registrations.map((registration) => registration.unregister()));
      if ("caches" in window) {
        const cacheNames = await caches.keys();
        await Promise.all(
          cacheNames
            .filter((cacheName) => cacheName.startsWith("xbloom-shell-"))
            .map((cacheName) => caches.delete(cacheName)),
        );
      }
      const reloadKey = "xbloom-dev-sw-reset";
      if (sessionStorage.getItem(reloadKey) !== "done") {
        sessionStorage.setItem(reloadKey, "done");
        window.location.reload();
      }
    } else {
      sessionStorage.removeItem("xbloom-dev-sw-reset");
    }
  } catch {
    // 清理失败时继续加载主应用，保留正常开发链路。
  }
}

export {};
