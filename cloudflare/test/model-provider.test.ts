import assert from "node:assert/strict";
import { it } from "node:test";
import {
  detectModelProvider,
  discoverModels,
  equivalentModelBaseUrls,
  generateModelText,
  normalizeModelBaseUrl,
  testModelConnection,
} from "../../shared/src/model-provider.ts";

it("按官方域名识别原生 Claude / Gemini，其余走 OpenAI 兼容协议", () => {
  assert.equal(detectModelProvider("https://api.anthropic.com/v1"), "anthropic");
  assert.equal(detectModelProvider("https://generativelanguage.googleapis.com/v1beta"), "gemini");
  assert.equal(detectModelProvider("https://api.deepseek.com/v1"), "openai-compatible");
});

it("仅把同源根地址与 /v1 视为同一凭据边界", () => {
  assert.equal(
    equivalentModelBaseUrls("https://gateway.example.com/", "https://gateway.example.com/v1"),
    true,
  );
  assert.equal(
    equivalentModelBaseUrls("https://gateway.example.com/api", "https://gateway.example.com/v1"),
    false,
  );
  assert.equal(equivalentModelBaseUrls("https://a.example/v1", "https://b.example/v1"), false);
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
  assert.equal(result.baseUrl, "https://api.example.com/v1");
  assert.deepEqual(result.models, ["model-a", "model-b"]);
});

it("模型发现兼容网关的 models 数组与常见模型字段", async () => {
  const result = await discoverModels(
    {
      provider: "openai-compatible",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "TOKEN",
    },
    {
      fetcher: async () =>
        Response.json({
          models: [{ id: "model-a" }, { model: "model-b" }, { model_id: "model-c" }, "model-d"],
        }),
    },
  );
  assert.deepEqual(result.models, ["model-a", "model-b", "model-c", "model-d"]);
});

it("网关同时返回 data 与 models 时合并全部模型", async () => {
  const result = await discoverModels(
    {
      provider: "openai-compatible",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "TOKEN",
    },
    {
      fetcher: async () =>
        Response.json({ data: [{ id: "model-a" }], models: [{ name: "model-b" }] }),
    },
  );
  assert.deepEqual(result.models, ["model-a", "model-b"]);
});

it("模型发现兼容裸数组，并保留超过 300 个的聚合网关模型池", async () => {
  const models = Array.from({ length: 350 }, (_, index) => ({ id: `model-${index}` }));
  const result = await discoverModels(
    {
      provider: "openai-compatible",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "TOKEN",
    },
    { fetcher: async () => Response.json(models) },
  );
  assert.equal(result.models.length, 350);
  assert.ok(result.models.includes("model-349"));
});

it("Gemini 模型发现读取全部分页并去除 models/ 前缀", async () => {
  const requestUrls: string[] = [];
  const result = await discoverModels(
    {
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "TOKEN",
    },
    {
      fetcher: async (input) => {
        const url = String(input);
        requestUrls.push(url);
        return url.includes("pageToken=NEXT")
          ? Response.json({ models: [{ name: "models/gemini-b" }] })
          : Response.json({
              models: [{ name: "models/gemini-a" }],
              nextPageToken: "NEXT",
            });
      },
    },
  );
  assert.equal(requestUrls.length, 2);
  assert.match(requestUrls[0], /pageSize=1000/);
  assert.match(requestUrls[1], /pageToken=NEXT/);
  assert.deepEqual(result.models, ["gemini-a", "gemini-b"]);
});

it("OpenAI 兼容网关使用 has_more/last_id 时继续读取 after_id 下一页", async () => {
  const requestUrls: string[] = [];
  const result = await discoverModels(
    {
      provider: "openai-compatible",
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "TOKEN",
    },
    {
      fetcher: async (input) => {
        const url = String(input);
        requestUrls.push(url);
        return url.includes("after_id=CURSOR")
          ? Response.json({ data: [{ id: "model-b" }], has_more: false })
          : Response.json({ data: [{ id: "model-a" }], has_more: true, last_id: "CURSOR" });
      },
    },
  );
  assert.deepEqual(requestUrls, [
    "https://gateway.example.com/v1/models",
    "https://gateway.example.com/v1/models?after_id=CURSOR",
  ]);
  assert.deepEqual(result.models, ["model-a", "model-b"]);
});

it("OpenAI 兼容根地址遇到网页时自动尝试 /v1 并返回修正地址", async () => {
  const requestUrls: string[] = [];
  const result = await discoverModels(
    {
      provider: "openai-compatible",
      baseUrl: "https://gateway.example.com/",
      apiKey: "TOKEN",
    },
    {
      fetcher: async (input) => {
        requestUrls.push(String(input));
        return String(input).endsWith("/v1/models")
          ? Response.json({ data: [{ id: "model-a" }] })
          : new Response("<html>console</html>", {
              headers: { "content-type": "text/html" },
            });
      },
    },
  );
  assert.deepEqual(requestUrls, [
    "https://gateway.example.com/models",
    "https://gateway.example.com/v1/models",
  ]);
  assert.equal(result.baseUrl, "https://gateway.example.com/v1");
  assert.deepEqual(result.models, ["model-a"]);
});

it("根地址与 /v1 都有效时采用模型更完整的入口", async () => {
  const result = await discoverModels(
    {
      provider: "openai-compatible",
      baseUrl: "https://gateway.example.com/",
      apiKey: "TOKEN",
    },
    {
      fetcher: async (input) =>
        String(input).endsWith("/v1/models")
          ? Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] })
          : Response.json({ data: [{ id: "model-a" }] }),
    },
  );
  assert.equal(result.baseUrl, "https://gateway.example.com/v1");
  assert.deepEqual(result.models, ["model-a", "model-b"]);
});

it("OpenAI 兼容根地址的首跳报错时仍在同一总预算内尝试 /v1", async () => {
  const requestUrls: string[] = [];
  const result = await discoverModels(
    {
      provider: "openai-compatible",
      baseUrl: "https://gateway.example.com/",
      apiKey: "TOKEN",
    },
    {
      fetcher: async (input) => {
        requestUrls.push(String(input));
        if (requestUrls.length === 1) throw new DOMException("root timeout", "TimeoutError");
        return Response.json({ data: [{ id: "model-a" }] });
      },
    },
  );
  assert.equal(result.baseUrl, "https://gateway.example.com/v1");
  assert.deepEqual(requestUrls, [
    "https://gateway.example.com/models",
    "https://gateway.example.com/v1/models",
  ]);
});

it("非根路径返回网页时给出 API 地址提示而非请求体 JSON 错误", async () => {
  await assert.rejects(
    discoverModels(
      {
        provider: "openai-compatible",
        baseUrl: "https://gateway.example.com/api",
        apiKey: "TOKEN",
      },
      { fetcher: async () => new Response("<html>console</html>") },
    ),
    /模型接口模型列表响应不是 JSON.*\/v1/,
  );
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

it("生成接口返回网页时给出接口地址提示", async () => {
  await assert.rejects(
    generateModelText(
      {
        provider: "openai-compatible",
        baseUrl: "https://gateway.example.com/v1",
        apiKey: "TOKEN",
        model: "model-a",
      },
      [{ role: "user", content: "HELLO" }],
      { fetcher: async () => new Response("<html>console</html>") },
    ),
    /模型接口生成响应不是 JSON.*\/v1/,
  );
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
