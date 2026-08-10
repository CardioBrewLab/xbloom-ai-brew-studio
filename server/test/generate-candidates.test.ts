/**
 * 多候选生成路由级测试（任务 #106）：express + mock LLM（真实 HTTP，非流式候选）。
 * - N=3 三候选返回不同质量配方 → picked 为最优且事件序列正确
 * - 网关 429 → 自动降 N（3→2）重试本次
 * - 反馈调参模式强制 N=1（不发 candidates 事件）
 * - config N=1 回滚开关：不发 candidates 事件、走流式路径
 * - 全体候选结构失败 → 首候选带错误重试一次 → 仍失败走现有错误路径
 * - 采样层：gpt 模型不下发 temperature、下发 seed（best-effort）
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { generateRouter } from "../src/routes/generate.js";
import { config } from "../src/config.js";

// ---------------------------------------------------------------------------
// mock LLM：按请求到达顺序消费响应队列；stream:true 回 SSE，否则回一次性 JSON
// ---------------------------------------------------------------------------

interface QueuedResponse {
  /** HTTP 状态码（≥400 时返回错误体，模拟 429 限流） */
  status?: number;
  /** 模型正文内容（配方 JSON 代码块或坏文本） */
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

// ---------------------------------------------------------------------------
// 候选配方夹具（以 ```json 代码块包裹，与 LLM 真实输出同形）
// ---------------------------------------------------------------------------

