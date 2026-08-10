/** recipe-schema 单元测试（node:test + assert） */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BLE_LIMITS,
  CLOUD_LIMITS,
  DEFAULT_RECIPE_COLOR,
  POUR_PATTERNS,
  RecipeSchema,
  SAFE_LIMITS,
  bleToPattern,
  cloudToPattern,
  defaultPourName,
  patternToBle,
  patternToCloud,
  pourName,
  suggestGrandWater,
} from "../src/lib/recipe-schema.js";
import { makeValidRecipe } from "./fixtures.js";

describe("RecipeSchema 基础校验", () => {
  it("合法配方通过校验", () => {
    const result = RecipeSchema.safeParse(makeValidRecipe());
    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  });

  it("各段 volume 之和 ≠ grandWater 时报错", () => {
    const bad = makeValidRecipe();
    bad.grandWater = 300; // 实际分段之和是 234
    const result = RecipeSchema.safeParse(bad);
    assert.equal(result.success, false);
    const msg = result.error?.issues.map((i) => i.message).join(";") ?? "";
    assert.match(msg, /grandWater/);
  });

  it("rpm 不在档位列表内时报错", () => {
    const bad = makeValidRecipe();
    bad.rpm = 75;
    assert.equal(RecipeSchema.safeParse(bad).success, false);
  });

  it("注水段数必须在 1-6 之间", () => {
    const empty = makeValidRecipe();
    empty.pours = [];
    empty.grandWater = 0.001;
    assert.equal(RecipeSchema.safeParse(empty).success, false);

    const seven = makeValidRecipe();
    const pour = { ...seven.pours[0], volume: 1 };
    seven.pours = Array.from({ length: 7 }, () => ({ ...pour }));
    seven.grandWater = 7;
    assert.equal(RecipeSchema.safeParse(seven).success, false);
  });

  it("suggestGrandWater 使用默认粉水比", () => {
    assert.equal(suggestGrandWater(15, "xdripper"), 234);
    assert.equal(suggestGrandWater(10, "other"), 156);
  });

  it("cupType 已彻底移除 xpod：非法枚举拒绝", () => {
    const bad = { ...makeValidRecipe(), cupType: "xpod" };
    assert.equal(RecipeSchema.safeParse(bad).success, false);
  });
});

describe("全参数新字段（bypass / vib / 磨豆模式 / 颜色 / 段名）", () => {
  it("缺省新字段由 default 补齐：bypass 关 / 5ml / 85℃ / 本机磨豆 / 默认色 / vib 关", () => {
    const result = RecipeSchema.safeParse(makeValidRecipe());
    assert.equal(result.success, true);
    const r = result.data!;
    assert.equal(r.bypassEnabled, false);
    assert.equal(r.bypassVolume, 5);
    assert.equal(r.bypassTemp, 85);
    assert.equal(r.isSetGrinderSize, 1);
    assert.equal(r.theColor, DEFAULT_RECIPE_COLOR);
    for (const p of r.pours) {
      assert.equal(p.vibBefore, false);
      assert.equal(p.vibAfter, false);
    }
  });

  it("bypassVolume 必须是 5-100 的整数", () => {
    assert.equal(RecipeSchema.safeParse({ ...makeValidRecipe(), bypassVolume: 4 }).success, false);
    assert.equal(
      RecipeSchema.safeParse({ ...makeValidRecipe(), bypassVolume: 101 }).success,
      false,
    );
    assert.equal(
      RecipeSchema.safeParse({ ...makeValidRecipe(), bypassVolume: 5.5 }).success,
      false,
    );
    assert.equal(RecipeSchema.safeParse({ ...makeValidRecipe(), bypassVolume: 60 }).success, true);
  });

  it("bypassTemp 范围 40-95", () => {
    assert.equal(RecipeSchema.safeParse({ ...makeValidRecipe(), bypassTemp: 39 }).success, false);
    assert.equal(RecipeSchema.safeParse({ ...makeValidRecipe(), bypassTemp: 96 }).success, false);
  });

  it("isSetGrinderSize 仅接受 1 | 2", () => {
    assert.equal(
      RecipeSchema.safeParse({ ...makeValidRecipe(), isSetGrinderSize: 3 }).success,
      false,
    );
    assert.equal(
      RecipeSchema.safeParse({ ...makeValidRecipe(), isSetGrinderSize: 2 }).success,
      true,
    );
  });

  it("theColor 必须是 #RRGGBB", () => {
    assert.equal(RecipeSchema.safeParse({ ...makeValidRecipe(), theColor: "red" }).success, false);
    assert.equal(
      RecipeSchema.safeParse({ ...makeValidRecipe(), theColor: "#12345" }).success,
      false,
    );
    assert.equal(
      RecipeSchema.safeParse({ ...makeValidRecipe(), theColor: "#a1B2c3" }).success,
      true,
    );
  });

  it("段名规则：首段 Bloom，其余 Pour n；用户命名优先", () => {
    assert.equal(defaultPourName(0), "Bloom");
    assert.equal(defaultPourName(1), "Pour 2");
    assert.equal(pourName({}, 0), "Bloom");
    assert.equal(pourName({ theName: "  " }, 2), "Pour 3");
    assert.equal(pourName({ theName: "Main Pour" }, 1), "Main Pour");
  });

  it("SAFE_LIMITS 包含 bypass 区间 5-100 / 40-95", () => {
    assert.deepEqual(SAFE_LIMITS.bypassVolume, { min: 5, max: 100 });
    assert.deepEqual(SAFE_LIMITS.bypassTemp, { min: 40, max: 95 });
  });
});

