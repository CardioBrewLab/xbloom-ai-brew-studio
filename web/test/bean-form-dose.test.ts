/**
 * 可用豆量输入解析测试（任务 #58，node:test + assert）：
 * - 留空 = 按 AI 推荐粉量（不发送字段）
 * - 合法数字原样返回；非数字/越出 1-200 克给轻提示且不返回 grams
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAvailableDose } from "../src/components/BeanForm.js";

describe("可用豆量输入解析（任务 #58）", () => {
  it("留空/纯空白：无 grams 无 hint（按 AI 推荐粉量，字段不发送）", () => {
    assert.deepEqual(parseAvailableDose(""), {});
    assert.deepEqual(parseAvailableDose("   "), {});
  });

  it("合法数字（含小数）：返回 grams，无 hint", () => {
    assert.deepEqual(parseAvailableDose("12"), { grams: 12 });
    assert.deepEqual(parseAvailableDose(" 15.5 "), { grams: 15.5 });
    assert.deepEqual(parseAvailableDose("1"), { grams: 1 });
    assert.deepEqual(parseAvailableDose("200"), { grams: 200 });
  });

  it("越界（0 / 负数 / >200）：仅给轻提示，不返回 grams", () => {
    for (const bad of ["0", "-3", "201", "999"]) {
      const r = parseAvailableDose(bad);
      assert.equal(r.grams, undefined);
      assert.ok(r.hint && r.hint.includes("1~200"));
    }
  });

  it("非数字：仅给轻提示，不返回 grams", () => {
    for (const bad of ["abc", "12g", "NaN"]) {
      const r = parseAvailableDose(bad);
      assert.equal(r.grams, undefined);
      assert.ok(r.hint);
    }
  });
});
