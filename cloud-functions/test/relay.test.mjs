import assert from "node:assert/strict";
import test from "node:test";
import onRequest from "../api/[[default]].js";

test("EdgeOne relay bounds chunked API bodies before forwarding", async () => {
  let bytesRead = 0;
  let upstreamCalls = 0;
  const chunk = new Uint8Array(64 * 1024);
  const body = new ReadableStream({
    pull(controller) {
      bytesRead += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    upstreamCalls += 1;
    await new Request(input, init).arrayBuffer();
    return new Response("unexpected upstream response", { status: 200 });
  };
  try {
    const response = await onRequest({
      request: new Request("https://relay.example/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://relay.example" },
        body,
        duplex: "half",
      }),
      env: {
        CLOUDFLARE_WORKER_ORIGIN: "https://worker.example/",
        EDGE_PROXY_SECRET: "edge-secret-with-at-least-32-characters",
      },
      clientIp: "198.51.100.10",
    });
    assert.equal(response.status, 413);
    assert.equal(upstreamCalls, 1);
    assert.ok(bytesRead <= 393216, `read ${bytesRead} bytes`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
