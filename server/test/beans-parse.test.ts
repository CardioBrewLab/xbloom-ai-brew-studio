/**
 * 豆信息粘贴 AI 智能解析归类路由测试（任务 #118）：
 * - 成功提取：mock LLM 返回结构化 JSON → 200 { ok:true, parsed }，请求体 stream:false
 * - 未知字段 null：LLM 按契约对未提及字段填 null → 响应原样透传 null
 * - LLM 失败三态：HTTP 500 / 输出非法 JSON / 输出非对象 → 均 200 { ok:false, error }，绝不 5xx
 * - 请求校验：text 缺失 / 超 2000 字 → 400 且从不发起 LLM 请求
 * - 烘焙度归一：LLM 返回 "light roast" 等别名时后端归一到五档之一
 * mock 方式沿用既有测试（generate-candidates.test.ts）：真实 HTTP mock LLM + config.llm.baseUrl 指向。
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { beansRouter, normalizeRoastLevel, sanitizeParsedBean } from "../src/routes/beans.js";
import { config } from "../src/config.js";
import { shutdownHttpServer } from "./helpers/http-server.js";

// ---------------------------------------------------------------------------
// mock LLM：按序消费响应队列；stream:false 回一次性 JSON
// ---------------------------------------------------------------------------

interface QueuedResponse {
  status?: number;
  content?: string;
}

function startMockLlm(queue: QueuedResponse[]) {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const item = queue.shift() ?? { status: 500 };
      if ((item.status ?? 200) >= 400) {
        res.writeHead(item.status!, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mock LLM exploded" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: item.content ?? "" } }] }));
    });
  });
  return { server, requests };
}

let appPort = 0;
let appServer: http.Server;
let mock: { server: http.Server; requests: Array<Record<string, unknown>> } | null = null;

const saved = { baseUrl: "", fallbackModel: "", thirdModel: "" };

before(async () => {
  saved.baseUrl = config.llm.baseUrl;
  saved.fallbackModel = config.llm.fallbackModel;
  saved.thirdModel = config.llm.thirdModel;

  const app = express();
  app.use(express.json());
  app.use(beansRouter);
  appServer = app.listen(0, "127.0.0.1");
  await once(appServer, "listening");
  appPort = (appServer.address() as AddressInfo).port;
});

after(async () => {
  config.llm.baseUrl = saved.baseUrl;
  config.llm.fallbackModel = saved.fallbackModel;
  config.llm.thirdModel = saved.thirdModel;
  await Promise.all([shutdownHttpServer(appServer), shutdownHttpServer(mock?.server)]);
});

/** 启动一个新 mock LLM 并把 config 指向它（单跳模型链，避免兜底干扰） */
async function useMockLlm(queue: QueuedResponse[]): Promise<Array<Record<string, unknown>>> {
  await shutdownHttpServer(mock?.server);
  mock = startMockLlm(queue);
  mock.server.listen(0, "127.0.0.1");
  await once(mock.server, "listening");
  const port = (mock.server.address() as AddressInfo).port;
  config.llm.baseUrl = `http://127.0.0.1:${port}/v1`;
  config.llm.apiKey = "test-key";
  config.llm.model = "gpt-test"; // gpt 系：不下发 temperature（采样层治理口径）
  config.llm.fallbackModel = "";
  config.llm.thirdModel = "";
  return mock.requests;
}

