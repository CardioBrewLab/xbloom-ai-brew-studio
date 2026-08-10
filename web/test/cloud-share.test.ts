import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cloudDetailReference } from "../src/lib/cloud-share.js";

describe("云端配方详情引用", () => {
  it("中国区优先使用服务端签发的官方分享链接", () => {
    const url = "https://share-h5.xbloomcoffee.cn/?id=SIGNED";
    assert.equal(cloudDetailReference({ tableId: "123", shareUrl: url }, "cn"), url);
  });

  it("中国区缺少签名链接时停止，全球区兼容 Base64 tableId", () => {
    assert.throws(() => cloudDetailReference({ tableId: "123" }, "cn"), /中国区分享链接/);
    assert.equal(cloudDetailReference({ tableId: "123" }, "global"), "MTIz");
  });

  it("仿冒分享域名不进入详情接口", () => {
    assert.throws(
      () =>
        cloudDetailReference({ tableId: "123", shareUrl: "https://evilxbloom.com/?id=X" }, "cn"),
      /中国区分享链接/,
    );
  });
});
