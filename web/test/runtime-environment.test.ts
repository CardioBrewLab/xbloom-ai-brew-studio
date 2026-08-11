import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backendConnectionErrorMessage, isHostedHostname } from "../src/lib/companion.js";

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
