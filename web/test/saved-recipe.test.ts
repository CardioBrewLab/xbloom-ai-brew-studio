import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { savedRecipeState } from "../src/lib/saved-recipe.js";
import type { Recipe } from "../src/lib/recipe-schema.js";

const fallback: Recipe = {
  name: "保存前配方",
  cupType: "xdripper",
  doseGrams: 15,
  grinderSize: 60,
  rpm: 80,
  grandWater: 225,
  pours: [
    {
      volume: 225,
      temperature: 93,
      flowRate: 5,
      pattern: "center",
      pausing: 0,
      vibBefore: false,
      vibAfter: false,
    },
  ],
  bypassEnabled: false,
  bypassVolume: 5,
  bypassTemp: 85,
  isSetGrinderSize: 1,
  theColor: "#111111",
};

describe("server-normalized saved recipe", () => {
  it("uses the validated server recipe and carries clamp feedback", () => {
    const normalized = {
      ...fallback,
      grandWater: 220,
      pours: [{ ...fallback.pours[0], volume: 220 }],
    };
    const result = savedRecipeState(
      {
        ok: true,
        id: "local-1",
        recipe: normalized,
        clamped: ["总水量 225ml → 220ml"],
        warning: "已按安全区间修正",
      },
      fallback,
    );
    assert.deepEqual(result.recipe, normalized);
    assert.equal(result.normalized, true);
    assert.deepEqual(result.clamped, ["总水量 225ml → 220ml"]);
    assert.equal(result.warning, "已按安全区间修正");
  });

  it("falls back to the submitted recipe when the response has no valid normalized payload", () => {
    const result = savedRecipeState({ ok: true, id: "local-2" }, fallback);
    assert.equal(result.recipe, fallback);
    assert.equal(result.normalized, false);
  });
});
