import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildLlmSettingsUpdate,
  normalizeSettingsBaseUrl,
  settingsBaseUrlOrigin,
} from "../src/lib/llm-settings.js";

describe("模型接口设置表单", () => {
  it("地址去掉首尾空白和尾部斜杠，同时保留本机 HTTP 网关", () => {
    assert.equal(
      normalizeSettingsBaseUrl(" https://gateway.example/v1/ "),
      "https://gateway.example/v1",
    );
    assert.equal(normalizeSettingsBaseUrl("http://127.0.0.1:9000/v1/"), "http://127.0.0.1:9000/v1");
  });

  it("拒绝带凭据、查询参数或非 HTTP 协议的地址", () => {
    assert.throws(() => normalizeSettingsBaseUrl("file:///tmp/api"));
    assert.throws(() => normalizeSettingsBaseUrl("https://u:p@example.com/v1"));
    assert.throws(() => normalizeSettingsBaseUrl("https://example.com/v1?key=x"));
  });

  it("未配置账号的空地址不阻塞首次保存", () => {
    assert.equal(settingsBaseUrlOrigin(""), "");
    assert.equal(settingsBaseUrlOrigin(undefined), "");
    assert.equal(settingsBaseUrlOrigin("https://gateway.example/v1"), "https://gateway.example");
  });

  it("空白 Key 不进入请求，表示保留当前密钥", () => {
    const payload = buildLlmSettingsUpdate({
      baseUrl: "https://gateway.example/v1",
      model: " main-model ",
      fallbackModel: " fallback-model ",
      thirdModel: "",
      apiKey: "   ",
      fallbackApiKey: "",
    });
    assert.deepEqual(payload, {
      baseUrl: "https://gateway.example/v1",
      model: "main-model",
      fallbackModel: "fallback-model",
      thirdModel: "",
    });
  });

  it("填写的新 Key 随请求发送，但由调用层保持密码输入形态", () => {
    const payload = buildLlmSettingsUpdate({
      baseUrl: "https://gateway.example/v1",
      model: "main-model",
      fallbackModel: "",
      thirdModel: "",
      apiKey: "new-primary",
      fallbackApiKey: "new-fallback",
    });
    assert.equal(payload.apiKey, "new-primary");
    assert.equal(payload.fallbackApiKey, "new-fallback");
  });
});
