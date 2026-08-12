import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cloudPublishTarget, shouldBindCloudRecord } from "../src/lib/cloud-publish-state.js";

describe("云端写入确认状态", () => {
  it("只把 verified 记录写入本地绑定", () => {
    assert.equal(shouldBindCloudRecord({ state: "verified", message: "ok" }), true);
    assert.equal(shouldBindCloudRecord({ state: "mismatch", message: "different" }), false);
    assert.equal(shouldBindCloudRecord({ state: "unverified", message: "pending" }), false);
  });

  it("reopens a pending write as an update instead of creating another cloud row", () => {
    const pending = {
      tableId: "CLOUD-1",
      shareUrl: "https://share.example/CLOUD-1",
      region: "global" as const,
      recipeKey: "recipe-1",
    };
    assert.deepEqual(cloudPublishTarget(undefined, pending), {
      mode: "update",
      tableId: "CLOUD-1",
    });
    assert.deepEqual(cloudPublishTarget("IMPORTED-1", pending), {
      mode: "update",
      tableId: "IMPORTED-1",
    });
    assert.deepEqual(cloudPublishTarget(undefined), { mode: "create" });
  });
});
