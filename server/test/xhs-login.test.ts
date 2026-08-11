/**
 * 小红书登录态 / 扫码续期测试（任务 #83，node:test + assert，网络全部 mock）：
 * - parseXhsLoginStatusText：check_login_status 文本解析（已登录+昵称 / 未登录 / 无法识别）
 * - parseXhsQrcodeContents：get_login_qrcode content 解析（base64/裸码/临时文件路径、
 *   截止时间解析与兜底 TTL、已登录短路）
 * - isXhsLoginExpiredError：登录失效错误特征识别（超时/中止类绝不命中）
 * - checkXhsLoginStatus / getXhsLoginQrcode：JSON-RPC 流程与工具名下发
 * - /api/xhs/* 路由：离线/已登录/取码/轮询/登出/检查失败六态（挂载临时 Express 实例，
 *   对 MCP 的 fetch 全部走队列 mock，不触网）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import {
  checkXhsLoginStatus,
  getXhsLoginQrcode,
  isXhsLoginExpiredError,
  parseXhsLoginStatusText,
  parseXhsQrcodeContents,
  XHS_QRCODE_FALLBACK_TTL_MS,
} from "../src/lib/xhs-mcp.js";

const BASE = "http://127.0.0.1:18060";
const realFetch = globalThis.fetch;

/** 按序消费的 fetch 队列 mock：超出预期的请求直接报错（防漏测） */
function mockFetchQueue(
  responses: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>,
): {
  calls: { url: string; body?: unknown }[];
} {
  const calls: { url: string; body?: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url, body });
    const next = responses.shift();
    if (!next) throw new Error(`意外的 fetch 调用：${url}`);
    return next(url, init);
  }) as typeof fetch;
  return { calls };
}

const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/** MCP content 数组形态的工具响应（可带 isError） */
const toolContents = (content: unknown[], isError = false): Response =>
  json({ jsonrpc: "2.0", id: 2, result: { content, isError } });

/** 1x1 透明 PNG 的 base64（真实二维码体积大，测试用最小有效 PNG） */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("parseXhsLoginStatusText 登录态解析", () => {
  it("已登录：提取用户名行作为昵称（空白截首段）", () => {
    const s = parseXhsLoginStatusText("✅ 已登录\n用户名: 咖啡小李\n\n你可以使用其他功能了。");
    assert.equal(s.loggedIn, true);
    assert.equal(s.nickname, "咖啡小李");
  });

  it("未登录文案返回 loggedIn:false；无法识别的文本保守按未登录", () => {
    assert.equal(
      parseXhsLoginStatusText("❌ 未登录\n\n请使用 get_login_qrcode 工具获取二维码进行登录。")
        .loggedIn,
      false,
    );
    assert.equal(parseXhsLoginStatusText("奇怪的输出").loggedIn, false);
  });

  it("已登录但无用户名行：loggedIn:true 且不带 nickname", () => {
    const s = parseXhsLoginStatusText("✅ 已登录");
    assert.equal(s.loggedIn, true);
    assert.equal(s.nickname, undefined);
  });
});