/** 优质候选：合法可达、闷蒸 45s、总时长 158s（甜区）、解读引用知识库 §9 → 满分 */
const GOOD_RECIPE = {
  name: "多候选测试",
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

/** 中等候选：闷蒸 10s（warn）+ 总时长 88s 偏短（扣分）+ 无解读 */
const MID_RECIPE = {
  ...GOOD_RECIPE,
  brewRationale: undefined,
  pours: [
    { volume: 100, temperature: 92, flowRate: 3.2, pattern: "center", pausing: 10 },
    { volume: 134, temperature: 90, flowRate: 3.2, pattern: "circular", pausing: 5 },
  ],
};

/** 劣质候选：250ml 总水对 15g 粉 ratio 0.1 步进不可达 → 一票否决 */
const BAD_RECIPE = {
  ...GOOD_RECIPE,
  grandWater: 250,
  pours: [
    { volume: 110, temperature: 92, flowRate: 3.2, pattern: "center", pausing: 45 },
    { volume: 140, temperature: 90, flowRate: 3.2, pattern: "circular", pausing: 40 },
  ],
};

/** 双 warn 候选（任务 #113 postFix 测试）：闷蒸 10s + 非首段 vibAfter → 触发 auto-fix，
 * 但无一票否决项（总分/可达性/段和均合法） */
const WARN_RECIPE = {
  ...GOOD_RECIPE,
  pours: [
    { volume: 100, temperature: 92, flowRate: 3.2, pattern: "center", pausing: 10 },
    {
      volume: 134,
      temperature: 90,
      flowRate: 3.2,
      pattern: "circular",
      pausing: 40,
      vibAfter: true,
    },
  ],
};

const fence = (recipe: unknown): string => "```json\n" + JSON.stringify(recipe, null, 2) + "\n```";

/** SSE 文本 → 事件对象列表 */
function parseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// 测试主体
// ---------------------------------------------------------------------------

let appPort = 0;
let appServer: http.Server;
let mock: { server: http.Server; requests: Array<Record<string, unknown>> } | null = null;

/** 保存/恢复 config，避免测试间串扰 */
const saved = {
  baseUrl: "",
  fallbackModel: "",
  thirdModel: "",
  candidates: 0,
};

before(async () => {
  saved.baseUrl = config.llm.baseUrl;
  saved.fallbackModel = config.llm.fallbackModel;
  saved.thirdModel = config.llm.thirdModel;
  saved.candidates = config.generateCandidates;

  const app = express();
  app.use(express.json());
  app.use(generateRouter);
  appServer = app.listen(0, "127.0.0.1");
  await once(appServer, "listening");
  appPort = (appServer.address() as AddressInfo).port;
});

/** 关闭 server 并强制断开 keep-alive 连接（否则 close() 挂住事件循环，node:test 子进程不退出） */
function shutdown(server: http.Server | undefined | null) {
  if (!server) return;
  server.close();
  server.closeAllConnections?.();
}

after(async () => {
  config.llm.baseUrl = saved.baseUrl;
  config.llm.fallbackModel = saved.fallbackModel;
  config.llm.thirdModel = saved.thirdModel;
  config.generateCandidates = saved.candidates;
  shutdown(appServer);
  shutdown(mock?.server);
});

/** 启动一个新 mock LLM 并把 config 指向它（单跳模型链，避免兜底干扰） */
async function useMockLlm(queue: QueuedResponse[]): Promise<Array<Record<string, unknown>>> {
  shutdown(mock?.server);
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

describe("多候选生成路由（任务 #106）", () => {
  it("N=3：三候选择优，事件序列 start/progress/picked/recipe 完整", async () => {
    config.generateCandidates = 3;
    const requests = await useMockLlm([
      { content: fence(MID_RECIPE) },
      { content: fence(GOOD_RECIPE) },
      { content: fence(BAD_RECIPE) },
    ]);

    const text = await postGenerate({ description: "冲一杯平衡的手冲咖啡" });
    const events = parseEvents(text);
    const types = events.map((e) => e.type as string);

    // 事件序列：start → 3×progress → picked → review → recipe → done
    assert.equal(types[0], "candidates");
    assert.deepEqual(events[0], { type: "candidates", stage: "start", n: 3, round: 0 });
    const progress = events.filter((e) => e.type === "candidates" && e.stage === "progress");
    assert.equal(progress.length, 3);
    assert.equal(progress[progress.length - 1].done, 3);
    assert.equal(progress[progress.length - 1].total, 3);

    const picked = events.find((e) => e.type === "candidates" && e.stage === "picked")!;
    assert.ok(picked, "picked 事件必须存在");
    const scores = picked.scores as Array<{ index: number; score: number; vetoed: boolean }>;
    assert.equal(scores.length, 3);
    const winnerIndex = picked.winner as number;
    const winnerScore = scores.find((s) => s.index === winnerIndex)!;
    // 获胜者必须是全场最高分，且唯一否决候选（250ml 不可达）被否决
    assert.equal(winnerScore.score, Math.max(...scores.map((s) => s.score)));
    assert.equal(winnerScore.vetoed, false);
    assert.ok(
      scores.some((s) => s.vetoed),
      "250ml 不可达候选应被一票否决",
    );

    // 候选请求均为非流式；gpt 模型不下发 temperature、下发 seed
    assert.equal(requests.length, 3);
    for (const r of requests) {
      assert.equal(r.stream, false);
      assert.equal(r.temperature, undefined, "gpt 系模型不下发 temperature");
      assert.equal(r.seed, 42, "seed 透传固定值 42（best-effort）");
    }

    // recipe 事件：获胜候选 = 唯一满分配方（grandWater 234），附 candidateScore
    const recipeEv = events.find((e) => e.type === "recipe")!;
    assert.ok(recipeEv, "recipe 事件必须存在");
    const recipe = recipeEv.recipe as { grandWater: number };
    assert.equal(recipe.grandWater, 234);
    const cs = recipeEv.candidateScore as {
      n: number;
      winner: number;
      score: number;
      postFix?: boolean;
    };
    assert.equal(cs.n, 3);
    assert.equal(cs.winner, winnerIndex);
    assert.equal(cs.score, winnerScore.score);
    assert.equal(cs.postFix, undefined, "无 auto-fix 改写时不带 postFix 标记（任务 #113）");
    assert.equal(types[types.length - 1], "done");
  });

  it("网关 429：全体候选限流 → 自动降 N（3→2）重试本次", async () => {
    config.generateCandidates = 3;
    const requests = await useMockLlm([
      { status: 429 },
      { status: 429 },
      { status: 429 },
      { content: fence(GOOD_RECIPE) },
      { content: fence(GOOD_RECIPE) },
    ]);

    const text = await postGenerate({ description: "冲一杯平衡的手冲咖啡" });
    const events = parseEvents(text);
    const starts = events.filter((e) => e.type === "candidates" && e.stage === "start");
    assert.deepEqual(
      starts.map((s) => s.n),
      [3, 2],
      "首轮 N=3 全 429 后降为 N=2 重发 start",
    );
    const picked = events.find((e) => e.type === "candidates" && e.stage === "picked");
    assert.ok(picked, "降级重试后必须产出 picked");
    const recipeEv = events.find((e) => e.type === "recipe")!;
    assert.equal((recipeEv.candidateScore as { n: number }).n, 2);
    assert.equal(requests.length, 5, "3 次 429 + 2 次成功 = 5 次请求");
  });

  it("反馈调参模式强制 N=1：不发 candidates 事件、只请求一次（流式）", async () => {
    config.generateCandidates = 3;
    const requests = await useMockLlm([{ content: fence(GOOD_RECIPE) }]);

    const text = await postGenerate({
      description: "偏酸，调参",
      baseRecipe: GOOD_RECIPE,
      feedback: { rating: 3, taste: ["偏酸"] },
    });
    const events = parseEvents(text);
    assert.ok(!events.some((e) => e.type === "candidates"), "反馈模式绝不下发 candidates 事件");
    assert.ok(
      events.some((e) => e.type === "recipe"),
      "配方照常交付",
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].stream, true, "N=1 走原流式路径");
  });

  it("config N=1 回滚开关：不发 candidates 事件、行为与单候选一致", async () => {
    config.generateCandidates = 1;
    const requests = await useMockLlm([{ content: fence(GOOD_RECIPE) }]);

    const text = await postGenerate({ description: "冲一杯平衡的手冲咖啡" });
    const events = parseEvents(text);
    assert.ok(!events.some((e) => e.type === "candidates"));
    assert.ok(events.some((e) => e.type === "recipe"));
    const recipeEv = events.find((e) => e.type === "recipe")!;
    assert.equal(recipeEv.candidateScore, undefined, "N=1 recipe 事件不带 candidateScore");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].stream, true);
  });

  it("全体候选结构失败：对首候选带错误重试一次，仍失败走现有错误路径", async () => {
    config.generateCandidates = 3;
    const requests = await useMockLlm([
      { content: "抱歉，我无法输出 JSON" },
      { content: "抱歉，我无法输出 JSON" },
      { content: "抱歉，我无法输出 JSON" },
      { content: "重试也没有 JSON" },
    ]);

    const text = await postGenerate({ description: "冲一杯平衡的手冲咖啡" });
    const events = parseEvents(text);
    const errEv = events.find((e) => e.type === "error")!;
    assert.ok(errEv, "全失败必须走错误路径");
    assert.ok(String(errEv.message).includes("配方生成失败（已重试）"));
    assert.ok(!events.some((e) => e.type === "recipe"));
    assert.ok(events.some((e) => e.type === "done"));
    assert.equal(requests.length, 4, "3 候选 + 1 次结构重试");
    // 结构重试的消息带上一轮错误说明
    const retryMessages = requests[3].messages as Array<{ role: string; content: string }>;
    assert.ok(
      retryMessages.some((m) => m.role === "assistant"),
      "重试消息包含上轮 assistant 输出",
    );
    assert.ok(
      retryMessages.some((m) => m.role === "user" && m.content.includes("无法使用")),
      "重试消息包含错误纠正指令",
    );
  });

  it("任务 #113：结构重试门不被降 N 轮吞噬（先限流降 N → 再全体结构失败仍重试一次）", async () => {
    config.generateCandidates = 3;
    const requests = await useMockLlm([
      { status: 429 },
      { status: 429 },
      { status: 429 }, // 首轮 N=3 全体限流 → 降为 N=2（旧实现下 attempt 已变 2）
      { content: "抱歉，我无法输出 JSON" },
      { content: "抱歉，我无法输出 JSON" }, // 第二轮全体结构失败 → 结构重试必须仍有一次机会
      { content: fence(GOOD_RECIPE) }, // 结构重试成功
    ]);

    const text = await postGenerate({ description: "冲一杯平衡的手冲咖啡" });
    const events = parseEvents(text);
    assert.ok(
      events.some((e) => e.type === "recipe"),
      "降 N 后的结构重试成功交付配方",
    );
    assert.ok(!events.some((e) => e.type === "error"), "不得走错误路径");
    assert.equal(requests.length, 6, "3×429 + 2 次结构失败 + 1 次结构重试");
  });

  it("任务 #113：N>1 在 auto-fix 后、recipe 前恰好补发一条 content 事件（获胜候选原始正文）", async () => {
    config.generateCandidates = 2;
    await useMockLlm([{ content: fence(MID_RECIPE) }, { content: fence(GOOD_RECIPE) }]);

    const text = await postGenerate({ description: "冲一杯平衡的手冲咖啡" });
    const events = parseEvents(text);
    const contents = events.filter((e) => e.type === "content");
    assert.equal(contents.length, 1, "恰好补发一条 content 事件");
    assert.equal(contents[0].content, fence(GOOD_RECIPE), "内容为获胜候选的原始非流式正文");
    assert.equal(contents[0].delta, undefined, "补发事件携带 content 字段而非 delta");
    // 事件序列：review fixed → content → recipe
    const idxContent = events.indexOf(contents[0]);
    const idxRecipe = events.findIndex((e) => e.type === "recipe");
    const idxReviewFixed = events.findIndex((e) => e.type === "review" && e.stage === "fixed");
    assert.ok(idxReviewFixed >= 0 && idxReviewFixed < idxContent, "补发在审查终结之后");
    assert.ok(idxContent < idxRecipe, "补发在 recipe 事件之前");
  });

  it("任务 #113：全体候选被否决时 recipe warning 通道附加优选兜底警告", async () => {
    config.generateCandidates = 2;
    await useMockLlm([{ content: fence(BAD_RECIPE) }, { content: fence(BAD_RECIPE) }]);

    const text = await postGenerate({ description: "冲一杯平衡的手冲咖啡" });
    const events = parseEvents(text);
    const picked = events.find((e) => e.type === "candidates" && e.stage === "picked")!;
    assert.ok(
      (picked.scores as Array<{ vetoed: boolean }>).every((s) => s.vetoed),
      "全体候选均被一票否决",
    );
    const recipeEv = events.find((e) => e.type === "recipe")!;
    assert.ok(recipeEv, "兜底仍须交付配方");
    assert.ok(String(recipeEv.warning).includes("优选兜底"), "warning 含优选兜底文案");
    assert.ok(String(recipeEv.warning).includes("请人工核对"), "warning 提示人工核对");
    assert.equal((recipeEv.candidateScore as { vetoed: boolean }).vetoed, true);
  });

  it("任务 #113：auto-fix 改写获胜配方后 candidateScore 附 postFix:true", async () => {
    config.generateCandidates = 2;
    const requests = await useMockLlm([
      { content: fence(WARN_RECIPE) },
      { content: fence(WARN_RECIPE) }, // 双 warn → needsAutoFix → 第三次请求为流式 auto-fix
      { content: fence(GOOD_RECIPE) }, // auto-fix 输出改写后的配方
    ]);

    const text = await postGenerate({ description: "冲一杯平衡的手冲咖啡" });
    const events = parseEvents(text);
    const fixedEv = events.find((e) => e.type === "review" && e.stage === "fixed")!;
    assert.equal(fixedEv.fixed, true, "auto-fix 确实改写了配方");
    const recipeEv = events.find((e) => e.type === "recipe")!;
    const cs = recipeEv.candidateScore as { postFix?: boolean };
    assert.equal(cs.postFix, true, "评分基于 auto-fix 前形态 → postFix 标记");
    assert.equal(requests.length, 3, "2 候选 + 1 次 auto-fix");
    assert.equal(requests[2].stream, true, "auto-fix 走流式调用");
  });

  it("任务 #120：progress 携带逐候选结果，picked.results 含失败原因/否决项/扣分项", async () => {
    config.generateCandidates = 3;
    await useMockLlm([
      { content: fence(GOOD_RECIPE) },
      { content: "抱歉，我无法输出 JSON" }, // 一个候选结构失败
      { content: fence(MID_RECIPE) },
    ]);

    const text = await postGenerate({ description: "冲一杯平衡的手冲咖啡" });
    const events = parseEvents(text);

    // progress：每条携带 result（index + status），失败者附 failReason
    const progress = events.filter((e) => e.type === "candidates" && e.stage === "progress");
    assert.equal(progress.length, 3);
    const results = progress.map(
      (p) => p.result as { index: number; status: string; failReason?: string },
    );
    assert.ok(
      results.every((r) => r && typeof r.index === "number"),
      "progress 必须携带逐候选 result",
    );
    const failedProgress = results.filter((r) => r.status === "failed");
    assert.equal(failedProgress.length, 1, "恰好一个候选结构失败");
    assert.ok(
      String(failedProgress[0].failReason).startsWith("结构失败："),
      "失败原因以「结构失败：」开头",
    );
    assert.equal(results.filter((r) => r.status === "ok").length, 2);

    // picked.results：全量 3 条，失败者带原因，成功者带 score/deductions
    const picked = events.find((e) => e.type === "candidates" && e.stage === "picked")!;
    const pickedResults = picked.results as Array<Record<string, unknown>>;
    assert.equal(pickedResults.length, 3, "results 覆盖本轮全部候选");
    const failedEntry = pickedResults.find((r) => r.status === "failed")!;
    assert.ok(String(failedEntry.failReason).includes("结构失败"));
    for (const r of pickedResults.filter((x) => x.status === "ok")) {
      assert.equal(typeof r.score, "number");
      assert.ok(Array.isArray(r.deductions), "成功候选携带扣分项列表");
      assert.ok(Array.isArray(r.vetoReasons), "成功候选携带否决项列表");
    }
    // 旧 scores 字段保持仅成功候选（向后兼容）
    assert.equal((picked.scores as unknown[]).length, 2);
  });

  it("任务 #120：picked.results 否决候选携带 vetoReasons", async () => {
    config.generateCandidates = 2;
    await useMockLlm([{ content: fence(GOOD_RECIPE) }, { content: fence(BAD_RECIPE) }]);

    const text = await postGenerate({ description: "冲一杯平衡的手冲咖啡" });
    const events = parseEvents(text);
    const picked = events.find((e) => e.type === "candidates" && e.stage === "picked")!;
    const pickedResults = picked.results as Array<Record<string, unknown>>;
    assert.equal(pickedResults.length, 2);
    const vetoed = pickedResults.find((r) => r.vetoed === true) as { vetoReasons?: string[] };
    assert.ok(vetoed, "250ml 不可达候选应被否决");
    assert.ok(
      Array.isArray(vetoed.vetoReasons) && vetoed.vetoReasons.length > 0,
      "否决候选携带非空 vetoReasons",
    );
  });

  it("任务 #121：picked.results 成功候选携带逐维度加权 dimensions（权重和 = 100）", async () => {
    config.generateCandidates = 3;
    await useMockLlm([
      { content: fence(GOOD_RECIPE) },
      { content: fence(MID_RECIPE) },
      { content: fence(BAD_RECIPE) },
    ]);

    const text = await postGenerate({ description: "冲一杯平衡的手冲咖啡" });
    const events = parseEvents(text);
    const picked = events.find((e) => e.type === "candidates" && e.stage === "picked")!;
    const pickedResults = picked.results as Array<Record<string, unknown>>;
    const okEntries = pickedResults.filter((r) => r.status === "ok") as Array<{
      vetoed?: boolean;
      dimensions?: Array<{
        key: string;
        label: string;
        weight: number;
        score: number;
        note: string;
      }>;
    }>;
    assert.equal(
      okEntries.length,
      3,
      "GOOD/MID/BAD 结构均合法进入评分（BAD 被否决但 status 仍为 ok）",
    );
    assert.ok(
      okEntries.some((e) => e.vetoed === true),
      "250ml 不可达候选被一票否决",
    );
    for (const entry of okEntries) {
      assert.ok(Array.isArray(entry.dimensions), "成功候选携带 dimensions 明细");
      assert.equal(entry.dimensions!.length, 7, "七个评分维度");
      assert.equal(
        entry.dimensions!.reduce((s, d) => s + d.weight, 0),
        100,
        "维度权重和恒为 100",
      );
      for (const d of entry.dimensions!) {
        assert.ok(typeof d.score === "number" && d.score >= 0 && d.score <= d.weight);
        assert.ok(d.label.length > 0 && d.note.length > 0);
      }
    }
    // 失败候选不携带 dimensions（本例无结构失败候选，改验否决候选仍带 dimensions 供兜底排序）
    const scores = (picked.scores as Array<{ score: number }>).map((s) => s.score);
    assert.equal(scores.length, 3);
    // 多维 rubric 下 GOOD/MID 得分拉开差距（不再人人同分）
    assert.notEqual(scores[0], scores[1], "GOOD 与 MID 候选得分必须不同（连续距离扣分）");
  });
});
