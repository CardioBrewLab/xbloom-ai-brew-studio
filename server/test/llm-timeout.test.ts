import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { llmRequestSignal } from "../src/lib/llm.js";

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
