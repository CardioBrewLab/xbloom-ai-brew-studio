import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTransientTransportError, LlmRequestError, llmRequestSignal } from "../src/lib/llm.js";

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
