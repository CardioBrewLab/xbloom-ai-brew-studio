/** web 侧多候选展示态测试（任务 #106）：candidates 事件状态机与文案 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANDIDATES_IDLE,
  candidateDimensionLines,
  candidatePickHeadline,
  candidateRowScoreText,
  candidatesDoneNote,
  candidatesErrorReset,
  candidatesProgressText,
  candidatesSoloWinNote,
  contentChunkOf,
  encodeCandidatesNote,
  parseCandidatesNote,
  reduceCandidatesEvent,
  shouldShowWinnerJson,
  type CandidateDimensionEntry,
} from "../src/lib/candidates.js";
import type { GenerateEvent } from "../src/lib/api.js";

describe("reduceCandidatesEvent（任务 #106）", () => {
  it("start → running 且记录 N", () => {
    const s = reduceCandidatesEvent(CANDIDATES_IDLE, { type: "candidates", stage: "start", n: 3 });
    assert.deepEqual(s, { phase: "running", n: 3, done: 0, total: 3, scores: [], results: [] });
  });

  it("progress → 更新 done/total（降 N 场景 total 可变）", () => {
    const running = reduceCandidatesEvent(CANDIDATES_IDLE, {
      type: "candidates",
      stage: "start",
      n: 3,
    });
    const s = reduceCandidatesEvent(running, {
      type: "candidates",
      stage: "progress",
      done: 2,
      total: 3,
    });
    assert.equal(s.done, 2);
    assert.equal(s.total, 3);
    assert.equal(s.phase, "running");
  });

  it("picked → 记录 winner 与 scores", () => {
    const scores = [
      { index: 0, score: 84, vetoed: false, warns: 2, clamps: 0 },
      { index: 1, score: 100, vetoed: false, warns: 0, clamps: 0 },
      { index: 2, score: 0, vetoed: true, warns: 0, clamps: 0 },
    ];
    const s = reduceCandidatesEvent(CANDIDATES_IDLE, {
      type: "candidates",
      stage: "picked",
      winner: 1,
      scores,
    });
    assert.equal(s.phase, "picked");
    assert.equal(s.winner, 1);
    assert.equal(s.scores.length, 3);
  });

  it("recipe.candidateScore → 记录优选明细 detail", () => {
    const detail = {
      n: 3,
      winner: 1,
      index: 1,
      score: 94,
      vetoed: false,
      warns: 0,
      clamps: 0,
      deductions: ["粉水比偏离 15.6"],
    };
    const ev = { type: "recipe", recipe: {}, candidateScore: detail } as unknown as GenerateEvent;
    const s = reduceCandidatesEvent(CANDIDATES_IDLE, ev);
    assert.deepEqual(s.detail, detail);
  });

  it("无关事件（N=1 路径）原样返回、状态恒为 idle", () => {
    const s = reduceCandidatesEvent(CANDIDATES_IDLE, { type: "done" });
    assert.equal(s, CANDIDATES_IDLE);
    assert.equal(s.phase, "idle");
  });
});

describe("candidatesProgressText", () => {
  it("running 阶段输出「正在并行生成 N 份方案…(k/N)」", () => {
    const s = reduceCandidatesEvent(CANDIDATES_IDLE, { type: "candidates", stage: "start", n: 3 });
    assert.equal(candidatesProgressText(s), "正在并行生成 3 份方案…(0/3)");
    const s2 = reduceCandidatesEvent(s, {
      type: "candidates",
      stage: "progress",
      done: 2,
      total: 3,
    });
    assert.equal(candidatesProgressText(s2), "正在并行生成 3 份方案…(2/3)");
  });

  it("idle / picked 阶段返回空串（N=1 UI 逐字节不变的前提）", () => {
    assert.equal(candidatesProgressText(CANDIDATES_IDLE), "");
    const picked = reduceCandidatesEvent(CANDIDATES_IDLE, {
      type: "candidates",
      stage: "picked",
      winner: 0,
      scores: [{ index: 0, score: 100, vetoed: false, warns: 0, clamps: 0 }],
    });
    assert.equal(candidatesProgressText(picked), "");
  });
});

describe("candidatePickHeadline（任务 #121 维度加权语义）", () => {
  it("无违规无修正：「N 选 1｜得分 X · 维度加权」", () => {
    assert.equal(
      candidatePickHeadline({
        n: 3,
        winner: 0,
        index: 0,
        score: 87.5,
        vetoed: false,
        warns: 0,
        clamps: 0,
        deductions: [],
      }),
      "3 选 1｜得分 87.5 · 维度加权",
    );
  });

  it("有警告/修正时追加如实数量", () => {
    assert.equal(
      candidatePickHeadline({
        n: 2,
        winner: 1,
        index: 1,
        score: 81,
        vetoed: false,
        warns: 1,
        clamps: 2,
        deductions: [],
      }),
      "2 选 1｜得分 81 · 维度加权（1 项警告、2 项修正）",
    );
  });
});

describe("任务 #121：逐维度明细透传与展开渲染纯函数", () => {
  const dims: CandidateDimensionEntry[] = [
    { key: "ratio", label: "粉水比最优性", weight: 20, score: 15, note: "1:15 落在金杯带" },
    {
      key: "tempRoast",
      label: "水温×烘焙度匹配",
      weight: 18,
      score: 13.5,
      note: "首段 92℃ 在浅焙带",
    },
  ];

  it("candidateRowScoreText：携带 dimensions 时「得分 NN · 维度加权」", () => {
    assert.equal(
      candidateRowScoreText({ index: 0, status: "ok", score: 88.6, dimensions: dims }),
      "得分 88.6 · 维度加权",
    );
  });

  it("candidateRowScoreText：旧形态（无 dimensions）回退警告/修正文案，绝不拼 undefined", () => {
    assert.equal(
      candidateRowScoreText({ index: 0, status: "ok", score: 92, warns: 1, clamps: 2 }),
      "得分 92 · 警告 1 · 修正 2",
    );
    assert.equal(candidateRowScoreText({ index: 0, status: "ok" }), "得分 — · 警告 0 · 修正 0");
  });

  it("candidateDimensionLines：无 dimensions/无条目时返回空数组（行不可展开）", () => {
    assert.deepEqual(candidateDimensionLines({ index: 0, status: "ok", score: 90 }), []);
    assert.deepEqual(candidateDimensionLines({ index: 0, status: "failed", failReason: "x" }), []);
    assert.deepEqual(candidateDimensionLines(undefined), []);
    assert.equal(candidateDimensionLines({ index: 0, status: "ok", dimensions: dims }).length, 2);
  });

  it("picked.results 聚合透传 dimensions（状态机原样保留）", () => {
    const s = reduceCandidatesEvent(CANDIDATES_IDLE, {
      type: "candidates",
      stage: "picked",
      winner: 0,
      scores: [{ index: 0, score: 88.6, vetoed: false, warns: 0, clamps: 0 }],
      results: [
        {
          index: 0,
          status: "ok",
          score: 88.6,
          vetoed: false,
          vetoReasons: [],
          warns: 0,
          clamps: 0,
          deductions: [],
          dimensions: dims,
        },
        { index: 1, status: "failed", failReason: "结构失败：x" },
      ],
    } as unknown as GenerateEvent);
    assert.deepEqual(s.results[0].dimensions, dims);
    assert.equal(s.results[1].dimensions, undefined);
  });

  it("信封往返无损保留 dimensions（doneNote 通道）", () => {
    const picked = reduceCandidatesEvent(CANDIDATES_IDLE, {
      type: "candidates",
      stage: "picked",
      winner: 0,
      scores: [],
      results: [{ index: 0, status: "ok", score: 88.6, dimensions: dims }],
    } as unknown as GenerateEvent);
    const parsed = parseCandidatesNote(candidatesDoneNote(picked));
    assert.deepEqual(parsed.state?.results[0].dimensions, dims);
  });
});

describe("candidatesDoneNote（任务 #111 O4；#120 信封通道）", () => {
  it("idle → 空串（N=1 副标题维持原文案的前提）", () => {
    assert.equal(candidatesDoneNote(CANDIDATES_IDLE), "");
    assert.deepEqual(parseCandidatesNote(candidatesDoneNote(CANDIDATES_IDLE)), {
      text: "",
      state: null,
    });
  });

  it("picked 无 detail → 信封通道激活、展示文案为空（#120 卡片始终渲染的数据前提）", () => {
    const picked = reduceCandidatesEvent(CANDIDATES_IDLE, {
      type: "candidates",
      stage: "picked",
      winner: 0,
      scores: [{ index: 0, score: 100, vetoed: false, warns: 0, clamps: 0 }],
    });
    const note = candidatesDoneNote(picked);
    assert.notEqual(note, "", "N>1 picked 后信封必须激活");
    const parsed = parseCandidatesNote(note);
    assert.equal(parsed.text, "");
    assert.equal(parsed.state?.phase, "picked");
    assert.equal(parsed.state?.winner, 0);
  });

  it("recipe.candidateScore 就绪后展示文案「N 选 1 完成 · 得分 X」", () => {
    const picked = reduceCandidatesEvent(CANDIDATES_IDLE, {
      type: "candidates",
      stage: "picked",
      winner: 1,
      scores: [],
    });
    const s = reduceCandidatesEvent(picked, {
      type: "recipe",
      recipe: {},
      candidateScore: {
        n: 3,
        winner: 1,
        index: 1,
        score: 94,
        vetoed: false,
        warns: 0,
        clamps: 0,
        deductions: [],
      },
    } as unknown as GenerateEvent);
    assert.equal(parseCandidatesNote(candidatesDoneNote(s)).text, "3 选 1 完成 · 得分 94");
  });
});

describe("任务 #120：逐候选结果聚合与信封通道", () => {
  it("progress.result 增量聚合进 results（按 index 去重覆盖）", () => {
    let s = reduceCandidatesEvent(CANDIDATES_IDLE, { type: "candidates", stage: "start", n: 3 });
    s = reduceCandidatesEvent(s, {
      type: "candidates",
      stage: "progress",
      done: 1,
      total: 3,
      result: { index: 1, status: "failed", failReason: "结构失败：x" },
    } as unknown as GenerateEvent);
    s = reduceCandidatesEvent(s, {
      type: "candidates",
      stage: "progress",
      done: 2,
      total: 3,
      result: { index: 0, status: "ok" },
    } as unknown as GenerateEvent);
    assert.equal(s.results.length, 2);
    assert.equal(s.results.find((r) => r.index === 1)?.failReason, "结构失败：x");
    // 无 result 字段的旧形态 progress 不破坏既有聚合
    s = reduceCandidatesEvent(s, { type: "candidates", stage: "progress", done: 3, total: 3 });
    assert.equal(s.results.length, 2);
    assert.equal(s.done, 3);
  });

  it("picked.results 全量覆盖；缺失时回退增量聚合", () => {
    let s = reduceCandidatesEvent(CANDIDATES_IDLE, { type: "candidates", stage: "start", n: 2 });
    s = reduceCandidatesEvent(s, {
      type: "candidates",
      stage: "picked",
      winner: 0,
      scores: [{ index: 0, score: 94, vetoed: false, warns: 0, clamps: 0 }],
      results: [
        {
          index: 0,
          status: "ok",
          score: 94,
          vetoed: false,
          vetoReasons: [],
          warns: 0,
          clamps: 0,
          deductions: [],
        },
        { index: 1, status: "failed", failReason: "网关限流/并发失败" },
      ],
    } as unknown as GenerateEvent);
    assert.equal(s.results.length, 2);
    assert.equal(s.results[1].status, "failed");
  });

  it("信封往返：state 与展示文案无损还原；非法输入安全降级", () => {
    const s: ReturnType<typeof reduceCandidatesEvent> = {
      ...CANDIDATES_IDLE,
      phase: "picked",
      n: 3,
      done: 3,
      total: 3,
      winner: 0,
      results: [{ index: 1, status: "failed", failReason: '结构失败：含中文与"引号"' }],
    };
    const note = encodeCandidatesNote(s, "3 选 1 完成 · 得分 100");
    const parsed = parseCandidatesNote(note);
    assert.equal(parsed.text, "3 选 1 完成 · 得分 100");
    assert.deepEqual(parsed.state, s);
    // 无信封 / 损坏信封 → 原文降级，绝不抛错
    assert.deepEqual(parseCandidatesNote("普通文案"), { text: "普通文案", state: null });
    assert.deepEqual(parseCandidatesNote(undefined), { text: "", state: null });
    assert.equal(parseCandidatesNote("\u0000xc120\u0000garbage").state, null);
  });

  it("candidatesSoloWinNote：仅 1 成功时明示其余失败原因", () => {
    const s = reduceCandidatesEvent(CANDIDATES_IDLE, {
      type: "candidates",
      stage: "picked",
      winner: 2,
      scores: [],
      results: [
        { index: 0, status: "failed", failReason: "结构失败：a" },
        { index: 1, status: "failed", failReason: "网关限流/并发失败" },
        { index: 2, status: "ok", score: 100 },
      ],
    } as unknown as GenerateEvent);
    assert.equal(
      candidatesSoloWinNote(s),
      "其余 2 个候选失败：候选 1 结构失败：a；候选 2 网关限流/并发失败，采用唯一成功候选",
    );
    // 全成功 / 非 picked → 空串
    const allOk = reduceCandidatesEvent(CANDIDATES_IDLE, {
      type: "candidates",
      stage: "picked",
      winner: 0,
      scores: [],
      results: [
        { index: 0, status: "ok" },
        { index: 1, status: "ok" },
      ],
    } as unknown as GenerateEvent);
    assert.equal(candidatesSoloWinNote(allOk), "");
    assert.equal(candidatesSoloWinNote(CANDIDATES_IDLE), "");
  });
});

describe("candidatesErrorReset（任务 #114）", () => {
  it("全体失败 error 事件：running 归位 idle，进度文案清空", () => {
    const running = reduceCandidatesEvent(CANDIDATES_IDLE, {
      type: "candidates",
      stage: "start",
      n: 3,
    });
    const mid = reduceCandidatesEvent(running, {
      type: "candidates",
      stage: "progress",
      done: 1,
      total: 3,
    });
    const s = candidatesErrorReset(mid);
    assert.deepEqual(s, CANDIDATES_IDLE);
    assert.equal(s.phase, "idle");
    assert.equal(candidatesProgressText(s), "");
  });

  it("idle / picked 不受影响（不侵入既有状态机）", () => {
    assert.equal(candidatesErrorReset(CANDIDATES_IDLE), CANDIDATES_IDLE);
    const picked = reduceCandidatesEvent(CANDIDATES_IDLE, {
      type: "candidates",
      stage: "picked",
      winner: 0,
      scores: [{ index: 0, score: 100, vetoed: false, warns: 0, clamps: 0 }],
    });
    assert.equal(candidatesErrorReset(picked), picked);
  });
});

describe("shouldShowWinnerJson（任务 #114 互斥）", () => {
  it("content 到达 → 不渲染 winnerJson 兜底卡（即使 N>1 带 candidateScore）", () => {
    assert.equal(shouldShowWinnerJson(true, true), false);
  });

  it("无 content 且 N>1 → winnerJson 兜底渲染", () => {
    assert.equal(shouldShowWinnerJson(true, false), true);
  });

  it("N=1（无 candidateScore）→ 无论有无 content 均不渲染兜底卡", () => {
    assert.equal(shouldShowWinnerJson(false, false), false);
    assert.equal(shouldShowWinnerJson(false, true), false);
  });
});

describe("contentChunkOf（任务 #116 载荷二选一）", () => {
  it("N=1 流式增量：delta 形态原样返回", () => {
    assert.equal(contentChunkOf({ type: "content", delta: "冲煮思路…" }), "冲煮思路…");
  });

  it("N>1 补发：content 字段形态正确提取（服务端固化契约）", () => {
    const ev = { type: "content", content: "获胜候选原始正文" } as unknown as Extract<
      GenerateEvent,
      { type: "content" }
    >;
    assert.equal(contentChunkOf(ev), "获胜候选原始正文");
  });

  it("两者同携时优先 delta；都缺失返回空串，绝不拼出 undefined", () => {
    assert.equal(contentChunkOf({ type: "content", delta: "a", content: "b" }), "a");
    assert.equal(contentChunkOf({ type: "content" }), "");
  });

  it("content 字段形态到达 → 正文正确累积且 winnerJson 被互斥抑制", () => {
    // 模拟 App.tsx 的累积逻辑：多候选全体走 content 字段补发
    let buf = "";
    const ev = { type: "content", content: "获胜候选原始正文" } as unknown as Extract<
      GenerateEvent,
      { type: "content" }
    >;
    buf += contentChunkOf(ev);
    assert.equal(buf, "获胜候选原始正文");
    assert.ok(!buf.includes("undefined"));
    // 已收到 content → 即使 recipe 带 candidateScore，兜底卡也不得出现
    const contentReceived = buf.length > 0;
    assert.equal(shouldShowWinnerJson(true, contentReceived), false);
  });
});
