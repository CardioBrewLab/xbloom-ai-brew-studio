import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { onRequest } from "../edge-functions/api/[[default]].js";

const originalFetch = globalThis.fetch;

function edgeRequest(url, init = {}, clientIp = "203.0.113.8") {
  const request = new Request(url, init);
  Object.defineProperty(request, "eo", { value: { clientIp } });
  return request;
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

describe("EdgeOne 中国入口 API Relay", () => {
  test("缺失或带凭据的后端配置返回 503", async () => {
    const missing = await onRequest({
      request: edgeRequest("https://brew.example.cn/api/status"),
      env: {},
    });
    assert.equal(missing.status, 503);

    const credentials = await onRequest({
      request: edgeRequest("https://brew.example.cn/api/status"),
      env: {
        CLOUDFLARE_WORKER_ORIGIN: "https://user:pass@worker.example/",
        EDGE_PROXY_SECRET: "x".repeat(32),
      },
    });
    assert.equal(credentials.status, 503);
  });

  test("只转发可信代理头，保留方法、查询、正文和流式响应", async () => {
    let captured;
    globalThis.fetch = async (target, init) => {
      captured = { target: String(target), init };
      return new Response('data: {"type":"done"}\n\n', {
        status: 202,
        headers: {
          "content-type": "text/event-stream",
          "set-cookie": "xbloom_auth=session; Path=/; HttpOnly; Secure",
          "content-length": "999",
        },
      });
    };

    const response = await onRequest({
      request: edgeRequest(
        "https://brew.example.cn/api/generate?mode=max",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-xbloom-proxy-secret": "attacker-value",
            "x-xbloom-client-ip": "attacker-ip",
            "cf-connecting-ip": "attacker-cf-ip",
          },
          body: JSON.stringify({ prompt: "test" }),
        },
        "198.51.100.23",
      ),
      env: {
        CLOUDFLARE_WORKER_ORIGIN: "https://worker.example/",
        EDGE_PROXY_SECRET: "s".repeat(48),
      },
    });

    assert.equal(captured.target, "https://worker.example/api/generate?mode=max");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.redirect, "manual");
    assert.equal(captured.init.headers.get("x-xbloom-proxy-secret"), "s".repeat(48));
    assert.equal(captured.init.headers.get("x-xbloom-client-ip"), "198.51.100.23");
    assert.equal(captured.init.headers.get("cf-connecting-ip"), null);
    assert.equal(captured.init.headers.get("x-forwarded-host"), "brew.example.cn");
    assert.deepEqual(await new Response(captured.init.body).json(), { prompt: "test" });

    assert.equal(response.status, 202);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("x-xbloom-edge"), "edgeone");
    assert.match(response.headers.get("set-cookie") ?? "", /xbloom_auth=session/);
    assert.match(await response.text(), /done/);
  });

  test("GET 与 HEAD 不附带正文，缺少边缘 IP 时使用 unknown", async () => {
    for (const method of ["GET", "HEAD"]) {
      globalThis.fetch = async (_target, init) => {
        assert.equal(init.body, undefined);
        assert.equal(init.headers.get("x-xbloom-client-ip"), "unknown");
        return new Response(null, { status: 204 });
      };
      const request = new Request("https://brew.example.cn/api/status", { method });
      const response = await onRequest({
        request,
        env: {
          CLOUDFLARE_WORKER_ORIGIN: "https://worker.example/",
          EDGE_PROXY_SECRET: "e".repeat(32),
        },
      });
      assert.equal(response.status, 204);
    }
  });
});
