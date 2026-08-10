/**
 * 豆仓库存纯函数单测（任务 #51）：freshness 四态边界 / 闰年 / 月末 / 缺字段 + brewsLeft。
 * now 一律固定断言，日期按本地日期差计算。
 * 运行：npx tsx --test "test/*.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  brewsLeft,
  DEFAULT_PEAK_WINDOW_DAYS,
  freshness,
  parseLocalDate,
} from "../src/lib/bean-math.js";

// 固定基准日：2026-01-28（本地时间）
const NOW = new Date(2026, 0, 28, 14, 30);

test("freshness：resting —— 烘焙后未达养豆天数", () => {
  const f = freshness({ roastDate: "2026-01-25", restDays: 7, peakWindowDays: 45 }, NOW);
  assert.equal(f.phase, "resting");
  assert.equal(f.daysToReady, 4, "距适饮还有 4 天");
  assert.equal(f.daysLeft, 42, "窗口剩余 45-3 天");
});

test("freshness：prime —— days == restDays 当天即进入适饮", () => {
  const f = freshness({ roastDate: "2026-01-21", restDays: 7 }, NOW);
  assert.equal(f.phase, "prime");
  assert.equal(f.daysToReady, 0);
  assert.equal(f.daysLeft, DEFAULT_PEAK_WINDOW_DAYS - 7);
});

test("freshness：prime 上边界 —— days == peakWindowDays 仍在适饮期", () => {
  const f = freshness({ roastDate: "2025-12-14", restDays: 0, peakWindowDays: 45 }, NOW);
  assert.equal(f.phase, "prime");
  assert.equal(f.daysLeft, 0);
});

test("freshness：fading —— 超过 peakWindowDays 次日转衰落", () => {
  const f = freshness({ roastDate: "2025-12-13", restDays: 0, peakWindowDays: 45 }, NOW);
  assert.equal(f.phase, "fading");
  assert.equal(f.daysToReady, 0);
  assert.equal(f.daysLeft, 0);
});

test("freshness：缺省 restDays=0、peakWindowDays=45", () => {
  const sameDay = freshness({ roastDate: "2026-01-28" }, NOW);
  assert.equal(sameDay.phase, "prime", "烘焙当天即可饮（restDays 缺省 0）");
  assert.equal(sameDay.daysLeft, 45, "peakWindowDays 缺省 45");
});

test("freshness：缺 roastDate / 非法格式 → unknown", () => {
  assert.equal(freshness({}, NOW).phase, "unknown");
  assert.equal(freshness({ roastDate: "2026/01/28" }, NOW).phase, "unknown");
  assert.equal(freshness({ roastDate: "abcd-01-01", restDays: 5 }, NOW).phase, "unknown");
});

test("freshness：进位日期（2026-13-01 / 2026-02-30）→ unknown（任务 #65）", () => {
  assert.equal(freshness({ roastDate: "2026-13-01" }, NOW).phase, "unknown");
  assert.equal(freshness({ roastDate: "2026-02-30", restDays: 3 }, NOW).phase, "unknown");
  assert.equal(freshness({ roastDate: "2026-04-31" }, NOW).phase, "unknown");
  assert.equal(freshness({ roastDate: "2025-02-29" }, NOW).phase, "unknown"); // 非闰年
  assert.equal(freshness({ roastDate: "2024-02-29", restDays: 0 }, NOW).phase, "fading"); // 闰年合法
});

test("parseLocalDate：合法日期回读一致；进位/格式非法返回 null（任务 #65）", () => {
  const ok = parseLocalDate("2026-01-28");
  assert.notEqual(ok, null);
  assert.equal(ok!.getFullYear(), 2026);
  assert.equal(ok!.getMonth(), 0);
  assert.equal(ok!.getDate(), 28);
  assert.equal(ok!.getHours(), 0); // 本地零点
  assert.equal(parseLocalDate("2026-13-01"), null); // 月份进位
  assert.equal(parseLocalDate("2026-02-30"), null); // 日期进位
  assert.equal(parseLocalDate("2026-00-10"), null);
  assert.equal(parseLocalDate("2026-1-1"), null); // 格式非法
  assert.equal(parseLocalDate(""), null);
});

test("freshness：闰年 2/28 → 2/29 养豆到期正确进入适饮", () => {
  const before = freshness({ roastDate: "2024-02-28", restDays: 1 }, new Date(2024, 1, 28));
  assert.equal(before.phase, "resting");
  assert.equal(before.daysToReady, 1);
  const leapDay = freshness({ roastDate: "2024-02-28", restDays: 1 }, new Date(2024, 1, 29));
  assert.equal(leapDay.phase, "prime");
  assert.equal(leapDay.daysToReady, 0);
});

test("freshness：月末跨月 1/31 → 2/1 天数差为 1", () => {
  const f = freshness({ roastDate: "2026-01-31", restDays: 1 }, new Date(2026, 1, 1));
  assert.equal(f.phase, "prime");
});

test("freshness：烘焙日期在未来 → resting（daysToReady 含未烘焙天数）", () => {
  const f = freshness({ roastDate: "2026-01-30", restDays: 3 }, NOW);
  assert.equal(f.phase, "resting");
  assert.equal(f.daysToReady, 5, "还有 2 天才烘焙 + 3 天养豆");
});

test("brewsLeft：floor 取整与边界", () => {
  assert.equal(brewsLeft(100, 15), 6);
  assert.equal(brewsLeft(15, 15), 1);
  assert.equal(brewsLeft(14, 15), 0);
  assert.equal(brewsLeft(0, 15), 0);
});

test("brewsLeft：输入缺失/非法 → null", () => {
  assert.equal(brewsLeft(undefined, 15), null);
  assert.equal(brewsLeft(null, 15), null);
  assert.equal(brewsLeft(100, undefined), null);
  assert.equal(brewsLeft(100, 0), null);
  assert.equal(brewsLeft(NaN, 15), null);
});
