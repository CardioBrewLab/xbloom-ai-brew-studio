import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MODEL_API_INVITE_URL, SUPPORT_QR_PATH } from "../src/components/SupportProjectModal.tsx";

const root = fileURLToPath(new URL("../../", import.meta.url));

describe("支持项目公开信息", () => {
  it("使用独立且完整的邀请地址", () => {
    const url = new URL(MODEL_API_INVITE_URL);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "llm.mathmodel.tech");
    assert.equal(url.pathname, "/sign-up");
    assert.equal(url.searchParams.get("aff"), "NmPu");
    assert.equal(url.searchParams.size, 1);
  });

  it("公开返利说明、外链安全属性和自愿支持边界", () => {
    const modal = readFileSync(`${root}web/src/components/SupportProjectModal.tsx`, "utf8");
    assert.match(modal, /可能为项目带来返利/);
    assert.match(modal, /rel="sponsored noopener noreferrer"/);
    assert.match(modal, /项目的全部功能与是否支持无关/);
    assert.match(modal, /不会获得额外功能或优先服务/);
  });

  it("二维码来自站内静态资源并进入发布目录", () => {
    assert.equal(SUPPORT_QR_PATH, "/support/wechat-support-qr.jpg");
    const image = readFileSync(`${root}web/public${SUPPORT_QR_PATH}`);
    assert.ok(image.length > 10_000);
    assert.equal(image[0], 0xff);
    assert.equal(image[1], 0xd8);
  });

  it("GitHub 首页同时展示邀请链接、披露和二维码", () => {
    const readme = readFileSync(`${root}README.md`, "utf8");
    assert.match(readme, /https:\/\/llm\.mathmodel\.tech\/sign-up\?aff=NmPu/);
    assert.match(readme, /可能为项目带来返利/);
    assert.match(readme, /web\/public\/support\/wechat-support-qr\.jpg/);
  });

  it("桌面与移动界面都有明确的支持入口", () => {
    const header = readFileSync(`${root}web/src/components/AppHeader.tsx`, "utf8");
    assert.match(header, /aria-label="支持项目"/);
    assert.match(header, /<IconHeart \/> 支持/);
  });
});
