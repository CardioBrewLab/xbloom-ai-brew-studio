import assert from "node:assert/strict";
import { it } from "node:test";
import { modelValidationTargets, parseStoredApiKeys } from "../src/model-settings.ts";

it("旧版单 Key 载荷在主模型和备用链之间复用", () => {
  assert.deepEqual(parseStoredApiKeys("TOKEN"), { primary: "TOKEN", fallback: "TOKEN" });
});

it("新版载荷分别恢复主 Key 与备用 Key", () => {
  assert.deepEqual(parseStoredApiKeys(JSON.stringify({ primary: "PRIMARY", fallback: "BACKUP" })), {
    primary: "PRIMARY",
    fallback: "BACKUP",
  });
});

it("保存前覆盖主模型、备用模型和第三模型，并去除完全重复的测试目标", () => {
  assert.deepEqual(modelValidationTargets("main", "backup", "third", "KEY-A", "KEY-B"), [
    { model: "main", apiKey: "KEY-A" },
    { model: "backup", apiKey: "KEY-B" },
    { model: "third", apiKey: "KEY-B" },
  ]);
  assert.deepEqual(modelValidationTargets("same", "same", "", "KEY", "KEY"), [
    { model: "same", apiKey: "KEY" },
  ]);
});
