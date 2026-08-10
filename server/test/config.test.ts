/**
 * 配置解析测试（任务 #113）：GENERATE_CANDIDATES 区分「未设置」与「设置了但越界」。
 * - 未设置/空串/非法值 → 缺省 3
 * - 已设置的数值（含 0/负数/超 5/小数）一律钳位到 [1,5] 整数（0 → 1 回滚而非静默 3）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGenerateCandidates } from "../src/config.js";

describe("parseGenerateCandidates（任务 #106/#113）", () => {
  it("未设置/空串/纯空白/非法值 → 缺省 3", () => {
    assert.equal(parseGenerateCandidates(undefined), 3);
    assert.equal(parseGenerateCandidates(""), 3);
    assert.equal(parseGenerateCandidates("   "), 3);
    assert.equal(parseGenerateCandidates("abc"), 3);
    assert.equal(parseGenerateCandidates("1x"), 3);
  });

  it("已设置的值一律钳位到 [1,5] 整数：0/负数 → 1，超 5 → 5，小数四舍五入", () => {
    assert.equal(parseGenerateCandidates("0"), 1, "0 显式钳位为 1（回滚开关）而非静默 3");
    assert.equal(parseGenerateCandidates("-2"), 1);
    assert.equal(parseGenerateCandidates("9"), 5);
    assert.equal(parseGenerateCandidates("2.6"), 3);
    assert.equal(parseGenerateCandidates("2.4"), 2);
    assert.equal(parseGenerateCandidates("1"), 1);
    assert.equal(parseGenerateCandidates("2"), 2);
    assert.equal(parseGenerateCandidates("5"), 5);
  });
});
