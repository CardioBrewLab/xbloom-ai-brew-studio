import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { missingRecipeMessage } from "../src/lib/generation-run.js";

describe("生成结束可见兜底", () => {
  it("recipe 或 error 已到达时不追加兜底错误", () => {
    assert.equal(missingRecipeMessage(true, false), undefined);
    assert.equal(missingRecipeMessage(false, true), undefined);
    assert.equal(missingRecipeMessage(true, true), undefined);
  });

  it("SSE 静默结束时给出可读提示", () => {
    assert.match(missingRecipeMessage(false, false) ?? "", /没有收到可展示的配方/);
  });
});
