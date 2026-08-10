/**
 * 发布对齐值回写本地配方库的匹配语义（任务 #55 警告1/建议3）：
 * - 版本链 v1/v2（各段水量相同、仅温度不同）→ 只回写被发布的版本，不误覆写旧版本
 * - 完全重复条目 → 全部回写，返回首个 id
 * - 未命中 → 安全 no-op（不抛错、不改库）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeBackAlignedRecipe } from "../src/lib/local-writeback.js";
import { RecipeSchema, type Recipe } from "../src/lib/recipe-schema.js";
import { loadAll, saveAll, type StoredRecipe } from "../src/routes/recipes.js";

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbloom-wb-"));
  return path.join(dir, "recipes.json");
}

/** 15g/245ml 四段配方（RecipeSchema.parse 归一，vib/theColor 等缺省由 schema 补齐） */
function mkRecipe(name: string, firstTemp: number): Recipe {
  return RecipeSchema.parse({
    name,
    cupType: "xdripper",
    doseGrams: 15,
    grinderSize: 70,
    rpm: 80,
    grandWater: 245,
    pours: [
      { volume: 50, temperature: firstTemp, flowRate: 3.2, pattern: "circular", pausing: 15 },
      { volume: 65, temperature: 91, flowRate: 3.2, pattern: "circular", pausing: 15 },
      { volume: 65, temperature: 90, flowRate: 3.2, pattern: "circular", pausing: 15 },
      { volume: 65, temperature: 89, flowRate: 3.2, pattern: "center", pausing: 0 },
    ],
  });
}

function entry(id: string, recipe: Recipe): StoredRecipe {
  return { id, createdAt: new Date().toISOString(), recipe };
}

describe("writeBackAlignedRecipe 本地回写匹配（任务 #55）", () => {
  it("版本链 v1/v2 仅一段温度不同 → 只回写被发布的 v2，v1 原样保留", () => {
    const file = tmpFile();
    const v1 = mkRecipe("同款配方", 92);
    const v2 = mkRecipe("同款配方", 90); // v2 调参只降首段温度：粉量/总水/各段水量全同
    saveAll([entry("id-v1", v1), entry("id-v2", v2)], file);

    const alignedPours = v2.pours.map((p, i) => ({ ...p, volume: [50, 66, 65, 65][i] }));
    const hit = writeBackAlignedRecipe(v2, 246, alignedPours, file);
    assert.equal(hit, "id-v2");

    const list = loadAll(file);
    const gotV1 = list.find((e) => e.id === "id-v1")!;
    const gotV2 = list.find((e) => e.id === "id-v2")!;
    // v2：对齐值已回写（grandWater 与分段整数化，温度等其余字段保持 v2 自身）
    assert.equal(gotV2.recipe.grandWater, 246);
    assert.deepEqual(
      gotV2.recipe.pours.map((p) => p.volume),
      [50, 66, 65, 65],
    );
    assert.equal(gotV2.recipe.pours[0].temperature, 90);
    // v1：绝不被覆写
    assert.equal(gotV1.recipe.grandWater, 245);
    assert.deepEqual(
      gotV1.recipe.pours.map((p) => p.volume),
      [50, 65, 65, 65],
    );
    assert.equal(gotV1.recipe.pours[0].temperature, 92);
  });

  it("库内只有更早版本（水量相同温度不同）→ 未命中，安全 no-op", () => {
    const file = tmpFile();
    saveAll([entry("id-v1", mkRecipe("同款配方", 92))], file);
    const hit = writeBackAlignedRecipe(mkRecipe("同款配方", 90), 246, [], file);
    assert.equal(hit, undefined);
    const got = loadAll(file)[0];
    assert.equal(got.recipe.grandWater, 245);
    assert.equal(got.recipe.pours[0].temperature, 92);
  });

  it("完全重复条目 → 全部回写，返回首个 id，其余同水量条目不受影响", () => {
    const file = tmpFile();
    const r = mkRecipe("重复配方", 92);
    saveAll(
      [
        entry("id-a", r),
        entry("id-b", JSON.parse(JSON.stringify(r)) as Recipe),
        entry("id-c", mkRecipe("无关配方", 92)),
      ],
      file,
    );
    const alignedPours = r.pours.map((p, i) => ({ ...p, volume: [50, 66, 65, 65][i] }));
    const hit = writeBackAlignedRecipe(r, 246, alignedPours, file);
    assert.equal(hit, "id-a");

    const list = loadAll(file);
    for (const id of ["id-a", "id-b"]) {
      const e = list.find((x) => x.id === id)!;
      assert.equal(e.recipe.grandWater, 246);
      assert.deepEqual(
        e.recipe.pours.map((p) => p.volume),
        [50, 66, 65, 65],
      );
    }
    const other = list.find((x) => x.id === "id-c")!;
    assert.equal(other.recipe.grandWater, 245);
  });

  it("名称不同 → 未命中，安全 no-op", () => {
    const file = tmpFile();
    saveAll([entry("id-x", mkRecipe("配方甲", 92))], file);
    assert.equal(writeBackAlignedRecipe(mkRecipe("配方乙", 92), 246, [], file), undefined);
    assert.equal(loadAll(file)[0].recipe.grandWater, 245);
  });
});

