/**
 * 引导式冲煮步骤生成（任务 #95）单测：
 * buildBrewGuide 累计水量 / 停顿插入 / 时间点单调性 / 空段边界，
 * 以及 guideStateAt 的步骤定位与插值。
 * 运行：npx tsx --test "test/*.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrewGuide, guideStateAt } from "../src/lib/brew-guide.js";
import type { Pour } from "../src/lib/recipe-schema.js";

/** 构造测试用 Pour：默认 5ml/s、92℃、无停顿、中心注水 */
function mkPour(volume: number, opts: Partial<Pour> = {}): Pour {
  return {
    volume,
    temperature: 92,
    flowRate: 5,
    pattern: "center",
    pausing: 0,
    vibBefore: false,
    vibAfter: false,
    ...opts,
  };
}

test("buildBrewGuide：累计水量与时间点逐段推算", () => {
  const guide = buildBrewGuide([
    mkPour(60, { pausing: 40 }),
    mkPour(80),
    mkPour(100, { pausing: 30 }),
  ]);
  // 3 段注水 + 2 个停顿 = 5 步
  assert.equal(guide.steps.length, 5);
  assert.equal(guide.pourCount, 3);
  assert.equal(guide.totalVolume, 240);
  // 注水时长：60/5=12、80/5=16、100/5=20；总时长 = 12+40+16+20+30 = 118
  assert.equal(guide.totalDuration, 118);

  const pours = guide.steps.filter((s) => s.kind === "pour");
  assert.deepEqual(
    pours.map((s) => s.targetVolume),
    [60, 140, 240],
    "目标累计水量逐段叠加",
  );
  assert.deepEqual(
    pours.map((s) => [s.startAt, s.endAt]),
    [
      [0, 12],
      [52, 68],
      [68, 88],
    ],
    "注水步起止时间（含前序停顿偏移）",
  );
});

test("buildBrewGuide：停顿步插入位置、时长与目标水量", () => {
  const guide = buildBrewGuide([mkPour(60, { pausing: 40 }), mkPour(80)]);
  assert.equal(guide.steps.length, 3, "pausing>0 才插入停顿步");
  const pause = guide.steps[1];
  assert.equal(pause.kind, "pause");
  assert.equal(pause.pourIndex, 1, "停顿归属于其前一段");
  assert.equal(pause.volume, 0, "停顿步不注水");
  assert.equal(pause.targetVolume, 60, "停顿步目标水量 = 前段累计");
  assert.equal(pause.temperature, null, "停顿步无水温提示");
  assert.equal(pause.startAt, 12);
  assert.equal(pause.endAt, 52);
  assert.match(pause.label, /40/, "停顿标签含秒数");
});

test("buildBrewGuide：pausing=0 不插入停顿步", () => {
  const guide = buildBrewGuide([mkPour(60), mkPour(80, { pausing: 0 })]);
  assert.equal(guide.steps.length, 2);
  assert.ok(guide.steps.every((s) => s.kind === "pour"));
});

test("buildBrewGuide：空 pours 边界", () => {
  const guide = buildBrewGuide([]);
  assert.deepEqual(guide.steps, []);
  assert.equal(guide.totalVolume, 0);
  assert.equal(guide.totalDuration, 0);
  assert.equal(guide.pourCount, 0);
  // 空引导任意时刻均视为完成
  const st = guideStateAt(guide, 5);
  assert.equal(st.finished, true);
  assert.equal(st.stepIndex, -1);
  assert.equal(st.volume, 0);
});

test("buildBrewGuide：flowRate<=0 段注水时长记 0 但水量照常累计", () => {
  const guide = buildBrewGuide([mkPour(50, { flowRate: 0 }), mkPour(50)]);
  const first = guide.steps[0];
  assert.equal(first.duration, 0);
  assert.equal(first.targetVolume, 50);
  assert.equal(guide.totalDuration, 10, "第二段 50/5=10s");
});

test("buildBrewGuide：段名缺省按 Bloom / Pour n 补齐", () => {
  const guide = buildBrewGuide([mkPour(60), mkPour(80, { theName: "主注水" })]);
  assert.equal(guide.steps[0].label, "Bloom");
  assert.equal(guide.steps[1].label, "主注水");
});

test("guideStateAt：步骤定位、剩余秒数与注水插值", () => {
  const guide = buildBrewGuide([mkPour(60, { pausing: 40 }), mkPour(80)]);
  // 第一段注水中点（0-12s）：t=6 → 注水一半 30ml
  const mid = guideStateAt(guide, 6);
  assert.equal(mid.stepIndex, 0);
  assert.equal(mid.finished, false);
  assert.equal(mid.stepRemaining, 6);
  assert.equal(mid.volume, 30);
  // 停顿中（12-52s）：水量锁定 60，剩余按停顿计
  const pausing = guideStateAt(guide, 32);
  assert.equal(pausing.stepIndex, 1);
  assert.equal(guide.steps[1].kind, "pause");
  assert.equal(pausing.volume, 60);
  assert.equal(pausing.stepRemaining, 20);
  // 第二段注水中（52-68s）
  const second = guideStateAt(guide, 60);
  assert.equal(second.stepIndex, 2);
  assert.equal(second.volume, 100, "60 + 80×(8/16) = 100");
});

test("guideStateAt：达到/超出总时长 → 完成态", () => {
  const guide = buildBrewGuide([mkPour(60, { pausing: 40 })]);
  const atEnd = guideStateAt(guide, guide.totalDuration);
  assert.equal(atEnd.finished, true);
  assert.equal(atEnd.stepIndex, -1);
  assert.equal(atEnd.volume, 60);
  const beyond = guideStateAt(guide, guide.totalDuration + 100);
  assert.equal(beyond.finished, true);
  // 负数钳位为 0：处于第一步
  const zero = guideStateAt(guide, -5);
  assert.equal(zero.stepIndex, 0);
  assert.equal(zero.finished, false);
});
