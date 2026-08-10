/**
 * 小红书 Cookie 导入兜底登录测试（任务 #97，node:test + assert，网络全部 mock）：
 * - parseBrowserCookieString：浏览器 Cookie 串解析（值含 "=" / 空白 / 重名 / 垃圾段）
 * - buildXhsCdpCookies：CDP 格式落盘字段（域/过期/size/secure）
 * - readXhsSessionSeed：既有会话文件 seed 保留（缺失/损坏回 0）
 * - importXhsBrowserCookies：落盘往返 + 校验错误（空串 / 缺 web_session）
 * - POST /api/xhs/login/cookie-import 路由：离线 / 校验失败 / 验证未通过 / 成功四态
 *   （挂载临时 Express 实例，MCP 侧 fetch 走队列 mock；XHS_COOKIES_PATH 指向临时文件）
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import {
  buildXhsCdpCookies,
  buildXhsSessionFile,
  importXhsBrowserCookies,
  parseBrowserCookieString,
  readXhsSessionSeed,
  xhsCookiesFilePath,
  XHS_COOKIE_IMPORT_TTL_DAYS,
} from "../src/lib/xhs-cookie-import.js";

const BASE = "http://127.0.0.1:18060";
const realFetch = globalThis.fetch;

/** 按序消费的 fetch 队列 mock（与 xhs-login.test.ts 同构） */
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

const toolContents = (content: unknown[], isError = false): Response =>
  json({ jsonrpc: "2.0", id: 2, result: { content, isError } });

function tmpCookiesFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xhs-cookie-import-")), "cookies.json");
}

it("默认 Cookie 导入路径与 MCP 私有 runtime 路径一致", () => {
  const previous = process.env.XHS_COOKIES_PATH;
  delete process.env.XHS_COOKIES_PATH;
  try {
    assert.equal(
      xhsCookiesFilePath().endsWith(path.join("tools", "xhs-mcp", "runtime", "cookies.json")),
      true,
    );
  } finally {
    if (previous === undefined) delete process.env.XHS_COOKIES_PATH;
    else process.env.XHS_COOKIES_PATH = previous;
  }
});

describe("parseBrowserCookieString 浏览器 Cookie 串解析", () => {
  it("常规三段式：名值对按序提取", () => {
    const pairs = parseBrowserCookieString("a1=AAA; web_session=BBB; webId=CCC");
    assert.deepEqual(pairs, [
      { name: "a1", value: "AAA" },
      { name: "web_session", value: "BBB" },
      { name: "webId", value: "CCC" },
    ]);
  });

  it("值内含 '=' 不截断（如 unread={%22uc%22:22} / base64 尾缀）", () => {
    const pairs = parseBrowserCookieString("unread={%22uc%22:22}; id_token=abc==;x=1");
    assert.deepEqual(pairs.find((p) => p.name === "unread")?.value, "{%22uc%22:22}");
    assert.deepEqual(pairs.find((p) => p.name === "id_token")?.value, "abc==");
    assert.deepEqual(pairs.find((p) => p.name === "x")?.value, "1");
  });

  it("空白/无值/无名字段跳过；重名保留最后一个", () => {
    const pairs = parseBrowserCookieString("  a1=one ;;  =v; broken; a1=two  ");
    assert.deepEqual(pairs, [{ name: "a1", value: "two" }]);
  });

  it("空串/纯垃圾返回空数组（由调用方报错）", () => {
    assert.deepEqual(parseBrowserCookieString(""), []);
    assert.deepEqual(parseBrowserCookieString(";;;;  "), []);
  });
});

describe("buildXhsCdpCookies CDP 格式转换", () => {
  const NOW = new Date("2026-08-07T22:00:00Z").getTime();

  it("域统一 .xiaohongshu.com，expires = now + 30 天，size = 名长+值长", () => {
    const [c] = buildXhsCdpCookies([{ name: "web_session", value: "040069b2" }], NOW);
    assert.equal(c.domain, ".xiaohongshu.com");
    assert.equal(c.path, "/");
    assert.equal(c.expires, NOW / 1000 + XHS_COOKIE_IMPORT_TTL_DAYS * 24 * 3600);
    assert.equal(c.size, "web_session".length + "040069b2".length);
    assert.equal(c.secure, true);
    assert.equal(c.session, false);
    assert.equal(c.sourcePort, 443);
  });
});

describe("readXhsSessionSeed / buildXhsSessionFile 会话文件往返", () => {
  it("既有 v2 文件的 seed 读得回；缺失/损坏回 0（同 cookies.go LoadSeed 语义）", () => {
    const file = tmpCookiesFile();
    fs.writeFileSync(file, JSON.stringify({ version: 2, seed: 2080511411, cookies: [] }));
    assert.equal(readXhsSessionSeed(file), 2080511411);
    fs.writeFileSync(file, "not-json");
    assert.equal(readXhsSessionSeed(file), 0);
    assert.equal(readXhsSessionSeed(path.join(os.tmpdir(), "no-such-dir-xhs", "cookies.json")), 0);
  });

  it("v2 结构组装：version=2 + saved_at + cookies 原样", () => {
    const cookies = buildXhsCdpCookies([{ name: "a1", value: "v" }], 1000);
    const f = buildXhsSessionFile(cookies, 7, "2026-08-07T22:00:00.000Z");
    assert.equal(f.version, 2);
    assert.equal(f.seed, 7);
    assert.equal(f.saved_at, "2026-08-07T22:00:00.000Z");
    assert.equal(f.cookies.length, 1);
    assert.equal(f.cookies[0].name, "a1");
  });
});

