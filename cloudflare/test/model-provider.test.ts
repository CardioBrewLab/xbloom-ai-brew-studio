import assert from "node:assert/strict";
import { it } from "node:test";
import {
  detectModelProvider,
  discoverModels,
  generateModelText,
  normalizeModelBaseUrl,
  testModelConnection,
} from "../../shared/src/model-provider.ts";

it("按官方域名识别原生 Claude / Gemini，其余走 OpenAI 兼容协议", () => {
  assert.equal(detectModelProvider("https://api.anthropic.com/v1"), "anthropic");
  assert.equal(detectModelProvider("https://generativelanguage.googleapis.com/v1beta"), "gemini");
  assert.equal(detectModelProvider("https://api.deepseek.com/v1"), "openai-compatible");
});

it("Hosted 地址校验拦截回环和带凭据 URL", () => {
  assert.throws(() => normalizeModelBaseUrl("http://127.0.0.1:11434/v1"), /公网|HTTPS/);
  assert.throws(() => normalizeModelBaseUrl("https://user:pass@example.com/v1"), /账号/);
  assert.equal(
    normalizeModelBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1/"),
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  );
});

it("OpenAI 兼容模型发现使用 Bearer 和 /models", async () => {
  let requestUrl = "";
  let authorization = "";
  const result = await discoverModels(
    {
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "TOKEN",
    },
    {
      fetcher: async (input, init) => {
        requestUrl = String(input);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({ data: [{ id: "model-b" }, { id: "model-a" }] });
      },
    },
  );
  assert.equal(requestUrl, "https://api.example.com/v1/models");
  assert.equal(authorization, "Bearer TOKEN");
  assert.deepEqual(result.models, ["model-a", "model-b"]);
});

it("Claude 使用 Messages 协议并读取 content.text", async () => {
  let requestUrl = "";
  let version = "";
  let payload: Record<string, unknown> = {};
  const text = await generateModelText(
    {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "TOKEN",
      model: "claude-model",
    },
    [
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "HELLO" },
    ],
    {
      fetcher: async (input, init) => {
        requestUrl = String(input);
        version = new Headers(init?.headers).get("anthropic-version") ?? "";
        payload = JSON.parse(String(init?.body));
        return Response.json({ content: [{ type: "text", text: "OK" }] });
      },
    },
  );
  assert.equal(requestUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(version, "2023-06-01");
  assert.equal(payload.system, "SYSTEM");
  assert.equal(text, "OK");
});

it("Gemini 使用 generateContent 并读取 candidates parts", async () => {
  let requestUrl = "";
  const text = await generateModelText(
    {
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "TOKEN",
      model: "gemini-model",
    },
    [{ role: "user", content: "HELLO" }],
    {
      fetcher: async (input) => {
        requestUrl = String(input);
        return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
      },
    },
  );
  assert.equal(
    requestUrl,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-model:generateContent",
  );
  assert.equal(text, "OK");
});

it("OpenAI 推理模型改用 max_completion_tokens 且省略 temperature", async () => {
  let payload: Record<string, unknown> = {};
  const text = await generateModelText(
    {
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "TOKEN",
      model: "gpt-5.6",
    },
    [{ role: "user", content: "HELLO" }],
    {
      maxTokens: 64,
      temperature: 0,
      fetcher: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ message: { content: "OK" } }] });
      },
    },
  );
  assert.equal(payload.max_completion_tokens, 64);
  assert.equal("max_tokens" in payload, false);
  assert.equal("temperature" in payload, false);
  assert.equal(text, "OK");
});

it("普通 OpenAI 兼容模型继续使用 max_tokens 与 temperature", async () => {
  let payload: Record<string, unknown> = {};
  await generateModelText(
    {
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiKey: "TOKEN",
      model: "gpt-4o-mini",
    },
    [{ role: "user", content: "HELLO" }],
    {
      maxTokens: 32,
      temperature: 0.2,
      fetcher: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ message: { content: "OK" } }] });
      },
    },
  );
  assert.equal(payload.max_tokens, 32);
  assert.equal(payload.temperature, 0.2);
  assert.equal("max_completion_tokens" in payload, false);
});

it("推理模型连接测试预留可见正文所需的 token 空间", async () => {
  let payload: Record<string, unknown> = {};
  await testModelConnection(
    {
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "TOKEN",
      model: "o3-mini",
    },
    {
      fetcher: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return Response.json({ choices: [{ message: { content: "OK" } }] });
      },
    },
  );
  assert.equal(payload.max_completion_tokens, 512);
  assert.equal("temperature" in payload, false);
});
