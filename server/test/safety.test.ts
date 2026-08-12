/** safety 钳位与目标路径校验测试（node:test + assert） */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RecipeSchema, SAFE_LIMITS } from "../src/lib/recipe-schema.js";
import {
  clampRecipe,
  DURATION_WARN_SECONDS,
  durationWarning,
  estimateTotalSeconds,
  validateForTarget,
} from "../src/lib/safety.js";
import { makeValidRecipe } from "./fixtures.js";

describe("clampRecipe 钳位", () => {
  it("安全区间内的配方不被钳位", () => {
    const { recipe, clamped } = clampRecipe(makeValidRecipe());
    assert.deepEqual(clamped, []);
    assert.deepEqual(recipe, RecipeSchema.parse(makeValidRecipe()));
  });

  it("水温 100℃ → 95℃（SAFE 上限）", () => {
    const input = makeValidRecipe();
    input.pours[0].temperature = 100;
    const { recipe, clamped } = clampRecipe(input);
    assert.equal(recipe.pours[0].temperature, 95);
    assert.ok(clamped.some((s) => s.includes("temperature")));
  });

  it("pausing 300s → 255s（SAFE 上限）", () => {
    const input = makeValidRecipe();
    input.pours[1].pausing = 300;
    const { recipe, clamped } = clampRecipe(input);
    assert.equal(recipe.pours[1].pausing, 255);
    assert.ok(clamped.some((s) => s.includes("pausing")));
  });

  it("dose 40g → 18g（Omni Dripper 2 建议与真机安全上限）", () => {
    const input = makeValidRecipe();
    input.doseGrams = 40;
    const { recipe, clamped } = clampRecipe(input);
    assert.equal(recipe.doseGrams, 18);
    assert.ok(clamped.some((s) => s.includes("doseGrams")));
  });

  it("流速越界双向钳位（5.0 → 3.5，0.2 → 3.0）", () => {
    const high = makeValidRecipe();
    high.pours[0].flowRate = 5.0;
    assert.equal(clampRecipe(high).recipe.pours[0].flowRate, 3.5);

    const low = makeValidRecipe();
    low.pours[0].flowRate = 0.2;
    assert.equal(clampRecipe(low).recipe.pours[0].flowRate, 3.0);
  });

  it("总水超过云端粉水比上限时缩放到云端可达总水", () => {
    const input = makeValidRecipe();
    input.pours = [
      { volume: 300, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 10 },
      { volume: 300, temperature: 88, flowRate: 3.2, pattern: "spiral", pausing: 5 },
    ];
    input.grandWater = 600;
    const { recipe } = clampRecipe(input);
    assert.equal(recipe.grandWater, 300);
    const sum = recipe.pours.reduce((s, p) => s + p.volume, 0);
    assert.ok(Math.abs(sum - recipe.grandWater) < 1e-6);
    assert.deepEqual(validateForTarget(recipe, "cloud"), []);
  });

  it("评审反例 [37,1,1]：向上缩放到云端最低可达总水", () => {
    const input = makeValidRecipe();
    input.grandWater = 39;
    input.pours = [
      { volume: 37, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 },
      { volume: 1, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 },
      { volume: 1, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 },
    ];
    const { recipe } = clampRecipe(input);
    assert.equal(recipe.grandWater, 180);
    const sum = recipe.pours.reduce((s, p) => s + p.volume, 0);
    assert.ok(Math.abs(sum - 180) < 1e-6, `sum=${sum} 应精确等于 180`);
    assert.ok(
      recipe.grandWater >= SAFE_LIMITS.totalWater.min &&
        recipe.grandWater <= SAFE_LIMITS.totalWater.max,
    );
    assert.deepEqual(validateForTarget(recipe, "cloud"), []);
  });

  it("评审反例 [300,300,1,1,1,1]：向下缩放到云端最高可达总水", () => {
    const input = makeValidRecipe();
    input.grandWater = 604;
    input.pours = [
      { volume: 300, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 },
      { volume: 300, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 },
      { volume: 1, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 },
      { volume: 1, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 },
      { volume: 1, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 },
      { volume: 1, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 },
    ];
    const { recipe } = clampRecipe(input);
    assert.equal(recipe.grandWater, 300);
    const sum = recipe.pours.reduce((s, p) => s + p.volume, 0);
    assert.ok(Math.abs(sum - 300) < 1e-6, `sum=${sum} 应精确等于 300`);
    assert.ok(
      recipe.grandWater >= SAFE_LIMITS.totalWater.min &&
        recipe.grandWater <= SAFE_LIMITS.totalWater.max,
    );
    assert.deepEqual(validateForTarget(recipe, "cloud"), []);
  });

  it("钳位结果始终通过 RecipeSchema 且落在 SAFE_LIMITS 内", () => {
    const wild = {
      ...makeValidRecipe(),
      doseGrams: 99,
      grinderSize: 200,
      grandWater: 2000,
      pours: [
        { volume: 900, temperature: 120, flowRate: 9.9, pattern: "spiral", pausing: 999 },
        { volume: 1100, temperature: 20, flowRate: 0.1, pattern: "center", pausing: -5 },
      ],
    };
    const { recipe } = clampRecipe(wild);
    assert.equal(RecipeSchema.safeParse(recipe).success, true);
    assert.ok(
      recipe.doseGrams >= SAFE_LIMITS.doseGrams.min &&
        recipe.doseGrams <= SAFE_LIMITS.doseGrams.max,
    );
    assert.ok(
      recipe.grinderSize >= SAFE_LIMITS.grinderSize.min &&
        recipe.grinderSize <= SAFE_LIMITS.grinderSize.max,
    );
    assert.ok(
      recipe.grandWater >= SAFE_LIMITS.totalWater.min &&
        recipe.grandWater <= SAFE_LIMITS.totalWater.max,
    );
    for (const p of recipe.pours) {
      assert.ok(
        p.temperature >= SAFE_LIMITS.waterTemperature.min &&
          p.temperature <= SAFE_LIMITS.waterTemperature.max,
      );
      assert.ok(p.flowRate >= SAFE_LIMITS.flowRate.min && p.flowRate <= SAFE_LIMITS.flowRate.max);
      assert.ok(p.pausing >= SAFE_LIMITS.pausing.min && p.pausing <= SAFE_LIMITS.pausing.max);
      assert.ok(p.volume >= SAFE_LIMITS.pourVolume.min && p.volume <= SAFE_LIMITS.pourVolume.max);
    }
  });

  it("结构非法的输入（缺字段）抛 Zod 错误", () => {
    assert.throws(() => clampRecipe({ name: "x" }));
  });
});

