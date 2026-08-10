import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GENERATION_MODES,
  generationModeOption,
  isGenerationMode,
} from "../src/lib/generation-mode.js";

describe("Fast / Pro / Max 模式文案契约", () => {
  it("三种模式顺序与行为摘要固定", () => {
    assert.deepEqual(
      GENERATION_MODES.map(({ id, eyebrow, summary }) => ({ id, eyebrow, summary })),
      [
        { id: "fast", eyebrow: "FAST", summary: "不联网 · 1 份" },
        { id: "pro", eyebrow: "PRO", summary: "联网 · 1 份" },
        { id: "max", eyebrow: "MAX", summary: "联网 · 3 份优选" },
      ],
    );
  });

  it("只接纳正式模式值，未知值回退 Max 展示", () => {
    assert.equal(isGenerationMode("fast"), true);
    assert.equal(isGenerationMode("pro"), true);
    assert.equal(isGenerationMode("max"), true);
    assert.equal(isGenerationMode("turbo"), false);
    assert.equal(generationModeOption("max").name, "细调风味");
  });
});
