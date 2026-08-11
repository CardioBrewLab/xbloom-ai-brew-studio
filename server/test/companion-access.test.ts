import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loopbackOrigin, trustedWebOrigin } from "../src/lib/companion-access.js";

describe("公网页面与本地助手的 Origin 边界", () => {
  it("接受 HTTPS 站点与明确回环地址", () => {
    assert.equal(trustedWebOrigin("https://brew.example"), true);
    assert.equal(trustedWebOrigin("http://127.0.0.1:5180"), true);
    assert.equal(trustedWebOrigin("http://localhost:5180"), true);
    assert.equal(loopbackOrigin("http://[::1]:8787"), true);
  });

  it("拒绝公网明文、带路径和 URL 解析混淆", () => {
    assert.equal(trustedWebOrigin("http://brew.example"), false);
    assert.equal(trustedWebOrigin("https://brew.example/path"), false);
    assert.equal(trustedWebOrigin("https://brew.example@attacker.test/path"), false);
    assert.equal(trustedWebOrigin("not-a-url"), false);
  });
});
