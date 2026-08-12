import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  backendConnectionErrorMessage,
  companionConfig,
  isHostedHostname,
  parseCompanionConfig,
} from "../src/lib/companion.js";
import { api } from "../src/lib/api.js";

describe("本地版与 Hosted 版连接提示", () => {
  it("只把回环地址识别为本地运行环境", () => {
    for (const hostname of ["localhost", "127.0.0.1", "::1", "LOCALHOST"]) {
      assert.equal(isHostedHostname(hostname), false);
    }
    assert.equal(isHostedHostname("brew.example.cn"), true);
    assert.equal(isHostedHostname("xbloom.example.pages.dev"), true);
  });

  it("Hosted 页面不提示用户运行本地 npm 命令", () => {
    assert.equal(
      backendConnectionErrorMessage("brew.example.cn"),
      "云端服务暂时未连通，请稍后重试",
    );
    assert.match(backendConnectionErrorMessage("localhost"), /npm run dev/);
  });
});

describe("本地助手配对配置", () => {
  it("只接受仍在有效期内的本机地址令牌", () => {
    const config = {
      baseUrl: "http://127.0.0.1:8787",
      token: "A".repeat(43),
      expiresAt: 2_000,
    };
    assert.deepEqual(parseCompanionConfig(JSON.stringify(config), 1_999), config);
    assert.equal(parseCompanionConfig(JSON.stringify(config), 2_000), null);
    assert.equal(
      parseCompanionConfig(JSON.stringify({ ...config, baseUrl: "https://remote.example" }), 1),
      null,
    );
  });

  it("升级时清除 v1/v2 配对项，只读取 v3 配置", () => {
    const current = {
      baseUrl: "http://127.0.0.1:8787",
      token: "B".repeat(43),
      expiresAt: 3_000,
    };
    const values = new Map<string, string>([
      ["xbloom-companion-v1", "legacy-v1"],
      ["xbloom-companion-v2", "legacy-v2"],
      ["xbloom-companion-v3", JSON.stringify(current)],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    };
    assert.deepEqual(companionConfig(storage, 2_999), current);
    assert.equal(values.has("xbloom-companion-v1"), false);
    assert.equal(values.has("xbloom-companion-v2"), false);
  });

  it("Hosted 小红书账号直接使用同源云端接口，不依赖本地助手", async () => {
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
    const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const originalFetch = globalThis.fetch;
    const values = new Map<string, string>([
      [
        "xbloom-companion-v3",
        JSON.stringify({
          baseUrl: "http://127.0.0.1:8787",
          token: "C".repeat(43),
          expiresAt: Date.now() + 10_000,
        }),
      ],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { hostname: "brew.example", origin: "https://brew.example" },
    });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    let requested = "";
    globalThis.fetch = async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({ ok: true, online: true, loggedIn: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const status = await api.xhsStatus();
      assert.equal(status.online, true);
      assert.equal(requested, "/api/xhs/status");
      assert.equal(values.has("xbloom-companion-v3"), true);
    } finally {
      globalThis.fetch = originalFetch;
      if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
      else Reflect.deleteProperty(globalThis, "location");
      if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