describe("bypass 钳位与粉水比守护", () => {
  it("bypassVolume/bypassTemp 独立钳位（4.2→5、120℃→95℃）", () => {
    const input = { ...makeValidRecipe(), bypassEnabled: true, bypassVolume: 4.2, bypassTemp: 120 };
    const { recipe, clamped } = clampRecipe(input);
    assert.equal(recipe.bypassVolume, 5);
    assert.equal(recipe.bypassTemp, 95);
    assert.ok(clamped.some((s) => s.includes("bypassVolume")));
    assert.ok(clamped.some((s) => s.includes("bypassTemp")));
  });

  it("守护区间内的 bypass 不被调整：(234+40)/15 = 18.27", () => {
    const input = { ...makeValidRecipe(), bypassEnabled: true, bypassVolume: 40 };
    const { recipe, clamped } = clampRecipe(input);
    assert.equal(recipe.bypassEnabled, true);
    assert.equal(recipe.bypassVolume, 40);
    assert.ok(!clamped.some((s) => s.includes("bypass")));
  });

  it("稀释过头（比例 >20）：压缩 bypassVolume 至 20 倍上限", () => {
    // (234+100)/15 = 22.27 > 20 → target = 20×15-234 = 66
    const input = { ...makeValidRecipe(), bypassEnabled: true, bypassVolume: 100 };
    const { recipe } = clampRecipe(input);
    assert.equal(recipe.bypassEnabled, true);
    assert.equal(recipe.bypassVolume, 66);
    const ratio = (recipe.grandWater + recipe.bypassVolume) / recipe.doseGrams;
    assert.ok(ratio <= 20 + 1e-9);
  });

  it("浓缩过度（比例 <12）：抬高 bypassVolume 至 12 倍下限", () => {
    // 100ml 水/15g 粉，bypass 5ml → 7 < 12 → target = 12×15-100 = 80
    const input = makeValidRecipe();
    input.grandWater = 100;
    input.pours = [{ volume: 100, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 }];
    const withBypass = { ...input, bypassEnabled: true, bypassVolume: 5 };
    const { recipe } = clampRecipe(withBypass);
    assert.equal(recipe.bypassEnabled, true);
    assert.equal(recipe.bypassVolume, 80);
  });

  it("调整不动时直接关闭 bypass 并留痕（grandWater/dose 已超上限）", () => {
    // 5g 粉 200ml 水：即便不加旁路比例也 40 > 20
    const input = makeValidRecipe();
    input.doseGrams = 5;
    input.grandWater = 200;
    input.pours = [
      { volume: 100, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 5 },
      { volume: 100, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 },
    ];
    const { recipe, clamped } = clampRecipe({ ...input, bypassEnabled: true, bypassVolume: 50 });
    assert.equal(recipe.bypassEnabled, false);
    assert.ok(clamped.some((s) => s.includes("bypassEnabled")));
  });

  it("旁路加满 100ml 仍达不到比例下限时也关闭 bypass", () => {
    // 31g 粉 100ml 水：12×31-100 = 272 > 100 → 关闭
    const input = makeValidRecipe();
    input.doseGrams = 31;
    input.grandWater = 100;
    input.pours = [{ volume: 100, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 }];
    const { recipe } = clampRecipe({ ...input, bypassEnabled: true, bypassVolume: 50 });
    assert.equal(recipe.bypassEnabled, false);
  });

  it("钳位结果始终满足 RecipeSchema", () => {
    const { recipe } = clampRecipe({
      ...makeValidRecipe(),
      bypassEnabled: true,
      bypassVolume: 100,
    });
    assert.equal(RecipeSchema.safeParse(recipe).success, true);
  });
});

