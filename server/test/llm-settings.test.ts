import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyStoredLlmSettings,
  currentLlmSettings,
  initializeLlmSettings,
  normalizeLlmBaseUrl,
  readStoredLlmSettings,
  resetLlmSettings,
  updateLlmSettings,
} from "../src/lib/llm-settings.js";
import type { AppConfig } from "../src/config.js";

type LlmConfig = AppConfig["llm"];

function fixture(): { file: string; defaults: LlmConfig; target: LlmConfig } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbloom-llm-settings-"));
  const defaults: LlmConfig = {
    provider: "openai-compatible",
    baseUrl: "https://env.example/v1",
    apiKey: "env-primary",
    fallbackApiKey: "env-fallback",
    model: "env-model",
    fallbackModel: "env-fallback-model",
    thirdModel: "",
    reasoningEffort: "high",
    temperature: 0.3,
  };
  return { file: path.join(dir, "settings.json"), defaults, target: { ...defaults } };
}

describe("本机模型接口设置", () => {
  it("规范化 http(s) 地址并拒绝凭据、查询参数和非 HTTP 协议", () => {
    assert.equal(
      normalizeLlmBaseUrl(" https://gateway.example/v1/ "),
      "https://gateway.example/v1",
    );
    assert.throws(() => normalizeLlmBaseUrl("file:///tmp/model"));
    assert.throws(() => normalizeLlmBaseUrl("https://user:pass@gateway.example/v1"));
    assert.throws(() => normalizeLlmBaseUrl("https://gateway.example/v1?token=x"));
    assert.throws(() => normalizeLlmBaseUrl("http://gateway.example/v1"));
    assert.equal(normalizeLlmBaseUrl("http://127.0.0.1:9000/v1"), "http://127.0.0.1:9000/v1");
  });

  it("保存后即时覆盖运行配置，GET 形态不包含密钥正文", async () => {
    const { file, defaults, target } = fixture();
    const result = await updateLlmSettings(
      {
        baseUrl: "https://new.example/v1/",
        model: "new-main",
        fallbackModel: "new-fallback",
        thirdModel: "",
        apiKey: "new-secret",
      },
      file,
      target,
      defaults,
    );

    assert.equal(target.baseUrl, "https://new.example/v1");
    assert.equal(target.model, "new-main");
    assert.equal(target.apiKey, "new-secret");
    assert.equal(result.apiKeyConfigured, true);
    assert.equal(result.source, "local");
    assert.equal("apiKey" in result, false);
    assert.equal(JSON.stringify(result).includes("new-secret"), false);

    const stored = readStoredLlmSettings(file);
    assert.equal(stored?.apiKey, "new-secret");
    assert.equal(stored?.baseUrl, "https://new.example/v1");
    const rawFile = fs.readFileSync(file, "utf8");
    assert.equal(rawFile.includes("new-secret"), false);
    assert.equal(rawFile.includes("apiKeyEncrypted"), true);
    assert.equal(rawFile.includes("windows-dpapi"), true);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  });

  it("后续留空密钥时保留既有本机密钥，只更新地址与模型", async () => {
    const { file, defaults, target } = fixture();
    await updateLlmSettings({ apiKey: "local-key", model: "model-a" }, file, target, defaults);
    await updateLlmSettings(
      { baseUrl: "http://127.0.0.1:9000/v1", model: "model-b", confirmEndpointChange: true },
      file,
      target,
      defaults,
    );
    assert.equal(target.apiKey, "local-key");
    assert.equal(target.baseUrl, "http://127.0.0.1:9000/v1");
    assert.equal(target.model, "model-b");
  });

  it("模型识别把同源根地址补全为 /v1 时继续复用已保存 Key", async () => {
    const { file, defaults, target } = fixture();
    await updateLlmSettings(
      { baseUrl: "https://gateway.example/", apiKey: "local-key", model: "model-a" },
      file,
      target,
      defaults,
    );
    await updateLlmSettings(
      { baseUrl: "https://gateway.example/v1", model: "model-b" },
      file,
      target,
      defaults,
    );
    assert.equal(target.baseUrl, "https://gateway.example/v1");
    assert.equal(target.apiKey, "local-key");
  });

  it("跨 endpoint 沿用已保存 Key 时要求显式确认", async () => {
    const { file, defaults, target } = fixture();
    await updateLlmSettings({ apiKey: "local-key", model: "model-a" }, file, target, defaults);
    await assert.rejects(
      updateLlmSettings({ baseUrl: "https://other.example/v1" }, file, target, defaults),
      /再次确认/,
    );
    await updateLlmSettings(
      { baseUrl: "https://other.example/v1", confirmEndpointChange: true },
      file,
      target,
      defaults,
    );
    assert.equal(target.baseUrl, "https://other.example/v1");
  });

  it("切换连接并提交新主 Key 时不复用旧兜底 Key", async () => {
    const { file, defaults, target } = fixture();
    await updateLlmSettings(
      { apiKey: "old-primary", fallbackApiKey: "old-fallback", model: "model-a" },
      file,
      target,
      defaults,
    );
    await updateLlmSettings(
      {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "new-primary",
        model: "claude-model",
      },
      file,
      target,
      defaults,
    );
    assert.equal(target.apiKey, "new-primary");
    assert.equal(target.fallbackApiKey, "new-primary");
    assert.equal(readStoredLlmSettings(file)?.fallbackApiKey, "new-primary");
  });

  it("运行期读取与写入共用队列，读取结果和即时配置保持一致", async () => {
    const { file, defaults, target } = fixture();
    const update = updateLlmSettings({ model: "queued-model" }, file, target, defaults);
    const snapshot = currentLlmSettings(file, target);
    await update;
    assert.equal((await snapshot).model, "queued-model");
    assert.equal(target.model, "queued-model");
  });

  it("重启加载本机覆盖；删除覆盖后完整恢复环境默认值", async () => {
    const { file, defaults, target } = fixture();
    await updateLlmSettings(
      {
        baseUrl: "https://persist.example/v1",
        model: "persist-model",
        fallbackModel: "",
        confirmEndpointChange: true,
      },
      file,
      target,
      defaults,
    );

    const restarted = { ...defaults, model: "transient" };
    const loaded = initializeLlmSettings(file, restarted, defaults);
    assert.equal(loaded.source, "local");
    assert.equal(restarted.model, "persist-model");
    assert.equal(restarted.fallbackModel, "");

    const reset = await resetLlmSettings(file, restarted, defaults);
    assert.equal(reset.source, "environment");
    assert.deepEqual(restarted, defaults);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(`${file}.key`), false);
  });

  it("密文被改动时启动回到环境设置，不把损坏内容带入运行态", async () => {
    const { file, defaults, target } = fixture();
    await updateLlmSettings({ apiKey: "local-key", model: "local-model" }, file, target, defaults);
    const disk = JSON.parse(fs.readFileSync(file, "utf8")) as {
      apiKeyEncrypted: { ciphertext: string };
    };
    const ciphertext = disk.apiKeyEncrypted.ciphertext;
    const tampered = Buffer.from(ciphertext, "base64");
    tampered[Math.floor(tampered.length / 2)] ^= 0x01;
    disk.apiKeyEncrypted.ciphertext = tampered.toString("base64");
    fs.writeFileSync(file, JSON.stringify(disk), "utf8");

    target.model = "dirty-runtime";
    const result = initializeLlmSettings(file, target, defaults);
    assert.equal(result.source, "environment");
    assert.equal(result.localOverridePresent, true);
    assert.equal(result.localOverrideValid, false);
    assert.deepEqual(target, defaults);
  });

  it("损坏覆盖仍可从状态接口发现，并可通过重新保存或恢复完成修复", async () => {
    const { file, defaults, target } = fixture();
    await updateLlmSettings(
      { apiKey: "first-local-key", model: "first-model" },
      file,
      target,
      defaults,
    );
    fs.writeFileSync(file, "{broken", "utf8");

    const broken = await currentLlmSettings(file, target);
    assert.equal(broken.localOverridePresent, true);
    assert.equal(broken.localOverrideValid, false);

    const repaired = await updateLlmSettings(
      { apiKey: "replacement-key", model: "replacement-model" },
      file,
      target,
      defaults,
    );
    assert.equal(repaired.source, "local");
    assert.equal(repaired.localOverrideValid, true);
    assert.equal(readStoredLlmSettings(file)?.apiKey, "replacement-key");

    await resetLlmSettings(file, target, defaults);
    assert.equal(fs.existsSync(file), false);
  });

  it("应用部分设置前先恢复默认值，避免旧运行态残留", () => {
    const { defaults, target } = fixture();
    target.thirdModel = "stale-third";
    applyStoredLlmSettings(
      {
        version: 3,
        updatedAt: new Date().toISOString(),
        model: "only-model",
      },
      target,
      defaults,
    );
    assert.equal(target.model, "only-model");
    assert.equal(target.thirdModel, defaults.thirdModel);
  });
});
