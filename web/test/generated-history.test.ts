import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generatedRecipeIsCurrent,
  generatedRecipeSaveOptions,
  reusableGeneratedSave,
  reusableGeneratedSaveCheckpointForRecipe,
  reusableGeneratedSaveForRecipe,
  sameRecipeSnapshot,
  savedPairVariantForRecipe,
} from "../src/lib/generated-history.js";
import type { GenerateEvent, GenerateRequest } from "../src/lib/api.js";

const recipeEvent = {
  type: "recipe",
  recipe: {
    name: "测试方案",
    cupType: "xdripper",
    doseGrams: 15,
    grinderSize: 60,
    rpm: 80,
    grandWater: 225,
    pours: [],
    bypassEnabled: false,
    bypassVolume: 0,
    bypassTemp: 85,
    isSetGrinderSize: 1,
    theColor: "#111111",
  },
  clamped: [],
  refUrls: ["https://example.com/recipe"],
} satisfies Extract<GenerateEvent, { type: "recipe" }>;

describe("generatedRecipeSaveOptions", () => {
  it("用户从豆库明确选择的 beanId 优先于后端自由文本匹配", () => {
    const request: GenerateRequest = {
      description: "突出花香",
      beanId: "selected-bean",
      beans: "测试豆（埃塞俄比亚，水洗）",
    };
    const options = generatedRecipeSaveOptions(
      request,
      recipeEvent,
      "调研摘要",
      "unexpected-auto-created-bean",
    );
    assert.equal(options.beanId, "selected-bean");
    assert.equal(options.beanSnapshot, request.beans);
    assert.equal(options.researchSummary, "调研摘要");
    assert.equal(options.variant, "original");
  });

  it("自由文本建档场景仍可记录服务端匹配到的豆档案", () => {
    const options = generatedRecipeSaveOptions(
      { description: "平衡", beans: "自由文本豆信息" },
      recipeEvent,
      "",
      "matched-bean",
    );
    assert.equal(options.beanId, "matched-bean");
    assert.deepEqual(options.refUrls, ["https://example.com/recipe"]);
  });
});

describe("reusableGeneratedSave", () => {
  it("同一生成会话与配方修订复用原保存 Promise", async () => {
    let saves = 0;
    const promise = Promise.resolve().then(() => ({ id: `saved-${++saves}` }));
    const checkpoint = { generationId: 7, recipeRevision: 3, promise };
    const reused = reusableGeneratedSave(checkpoint, 7, 3);
    assert.equal(reused, promise);
    assert.deepEqual(await reused, { id: "saved-1" });
    assert.equal(saves, 1);
  });

  it("新生成会话或已编辑配方不会沿用旧保存", () => {
    const checkpoint = {
      generationId: 7,
      recipeRevision: 3,
      promise: Promise.resolve({ id: "old" }),
    };
    assert.equal(reusableGeneratedSave(checkpoint, 8, 3), null);
    assert.equal(reusableGeneratedSave(checkpoint, 7, 4), null);
  });

  it("双方案完成检查点在重复点击时只执行一组写入", async () => {
    let writes = 0;
    const promise = Promise.resolve().then(() => {
      writes += 2;
      return { original: { id: "a" }, improved: { id: "b" } };
    });
    const checkpoint = { generationId: 9, recipeRevision: 4, promise };
    const first = reusableGeneratedSave(checkpoint, 9);
    const second = reusableGeneratedSave(checkpoint, 9);
    assert.equal(first, second);
    await Promise.all([first, second]);
    assert.equal(writes, 2);
  });

  it("云端绑定完成前必须同时匹配生成轮次和配方修订", () => {
    assert.equal(generatedRecipeIsCurrent(3, 8, 3, 8), true);
    assert.equal(generatedRecipeIsCurrent(3, 8, 4, 8), false);
    assert.equal(generatedRecipeIsCurrent(3, 8, 3, 9), false);
  });
});

describe("savedPairVariantForRecipe", () => {
  const original = recipeEvent.recipe;
  const improved = { ...original, name: "测试方案 · AI 改进", grinderSize: 64 };

  it("双方案保存期间切换版本时认领当前版本的历史 ID", () => {
    assert.equal(savedPairVariantForRecipe({ ...original }, original, improved), "original");
    assert.equal(savedPairVariantForRecipe({ ...improved }, original, improved), "improved");
  });

  it("保存期间编辑过配方时拒绝把旧历史 ID 回写给新内容", () => {
    assert.equal(
      savedPairVariantForRecipe({ ...improved, rpm: improved.rpm + 5 }, original, improved),
      null,
    );
    assert.equal(savedPairVariantForRecipe(null, original, improved), null);
  });

  it("两份参数完全一致时按用户当前采用版本消除歧义", () => {
    assert.equal(
      savedPairVariantForRecipe(original, original, { ...original }, "improved"),
      "improved",
    );
    assert.equal(
      savedPairVariantForRecipe(original, original, { ...original }, "original"),
      "original",
    );
  });
});

describe("配方快照保存检查点", () => {
  it("revision 改变但切回同一配方时仍复用原写入", () => {
    const promise = Promise.resolve({ id: "original-id" });
    const checkpoint = {
      generationId: 12,
      recipeRevision: 2,
      recipe: recipeEvent.recipe,
      promise,
    };
    assert.equal(
      reusableGeneratedSaveForRecipe(checkpoint, 12, { ...recipeEvent.recipe }),
      promise,
    );
    assert.equal(
      reusableGeneratedSaveForRecipe(checkpoint, 12, {
        ...recipeEvent.recipe,
        grinderSize: recipeEvent.recipe.grinderSize + 1,
      }),
      null,
    );
    assert.equal(sameRecipeSnapshot(recipeEvent.recipe, { ...recipeEvent.recipe }), true);
  });

  it("响应丢失后的重试复用同一 clientRequestId", () => {
    const checkpoint = {
      generationId: 12,
      recipeRevision: 2,
      recipe: recipeEvent.recipe,
      promise: Promise.reject(new Error("lost response")),
      clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
      saveOptions: {
        clientRequestId: "123e4567-e89b-42d3-a456-426614174000",
        name: "调参第 2 版",
        parentId: "parent-id",
        sourceFeedbackId: "feedback-id",
        changeNotes: "降低萃取",
      },
    };
    checkpoint.promise.catch(() => undefined);
    assert.equal(
      reusableGeneratedSaveCheckpointForRecipe(checkpoint, 12, { ...recipeEvent.recipe })
        ?.clientRequestId,
      checkpoint.clientRequestId,
    );
    assert.equal(
      reusableGeneratedSaveCheckpointForRecipe(checkpoint, 12, {
        ...recipeEvent.recipe,
      })?.saveOptions?.parentId,
      "parent-id",
    );
  });
});