describe("importXhsBrowserCookies 导入执行", () => {
  const NOW = new Date("2026-08-07T22:00:00Z").getTime();

  it("落盘为 MCP 可读的 v2 格式，且保留既有 seed", () => {
    const file = tmpCookiesFile();
    fs.writeFileSync(file, JSON.stringify({ version: 2, seed: 424242, cookies: [] }));
    const r = importXhsBrowserCookies("a1=AAA; web_session=BBB", { cookiesPath: file, nowMs: NOW });
    assert.equal(r.count, 2);
    assert.equal(r.hasWebSession, true);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as {
      version: number;
      seed: number;
      cookies: { name: string; value: string; domain: string }[];
    };
    assert.equal(onDisk.version, 2);
    assert.equal(onDisk.seed, 424242);
    const names = onDisk.cookies.map((c) => c.name);
    assert.deepEqual(names.sort(), ["a1", "web_session"]);
    assert.ok(onDisk.cookies.every((c) => c.domain === ".xiaohongshu.com"));
  });

  it("空串与缺 web_session 抛中文指引错误（不落盘）", () => {
    const file = tmpCookiesFile();
    assert.throws(() => importXhsBrowserCookies("", { cookiesPath: file }), /未解析到任何 Cookie/);
    assert.throws(() => importXhsBrowserCookies("a1=AAA", { cookiesPath: file }), /web_session/);
    assert.equal(fs.existsSync(file), false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/xhs/login/cookie-import 路由四态（临时 Express + MCP fetch mock）
// ---------------------------------------------------------------------------

describe("/api/xhs/login/cookie-import 路由", () => {
  let port = 0;
  let server: import("node:http").Server;
  let client: typeof fetch;
  let cookieFile = "";

  before(async () => {
    process.env.XHS_MCP_URL ??= BASE;
    cookieFile = tmpCookiesFile();
    process.env.XHS_COOKIES_PATH = cookieFile; // 路由经 xhsCookiesFilePath() 调用时读取
    const [{ default: express }, { default: xhsRouter }] = await Promise.all([
      import("express"),
      import("../src/routes/xhs.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use("/api/xhs", xhsRouter);
    client = realFetch;
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
  });

  after(() => {
    globalThis.fetch = realFetch;
    delete process.env.XHS_COOKIES_PATH;
    server?.close();
  });

  const post = (cookie: string) =>
    client(`http://127.0.0.1:${port}/api/xhs/login/cookie-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie }),
    });

  it("MCP 离线 → ok:false + online:false（不触文件）", async () => {
    mockFetchQueue([() => new Response("", { status: 503 })]);
    const body = (await (await post("a1=x; web_session=y")).json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.online, false);
    assert.ok(String(body.message).includes("未启动"));
    assert.equal(fs.existsSync(cookieFile), false);
  });

  it("缺 web_session → ok:false 且不发起 MCP 验证调用", async () => {
    const { calls } = mockFetchQueue([() => new Response('{"status":"healthy"}')]);
    const body = (await (await post("a1=only")).json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.online, true);
    assert.ok(String(body.message).includes("web_session"));
    assert.equal(calls.length, 1); // 仅探活，无工具调用
    assert.equal(fs.existsSync(cookieFile), false);
  });

  it("写入成功但 MCP 验证未登录 → ok:false + 提示重新复制", async () => {
    mockFetchQueue([
      () => new Response('{"status":"healthy"}'),
      () => json({ result: {} }), // initialize
      () => toolContents([{ type: "text", text: "❌ 未登录" }]),
    ]);
    const body = (await (await post("a1=x; web_session=stale")).json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.loggedIn, false);
    assert.ok(String(body.message).includes("验证未通过"));
    assert.ok(fs.existsSync(cookieFile)); // 文件已写入（便于排障保留）
  });

  it("导入成功：写入文件 + 验证已登录 → ok:true + 昵称", async () => {
    const { calls } = mockFetchQueue([
      () => new Response('{"status":"healthy"}'),
      () => json({ result: {} }),
      () => toolContents([{ type: "text", text: "✅ 已登录\n用户名: 咖啡小李" }]),
    ]);
    const body = (await (await post("a1=x; web_session=good")).json()) as Record<string, unknown>;
    assert.deepEqual(
      { ok: body.ok, online: body.online, loggedIn: body.loggedIn, nickname: body.nickname },
      { ok: true, online: true, loggedIn: true, nickname: "咖啡小李" },
    );
    const callBody = calls[2].body as { params: { name: string } };
    assert.equal(callBody.params.name, "check_login_status");
    const onDisk = JSON.parse(fs.readFileSync(cookieFile, "utf8")) as {
      cookies: { name: string }[];
    };
    assert.ok(onDisk.cookies.some((c) => c.name === "web_session"));
  });
});
