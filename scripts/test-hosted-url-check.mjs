import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkHostedUrl, normalizeHostedUrl } from "./check-hosted-url.mjs";

function response(status, body, contentType = "text/html", finalUrl = "") {
  const result = new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
  if (finalUrl) {
    Object.defineProperty(result, "url", { value: finalUrl });
  }
  return result;
}

describe("Hosted 公开入口检查", () => {
  test("拒绝 EdgeOne 临时预览令牌", () => {
    assert.throws(
      () => normalizeHostedUrl("https://brew.edgeone.cool/?eo_token=TOKEN&eo_time=OFFSET"),
      /临时预览令牌/,
    );
  });

  test("首页和状态接口均公开时通过", async () => {
    const calls = [];
    const result = await checkHostedUrl("https://brew.example.com/", {
      fetchImpl: async (target) => {
        calls.push(String(target));
        if (String(target).endsWith("/api/status")) {
          return response(
            200,
            JSON.stringify({
              ok: true,
              version: "hosted-test",
              deployment: "cloudflare",
              capabilities: { generate: true },
            }),
            "application/json",
          );
        }
        return response(200, "<title>xBloom AI Brew Studio</title>");
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.version, "hosted-test");
    assert.equal(result.deployment, "cloudflare");
    assert.deepEqual(calls, ["https://brew.example.com/", "https://brew.example.com/api/status"]);
  });

  test("匿名首页返回 401 时给出 EdgeOne 域名提示", async () => {
    await assert.rejects(
      checkHostedUrl("https://brew.edgeone.cool/", {
        fetchImpl: async () => response(401, "Unauthorized"),
      }),
      /返回 401.*正式自定义域名/,
    );
  });

  test("拒绝重定向到 EdgeOne 临时预览地址", async () => {
    await assert.rejects(
      checkHostedUrl("https://brew.example.com/", {
        fetchImpl: async () =>
          response(
            200,
            "<title>xBloom AI Brew Studio</title>",
            "text/html",
            "https://brew.edgeone.cool/?eo_token=TOKEN&eo_time=OFFSET",
          ),
      }),
      /最终地址无效.*临时预览令牌/,
    );
  });

  test("拒绝重定向到其他来源", async () => {
    let bodyCancelled = false;
    const redirectedResponse = new Response(
      new ReadableStream({
        cancel() {
          bodyCancelled = true;
        },
      }),
      { status: 200 },
    );
    Object.defineProperty(redirectedResponse, "url", {
      value: "https://other.example.com/",
    });

    await assert.rejects(
      checkHostedUrl("https://brew.example.com/", {
        fetchImpl: async () => redirectedResponse,
      }),
      /被重定向到其他来源/,
    );
    assert.equal(bodyCancelled, true);
  });

  test("状态接口必须符合项目契约", async () => {
    await assert.rejects(
      checkHostedUrl("https://brew.example.com/", {
        fetchImpl: async (target) =>
          String(target).endsWith("/api/status")
            ? response(200, "{}", "application/json")
            : response(200, "<title>xBloom AI Brew Studio</title>"),
      }),
      /不是 xBloom Brew Studio 状态契约/,
    );
  });

  test("生成能力关闭时不计入公开验收通过", async () => {
    await assert.rejects(
      checkHostedUrl("https://brew.example.com/", {
        fetchImpl: async (target) =>
          String(target).endsWith("/api/status")
            ? response(
                200,
                JSON.stringify({
                  ok: true,
                  version: "hosted-test",
                  capabilities: { generate: false },
                }),
                "application/json",
              )
            : response(200, "<title>xBloom AI Brew Studio</title>"),
      }),
      /不是 xBloom Brew Studio 状态契约/,
    );
  });

  test("首页内容不是应用时失败", async () => {
    await assert.rejects(
      checkHostedUrl("https://brew.example.com/", {
        fetchImpl: async () => response(200, "<title>Other site</title>"),
      }),
      /没有识别到 xBloom Brew Studio/,
    );
  });
});
