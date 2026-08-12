/**
 * EdgeOne Makers 中国网络入口。
 * 静态文件直接由 EdgeOne 返回；这里只把 /api/* 流式转发给 Cloudflare Worker + D1。
 * 两端共用的 EDGE_PROXY_SECRET 只配置在平台环境变量中，不进入仓库或浏览器。
 *
 * Cloud Functions are used instead of Edge Functions because this relay makes
 * outbound requests to a third-party API origin and needs the Node.js network
 * runtime and longer request budget.
 */
function jsonError(message, status) {
  return new Response(JSON.stringify({ ok: false, message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const MAX_API_BODY_BYTES = 262144;

function limitBody(body, maxBytes, onExceeded) {
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          onExceeded();
          await reader.cancel("request body too large").catch(() => {});
          controller.error(new Error("request body too large"));
          return;
        }
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function sameOriginMutation(request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.get("origin");
  return Boolean(origin) && origin === new URL(request.url).origin;
}

export default async function onRequest(context) {
  const request = context.request;
  const backend = String(context.env.CLOUDFLARE_WORKER_ORIGIN || "").replace(/\/+$/, "");
  const secret = String(context.env.EDGE_PROXY_SECRET || "");
  let backendUrl;
  try {
    backendUrl = new URL(backend);
  } catch {
    return jsonError("站点后端地址尚未配置", 503);
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
    return jsonError("站点后端连接参数尚未配置完整", 503);
  }
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_API_BODY_BYTES)
    return jsonError("API 请求体过大", 413);

  const incoming = new URL(request.url);
  if (!sameOriginMutation(request)) {
    return jsonError("跨站写请求已拦截", 403);
  }
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
  headers.set("x-xbloom-client-ip", context.clientIp || request.eo?.clientIp || "unknown");
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", "https");

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let bodyTooLarge = false;
  const body =
    hasBody && request.body
      ? limitBody(request.body, MAX_API_BODY_BYTES, () => {
          bodyTooLarge = true;
        })
      : null;
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
    ...(hasBody ? { body, duplex: "half" } : {}),
  };
  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch {
    if (bodyTooLarge) return jsonError("API 请求体过大", 413);
    return jsonError("云端后端连接暂时不可用", 502);
  }
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

// Keep a named export so the platform entry point is exercised directly by
// the local test suite rather than through a separate test-only wrapper.
export { onRequest };
