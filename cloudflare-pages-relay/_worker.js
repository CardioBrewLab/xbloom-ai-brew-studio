/**
 * Cloudflare Pages API relay used when an EdgeOne Cloud Function cannot reach
 * a workers.dev origin directly. The deployment script replaces the marker in
 * a temporary upload bundle; public forks never inherit the maintainer's URL.
 */
const DEPLOYED_UPSTREAM_ORIGIN = "__XBLOOM_UPSTREAM_ORIGIN__";
const MAX_API_BODY_BYTES = 262_144;

function jsonError(message, status) {
  return new Response(JSON.stringify({ ok: false, message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function upstreamOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  return parsed;
}

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

export async function relayRequest(request, env = {}) {
  const incoming = new URL(request.url);
  if (incoming.pathname !== "/api" && !incoming.pathname.startsWith("/api/")) {
    return new Response("Not found", { status: 404 });
  }

  const upstream = upstreamOrigin(
    env.RELAY_UPSTREAM_ORIGIN || env.UPSTREAM_ORIGIN || DEPLOYED_UPSTREAM_ORIGIN,
  );
  if (!upstream) return jsonError("API Relay 上游地址尚未配置", 503);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_API_BODY_BYTES)
    return jsonError("API Relay 请求体过大", 413);

  const target = new URL(`${incoming.pathname}${incoming.search}`, upstream);
  const headers = new Headers(request.headers);
  for (const name of ["host", "content-length", "cf-connecting-ip", "x-xbloom-relay"]) {
    headers.delete(name);
  }
  headers.set("x-xbloom-relay", "cloudflare-pages");

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
    signal: request.signal,
    ...(hasBody ? { body, duplex: "half" } : {}),
  };

  let response;
  try {
    response = await fetch(new Request(target, init));
  } catch {
    if (bodyTooLarge) return jsonError("API Relay 请求体过大", 413);
    return jsonError("API Relay 上游暂时不可用", 502);
  }

  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("content-length");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-xbloom-relay", "cloudflare-pages");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export default {
  fetch(request, env) {
    return relayRequest(request, env);
  },
};
