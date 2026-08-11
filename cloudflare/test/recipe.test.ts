import assert from "node:assert/strict";
import test from "node:test";
import {
  extractJsonObject,
  hostedRecipeDifferenceCount,
  hostedRecipeFingerprint,
  hostedRecipesAreDistinct,
  hostedRecipeSummary,
  normalizeRecipe,
  normalizeRecipeWithReport,
  scoreHostedRecipe,
  scoreRecipe,
} from "../src/recipe.ts";

test("normalizes a fenced model recipe into xBloom-safe ranges", () => {
  const raw = extractJsonObject(
    '```json\n{"name":"Test","doseGrams":99,"grinderSize":10,"rpm":83,"pours":[{"volume":45,"temperature":99,"flowRate":9,"pattern":"bad","pausing":20}]}\n```',
  );
  const recipe = normalizeRecipe(raw);
  assert.equal(recipe.doseGrams, 18);
  assert.equal(recipe.grinderSize, 40);
  assert.equal(recipe.rpm, 80);
  assert.equal(recipe.pours[0].temperature, 95);
  assert.equal(recipe.pours[0].flowRate, 3.5);
  assert.equal(recipe.pours[0].pattern, "center");
  assert.equal(recipe.grandWater, 45);
  assert.ok(normalizeRecipeWithReport(raw).clamps.length >= 5);
});

test("string false never enables bypass or vibration and is reported as normalization", () => {
  const normalized = normalizeRecipeWithReport({
    name: "Strict boolean",
    doseGrams: 15,
    grinderSize: 72,
    rpm: 80,
    grandWater: 240,
    bypassEnabled: "false",
    isSetGrinderSize: 1,
    pours: [
      {
        volume: 240,
        temperature: 92,
        flowRate: 3.2,
        pattern: "center",
        pausing: 35,
        vibBefore: "false",
        vibAfter: "false",
      },
    ],
  });
  assert.equal(normalized.recipe.bypassEnabled, false);
  assert.equal(normalized.recipe.pours[0].vibBefore, false);
  assert.equal(normalized.recipe.pours[0].vibAfter, false);
  assert.ok(normalized.clamps.some((message) => message.includes("旁路开关")));
  assert.ok(normalized.clamps.some((message) => message.includes("前振动")));
  assert.ok(normalized.clamps.some((message) => message.includes("后振动")));
});

test("scores a normal three-pour recipe above an extreme ratio", () => {
  const normal = normalizeRecipe({
    name: "N",
    doseGrams: 15,
    grinderSize: 72,
    rpm: 80,
    pours: [
      { volume: 45, temperature: 92, flowRate: 3.2, pattern: "center", pausing: 35 },
      { volume: 95 },
      { volume: 95 },
    ],
  });
  const extreme = normalizeRecipe({
    name: "E",
    doseGrams: 18,
    grinderSize: 72,
    rpm: 80,
    pours: [{ volume: 40, pausing: 10 }],
  });
  assert.ok(scoreRecipe(normal) > scoreRecipe(extreme));
  const report = scoreHostedRecipe(normal);
  assert.equal(
    report.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0),
    100,
  );
  assert.equal(report.score, scoreRecipe(normal));
});

test("fingerprint ignores display name but catches executable parameter differences", () => {
  const base = normalizeRecipe({
    name: "A",
    doseGrams: 15,
    grinderSize: 60,
    rpm: 90,
    pours: [{ volume: 45, temperature: 92, flowRate: 3.2, pattern: "center", pausing: 35 }],
  });
  assert.equal(hostedRecipeFingerprint(base), hostedRecipeFingerprint({ ...base, name: "B" }));
  assert.notEqual(
    hostedRecipeFingerprint(base),
    hostedRecipeFingerprint({ ...base, grinderSize: 61 }),
  );
  assert.equal(hostedRecipeSummary(base).ratio, 3);
});

test("requires two material executable changes before a MAX candidate is distinct", () => {
  const base = normalizeRecipe({
    name: "A",
    cupType: "xdripper",
    doseGrams: 15,
    grinderSize: 60,
    rpm: 90,
    grandWater: 234,
    isSetGrinderSize: 1,
    pours: [
      { volume: 100, temperature: 92, flowRate: 3.2, pattern: "center", pausing: 45 },
      { volume: 134, temperature: 90, flowRate: 3.2, pattern: "circular", pausing: 40 },
    ],
  });
  const oneChange = { ...base, grinderSize: 62 };
  const twoChanges = { ...oneChange, rpm: 100 as const };
  assert.equal(hostedRecipeDifferenceCount(base, oneChange), 1);
  assert.equal(hostedRecipesAreDistinct(base, oneChange), false);
  assert.equal(hostedRecipeDifferenceCount(base, twoChanges), 2);
  assert.equal(hostedRecipesAreDistinct(base, twoChanges), true);
});

test("summary ratio includes bypass and exposes every diversity parameter", () => {
  const recipe = normalizeRecipe({
    name: "旁路",
    cupType: "xdripper",
    doseGrams: 15,
    grinderSize: 72,
    rpm: 80,
    grandWater: 225,
    bypassEnabled: true,
    bypassVolume: 15,
    bypassTemp: 82,
    isSetGrinderSize: 2,
    pours: [
      {
        volume: 225,
        temperature: 92,
        flowRate: 3.2,
        pattern: "center",
        pausing: 35,
        vibBefore: true,
        vibAfter: false,
      },
    ],
  });
  const summary = hostedRecipeSummary(recipe);
  assert.equal(summary.ratio, 16);
  assert.equal(summary.bypassVolume, 15);
  assert.equal(summary.isSetGrinderSize, 2);
  assert.equal(summary.pours[0].vibBefore, true);
});