describe("parseXhsQrcodeContents 二维码解析", () => {
  const NOW = new Date("2026-08-07T10:00:00").getTime();

  it("实测形态：text 带截止时间 + image base64 → data URL + expiresAt", () => {
    const qr = parseXhsQrcodeContents(
      [
        { type: "text", text: "请用小红书 App 在 2026-08-07 10:05:00 前扫码登录 👇" },
        { type: "image", mimeType: "image/png", data: TINY_PNG_B64 },
      ],
      NOW,
    );
    assert.equal(qr.alreadyLoggedIn, false);
    assert.equal(qr.qrcode, `data:image/png;base64,${TINY_PNG_B64}`);
    assert.equal(qr.expiresAt, new Date("2026-08-07T10:05:00").getTime());
  });

  it("data: URL 按真实图片类型规范化；截止时间已过/缺失时用兜底 TTL", () => {
    const dataUrl = `data:image/jpeg;base64,${TINY_PNG_B64}`;
    const qr1 = parseXhsQrcodeContents(
      [
        { type: "text", text: "请用小红书 App 在 2020-01-01 00:00:00 前扫码登录" },
        { type: "image", data: dataUrl },
      ],
      NOW,
    );
    assert.equal(qr1.qrcode, `data:image/png;base64,${TINY_PNG_B64}`);
    assert.equal(qr1.expiresAt, NOW + XHS_QRCODE_FALLBACK_TTL_MS);
    const qr2 = parseXhsQrcodeContents([{ type: "image", data: TINY_PNG_B64 }], NOW);
    assert.equal(qr2.expiresAt, NOW + XHS_QRCODE_FALLBACK_TTL_MS);
    assert.equal(qr2.qrcode, `data:image/png;base64,${TINY_PNG_B64}`); // mimeType 缺省按 png
  });

  it("本地临时图片路径读成 base64 内联", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-qr-"));
    try {
      const file = path.join(directory, "qr.png");
      fs.writeFileSync(file, Buffer.from(TINY_PNG_B64, "base64"));
      const qr = parseXhsQrcodeContents(
        [
          { type: "text", text: "请用小红书 App 在 2026-08-07 10:05:00 前扫码登录" },
          { type: "image", data: file },
        ],
        NOW,
      );
      assert.equal(qr.qrcode, `data:image/png;base64,${TINY_PNG_B64}`);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("已登录短路：仅文本「你当前已处于登录状态」，无二维码", () => {
    const qr = parseXhsQrcodeContents([{ type: "text", text: "你当前已处于登录状态" }], NOW);
    assert.equal(qr.alreadyLoggedIn, true);
    assert.equal(qr.qrcode, undefined);
  });
});

describe("isXhsLoginExpiredError 失效特征识别", () => {
  it("未登录/凭证失效类错误命中", () => {
    assert.equal(
      isXhsLoginExpiredError(new Error("MCP 工具报错：搜索Feeds失败: 当前未登录，请先扫码登录")),
      true,
    );
    assert.equal(isXhsLoginExpiredError(new Error("cookie 已过期，请重新登录")), true);
    assert.equal(isXhsLoginExpiredError(new Error("user not logged in")), true);
    assert.equal(isXhsLoginExpiredError("session expired"), true);
  });

  it("超时/中止/网络类错误绝不命中（避免误报）", () => {
    assert.equal(isXhsLoginExpiredError(new Error("The operation was aborted")), false);
    assert.equal(isXhsLoginExpiredError(new Error("MCP tools/call 失败（HTTP 500）")), false);
    assert.equal(isXhsLoginExpiredError(new Error("fetch failed")), false);
    assert.equal(isXhsLoginExpiredError(new Error("timeout")), false);
    assert.equal(isXhsLoginExpiredError(new Error("笔记正文为空")), false);
  });
});

describe("checkXhsLoginStatus / getXhsLoginQrcode JSON-RPC 流程", () => {
  it("check_login_status：工具名正确下发，解析已登录昵称", async () => {
    const { calls } = mockFetchQueue([
      () => json({ result: {} }),
      () => toolContents([{ type: "text", text: "✅ 已登录\n用户名: 咖啡小李" }]),
    ]);
    try {
      const s = await checkXhsLoginStatus({ baseUrl: BASE, toolTimeoutMs: 5000 });
      assert.deepEqual(s, { loggedIn: true, nickname: "咖啡小李" });
      const callBody = calls[1].body as { params: { name: string; arguments: unknown } };
      assert.equal(callBody.params.name, "check_login_status");
      assert.deepEqual(callBody.params.arguments, {});
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("get_login_qrcode：image content 提取为 data URL（不被首 text 限制丢失）", async () => {
    mockFetchQueue([
      () => json({ result: {} }),
      () =>
        toolContents([
          { type: "text", text: "请用小红书 App 在 2099-01-01 00:00:00 前扫码登录 👇" },
          { type: "image", mimeType: "image/png", data: TINY_PNG_B64 },
        ]),
    ]);
    try {
      const qr = await getXhsLoginQrcode({ baseUrl: BASE, toolTimeoutMs: 5000 });
      assert.equal(qr.alreadyLoggedIn, false);
      assert.ok(qr.qrcode?.startsWith("data:image/png;base64,"));
      assert.ok((qr.expiresAt ?? 0) > Date.now());
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// /api/xhs/* 路由六态（挂载临时 Express，MCP 侧 fetch 全 mock）
// ---------------------------------------------------------------------------

describe("/api/xhs 路由", () => {
  let port = 0;
  let server: import("node:http").Server;
  let client: typeof fetch;

  before(async () => {
    process.env.XHS_MCP_URL ??= BASE; // config 模块级求值前兜底（已配置则不覆盖）
    const [{ default: express }, { default: xhsRouter }] = await Promise.all([
      import("express"),
      import("../src/routes/xhs.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use("/api/xhs", xhsRouter);
    client = realFetch; // 测试客户端用真实 fetch；MCP 侧已被队列 mock 接管
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  after(() => {
    globalThis.fetch = realFetch;
    server?.close();
  });

  const url = (p: string) => `http://127.0.0.1:${port}${p}`;

  it("status：MCP 离线 → online:false（不误导为掉登录）", async () => {
    mockFetchQueue([() => new Response("", { status: 503 })]);
    const body = (await (await client(url("/api/xhs/status"))).json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.online, false);
    assert.equal(body.loggedIn, false);
    assert.ok(String(body.message).includes("未启动"));
  });

  it("status：在线且已登录 → loggedIn:true + 昵称", async () => {
    mockFetchQueue([
      () => new Response('{"status":"healthy"}'),
      () => json({ result: {} }),
      () => toolContents([{ type: "text", text: "✅ 已登录\n用户名: 咖啡小李" }]),
    ]);
    const body = (await (await client(url("/api/xhs/status"))).json()) as Record<string, unknown>;
    assert.deepEqual(
      { ok: body.ok, online: body.online, loggedIn: body.loggedIn, nickname: body.nickname },
      { ok: true, online: true, loggedIn: true, nickname: "咖啡小李" },
    );
  });

  it("status：在线但检查失败 → checkFailed:true（HTTP 200 结构化错误）", async () => {
    mockFetchQueue([
      () => new Response('{"status":"healthy"}'),
      () => json({ result: {} }),
      () => toolContents([{ type: "text", text: "检查登录状态失败: 浏览器未启动" }], true),
    ]);
    const res = await client(url("/api/xhs/status"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.checkFailed, true);
  });

  it("login/qrcode：返回 base64 data URL 与过期时刻", async () => {
    mockFetchQueue([
      () => new Response('{"status":"healthy"}'),
      () => json({ result: {} }),
      () =>
        toolContents([
          { type: "text", text: "请用小红书 App 在 2099-01-01 00:00:00 前扫码登录 👇" },
          { type: "image", mimeType: "image/png", data: TINY_PNG_B64 },
        ]),
    ]);
    const body = (await (
      await client(url("/api/xhs/login/qrcode"), { method: "POST" })
    ).json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.ok(String(body.qrcode).startsWith("data:image/png;base64,"));
    assert.ok(Number(body.expiresAt) > Date.now());
  });

  it("login/qrcode：已登录短路 → alreadyLoggedIn:true（提示先登出切换账号）", async () => {
    mockFetchQueue([
      () => new Response('{"status":"healthy"}'),
      () => json({ result: {} }),
      () => toolContents([{ type: "text", text: "你当前已处于登录状态" }]),
    ]);
    const body = (await (
      await client(url("/api/xhs/login/qrcode"), { method: "POST" })
    ).json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.alreadyLoggedIn, true);
  });

  it("login/poll：未确认 → loggedIn:false；确认后 → loggedIn:true + 昵称", async () => {
    mockFetchQueue([
      () => new Response('{"status":"healthy"}'),
      () => json({ result: {} }),
      () => toolContents([{ type: "text", text: "❌ 未登录" }]),
    ]);
    const b1 = (await (await client(url("/api/xhs/login/poll"))).json()) as Record<string, unknown>;
    assert.equal(b1.ok, true);
    assert.equal(b1.loggedIn, false);

    mockFetchQueue([
      () => new Response('{"status":"healthy"}'),
      () => json({ result: {} }),
      () => toolContents([{ type: "text", text: "✅ 已登录\n用户名: 新账号" }]),
    ]);
    const b2 = (await (await client(url("/api/xhs/login/poll"))).json()) as Record<string, unknown>;
    assert.equal(b2.loggedIn, true);
    assert.equal(b2.nickname, "新账号");
  });

  it("logout：delete_cookies 成功 → ok:true", async () => {
    const { calls } = mockFetchQueue([
      () => new Response('{"status":"healthy"}'),
      () => json({ result: {} }),
      () => toolContents([{ type: "text", text: "Cookies 已成功删除，登录状态已重置。" }]),
    ]);
    const body = (await (
      await client(url("/api/xhs/logout"), { method: "POST" })
    ).json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    const callBody = calls[2].body as { params: { name: string } };
    assert.equal(callBody.params.name, "delete_cookies");
  });
});