describe("双方案异名双条目独立回写（任务 #61）", () => {
  /** AI 改进版样例：三段骨架（与原版四段结构不同），总水 240ml */
  function mkImproved(): Recipe {
    return RecipeSchema.parse({
      name: "原名· AI 改进版",
      cupType: "xdripper",
      doseGrams: 15,
      grinderSize: 66,
      rpm: 80,
      grandWater: 240,
      pours: [
        { volume: 60, temperature: 91, flowRate: 3.2, pattern: "circular", pausing: 35 },
        { volume: 100, temperature: 90, flowRate: 3.2, pattern: "circular", pausing: 15 },
        { volume: 80, temperature: 89, flowRate: 3.2, pattern: "center", pausing: 0 },
      ],
    });
  }

  it("「原名」与「原名· AI 改进版」独立回写互不干扰", () => {
    const file = tmpFile();
    const original = mkRecipe("原名", 92);
    const improved = mkImproved();
    saveAll([entry("id-orig", original), entry("id-improved", improved)], file);

    // 原版发布后回写：只命中原版条目
    const alignedOrig = original.pours.map((p, i) => ({ ...p, volume: [50, 66, 65, 65][i] }));
    assert.equal(writeBackAlignedRecipe(original, 246, alignedOrig, file), "id-orig");

    let list = loadAll(file);
    assert.equal(list.find((e) => e.id === "id-orig")!.recipe.grandWater, 246);
    // 改进版未被原版回写波及
    assert.equal(list.find((e) => e.id === "id-improved")!.recipe.grandWater, 240);
    assert.deepEqual(
      list.find((e) => e.id === "id-improved")!.recipe.pours.map((p) => p.volume),
      [60, 100, 80],
    );

    // 改进版发布后回写：只命中改进版条目
    const alignedImpr = improved.pours.map((p, i) => ({ ...p, volume: [60, 102, 78][i] }));
    assert.equal(writeBackAlignedRecipe(improved, 240, alignedImpr, file), "id-improved");

    list = loadAll(file);
    const gotO = list.find((e) => e.id === "id-orig")!;
    const gotI = list.find((e) => e.id === "id-improved")!;
    // 原版保持自己的回写值，未被改进版回写覆写
    assert.equal(gotO.recipe.grandWater, 246);
    assert.deepEqual(
      gotO.recipe.pours.map((p) => p.volume),
      [50, 66, 65, 65],
    );
    // 改进版写入自己的对齐值
    assert.equal(gotI.recipe.grandWater, 240);
    assert.deepEqual(
      gotI.recipe.pours.map((p) => p.volume),
      [60, 102, 78],
    );
    assert.equal(gotI.recipe.name, "原名· AI 改进版");
  });
});