async function postParse(
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${appPort}/api/beans/parse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const FULL_PARSED = {
  name: "耶加雪菲 G1 科契尔",
  roaster: "某烘焙工坊",
  origin: "埃塞俄比亚 · 耶加雪菲",
  estate: null,
  process: "水洗",
  varietal: "原生种",
  roastLevel: "浅焙",
  tastingNotes: ["茉莉花", "柑橘", "红茶尾韵"],
  altitude: "1900-2100m",
  notes: null,
};

describe("POST /api/beans/parse（任务 #118）", () => {
  it("成功提取：结构化 JSON 全字段回填，请求体为非流式（stream:false）", async () => {
    const requests = await useMockLlm([{ content: JSON.stringify(FULL_PARSED) }]);
    const { status, json } = await postParse({ text: "朋友发的一段乱七八糟的豆信息…" });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.deepEqual(json.parsed, { ...FULL_PARSED, estate: null, notes: null });
    assert.equal(requests.length, 1, "恰好一次 LLM 请求");
    assert.equal(requests[0].stream, false, "非流式 chatCompletion");
    assert.equal(requests[0].model, "gpt-test");
    const messages = requests[0].messages as Array<{ role: string; content: string }>;
    assert.equal(messages[0].role, "system");
    assert.ok(messages[0].content.includes("严禁编造"), "system prompt 声明严禁编造");
    assert.ok(
      messages[1].content.includes("朋友发的一段乱七八糟的豆信息"),
      "用户文本注入 user 消息",
    );
  });

  it("未知字段 null：LLM 按契约填 null 的字段原样透传，tastingNotes 空数组保留", async () => {
    await useMockLlm([
      {
        content: JSON.stringify({
          name: "曼特宁",
          roaster: null,
          origin: "印尼苏门答腊",
          estate: null,
          process: null,
          varietal: null,
          roastLevel: null,
          tastingNotes: [],
          altitude: null,
          notes: null,
        }),
      },
    ]);
    const { status, json } = await postParse({ text: "曼特宁，苏门答腊的" });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    const parsed = json.parsed as Record<string, unknown>;
    assert.equal(parsed.roaster, null);
    assert.equal(parsed.process, null);
    assert.equal(parsed.roastLevel, null);
    assert.deepEqual(parsed.tastingNotes, []);
  });

  it("烘焙度归一：LLM 返回英文别名 light roast 时归一到「浅焙」", async () => {
    await useMockLlm([{ content: JSON.stringify({ ...FULL_PARSED, roastLevel: "Light Roast" }) }]);
    const { json } = await postParse({ text: "any" });
    assert.equal(json.ok, true);
    assert.equal((json.parsed as Record<string, unknown>).roastLevel, "浅焙");
  });

  it("LLM HTTP 500：200 + { ok:false, error } 结构化错误，绝不 5xx", async () => {
    await useMockLlm([{ status: 500 }]);
    const { status, json } = await postParse({ text: "任意文本" });
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.ok(typeof json.error === "string" && (json.error as string).length > 0);
  });

  it("LLM 输出非法 JSON：200 + { ok:false }（解析失败态）", async () => {
    await useMockLlm([{ content: "抱歉，我无法输出 JSON {{{" }]);
    const { status, json } = await postParse({ text: "任意文本" });
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.ok((json.error as string).includes("无法解析"));
  });

  it("LLM 输出非对象 JSON（数组）：200 + { ok:false }", async () => {
    await useMockLlm([{ content: "[1,2,3]" }]);
    const { status, json } = await postParse({ text: "任意文本" });
    assert.equal(status, 200);
    assert.equal(json.ok, false);
  });

  it("请求校验：text 缺失 / 空串 / 超 2000 字 → 400，且从不发起 LLM 请求", async () => {
    const requests = await useMockLlm([]);
    for (const body of [{}, { text: "" }, { text: "豆".repeat(2001) }]) {
      const { status, json } = await postParse(body);
      assert.equal(status, 400);
      assert.equal(json.ok, false);
    }
    assert.equal(requests.length, 0, "校验失败不触达 LLM");
  });
});

describe("烘焙度归一与输出清洗纯函数（任务 #118）", () => {
  it("normalizeRoastLevel：五档原值直通，别名归一，未知返回 null", () => {
    assert.equal(normalizeRoastLevel("中焙"), "中焙");
    assert.equal(normalizeRoastLevel("light"), "浅焙");
    assert.equal(normalizeRoastLevel("中烘"), "中焙");
    assert.equal(normalizeRoastLevel("中深烘"), "中深焙");
    assert.equal(normalizeRoastLevel("深烘"), "深焙");
    assert.equal(normalizeRoastLevel("法式深焙"), "深焙");
    assert.equal(normalizeRoastLevel("半水洗"), null, "无法识别不得编造");
    assert.equal(normalizeRoastLevel(null), null);
    assert.equal(normalizeRoastLevel("  "), null);
  });

  it("sanitizeParsedBean：空白归 null、tastingNotes 去空去重、结构非法返回 null", () => {
    const out = sanitizeParsedBean({
      name: "  花魁  ",
      roaster: "   ",
      origin: null,
      estate: null,
      process: "日晒",
      varietal: null,
      roastLevel: "中浅",
      tastingNotes: ["草莓", "  ", "草莓", "蓝莓"],
      altitude: null,
      notes: null,
    });
    assert.ok(out);
    assert.equal(out!.name, "花魁");
    assert.equal(out!.roaster, null);
    assert.equal(out!.roastLevel, "中浅焙");
    assert.deepEqual(out!.tastingNotes, ["草莓", "蓝莓"]);
    assert.equal(sanitizeParsedBean({ name: 123 }), null, "schema 不符返回 null");
    assert.equal(sanitizeParsedBean("not-an-object"), null);
  });
});
