import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiRequestError, parseGenerateEvent, xhsFailureKindFromError } from "../src/lib/api.js";

const recipe = {
  name: "测试配方",
  cupType: "xdripper",
  doseGrams: 15,
  grinderSize: 60,
  rpm: 80,
  grandWater: 234,
  pours: [
    {
      volume: 50,
      temperature: 93,
      flowRate: 3.2,
      pattern: "center",
      pausing: 30,
      vibBefore: false,
      vibAfter: false,
    },
    {
      volume: 184,
      temperature: 92,
      flowRate: 3.3,
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
};

describe("生成 SSE 运行时契约", () => {
  it("接纳完整 recipe 并保留配方", () => {
    const event = parseGenerateEvent({ type: "recipe", recipe, clamped: [] });
    assert.equal(event.type, "recipe");
    if (event.type === "recipe") assert.equal(event.recipe.grandWater, 234);
  });

  it("拒绝空 recipe、未知事件与残缺 content", () => {
    assert.throws(() => parseGenerateEvent({ type: "recipe" }), /recipe/);
    assert.throws(() => parseGenerateEvent({ type: "mystery" }), /未知/);
    assert.throws(() => parseGenerateEvent({ type: "content" }), /正文/);
  });
});

describe("小红书结构化失败分类", () => {
  it("保留 browser_timeout 供二维码弹窗选择文案", () => {
    const error = new ApiRequestError("超时", "browser_timeout");
    assert.equal(xhsFailureKindFromError(error), "browser_timeout");
    assert.equal(xhsFailureKindFromError(new Error("普通错误")), undefined);
  });
});
