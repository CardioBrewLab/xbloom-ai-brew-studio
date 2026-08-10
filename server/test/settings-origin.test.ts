import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTrustedSettingsOrigin } from "../src/routes/settings.js";

describe("模型设置来源边界", () => {
  it("接纳本机工作台与 CLI，拦截外部网页来源", () => {
    assert.equal(isTrustedSettingsOrigin(undefined), true);
    assert.equal(isTrustedSettingsOrigin("http://localhost:5180"), true);
    assert.equal(isTrustedSettingsOrigin("http://127.0.0.1:5180"), true);
    assert.equal(isTrustedSettingsOrigin("https://example.com"), false);
    assert.equal(isTrustedSettingsOrigin("not-a-url"), false);
  });
});
