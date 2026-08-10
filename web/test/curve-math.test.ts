/**
 * C40 手磨刻度 ↔ xBloom 云端研磨度换算单测。
 * 依据 xBloom 官方帮助中心 C40 换算表锚点：
 * 11格=40；18格≈59；22格≈70（600µm 推荐校准点）；25格≈79；40格=120。
 * 运行：npx tsx --test "test/*.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  balancePours,
  c40ToCloud,
  cloudToC40,
  cloudToBleGrind,
  bleToCloudGrind,
} from "../src/lib/curve-math.js";
import type { Pour } from "../src/lib/recipe-schema.js";

test("c40ToCloud：官方锚点换算", () => {
  assert.equal(c40ToCloud(11), 40, "C40 11格 = 40（最细端锚点）");
  assert.equal(c40ToCloud(18), 59, "C40 18格 ≈ 59（.5 向下取整）");
  assert.equal(c40ToCloud(22), 70, "C40 22格 ≈ 70（600µm 推荐校准点）");
  assert.equal(c40ToCloud(25), 79, "C40 25格 ≈ 79");
  assert.equal(c40ToCloud(40), 120, "C40 40格 = 120（最粗端锚点）");
});

test("c40ToCloud：下限钳位（细于机器最细档按 40 处理）", () => {
  assert.equal(c40ToCloud(5), 40, "C40 5格 低于下限，封顶 40");
  assert.equal(c40ToCloud(0), 40, "C40 0格 封顶 40");
});

test("c40ToCloud：烘焙商常见手冲区间 C40 20-25 格 ↔ 65-79", () => {
  assert.equal(c40ToCloud(20), 65);
  const upper = c40ToCloud(25);
  assert.ok(upper >= 65 && upper <= 79, "25格应落在区间上端");
});

test("cloudToC40：反向换算", () => {
  assert.equal(cloudToC40(70), 22, "云端 70 → C40 22格");
  assert.equal(cloudToC40(40), 11, "云端 40 → C40 11格");
  assert.equal(cloudToC40(120), 40, "云端 120 → C40 40格");
  assert.equal(cloudToC40(65), 20, "云端 65 → C40 20格");
});

test("cloudToC40：钳位 0-40", () => {
  assert.equal(cloudToC40(40), 11);
  assert.ok(cloudToC40(40) >= 0);
  assert.ok(cloudToC40(120) <= 40);
});

test("方向一致性：与 BLE 标尺同为越小越细", () => {
  // C40 格数增大（变粗）→ 云端值增大 → BLE 值增大
  const fine = c40ToCloud(15);
  const coarse = c40ToCloud(30);
  assert.ok(coarse > fine, "同向：数值越大越粗");
  assert.ok(cloudToBleGrind(coarse) > cloudToBleGrind(fine));
  // 往返一致性（锚点处）
  assert.equal(cloudToC40(c40ToCloud(22)), 22);
  assert.equal(c40ToCloud(cloudToC40(70)), 70);
  assert.equal(bleToCloudGrind(cloudToBleGrind(70)), 70);
});

test("balancePours：极端比例仍精确配平且每段不少于 1ml", () => {
  const volumes = [81.1, 34.6, 85.6, 99.2, 1.1];
  const pours = volumes.map((volume): Pour => ({
    volume,
    temperature: 92,
    flowRate: 3,
    pattern: "spiral",
    pausing: 0,
    vibBefore: false,
    vibAfter: false,
  }));
  const balanced = balancePours(pours, 40);
  assert.equal(Math.round(balanced.reduce((sum, pour) => sum + pour.volume, 0) * 10) / 10, 40);
  assert.ok(balanced.every((pour) => pour.volume >= 1));
});
