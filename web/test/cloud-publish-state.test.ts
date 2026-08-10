import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldBindCloudRecord } from "../src/lib/cloud-publish-state.js";

describe("云端写入确认状态", () => {
  it("只把 verified 记录写入本地绑定", () => {
    assert.equal(shouldBindCloudRecord({ state: "verified", message: "ok" }), true);
    assert.equal(shouldBindCloudRecord({ state: "mismatch", message: "different" }), false);
    assert.equal(shouldBindCloudRecord({ state: "unverified", message: "pending" }), false);
  });
});