describe("validateForTarget 目标路径校验", () => {
  it("安全配方同时通过 cloud 与 ble 校验", () => {
    const recipe = RecipeSchema.parse(makeValidRecipe());
    assert.deepEqual(validateForTarget(recipe, "cloud"), []);
    assert.deepEqual(validateForTarget(recipe, "ble"), []);
  });

  it("dose=40g：cloud 拒绝（≤31），ble 按真机/App 上限拒绝（≤18）", () => {
    const input = makeValidRecipe();
    input.doseGrams = 40;
    input.grandWater = 624; // 40 × 15.6，保持云端粉水比约束成立
    input.pours = [
      { volume: 300, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 10 },
      { volume: 300, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 10 },
      { volume: 24, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 10 },
    ];
    const recipe = RecipeSchema.parse(input);
    assert.ok(validateForTarget(recipe, "cloud").some((e) => e.includes("doseGrams")));
    // BLE 同时报粉量与总水超界；设备协议边界不再沿用旧项目的 40g 假设。
    const bleErrors = validateForTarget(recipe, "ble");
    assert.ok(bleErrors.some((e) => e.includes("doseGrams")));
    assert.ok(bleErrors.some((e) => e.includes("grandWater")));
  });

  it("grinderSize=120：cloud 与 ble 都接纳，ble 编码层映射为设备 80", () => {
    const input = makeValidRecipe();
    input.grinderSize = 120;
    const recipe = RecipeSchema.parse(input);
    assert.deepEqual(validateForTarget(recipe, "cloud"), []);
    assert.ok(!validateForTarget(recipe, "ble").some((e) => e.includes("grinderSize")));
  });

  it("grinderSize=121：超出内部云端标尺，cloud 与 ble 均报错", () => {
    const input = makeValidRecipe();
    input.grinderSize = 121;
    const recipe = RecipeSchema.parse(input);
    assert.ok(validateForTarget(recipe, "cloud").some((e) => e.includes("grinderSize")));
    assert.ok(validateForTarget(recipe, "ble").some((e) => e.includes("grinderSize")));
  });

  it("ble 路径拒绝 ratio>25.5：尾字节单字节编码上限（任务#47）", () => {
    // 5g 粉 / 200ml 水 = 1:40，int(400) & 0xFF = 144，机器按 1:14.4 误读
    const input = makeValidRecipe();
    input.doseGrams = 5;
    input.grandWater = 200;
    input.pours = [{ volume: 200, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 }];
    const recipe = RecipeSchema.parse(input);
    const errors = validateForTarget(recipe, "ble");
    assert.ok(errors.some((e) => e.includes("BLE 尾字节单字节编码上限 25.5")));
    // cloud 路径不受该规则影响（其自有粉水比区间校验另行拦截）
    assert.ok(!validateForTarget(recipe, "cloud").some((e) => e.includes("尾字节")));
  });

  it("ble 路径边界 ratio=25.5 不被尾字节规则拦截", () => {
    const input = makeValidRecipe();
    input.doseGrams = 20;
    input.grandWater = 500;
    input.pours = [
      { volume: 250, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 10 },
      { volume: 250, temperature: 88, flowRate: 3.2, pattern: "circular", pausing: 5 },
    ];
    const recipe = RecipeSchema.parse(input);
    assert.ok(!validateForTarget(recipe, "ble").some((e) => e.includes("尾字节")));
  });

  it("cloud 路径拒绝粉水比越界的配方（1:6.7 < 12）", () => {
    const input = makeValidRecipe();
    input.grandWater = 100;
    input.pours = [{ volume: 100, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 }];
    const recipe = RecipeSchema.parse(input);
    assert.ok(validateForTarget(recipe, "cloud").some((e) => e.includes("粉水比 grandWater/dose")));
  });

  it("手动录入 12g/200ml（1:16.7）被 cloud 拒绝：ratio 0.1 步进不可达（任务#39/#41）", () => {
    // 12×16.7=200.4≠200：官方 App/机器强校验 dose×ratio == Σ各段，
    // 不可达配方发布报"浇注指令异常"、App 加载报"检查蓝牙"
    const input = makeValidRecipe();
    input.doseGrams = 12;
    input.grandWater = 200;
    input.pours = [
      { volume: 100, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 10 },
      { volume: 100, temperature: 88, flowRate: 3.2, pattern: "circular", pausing: 5 },
    ];
    const recipe = RecipeSchema.parse({ ...input, bypassEnabled: false });
    const errors = validateForTarget(recipe, "cloud");
    assert.ok(errors.some((e) => e.includes("粉水比不可达")));
    // 错误文案给出就近可达值 198ml（12×16.5）
    assert.ok(errors.some((e) => e.includes("198ml")));
    // 对齐到可达值后通过校验
    const fixed = RecipeSchema.parse({
      ...input,
      bypassEnabled: false,
      grandWater: 198,
      pours: [
        { volume: 99, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 10 },
        { volume: 99, temperature: 88, flowRate: 3.2, pattern: "circular", pausing: 5 },
      ],
    });
    assert.deepEqual(validateForTarget(fixed, "cloud"), []);
  });

  it("默认比例 12g/187.2ml（1:15.6）通过 cloud 校验", () => {
    const input = makeValidRecipe();
    input.doseGrams = 12;
    input.grandWater = 187.2;
    input.pours = [
      { volume: 100, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 10 },
      { volume: 87.2, temperature: 88, flowRate: 3.2, pattern: "circular", pausing: 5 },
    ];
    const recipe = RecipeSchema.parse({ ...input, bypassEnabled: false });
    assert.deepEqual(validateForTarget(recipe, "cloud"), []);
  });

  it("bypass 开启的 1:12 浓缩配方（15g/180ml+45ml bypass）通过 cloud 校验", () => {
    // grandWater=180 偏离 15.6 倍（234ml）超 2%，但 bypass 开启时豁免贴合校验；
    // 总比 (180+45)/15 = 15 ∈ [12,20]，应整体通过
    const input = makeValidRecipe();
    input.grandWater = 180;
    input.pours = [
      { volume: 100, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 10 },
      { volume: 80, temperature: 88, flowRate: 3.2, pattern: "circular", pausing: 5 },
    ];
    const recipe = RecipeSchema.parse({ ...input, bypassEnabled: true, bypassVolume: 45 });
    assert.deepEqual(validateForTarget(recipe, "cloud"), []);
  });

  it("bypass 关闭且粉水比越界（1:10 < 12）仍被 cloud 拒绝", () => {
    // 15g 粉 / 150ml 水 → grandWater/dose = 10 < 12
    const input = makeValidRecipe();
    input.grandWater = 150;
    input.pours = [
      { volume: 100, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 10 },
      { volume: 50, temperature: 88, flowRate: 3.2, pattern: "circular", pausing: 5 },
    ];
    const recipe = RecipeSchema.parse({ ...input, bypassEnabled: false });
    assert.ok(validateForTarget(recipe, "cloud").some((e) => e.includes("粉水比 grandWater/dose")));
  });

  it("bypass 关闭但粉水比在区间内（1:12 边界）不被 cloud 拒绝", () => {
    // 15g 粉 / 180ml 水 → grandWater/dose = 12，恰好落在区间下限
    const input = makeValidRecipe();
    input.grandWater = 180;
    input.pours = [
      { volume: 100, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 10 },
      { volume: 80, temperature: 88, flowRate: 3.2, pattern: "circular", pausing: 5 },
    ];
    const recipe = RecipeSchema.parse({ ...input, bypassEnabled: false });
    assert.deepEqual(validateForTarget(recipe, "cloud"), []);
  });

  it("bypass 开启但总比 <12 被 cloud 拒绝", () => {
    // (150+5)/15 ≈ 10.3 < 12
    const input = makeValidRecipe();
    input.grandWater = 150;
    input.pours = [{ volume: 150, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 0 }];
    const recipe = RecipeSchema.parse({ ...input, bypassEnabled: true, bypassVolume: 5 });
    assert.ok(validateForTarget(recipe, "cloud").some((e) => e.includes("最终粉水比")));
  });

  it("bypass 开启但总比 >20 被 cloud 拒绝", () => {
    // (234+100)/15 ≈ 22.3 > 20
    const recipe = RecipeSchema.parse({
      ...makeValidRecipe(),
      bypassEnabled: true,
      bypassVolume: 100,
    });
    assert.ok(validateForTarget(recipe, "cloud").some((e) => e.includes("最终粉水比")));
  });

  it("bypass 粉水比守护：比例越界时两条路径都报错", () => {
    const recipe = RecipeSchema.parse({
      ...makeValidRecipe(),
      bypassEnabled: true,
      bypassVolume: 100, // (234+100)/15 = 22.3 > 20
    });
    assert.ok(validateForTarget(recipe, "cloud").some((e) => e.includes("最终粉水比")));
    assert.ok(validateForTarget(recipe, "ble").some((e) => e.includes("最终粉水比")));

    // 守护区间内无错误（cloud 路径 grandWater 贴合 15.6 倍，bypass 不计入）
    const ok = RecipeSchema.parse({ ...makeValidRecipe(), bypassEnabled: true, bypassVolume: 40 });
    assert.deepEqual(validateForTarget(ok, "cloud"), []);
  });
});

