import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { xhsQrFailureCopy } from "../src/lib/xhs-qr.js";

describe("小红书二维码失败状态", () => {
  it("浏览器内核超时与服务离线使用不同说明", () => {
    const timeout = xhsQrFailureCopy("browser_timeout");
    const offline = xhsQrFailureCopy("service_offline");
    assert.match(timeout.title, /超时/);
    assert.match(timeout.detail, /端口在线/);
    assert.match(offline.title, /尚未就绪/);
    assert.notEqual(timeout.detail, offline.detail);
  });

  it("图片解码失败提示重新取码", () => {
    const copy = xhsQrFailureCopy("image_invalid");
    assert.match(copy.detail, /重新取码/);
  });
});
