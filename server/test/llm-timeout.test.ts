import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  completionTokenParams,
  isTransientTransportError,
  LlmRequestError,
  llmRequestSignal,
  reasoningParams,
  samplingParams,
  usesReasoningTokenBudget,
} from "../src/lib/llm.js";
import { config } from "../src/config.js";

describe("LLM 请求超时信号", () => {
  it("单次请求到达上限后中止", async () => {
    const signal = llmRequestSignal(undefined, 10);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(signal.aborted, true);
  });

  it("父请求先中止时立即联动", () => {
    const parent = new AbortController();
    const signal = llmRequestSignal(parent.signal, 10_000);
    parent.abort();
    assert.equal(signal.aborted, true);
  });
});

describe("LLM 瞬时传输故障判定", () => {
  it("识别 Undici fetch failed 的嵌套错误码", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" }),
    });
    assert.equal(isTransientTransportError(error), true);
  });

  it("识别临时 5xx，但不重试认证和参数错误", () => {
    assert.equal(isTransientTransportError(new LlmRequestError("bad gateway", 502)), true);
    assert.equal(isTransientTransportError(new LlmRequestError("unauthorized", 401)), false);
    assert.equal(isTransientTransportError(new LlmRequestError("bad request", 400)), false);
  });
});

describe("OpenAI 推理模型请求参数", () => {
  it("GPT 与 o 系列沿用或覆盖推理强度，其他模型忽略", () => {
    const saved = config.llm.reasoningEffort;
    config.llm.reasoningEffort = "high";
    try {
      assert.deepEqual(reasoningParams("gpt-test"), { reasoning_effort: "high" });
      assert.deepEqual(reasoningParams("gpt-test", "low"), { reasoning_effort: "low" });
      assert.deepEqual(reasoningParams("gpt-test", false), {});
      assert.deepEqual(reasoningParams("o3-mini", "low"), { reasoning_effort: "low" });
      assert.deepEqual(reasoningParams("claude-test", "low"), {});
    } finally {
      config.llm.reasoningEffort = saved;
    }
  });

  it("推理模型不发送 temperature，并使用 completion token 预算字段", () => {
    assert.deepEqual(samplingParams("o3-mini", { temperature: 0.2 }), {});
    assert.equal(usesReasoningTokenBudget("o3-mini"), true);
    assert.equal(usesReasoningTokenBudget("gpt-5.6"), true);
    assert.equal(usesReasoningTokenBudget("gpt-4o-mini"), false);
    assert.deepEqual(completionTokenParams("o3-mini", 700), { max_completion_tokens: 700 });
    assert.deepEqual(completionTokenParams("gpt-5.6", 700), { max_completion_tokens: 700 });
    assert.deepEqual(completionTokenParams("gpt-4o-mini", 700), { max_tokens: 700 });
    assert.deepEqual(completionTokenParams("claude-test", 700), { max_tokens: 700 });
  });
});
