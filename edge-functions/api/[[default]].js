/**
 * EdgeOne Makers 中国网络入口。
 * 静态文件直接由 EdgeOne 返回；这里只把 /api/* 流式转发给 Cloudflare Worker + D1。
 * 两端共用的 EDGE_PROXY_SECRET 只配置在平台环境变量中，不进入仓库或浏览器。
 */
export async function onRequest(context) {
  const request = context.request;
  const backend = String(context.env.CLOUDFLARE_WORKER_ORIGIN || "").replace(/\/+$/, "");
  const secret = String(context.env.EDGE_PROXY_SECRET || "");
  let backendUrl;
  try {
    backendUrl = new URL(backend);
  } catch {
    return Response.json({ ok: false, message: "站点后端地址尚未配置" }, { status: 503 });
  }
  if (
    backendUrl.protocol !== "https:" ||
    backendUrl.pathname !== "/" ||
    backendUrl.username ||
    backendUrl.password ||
    backendUrl.search ||
    backendUrl.hash ||
    secret.length < 32
  ) {
    return Response.json({ ok: false, message: "站点后端连接参数尚未配置完整" }, { status: 503 });
  }

  const incoming = new URL(request.url);
  const target = new URL(`${incoming.pathname}${incoming.search}`, backendUrl);
  const headers = new Headers(request.headers);
  for (const name of [
    "host",
    "content-length",
    "cf-connecting-ip",
    "x-xbloom-proxy-secret",
    "x-xbloom-client-ip",
  ]) {
    headers.delete(name);
  }
  headers.set("x-xbloom-proxy-secret", secret);
  headers.set("x-xbloom-client-ip", request.eo?.clientIp || "unknown");
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", "https");

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-length");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-xbloom-edge", "edgeone");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
