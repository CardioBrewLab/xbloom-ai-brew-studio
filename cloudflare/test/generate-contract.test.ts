import assert from "node:assert/strict";
import test from "node:test";
import { hostedCandidateSelection, publicHostedFailureReason } from "../src/index.ts";
import { normalizeRecipe } from "../src/recipe.ts";

const recipe = (grinderSize: number) =>
  normalizeRecipe({
    name: `候选 ${grinderSize}`,
    doseGrams: 15,
    grinderSize,
    rpm: 90,
    pours: [
      { volume: 45, temperature: 92, flowRate: 3.2, pattern: "center", pausing: 35 },
      { volume: 189, temperature: 90, flowRate: 3.2, pattern: "circular", pausing: 5 },
    ],
  });

test("hosted candidate selection matches desktop SSE result contract", () => {
  const selection = hostedCandidateSelection([
    { index: 0, recipe: recipe(58) },
    { index: 1, recipe: recipe(60) },
    { index: 2, error: "网络波动，自动重试后仍未完成" },
  ]);
  assert.equal(selection.results.length, 3);
  assert.equal(selection.scores.length, 2);
  assert.equal(selection.results[0].status, "ok");
  assert.ok("recipeSummary" in selection.results[0]);
  assert.deepEqual(selection.results[2], {
    index: 2,
    status: "failed",
    failReason: "网络波动，自动重试后仍未完成",
  });
  assert.equal(typeof selection.winner.index, "number");
});

test("hosted failures distinguish credentials, model paths, throttling and transport", () => {
  assert.equal(publicHostedFailureReason(new Error("LLM HTTP 401")), "模型接口认证未通过");
  assert.equal(publicHostedFailureReason(new Error("LLM HTTP 404")), "模型或接口路径不存在");
  assert.match(publicHostedFailureReason(new Error("LLM HTTP 429")), /请求较多/);
  assert.match(publicHostedFailureReason(new TypeError("fetch failed")), /网络连接波动/);
  assert.match(publicHostedFailureReason(new Error("Unexpected token in JSON")), /响应格式/);
});
