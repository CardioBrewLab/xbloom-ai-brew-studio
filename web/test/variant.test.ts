/**
 * 双方案对比（任务 #62）纯逻辑单测：
 * - reduceVariantEvent：variant 事件归并状态机（start/improved 增量/result ok/失败/透传）
 * - improvedRecipeName：改进版落库名称后缀（幂等）
 * - diffRecipes：原版 → 改进版场景的参数差异提取
 * 运行：npx tsx --test "test/*.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GenerateEvent } from "../src/lib/api.js";
import type { Recipe } from "../src/lib/recipe-schema.js";
import {
  improvedRecipeName,
  reduceVariantEvent,
  VARIANT_IDLE,
  type VariantState,
} from "../src/lib/variant.js";
import { diffRecipes } from "../src/components/TuningDiffCard.js";

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: "测试配方",
    cupType: "xdripper",
    doseGrams: 15,
    grinderSize: 60,
    rpm: 80,
    grandWater: 230,
    pours: [
      {
        volume: 50,
        temperature: 92,
        flowRate: 3.2,
        pattern: "center",
        pausing: 30,
        vibBefore: false,
        vibAfter: false,
      },
      {
        volume: 180,
        temperature: 90,
        flowRate: 3.2,
        pattern: "circular",
        pausing: 0,
        vibBefore: false,
        vibAfter: false,
      },
    ],
    bypassEnabled: false,
    bypassVolume: 5,
    bypassTemp: 85,
    isSetGrinderSize: 1,
    theColor: "#C9D5B8",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// reduceVariantEvent：状态机归并
// ---------------------------------------------------------------------------

test("reduceVariantEvent：variant:start 置 running 并清理上轮残留", () => {
  const dirty: VariantState = {
    phase: "failed",
    message: "旧失败",
    improved: null,
    buffer: "旧缓冲",
  };
  const next = reduceVariantEvent(dirty, { type: "variant", stage: "start" });
  assert.equal(next.phase, "running");
  assert.equal(next.message, "", "失败文案被清理");
  assert.equal(next.improved, null);
  assert.equal(next.buffer, "旧缓冲", "buffer 不因 start 丢失");
});

test('reduceVariantEvent：带 variant:"improved" 的 reasoning/content 静默累计进 buffer', () => {
  let s: VariantState = reduceVariantEvent(VARIANT_IDLE, { type: "variant", stage: "start" });
  s = reduceVariantEvent(s, { type: "reasoning", delta: "分析烘焙商方案…", variant: "improved" });
  s = reduceVariantEvent(s, { type: "content", delta: "改进思路", variant: "improved" });
  assert.equal(s.buffer, "分析烘焙商方案…改进思路");
  assert.equal(s.phase, "running");
});

test("reduceVariantEvent：不带 variant 的 reasoning/content 与无关事件原样透传（同引用）", () => {
  const events: GenerateEvent[] = [
    { type: "reasoning", delta: "主思考" },
    { type: "content", delta: "主正文" },
    { type: "recipe", recipe: makeRecipe(), clamped: [] },
    { type: "done" },
  ];
  for (const ev of events) {
    assert.equal(
      reduceVariantEvent(VARIANT_IDLE, ev),
      VARIANT_IDLE,
      `${ev.type} 事件不应触碰 variant 状态`,
    );
  }
});

test("reduceVariantEvent：result ok:true → ready 且仅保留非空可选字段", () => {
  let s = reduceVariantEvent(VARIANT_IDLE, { type: "variant", stage: "start" });
  s = reduceVariantEvent(s, {
    type: "variant",
    stage: "result",
    ok: true,
    recipe: makeRecipe({ name: "改进版" }),
    clamped: ["水温 97→95℃"],
    improvementNotes: [{ param: "水温", from: "97℃", to: "95℃", rationale: "浅烘降酸" }],
  });
  assert.equal(s.phase, "ready");
  assert.equal(s.improved?.recipe.name, "改进版");
  assert.deepEqual(s.improved?.clamped, ["水温 97→95℃"]);
  assert.equal(s.improved?.improvementNotes?.length, 1);
  assert.equal(s.improved?.warning, undefined, "未携带 warning 不落字段");
  assert.equal(s.improved?.refUrls, undefined);
});

test("reduceVariantEvent：result 携带 brewRationale 时透传进载荷；未携带不落字段（任务 #73）", () => {
  const rationale = [{ param: "起步水温", choice: "92℃", basis: "L2 烘焙商骨架" }];
  let s = reduceVariantEvent(VARIANT_IDLE, { type: "variant", stage: "start" });
  s = reduceVariantEvent(s, {
    type: "variant",
    stage: "result",
    ok: true,
    recipe: makeRecipe({ name: "改进版" }),
    clamped: [],
    brewRationale: rationale,
  });
  assert.equal(s.phase, "ready");
  assert.deepEqual(s.improved?.brewRationale, rationale, "采用改进版后能读到其解读");

  // 未携带时不落字段（与既有可选字段同模式）
  const bare = reduceVariantEvent(VARIANT_IDLE, {
    type: "variant",
    stage: "result",
    ok: true,
    recipe: makeRecipe(),
    clamped: [],
  });
  assert.equal(bare.improved?.brewRationale, undefined);
  // 空数组同样不落字段
  const empty = reduceVariantEvent(VARIANT_IDLE, {
    type: "variant",
    stage: "result",
    ok: true,
    recipe: makeRecipe(),
    clamped: [],
    brewRationale: [],
  });
  assert.equal(empty.improved?.brewRationale, undefined);
});

test("reduceVariantEvent：result ok:false → failed 并携带 message，随后正常忽略 done", () => {
  let s = reduceVariantEvent(VARIANT_IDLE, { type: "variant", stage: "start" });
  s = reduceVariantEvent(s, {
    type: "variant",
    stage: "result",
    ok: false,
    message: "AI 改进版生成失败：上游超时",
  });
  assert.equal(s.phase, "failed");
  assert.equal(s.message, "AI 改进版生成失败：上游超时");
  assert.equal(s.improved, null);
  assert.equal(reduceVariantEvent(s, { type: "done" }), s, "done 事件透传不变");
});

// ---------------------------------------------------------------------------
// improvedRecipeName：落库名称后缀
// ---------------------------------------------------------------------------

test("improvedRecipeName：自动附「· AI 改进版」后缀且幂等", () => {
  assert.equal(improvedRecipeName("日晒耶加"), "日晒耶加 · AI 改进版");
  assert.equal(
    improvedRecipeName("日晒耶加 · AI 改进版"),
    "日晒耶加 · AI 改进版",
    "已有后缀不重复追加",
  );
  assert.equal(improvedRecipeName("  曼特宁  "), "曼特宁 · AI 改进版", "首尾空白先裁剪");
});

// ---------------------------------------------------------------------------
// diffRecipes：原版 → 改进版场景
// ---------------------------------------------------------------------------

test("diffRecipes：原版 vs 改进版提取变化项（水温/闷蒸/研磨/粉水比）", () => {
  const original = makeRecipe();
  const improved = makeRecipe({
    grinderSize: 55,
    pours: [
      {
        volume: 50,
        temperature: 93,
        flowRate: 3.2,
        pattern: "center",
        pausing: 45,
        vibBefore: false,
        vibAfter: false,
      },
      {
        volume: 180,
        temperature: 90,
        flowRate: 3.2,
        pattern: "circular",
        pausing: 0,
        vibBefore: false,
        vibAfter: false,
      },
    ],
  });
  const items = diffRecipes(original, improved);
  const byLabel = new Map(items.map((i) => [i.label, i]));
  assert.ok(byLabel.has("研磨度"), "研磨度 60→55 应被捕获");
  assert.equal(byLabel.get("研磨度")?.from, "60");
  assert.equal(byLabel.get("研磨度")?.to, "55");
  assert.equal(byLabel.get("闷蒸水温")?.to, "93℃");
  assert.equal(byLabel.get("闷蒸停顿")?.from, "30s");
  assert.ok(!byLabel.has("总水量"), "未变化的总水量不应出现");
  assert.ok(!byLabel.has("粉水比"), "总水量与粉量不变 → 粉水比无差异");
});

test("diffRecipes：完全一致的两份配方返回空数组（骨架保留场景）", () => {
  const a = makeRecipe();
  const b = makeRecipe();
  assert.deepEqual(diffRecipes(a, b), []);
});

test("diffRecipes：分段结构不同（改进版增减段）走结构分支", () => {
  const original = makeRecipe();
  const improved = makeRecipe({
    grandWater: 225,
    pours: [
      {
        volume: 45,
        temperature: 92,
        flowRate: 3.2,
        pattern: "center",
        pausing: 30,
        vibBefore: false,
        vibAfter: false,
      },
      {
        volume: 90,
        temperature: 91,
        flowRate: 3.2,
        pattern: "circular",
        pausing: 10,
        vibBefore: false,
        vibAfter: false,
      },
      {
        volume: 90,
        temperature: 89,
        flowRate: 3.2,
        pattern: "circular",
        pausing: 0,
        vibBefore: false,
        vibAfter: false,
      },
    ],
  });
  const items = diffRecipes(original, improved);
  const structure = items.find((i) => i.label === "分段结构");
  assert.equal(structure?.from, "2 段");
  assert.equal(structure?.to, "3 段");
});
