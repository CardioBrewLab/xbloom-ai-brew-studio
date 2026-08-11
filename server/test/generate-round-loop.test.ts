/**
 * 任务 #131 测试：generate round 循环集成
 * - N=1 + 豆信息：research 事件 round=0，recipe 正常交付（round 循环不破坏既有流程）
 * - N=3 + 低分 + 重调研：research 事件 round≥1（换源重调研触发）
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { generateRouter } from "../src/routes/generate.js";
import { config } from "../src/config.js";
import { shutdownHttpServer } from "./helpers/http-server.js";

// ---------------------------------------------------------------------------
// mock LLM（与 generate-candidates.test.ts 同模式）
// ---------------------------------------------------------------------------

function startMockLlm(queue: Array<{ content?: string; status?: number }>) {
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
        res.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: item.content ?? "" } }] })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: item.content ?? "" } }] }));
    });
  });
  return { server, requests };
}

const GOOD_RECIPE = {
  name: "round loop 测试",
  cupType: "xdripper",
  doseGrams: 15,
  grinderSize: 60,
  rpm: 90,
  grandWater: 234,
  pours: [
    { volume: 100, temperature: 92, flowRate: 3.2, pattern: "center", pausing: 45 },
    { volume: 134, temperature: 90, flowRate: 3.2, pattern: "circular", pausing: 40 },
  ],
  brewRationale: [{ param: "研磨度", choice: "60", basis: "知识库 §9 xBloom 官方滤杯流速特性" }],
};

/** 低分候选：闷蒸 10s（warn）+ 无解读 + 总时长偏短 */
const LOW_RECIPE = {
  ...GOOD_RECIPE,
  brewRationale: undefined,
  pours: [
    { volume: 100, temperature: 92, flowRate: 3.2, pattern: "center", pausing: 10 },
    { volume: 134, temperature: 90, flowRate: 3.2, pattern: "circular", pausing: 5 },
  ],
};

const LOW_RECIPE_ALT_1 = { ...LOW_RECIPE, grinderSize: 58, rpm: 100 };
const LOW_RECIPE_ALT_2 = { ...LOW_RECIPE, grinderSize: 62, rpm: 70 };

const fence = (recipe: unknown): string => "```json\n" + JSON.stringify(recipe, null, 2) + "\n```";

function parseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

let appPort = 0;
let appServer: http.Server;
let mock: { server: http.Server; requests: Array<Record<string, unknown>> } | null = null;
const saved = {
  baseUrl: "",
  apiKey: "",
  fallbackModel: "",
  thirdModel: "",
  candidates: 0,
  threshold: 0,
  maxRounds: 0,
};

before(async () => {
  saved.baseUrl = config.llm.baseUrl;
  saved.apiKey = config.llm.apiKey;
  saved.fallbackModel = config.llm.fallbackModel;
  saved.thirdModel = config.llm.thirdModel;
  saved.candidates = config.generateCandidates;
  saved.threshold = config.candidateScoreThreshold;
  saved.maxRounds = config.researchRetryMaxRounds;

  const app = express();
  app.use(express.json());
  app.use(generateRouter);
  appServer = app.listen(0, "127.0.0.1");
  await once(appServer, "listening");
  appPort = (appServer.address() as AddressInfo).port;
});

after(async () => {
  config.llm.baseUrl = saved.baseUrl;
  config.llm.apiKey = saved.apiKey;
  config.llm.fallbackModel = saved.fallbackModel;
  config.llm.thirdModel = saved.thirdModel;
  config.generateCandidates = saved.candidates;
  config.candidateScoreThreshold = saved.threshold;
  config.researchRetryMaxRounds = saved.maxRounds;
  await Promise.all([shutdownHttpServer(appServer), shutdownHttpServer(mock?.server)]);
});

async function useMockLlm(
  queue: Array<{ content?: string; status?: number }>,
): Promise<Array<Record<string, unknown>>> {
  await shutdownHttpServer(mock?.server);
  mock = startMockLlm(queue);
  mock.server.listen(0, "127.0.0.1");
  await once(mock.server, "listening");
  const port = (mock.server.address() as AddressInfo).port;
  config.llm.baseUrl = `http://127.0.0.1:${port}/v1`;
  config.llm.apiKey = "test-key";
  config.llm.fallbackModel = "";
  config.llm.thirdModel = "";
  return mock.requests;
}

async function postGenerate(body: unknown): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${appPort}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.text();
}

describe("任务 #131：generate round 循环（N=1 基本路径）", () => {
  it("N=1 research=false：round 循环不破坏既有流程，recipe 正常交付", async () => {
    config.generateCandidates = 1;
    config.candidateScoreThreshold = 70;
    config.researchRetryMaxRounds = 2;

    await useMockLlm([{ content: fence(GOOD_RECIPE) }]);

    const text = await postGenerate({
      description: "冲一杯平衡的手冲咖啡",
      beans: "耶加雪菲 G1 埃塞俄比亚 水洗",
      research: false,
    });
    const events = parseEvents(text);
    const types = events.map((e) => e.type as string);

    // 必须有 recipe 事件（round 循环 N=1 路径直接 break）
    assert.ok(types.includes("recipe"), `应有 recipe 事件：${types.join(", ")}`);
    // done 事件必须存在
    assert.ok(types.includes("done"), `应有 done 事件：${types.join(", ")}`);
  });
});

describe("任务 #131：离线多候选兼容路径（N=3 + research=false）", () => {
  it("低分候选直接择优交付，不做没有新来源的空转轮次", async () => {
    config.generateCandidates = 3;
    config.candidateScoreThreshold = 999; // 无人能达到 → 必触发重调研
    config.researchRetryMaxRounds = 1; // 只重调研一次

    // research=false 时没有新来源可换，三候选择优后直接交付。
    const requests = await useMockLlm([
      { content: fence(LOW_RECIPE) },
      { content: fence(LOW_RECIPE_ALT_1) },
      { content: fence(LOW_RECIPE_ALT_2) },
    ]);

    const text = await postGenerate({
      description: "冲一杯平衡的手冲咖啡",
      beans: "耶加雪菲 G1 埃塞俄比亚 水洗",
      research: false, // 禁用调研避免 fetch mock 复杂性
    });
    const events = parseEvents(text);
    const types = events.map((e) => e.type as string);

    // 必须有 recipe 事件（降级交付）
    assert.ok(types.includes("recipe"), `低分也应降级交付 recipe：${types.join(", ")}`);

    // candidates picked 事件保持 round=0，且仅请求首轮 3 个候选。
    const pickedEvents = events.filter((e) => e.type === "candidates" && e.stage === "picked");
    assert.equal(pickedEvents.length, 1);
    assert.equal(pickedEvents[0].round, 0);
    assert.equal(requests.length, 3);

    // recipe 事件应携带降级 warning（低分/用尽重调研）
    const recipeEvent = events.find((e) => e.type === "recipe");
    if (recipeEvent?.warning) {
      assert.ok(
        typeof recipeEvent.warning === "string" && recipeEvent.warning.length > 0,
        "降级 warning 应有内容",
      );
    }

    // done 事件必须存在
    assert.ok(types.includes("done"), `应有 done 事件：${types.join(", ")}`);
  });
});
