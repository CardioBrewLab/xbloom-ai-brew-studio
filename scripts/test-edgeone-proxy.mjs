import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, beforeEach, describe, test } from "node:test";
import edgeOneHandler, { onRequest } from "../cloud-functions/api/[[default]].js";

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
  test("部署配置使用平台预装 Node，并给流式 API 配置完整函数时限与安全响应头", async () => {
    const config = JSON.parse(await readFile(new URL("../edgeone.json", import.meta.url), "utf8"));
    assert.equal(config.nodeVersion, "22.11.0");
    assert.equal(config.cloudFunctions?.nodejs?.maxDuration, 120);

    const globalHeaders = Object.fromEntries(
      config.headers
        .find((rule) => rule.source === "/*")
        .headers.map(({ key, value }) => [key.toLowerCase(), value]),
    );
    assert.equal(globalHeaders["x-frame-options"], "DENY");
    assert.equal(globalHeaders["strict-transport-security"], "max-age=31536000");
    assert.match(globalHeaders["content-security-policy"], /frame-ancestors 'none'/);
    assert.match(globalHeaders["content-security-policy"], /connect-src 'self'/);
  });

  test("默认导出与可测试的命名处理器保持一致", () => {
    assert.equal(edgeOneHandler, onRequest);
  });

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
            origin: "https://brew.example.cn",
            "x-xbloom-proxy-secret": "attacker-value",
            "x-xbloom-client-ip": "attacker-ip",
            "cf-connecting-ip": "attacker-cf-ip",
          },
          body: JSON.stringify({ prompt: "test" }),
        },
        "198.51.100.23",
      ),
      clientIp: "198.51.100.23",
      env: {
        CLOUDFLARE_WORKER_ORIGIN: "https://worker.example/",
        EDGE_PROXY_SECRET: "s".repeat(48),
      },
    });

    assert.equal(captured.target, "https://worker.example/api/generate?mode=max");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.redirect, "manual");
    assert.equal(captured.init.duplex, "half");
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

  test("跨站或缺少 Origin 的写请求不会获得可信代理豁免", async () => {
    let forwarded = false;
    globalThis.fetch = async () => {
      forwarded = true;
      return new Response(null, { status: 204 });
    };
    const env = {
      CLOUDFLARE_WORKER_ORIGIN: "https://worker.example/",
      EDGE_PROXY_SECRET: "s".repeat(48),
    };
    for (const origin of ["https://attacker.example", null]) {
      const headers = origin ? { origin } : {};
      const response = await onRequest({
        request: edgeRequest("https://brew.example.cn/api/beans", {
          method: "POST",
          headers,
          body: "{}",
        }),
        env,
      });
      assert.equal(response.status, 403);
    }
    assert.equal(forwarded, false);
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

  test("客户端取消会传递到 Cloudflare 上游请求", async () => {
    let capturedSignal;
    globalThis.fetch = async (_target, init) => {
      capturedSignal = init.signal;
      return new Response(null, { status: 204 });
    };
    const controller = new AbortController();
    const response = await onRequest({
      request: edgeRequest("https://brew.example.cn/api/status", {
        signal: controller.signal,
      }),
      env: {
        CLOUDFLARE_WORKER_ORIGIN: "https://worker.example/",
        EDGE_PROXY_SECRET: "e".repeat(32),
      },
    });
    assert.equal(response.status, 204);
    assert.equal(capturedSignal.aborted, false);
    controller.abort(new Error("client left"));
    assert.equal(capturedSignal.aborted, true);
  });

  test("上游网络异常返回稳定的 JSON 502，而不是平台运行时错误", async () => {
    globalThis.fetch = async () => {
      throw new Error("simulated network failure");
    };
    const response = await onRequest({
      request: edgeRequest("https://brew.example.cn/api/status"),
      env: {
        CLOUDFLARE_WORKER_ORIGIN: "https://worker.example/",
        EDGE_PROXY_SECRET: "e".repeat(32),
      },
    });
    assert.equal(response.status, 502);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await response.json(), {
      ok: false,
      message: "云端后端连接暂时不可用",
    });
  });
});
