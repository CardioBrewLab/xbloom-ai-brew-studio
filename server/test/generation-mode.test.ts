import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveGenerationPlan } from "../src/lib/generation-mode.js";

const defaults = { candidateCount: 3, maxResearchRounds: 2 };

describe("Fast / Pro / Max 服务端执行计划", () => {
  it("Fast 使用本地知识库单案且不进入换源循环", () => {
    assert.deepEqual(resolveGenerationPlan("fast", true, defaults), {
      mode: "fast",
      research: false,
      candidateCount: 1,
      maxResearchRounds: 0,
    });
  });

  it("Pro 联网但只生成一案", () => {
    assert.deepEqual(resolveGenerationPlan("pro", false, defaults), {
      mode: "pro",
      research: true,
      candidateCount: 1,
      maxResearchRounds: 0,
    });
  });

  it("Max 保留当前三案评分与低分换源轮次", () => {
    assert.deepEqual(resolveGenerationPlan("max", false, defaults), {
      mode: "max",
      research: true,
      candidateCount: 3,
      maxResearchRounds: 2,
    });
  });

  it("Max 固定三案，不受 legacy 环境候选数影响", () => {
    assert.equal(
      resolveGenerationPlan("max", true, { candidateCount: 5, maxResearchRounds: 1 })
        .candidateCount,
      3,
    );
    assert.equal(
      resolveGenerationPlan("max", true, { candidateCount: 1, maxResearchRounds: 1 })
        .candidateCount,
      3,
    );
  });

  it("旧请求继续兼容 research 开关；关闭时省去无效重跑", () => {
    assert.deepEqual(resolveGenerationPlan(undefined, true, defaults), {
      mode: "legacy",
      research: true,
      candidateCount: 3,
      maxResearchRounds: 2,
    });
    assert.deepEqual(resolveGenerationPlan(undefined, false, defaults), {
      mode: "legacy",
      research: false,
      candidateCount: 3,
      maxResearchRounds: 0,
    });
  });
});
