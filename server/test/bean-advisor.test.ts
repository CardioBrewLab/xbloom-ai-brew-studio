/**
 * 豆推荐规则引擎测试（任务 #50，node:test + assert）：
 * - 四因子打分排序（养豆窗口 / 库存水位 / 历史反馈 / 风味轮转）
 * - 库存为 0 / 不足一次冲煮排除；stockGrams 未录入不排除但低分
 * - 空输入与全部不合格 → 空列表；reasons 2-4 条非空；fallback 标识
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADVISOR_WEIGHTS,
  brewsLeftFor,
  recommendBeans,
  referenceDoseFor,
  scoreRipeness,
  scoreRotation,
  type AdvisorBeanInput,
  type AdvisorRecipeInput,
} from "../src/lib/bean-advisor.js";

/** 固定基准时间：2026-08-04，保证用例不受真实时钟漂移影响 */
const NOW = new Date("2026-08-04T12:00:00Z");

function bean(
  overrides: Partial<AdvisorBeanInput> & { id: string; name: string },
): AdvisorBeanInput {
  return overrides;
}

describe("养豆窗口因子", () => {
  it("适饮窗口内满分；养豆期未到扣分；无日期中性分", () => {
    // 烘焙 15 天（2026-07-20），restDays 7，peak 45 → 窗口内
    const inPeak = scoreRipeness({ id: "a", name: "A", roastDate: "2026-07-20", restDays: 7 }, NOW);
    assert.equal(inPeak.score, 1);
    assert.ok(inPeak.reasons[0].includes("适饮高峰"));

    // 烘焙 3 天（2026-08-01），restDays 7 → 仍在养豆期
    const resting = scoreRipeness(
      { id: "b", name: "B", roastDate: "2026-08-01", restDays: 7 },
      NOW,
    );
    assert.ok(resting.score < inPeak.score);
    assert.ok(resting.reasons[0].includes("养豆期"));

    // 无烘焙日期 → 中性 0.5
    const noDate = scoreRipeness({ id: "c", name: "C" }, NOW);
    assert.equal(noDate.score, 0.5);
  });

  it("超 peakWindowDays 线性衰减（缺省峰值 45 天）", () => {
    // 烘焙 60 天前，peak 45 → 过峰 15 天，score = 1 - 15/30 = 0.5
    const past = scoreRipeness({ id: "d", name: "D", roastDate: "2026-06-05" }, NOW);
    assert.ok(Math.abs(past.score - 0.5) < 1e-9);
    // 过峰超过衰减跨度（30 天）→ 0 分
    const gone = scoreRipeness({ id: "e", name: "E", roastDate: "2026-04-01" }, NOW);
    assert.equal(gone.score, 0);
  });

  it("本地日期差口径（任务 #65）：本地凌晨时刻天数不跨天，与前端 bean-math 一致", () => {
    // 烘焙 2026-08-01；UTC+8 时区下 2026-08-04T02:00+08:00 = 本地凌晨 2 点（本地日期仍是 8/4）
    // 旧 UTC 口径会算成 2 天（2026-08-03T18:00Z - 08-01T00:00Z 向下取整），本地口径应为 3 天
    const localEarly = new Date(2026, 7, 4, 2, 0, 0);
    const r = scoreRipeness(
      { id: "f", name: "F", roastDate: "2026-08-01", restDays: 0 },
      localEarly,
    );
    assert.ok(r.reasons[0].includes("第 3 天"), `期望本地日期差 3 天，实际：${r.reasons[0]}`);
    // 本地午夜前一刻（23:59）仍是同一天，不跨天
    const localLate = new Date(2026, 7, 4, 23, 59, 59);
    const r2 = scoreRipeness(
      { id: "g", name: "G", roastDate: "2026-08-01", restDays: 0 },
      localLate,
    );
    assert.ok(r2.reasons[0].includes("第 3 天"), `期望本地日期差 3 天，实际：${r2.reasons[0]}`);
  });

  it("非法日历日期（进位值）→ 中性分（任务 #65）", () => {
    const bad = scoreRipeness({ id: "h", name: "H", roastDate: "2026-02-30" }, NOW);
    assert.equal(bad.score, 0.5);
    assert.ok(bad.reasons[0].includes("无法解析"));
  });
});

