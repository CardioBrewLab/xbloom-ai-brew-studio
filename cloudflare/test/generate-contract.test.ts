import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  hostedCandidateSelection,
  publicApiError,
  publicHostedFailureReason,
} from "../src/index.ts";
import { normalizeRecipe } from "../src/recipe.ts";

test("Worker 出站 fetch 强制走公网路由", () => {
  const config = readFileSync(
    fileURLToPath(new URL("../wrangler.template.jsonc", import.meta.url).href),
    "utf8",
  );
  assert.match(config, /"global_fetch_strictly_public"/);
});

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

test("public API errors keep user guidance and hide internal runtime details", () => {
  assert.deepEqual(publicApiError(new SyntaxError("Unexpected token")), {
    status: 400,
    message: "请求体不是有效的 JSON",
  });
  assert.equal(publicApiError(new Error("请填写账号名")).status, 400);
  assert.equal(publicApiError(new Error("登录尝试较多，请稍后继续")).status, 429);
  assert.deepEqual(publicApiError(new Error("模型接口 HTTP 401：bad key")), {
    status: 502,
    message: "模型接口鉴权未通过，请检查 API Key 与账号权限",
  });
  assert.deepEqual(publicApiError(new Error("D1_ERROR: SELECT password_hash failed")), {
    status: 500,
    message: "服务本次未完成请求，请稍后重试",
  });
  assert.deepEqual(publicApiError(new Error("APP_DATA_ENCRYPTION_KEY missing")), {
    status: 503,
    message: "站点配置尚未完成，请联系站点维护者",
  });
  assert.equal(publicApiError(new Error("APP_PASSWORD_PEPPER missing")).status, 503);
});
