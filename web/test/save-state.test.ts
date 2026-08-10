import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { saveCompletionIsCurrent } from "../src/lib/save-state.js";

describe("单配方异步保存身份", () => {
  it("请求和配方版本都一致时才接纳完成结果", () => {
    assert.equal(saveCompletionIsCurrent(4, 8, 4, 8), true);
    assert.equal(saveCompletionIsCurrent(4, 8, 5, 8), false);
    assert.equal(saveCompletionIsCurrent(4, 8, 4, 9), false);
  });
});