describe("参考粉量与可冲次数", () => {
  it("referenceDoseFor：最近一条关联配方的 doseGrams，缺省 15", () => {
    const recipes: AdvisorRecipeInput[] = [
      { createdAt: "2026-07-01T00:00:00Z", beanId: "b1", recipe: { doseGrams: 12 } },
      { createdAt: "2026-07-20T00:00:00Z", beanId: "b1", recipe: { doseGrams: 18 } },
      { createdAt: "2026-08-01T00:00:00Z", beanId: "other", recipe: { doseGrams: 30 } },
    ];
    assert.equal(referenceDoseFor("b1", recipes), 18);
    assert.equal(referenceDoseFor("no-recipes", recipes), 15);
  });

  it("brewsLeftFor：floor(库存 / 参考粉量)；未录入库存返回 null", () => {
    const recipes: AdvisorRecipeInput[] = [];
    assert.equal(brewsLeftFor({ id: "b1", name: "x", stockGrams: 40 }, recipes), 2);
    assert.equal(brewsLeftFor({ id: "b1", name: "x", stockGrams: 0 }, recipes), 0);
    assert.equal(brewsLeftFor({ id: "b1", name: "x" }, recipes), null);
  });
});

describe("风味轮转因子", () => {
  const beans: AdvisorBeanInput[] = [
    { id: "x", name: "候选豆X", process: "水洗", origin: "肯尼亚" },
    { id: "y", name: "候选豆Y", process: "水洗", origin: "埃塞俄比亚" },
    { id: "z", name: "候选豆Z", process: "日晒", origin: "巴西" },
  ];

  it("最近冲煮存在同处理法/产地 → 轻微惩罚；无重复 → 满分", () => {
    const recipes: AdvisorRecipeInput[] = [{ createdAt: "2026-08-03T00:00:00Z", beanId: "y" }];
    const x = scoreRotation(beans[0], recipes, beans); // X 与 Y 同为水洗
    assert.ok(x.score < 1);
    assert.ok(x.reasons[0].includes("轮转"));
    const z = scoreRotation(beans[2], recipes, beans); // Z 日晒/巴西无重复
    assert.equal(z.score, 1);
  });

  it("beanSnapshot 豆名归一化匹配（无 beanId 的旧配方）", () => {
    const recipes: AdvisorRecipeInput[] = [
      { createdAt: "2026-08-03T00:00:00Z", beanSnapshot: "埃塞 候选豆Y 水洗 风味：柑橘" },
    ];
    const x = scoreRotation(beans[0], recipes, beans);
    assert.ok(x.score < 1); // snapshot 命中 Y → 同水洗处理法计一次重复
  });

  it("无冲煮记录 → 满分；自身历史记录不计惩罚", () => {
    assert.equal(scoreRotation(beans[0], [], beans).score, 1);
    const selfOnly: AdvisorRecipeInput[] = [{ createdAt: "2026-08-03T00:00:00Z", beanId: "x" }];
    assert.equal(scoreRotation(beans[0], selfOnly, beans).score, 1);
  });
});

