import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import relay, { relayRequest } from "../_worker.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

describe("Cloudflare Pages API Relay", () => {
  test("只接受 /api 路径并要求纯 HTTPS 上游根地址", async () => {
    assert.equal((await relayRequest(new Request("https://relay.example/"))).status, 404);
    assert.equal((await relayRequest(new Request("https://relay.example/api/status"))).status, 503);
    assert.equal(
      (
        await relayRequest(new Request("https://relay.example/api/status"), {
          UPSTREAM_ORIGIN: "https://user:pass@worker.example/",
        })
      ).status,
      503,
    );
  });

  test("保留方法、查询、正文、代理凭据、Cookie 与 SSE", async () => {
    let captured;
    globalThis.fetch = async (request) => {
      captured = request;
      return new Response('data: {"type":"done"}\n\n', {
        status: 202,
        headers: {
          "content-type": "text/event-stream",
          "content-length": "999",
          "set-cookie": "xbloom_auth=session; Path=/; HttpOnly; Secure",
        },
      });
    };

    const response = await relay.fetch(
      new Request("https://relay.example/api/generate?mode=max", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "attacker-ip",
          "x-xbloom-proxy-secret": "trusted-edge-secret",
          "x-xbloom-client-ip": "198.51.100.23",
          "x-xbloom-relay": "attacker-value",
        },
        body: JSON.stringify({ prompt: "test" }),
      }),
      { UPSTREAM_ORIGIN: "https://worker.example/" },
    );

    assert.equal(captured.url, "https://worker.example/api/generate?mode=max");
    assert.equal(captured.method, "POST");
    assert.equal(captured.headers.get("cf-connecting-ip"), null);
    assert.equal(captured.headers.get("x-xbloom-proxy-secret"), "trusted-edge-secret");
    assert.equal(captured.headers.get("x-xbloom-client-ip"), "198.51.100.23");
    assert.equal(captured.headers.get("x-xbloom-relay"), "cloudflare-pages");
    assert.deepEqual(await captured.json(), { prompt: "test" });

    assert.equal(response.status, 202);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("x-xbloom-relay"), "cloudflare-pages");
    assert.match(response.headers.get("set-cookie") ?? "", /xbloom_auth=session/);
    assert.match(await response.text(), /done/);
  });

  test("上游网络异常返回稳定 JSON 502", async () => {
    globalThis.fetch = async () => {
      throw new Error("simulated network failure");
    };
    const response = await relayRequest(new Request("https://relay.example/api/status"), {
      UPSTREAM_ORIGIN: "https://worker.example/",
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      ok: false,
      message: "API Relay 上游暂时不可用",
    });
  });

  test("chunked API bodies are bounded before relay forwarding", async () => {
    let bytesRead = 0;
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream({
      pull(controller) {
        bytesRead += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    globalThis.fetch = async (request) => {
      await request.arrayBuffer();
      return new Response("unexpected upstream response", { status: 200 });
    };
    const response = await relay.fetch(
      new Request("https://relay.example/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      }),
      { UPSTREAM_ORIGIN: "https://worker.example/" },
    );
    assert.equal(response.status, 413);
    assert.ok(bytesRead <= 393216, `read ${bytesRead} bytes`);
  });
});
