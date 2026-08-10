import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { config } from "../src/config.js";
import settingsRouter, { isLoopbackHostname } from "../src/routes/settings.js";

let appServer: http.Server;
let appPort = 0;
const originalLlmConfig = { ...config.llm };

function shutdown(server: http.Server | undefined): void {
  if (!server) return;
  server.closeAllConnections?.();
  server.close();
}

async function startMockLlm(status = 200): Promise<{
  server: http.Server;
  port: number;
  requests: Array<{ url: string; authorization: string; body: Record<string, unknown> }>;
}> {
  const requests: Array<{
    url: string;
    authorization: string;
    body: Record<string, unknown>;
  }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        authorization: req.headers.authorization ?? "",
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        status >= 400
          ? JSON.stringify({ error: { message: "UPSTREAM_SECRET_DIAGNOSTIC" } })
          : JSON.stringify({ choices: [{ message: { content: "OK" } }] }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: (server.address() as AddressInfo).port, requests };
}

async function testConnection(origin?: string): Promise<{
  status: number;
  text: string;
  json: Record<string, unknown>;
}> {
  const response = await fetch(`http://127.0.0.1:${appPort}/api/settings/llm/test`, {
    method: "POST",
    ...(origin ? { headers: { origin } } : {}),
  });
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/settings", settingsRouter);
  appServer = app.listen(0, "127.0.0.1");
  await once(appServer, "listening");
  appPort = (appServer.address() as AddressInfo).port;
});

after(() => {
  Object.assign(config.llm, originalLlmConfig);
  shutdown(appServer);
});

describe("POST /api/settings/llm/test", () => {
  it("accepts loopback hosts and rejects non-local origins", async () => {
    assert.equal(isLoopbackHostname("localhost"), true);
    assert.equal(isLoopbackHostname("127.0.0.1"), true);
    assert.equal(isLoopbackHostname("[::1]"), true);
    assert.equal(isLoopbackHostname("attacker.example"), false);

    const result = await testConnection("https://attacker.example");
    assert.equal(result.status, 403);
    assert.equal(result.json.ok, false);
  });

  it("uses the configured OpenAI-compatible URL, model and key", async () => {
    const mock = await startMockLlm();
    try {
      Object.assign(config.llm, {
        baseUrl: `http://127.0.0.1:${mock.port}/v1`,
        apiKey: "fixture-api-key",
        model: "fixture-model",
        fallbackModel: "",
        thirdModel: "",
        reasoningEffort: "",
      });

      const result = await testConnection();
      assert.equal(result.status, 200);
      assert.equal(result.json.ok, true);
      assert.equal(result.json.model, "fixture-model");
      assert.equal(typeof result.json.latencyMs, "number");
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0]?.url, "/v1/chat/completions");
      assert.equal(mock.requests[0]?.authorization, "Bearer fixture-api-key");
      assert.equal(mock.requests[0]?.body.model, "fixture-model");
      assert.equal(mock.requests[0]?.body.stream, false);
    } finally {
      shutdown(mock.server);
    }
  });

  it("does not expose the upstream response body or API key on failure", async () => {
    const mock = await startMockLlm(401);
    try {
      Object.assign(config.llm, {
        baseUrl: `http://127.0.0.1:${mock.port}/v1`,
        apiKey: "fixture-secret-key",
        model: "fixture-model",
        fallbackModel: "",
        thirdModel: "",
        reasoningEffort: "",
      });

      const result = await testConnection();
      assert.equal(result.status, 400);
      assert.equal(result.json.ok, false);
      assert.match(String(result.json.message), /HTTP 401/);
      assert.equal(result.text.includes("UPSTREAM_SECRET_DIAGNOSTIC"), false);
      assert.equal(result.text.includes("fixture-secret-key"), false);
    } finally {
      shutdown(mock.server);
    }
  });
});