describe("recommendBeans 综合打分", () => {
  it("四因子加权排序：适饮+充足库存+高反馈的豆排前，养豆期豆排后", () => {
    const beans: AdvisorBeanInput[] = [
      bean({
        id: "a",
        name: "豆A",
        roastDate: "2026-07-20",
        restDays: 7,
        peakWindowDays: 45,
        stockGrams: 100,
        process: "水洗",
        origin: "肯尼亚",
      }),
      bean({
        id: "b",
        name: "豆B",
        roastDate: "2026-08-01",
        restDays: 7,
        stockGrams: 60,
        process: "日晒",
        origin: "埃塞俄比亚",
      }),
    ];
    const recipes: AdvisorRecipeInput[] = [
      {
        createdAt: "2026-07-25T00:00:00Z",
        beanId: "a",
        recipe: { doseGrams: 15 },
        feedbacks: [{ rating: 5 }, { rating: 5 }],
      },
      { createdAt: "2026-08-02T00:00:00Z", beanId: "b", recipe: { doseGrams: 15 } },
    ];
    const { recommendations, fallback } = recommendBeans(beans, recipes, NOW);
    assert.equal(recommendations.length, 2);
    assert.equal(recommendations[0].beanId, "a");
    assert.ok(recommendations[0].score > recommendations[1].score);
    assert.equal(fallback, true); // 纯规则引擎结果
  });

  it("库存为 0 或不足一次冲煮的豆被排除", () => {
    const beans: AdvisorBeanInput[] = [
      bean({ id: "empty", name: "空仓豆", stockGrams: 0 }),
      bean({ id: "trace", name: "残量豆", stockGrams: 10 }), // 不足 15g 一次量
      bean({ id: "ok", name: "正常豆", stockGrams: 60 }),
    ];
    const { recommendations } = recommendBeans(beans, [], NOW);
    const ids = recommendations.map((r) => r.beanId);
    assert.ok(!ids.includes("empty"));
    assert.ok(!ids.includes("trace"));
    assert.ok(ids.includes("ok"));
  });

  it("stockGrams 未录入不排除但低于有库存的豆", () => {
    const beans: AdvisorBeanInput[] = [
      bean({ id: "nostock", name: "未录库存" }),
      bean({ id: "stocked", name: "有库存", stockGrams: 90 }),
    ];
    const { recommendations } = recommendBeans(beans, [], NOW);
    assert.equal(recommendations.length, 2);
    const noStock = recommendations.find((r) => r.beanId === "nostock")!;
    const stocked = recommendations.find((r) => r.beanId === "stocked")!;
    assert.ok(noStock.score < stocked.score);
    assert.ok(noStock.reasons.some((s) => s.includes("库存未录入")));
  });

  it("历史反馈 rating 均值影响排序", () => {
    const beans: AdvisorBeanInput[] = [
      bean({ id: "loved", name: "高分豆", stockGrams: 90 }),
      bean({ id: "hated", name: "低分豆", stockGrams: 90 }),
    ];
    const recipes: AdvisorRecipeInput[] = [
      { createdAt: "2026-07-01T00:00:00Z", beanId: "loved", feedbacks: [{ rating: 5 }] },
      { createdAt: "2026-07-02T00:00:00Z", beanId: "hated", feedbacks: [{ rating: 1 }] },
    ];
    const { recommendations } = recommendBeans(beans, recipes, NOW);
    assert.equal(recommendations[0].beanId, "loved");
    assert.ok(recommendations[0].reasons.some((s) => s.includes("平均评分")));
  });

  it("最多返回 Top3；每条 reasons 2-4 条非空中文", () => {
    const beans = Array.from({ length: 6 }, (_, i) =>
      bean({ id: `b${i}`, name: `豆${i}`, stockGrams: 60 + i }),
    );
    const { recommendations } = recommendBeans(beans, [], NOW);
    assert.equal(recommendations.length, 3);
    for (const rec of recommendations) {
      assert.ok(rec.reasons.length >= 2 && rec.reasons.length <= 4);
      for (const r of rec.reasons) assert.ok(typeof r === "string" && r.trim().length > 0);
      assert.ok(rec.score >= 0 && rec.score <= 1);
    }
  });

  it("空豆库 / 全部不合格 → 空列表（fallback 仍为 true）", () => {
    assert.deepEqual(recommendBeans([], [], NOW), { recommendations: [], fallback: true });
    const allEmpty: AdvisorBeanInput[] = [bean({ id: "e", name: "空", stockGrams: 0 })];
    const { recommendations } = recommendBeans(allEmpty, [], NOW);
    assert.deepEqual(recommendations, []);
  });

  it("权重表总和为 1（契约稳定性）", () => {
    const sum = Object.values(ADVISOR_WEIGHTS).reduce((s, w) => s + w, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });
});
