/**
 * 小红书 MCP 直连客户端测试（任务 #82，node:test + assert，网络全部 mock）：
 * - xhsMcpHealthy：/health 探活（在线/离线/未配置基址）
 * - parseXhsMcpSearchText / parseXhsMcpFeeds：search_feeds 响应解析（真实结构样本）
 * - xhsNoteUrl / xhsNoteToSource：笔记真实链接与来源构造（xiaohongshu.com 域名）
 * - parseXhsMcpDetailText：get_feed_detail 正文解析
 * - xhsMcpCallTool / searchXhsMcp：JSON-RPC 流程（initialize → tools/call）、报错与超时降级
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  getFeedDetailText,
  isXhsAllowedLocalImagePath,
  parseXhsMcpDetailText,
  parseXhsMcpSearchText,
  parseXhsQrcodeContents,
  searchXhsMcp,
  XHS_MCP_WORK_DIR,
  xhsMcpCallTool,
  xhsMcpHealthy,
  xhsNoteToSource,
  xhsNoteUrl,
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

/** MCP 工具成功响应：result.content[0].text 为 JSON 字符串 */
const toolResult = (payload: unknown): Response =>
  json({
    jsonrpc: "2.0",
    id: 2,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  });

describe("xhsMcpHealthy 探活", () => {
  it("2xx 返回 true；非 2xx/异常返回 false", async () => {
    mockFetchQueue([() => new Response('{"status":"healthy"}')]);
    try {
      assert.equal(await xhsMcpHealthy({ baseUrl: BASE }), true);
    } finally {
      globalThis.fetch = realFetch;
    }
    mockFetchQueue([() => new Response("", { status: 503 })]);
    try {
      assert.equal(await xhsMcpHealthy({ baseUrl: BASE }), false);
    } finally {
      globalThis.fetch = realFetch;
    }
    mockFetchQueue([
      () => {
        throw new Error("ECONNREFUSED");
      },
    ]);
    try {
      assert.equal(await xhsMcpHealthy({ baseUrl: BASE }), false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("未配置基址时直接 false（不发请求）", async () => {
    mockFetchQueue([]);
    try {
      assert.equal(await xhsMcpHealthy({ baseUrl: "" }), false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("parseXhsMcpSearchText 搜索响应解析", () => {
  it("解析真实结构样本：id/xsecToken/displayTitle/点赞数，非法条目跳过", () => {
    // 与 tools/xhs-mcp/search-result.json 实测结构对齐
    const text = JSON.stringify({
      feeds: [
        {
          xsecToken: "ABtoken1=",
          id: "6a366131000000001702d0fa",
          modelType: "note",
          noteCard: {
            type: "normal",
            displayTitle: "冲煮日记022｜埃塞花魁",
            interactInfo: { likedCount: "7", collectedCount: "2" },
          },
          index: 0,
        },
        {
          xsecToken: "ABtoken2=",
          id: "67ff6dce000000001c01583f",
          noteCard: {
            displayTitle: "手冲花魁天花板｜分段萃取公式",
            interactInfo: { likedCount: "40" },
          },
        },
        { xsecToken: "无标题跳过", id: "abc", noteCard: {} },
        null,
      ],
      count: 4,
    });
    const notes = parseXhsMcpSearchText(text);
    assert.equal(notes.length, 2);
    assert.equal(notes[0].id, "6a366131000000001702d0fa");
    assert.equal(notes[0].title, "冲煮日记022｜埃塞花魁");
    assert.equal(notes[0].xsecToken, "ABtoken1=");
    assert.equal(notes[0].likedCount, 7);
    assert.equal(notes[1].likedCount, 40);
    assert.equal(notes[0].desc, ""); // search_feeds 当前版本不带正文摘要
  });

  it("非法 JSON / 缺 feeds / 空输入返回空数组（不抛错）", () => {
    assert.deepEqual(parseXhsMcpSearchText("not-json"), []);
    assert.deepEqual(parseXhsMcpSearchText("{}"), []);
    assert.deepEqual(parseXhsMcpSearchText(JSON.stringify({ feeds: "nope" })), []);
    assert.deepEqual(parseXhsMcpSearchText(""), []);
  });
});

describe("xhsNoteUrl / xhsNoteToSource 来源构造", () => {
  it("笔记链接为 xiaohongshu.com 域名且携带 xsec_token（详情页必需参数）", () => {
    const url = xhsNoteUrl({ id: "abc123", xsecToken: "tok==" });
    const u = new URL(url);
    assert.equal(u.hostname, "www.xiaohongshu.com");
    assert.ok(u.pathname.includes("/explore/abc123"));
    assert.equal(u.searchParams.get("xsec_token"), "tok==");
  });

  it("来源构造：标题截断 120 字，有 desc 才带 snippet", () => {
    const withDesc = xhsNoteToSource({
      id: "a",
      xsecToken: "t",
      title: "花魁冲煮参数".repeat(30),
      desc: "粉水比 1:15",
      likedCount: 1,
    });
    assert.equal(withDesc.title.length, 120);
    assert.equal(withDesc.snippet, "粉水比 1:15");
    const noDesc = xhsNoteToSource({
      id: "b",
      xsecToken: "t",
      title: "标题",
      desc: "",
      likedCount: 0,
    });
    assert.equal(noDesc.snippet, undefined);
  });
});

describe("parseXhsMcpDetailText 正文解析", () => {
  it("顶层 desc 与 noteCard 嵌套两种形态都取得到正文", () => {
    assert.equal(
      parseXhsMcpDetailText(JSON.stringify({ desc: "正文 A", title: "标题 A" })).desc,
      "正文 A",
    );
    assert.equal(
      parseXhsMcpDetailText(JSON.stringify({ noteCard: { desc: "正文 B", title: "标题 B" } })).desc,
      "正文 B",
    );
  });

  it("实测响应结构 { feed_id, data: { note: { title, desc } } } 优先命中 data.note", () => {
    const detail = parseXhsMcpDetailText(
      JSON.stringify({
        feed_id: "67ff059f000000001d005ad9",
        data: {
          note: { title: "花魁冲煮指南", desc: "粉水比 1:15，92 度，三段式注水。", type: "normal" },
        },
        // 干扰字段：顶层 desc 不应覆盖 data.note.desc
        desc: "干扰",
      }),
    );
    assert.equal(detail.title, "花魁冲煮指南");
    assert.equal(detail.desc, "粉水比 1:15，92 度，三段式注水。");
  });

  it("非法输入返回空字段（不抛错）", () => {
    assert.deepEqual(parseXhsMcpDetailText("not-json"), { title: "", desc: "" });
    assert.deepEqual(parseXhsMcpDetailText("{}"), { title: "", desc: "" });
  });
});

describe("xhsMcpCallTool / searchXhsMcp JSON-RPC 流程", () => {
  it("initialize → tools/call 两轮请求，工具名与参数正确下发", async () => {
    const { calls } = mockFetchQueue([
      () => json({ result: {} }),
      () => toolResult({ feeds: [], count: 0 }),
    ]);
    try {
      await searchXhsMcp("花魁 冲煮参数", { baseUrl: BASE });
      assert.equal(calls.length, 2);
      assert.ok(calls.every((c) => c.url === `${BASE}/mcp`));
      const initBody = calls[0].body as { method: string };
      assert.equal(initBody.method, "initialize");
      const callBody = calls[1].body as {
        method: string;
        params: { name: string; arguments: unknown };
      };
      assert.equal(callBody.method, "tools/call");
      assert.equal(callBody.params.name, "search_feeds");
      assert.deepEqual(callBody.params.arguments, { keyword: "花魁 冲煮参数" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("search_feeds 命中时返回解析后的笔记列表", async () => {
    mockFetchQueue([
      () => json({ result: {} }),
      () =>
        toolResult({
          feeds: [
            {
              id: "n1",
              xsecToken: "t1",
              noteCard: { displayTitle: "花魁手冲", interactInfo: { likedCount: "5" } },
            },
          ],
        }),
    ]);
    try {
      const notes = await searchXhsMcp("花魁", { baseUrl: BASE });
      assert.equal(notes.length, 1);
      assert.equal(notes[0].title, "花魁手冲");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("JSON-RPC error / 缺 content / 非 2xx 都抛错（调用方降级处理）", async () => {
    // JSON-RPC error
    mockFetchQueue([
      () => json({ result: {} }),
      () => json({ jsonrpc: "2.0", id: 2, error: { message: "未登录" } }),
    ]);
    try {
      await assert.rejects(
        () => xhsMcpCallTool("search_feeds", { keyword: "x" }, { baseUrl: BASE }),
        /未登录/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // 缺 content
    mockFetchQueue([() => json({ result: {} }), () => json({ jsonrpc: "2.0", id: 2, result: {} })]);
    try {
      await assert.rejects(
        () => xhsMcpCallTool("search_feeds", { keyword: "x" }, { baseUrl: BASE }),
        /content/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // initialize 非 2xx
    mockFetchQueue([() => new Response("", { status: 500 })]);
    try {
      await assert.rejects(
        () => xhsMcpCallTool("search_feeds", { keyword: "x" }, { baseUrl: BASE }),
        /HTTP 500/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("超时降级：工具调用超过时间盒即中止（不等到对端 60s 挂死）", async () => {
    mockFetchQueue([
      () => json({ result: {} }),
      (_url, init) =>
        // 模拟 search_feeds 首次调用的挂死：对端迟迟不返回，
        // 由 AbortSignal 先中止 fetch（与真实 fetch 的中止行为一致）
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(toolResult({ feeds: [] })), 500);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(init.signal?.reason ?? new Error("aborted"));
          });
        }),
    ]);
    try {
      const started = Date.now();
      await assert.rejects(() =>
        xhsMcpCallTool("search_feeds", { keyword: "x" }, { baseUrl: BASE, toolTimeoutMs: 60 }),
      );
      assert.ok(Date.now() - started < 450, "超时应在 60ms 量级触发，而非等满挂死时长");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("getFeedDetailText 正文深取", () => {
  it("拼接标题与正文并截断；正文为空时抛错（调用方保留标题级来源）", async () => {
    mockFetchQueue([
      () => json({ result: {} }),
      () => toolResult({ desc: "粉水比 1:15，92 度水温。", title: "花魁冲煮" }),
    ]);
    try {
      const body = await getFeedDetailText("n1", "t1", { baseUrl: BASE });
      assert.ok(body.startsWith("花魁冲煮"));
      assert.ok(body.includes("粉水比 1:15"));
    } finally {
      globalThis.fetch = realFetch;
    }
    mockFetchQueue([() => json({ result: {} }), () => toolResult({ desc: "", title: "" })]);
    try {
      await assert.rejects(() => getFeedDetailText("n1", "t1", { baseUrl: BASE }), /正文为空/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("isXhsAllowedLocalImagePath 二维码本地路径白名单（任务 #99）", () => {
  it("仅放行系统临时目录与 tools/xhs-mcp 工作目录前缀下的路径", () => {
    assert.equal(isXhsAllowedLocalImagePath(path.join(os.tmpdir(), "xhs-qr.png")), true);
    assert.equal(isXhsAllowedLocalImagePath(path.join(XHS_MCP_WORK_DIR, "qr.png")), true);
  });

  it("拒绝白名单外路径：用户目录/系统目录/.. 目录穿越", () => {
    assert.equal(isXhsAllowedLocalImagePath(path.join(os.homedir(), "secret.png")), false);
    assert.equal(isXhsAllowedLocalImagePath(path.resolve("/etc/passwd")), false);
    // 临时目录的兄弟目录（.. 穿越后已不在 tmpdir 下）
    assert.equal(isXhsAllowedLocalImagePath(path.join(os.tmpdir(), "..", "steal.png")), false);
    assert.equal(isXhsAllowedLocalImagePath(""), false);
  });
});

describe("parseXhsQrcodeContents 本地路径分支（任务 #99：防任意文件读取）", () => {
  const qrText = "请用小红书 App 在 2099-01-01 00:00:00 前扫码登录";
  const now = new Date("2098-01-01T00:00:00").getTime();

  it("白名单外路径即使存在也不读取，走既有 fallback（无 qrcode，仅 hint）", () => {
    // server/package.json 必然存在且不在白名单内：旧代码会直接 readFileSync
    const outside = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );
    assert.ok(fs.existsSync(outside), "前置条件：白名单外文件应真实存在才能证明被拒读");
    const r = parseXhsQrcodeContents(
      [
        { type: "text", text: qrText },
        { type: "image", mimeType: "image/png", data: outside },
      ],
      now,
    );
    assert.equal(r.qrcode, undefined);
    assert.equal(r.alreadyLoggedIn, false);
    assert.equal(r.hint, qrText);
  });

  it("临时目录内的真实图片仍可读成 base64 内联（不误伤正常路径）", () => {
    const tmp = path.join(os.tmpdir(), "xhs-t99-qr-" + Date.now() + ".png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(tmp, bytes);
    try {
      const r = parseXhsQrcodeContents(
        [
          { type: "text", text: qrText },
          { type: "image", mimeType: "image/png", data: tmp },
        ],
        now,
      );
      assert.ok(r.qrcode?.startsWith("data:image/png;base64,"));
      assert.deepEqual(Buffer.from(r.qrcode!.split(",")[1], "base64"), bytes);
      assert.ok(r.expiresAt && r.expiresAt > now);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("临时目录内的普通文本即使伪装成 png 也不读取", () => {
    const tmp = path.join(os.tmpdir(), "xhs-t99-fake-" + Date.now() + ".png");
    fs.writeFileSync(tmp, JSON.stringify({ secret: "not-an-image" }));
    try {
      const result = parseXhsQrcodeContents([
        { type: "text", text: qrText },
        { type: "image", mimeType: "image/png", data: tmp },
      ]);
      assert.equal(result.qrcode, undefined);
      assert.equal(result.hint, qrText);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