describe("pattern 双映射", () => {
  it("云端编码：center→1, spiral→2, circular→3", () => {
    assert.equal(patternToCloud("center"), 1);
    assert.equal(patternToCloud("spiral"), 2);
    assert.equal(patternToCloud("circular"), 3);
  });

  it("BLE 编码：center→0, circular→1, spiral→2", () => {
    assert.equal(patternToBle("center"), 0);
    assert.equal(patternToBle("circular"), 1);
    assert.equal(patternToBle("spiral"), 2);
  });

  it("云端往返一致：cloudToPattern(patternToCloud(p)) === p", () => {
    for (const p of POUR_PATTERNS) {
      assert.equal(cloudToPattern(patternToCloud(p)), p);
    }
  });

  it("BLE 往返一致：bleToPattern(patternToBle(p)) === p", () => {
    for (const p of POUR_PATTERNS) {
      assert.equal(bleToPattern(patternToBle(p)), p);
    }
  });

  it("未知编码抛错", () => {
    assert.throws(() => cloudToPattern(99));
    assert.throws(() => bleToPattern(99));
  });
});

describe("双边界常量表", () => {
  it("BLE 使用当前真机/App 已验证的 40-95℃ 水温边界", () => {
    assert.equal(BLE_LIMITS.waterTemperature.min, 40);
    assert.equal(BLE_LIMITS.waterTemperature.max, 95);
  });

  it("SAFE_LIMITS 对设备字段取交集，并为咖啡生成保留 60℃ 最低水温", () => {
    const keys = ["doseGrams", "flowRate", "pausing"] as const;
    for (const key of keys) {
      const cloud = CLOUD_LIMITS[key];
      const ble = BLE_LIMITS[key];
      const safe = SAFE_LIMITS[key];
      assert.equal(safe.min, Math.max(cloud.min, ble.min), `${key}.min`);
      assert.equal(safe.max, Math.min(cloud.max, ble.max), `${key}.max`);
    }
    assert.deepEqual(SAFE_LIMITS.waterTemperature, { min: 60, max: 95 });
    // grinderSize 内部是 40-120，BLE 编码层映射为设备 1-80，不对异标尺数值取交集。
    assert.deepEqual(SAFE_LIMITS.grinderSize, CLOUD_LIMITS.grinderSize);
    // BLE 独有区间直接沿用
    assert.deepEqual(SAFE_LIMITS.totalWater, BLE_LIMITS.totalWater);
    assert.deepEqual(SAFE_LIMITS.pourVolume, BLE_LIMITS.pourVolume);
  });
});