describe("estimateTotalSeconds 与总时长警告（任务 #35）", () => {
  it("估算总时长 = Σ(volume/flowRate + pausing)，保留一位小数", () => {
    // 标准夹具：100/3.2+10 + 134/3.2+5 = 88.125 → 88.1
    assert.equal(estimateTotalSeconds(makeValidRecipe()), 88.1);
  });

  it("flowRate 非法（≤0）时注水时长按 0 计，pausing 仍累计", () => {
    const seconds = estimateTotalSeconds({
      pours: [{ volume: 60, temperature: 90, flowRate: 0, pattern: "center", pausing: 40 }],
    });
    assert.equal(seconds, 40);
  });

  it("≤180s 无警告；>180s 返回含时长与建议的警告文案（仅警告不拦截）", () => {
    assert.equal(DURATION_WARN_SECONDS, 180);
    // 恰好 180s：构造恰为 180s 的配方：32/3.2+170 = 180
    const atLimit = {
      pours: [{ volume: 32, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 170 }],
    };
    assert.equal(estimateTotalSeconds(atLimit), 180);
    assert.equal(durationWarning(atLimit), undefined);

    // >180s：100/3.2+150 = 181.25
    const over = {
      pours: [{ volume: 100, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 150 }],
    };
    assert.equal(estimateTotalSeconds(over), 181.3);
    const warning = durationWarning(over);
    assert.ok(warning);
    assert.ok(warning!.includes("3:00"));
    assert.ok(warning!.includes("建议"));
  });
});
