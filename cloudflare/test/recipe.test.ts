import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonObject, normalizeRecipe, scoreRecipe } from "../src/recipe.ts";

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
});
