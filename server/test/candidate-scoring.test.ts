/**
 * 多候选评分器单测（任务 #106；#121 重设计为多维 rubric 加权）：
 * - 一票否决各分支（云端校验 / review error / Σ≠grandWater / ratio 不可达 / bypass 越界）
 * - 维度权重和 = 100；逐维度明细 dimensions 输出
 * - 连续距离扣分拉开分差：三个真实差异候选得分互不相同、最贴近理想带者获胜
 * - 无信号维度（风味/调研）中性给满；用户显式指定水量/比例豁免 ratio 维度
 * - 全局扣分（warn/clamp/方案解读）在维度总分之上继续扣
 * - 平局五级序（软分 → clamped → warn → 近 170s → 完成顺序）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bypassFinalRatioInRange,
  checkResearchConsistency,
  DIMENSION_WEIGHTS,
  extractResearchSignals,
  parseFlavorTags,
  pickWinner,
  pourSumEqualsGrandWater,
  rationaleCitesKnowledgeOrHardware,
  scoreCandidate,
  userSpecifiesRatioOrWater,
  vetoChecks,
  type RankedCandidate,
  type ResearchSignals,
  type ScoreCandidateInput,
} from "../src/lib/candidate-scoring.js";
import type { Recipe } from "../src/lib/recipe-schema.js";
import type { ReviewFinding } from "../src/lib/review.js";

/** 基础合法配方：15g × 15.6 = 234ml（可达），总时长 158.1s（合理带内），闷蒸 45s */
function goodRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: "测试配方",
    cupType: "xdripper",
    doseGrams: 15,
    grinderSize: 60,
    rpm: 90,
    grandWater: 234,
    pours: [
      {
        volume: 100,
        temperature: 92,
        flowRate: 3.2,
        pattern: "center",
        pausing: 45,
        vibBefore: false,
        vibAfter: false,
      },
      {
        volume: 134,
        temperature: 90,
        flowRate: 3.2,
        pattern: "circular",
        pausing: 40,
        vibBefore: false,
        vibAfter: false,
      },
    ],
    bypassEnabled: false,
    bypassVolume: 5,
    bypassTemp: 85,
    isSetGrinderSize: 1,
    theColor: "#C9D5B8",
    ...overrides,
  };
}

/** 引用知识库 §9 的方案解读（满足解读扣分豁免） */
const citedRationale = [
  { param: "研磨度", choice: "60", basis: "知识库 §9 xBloom 官方滤杯流速特性与 V60 移植" },
];

const warn = (rule: string): ReviewFinding => ({
  level: "warn",
  rule,
  message: "测试警告",
  suggestion: "测试建议",
});
const error = (rule: string): ReviewFinding => ({
  level: "error",
  rule,
  message: "测试违规",
  suggestion: "测试建议",
});

/** 标准输入：无警告、无修正、解读引用知识库、无豆信息/偏好/调研信号 */
function baseInput(overrides: Partial<ScoreCandidateInput> = {}): ScoreCandidateInput {
  return {
    recipe: goodRecipe(),
    clamped: [] as string[],
    findings: [] as ReviewFinding[],
    brewRationale: citedRationale,
    ...overrides,
  };
}

describe("一票否决 vetoChecks（任务 #121：保留既有五项）", () => {
  it("云端路径校验不通过（首段水温 96℃ 越出 40-95）", () => {
    const recipe = goodRecipe({
      pours: [
        {
          volume: 100,
          temperature: 96,
          flowRate: 3.2,
          pattern: "center",
          pausing: 45,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 134,
          temperature: 90,
          flowRate: 3.2,
          pattern: "circular",
          pausing: 40,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    });
    const reasons = vetoChecks(recipe, []);
    assert.ok(reasons.some((r) => r.includes("云端路径校验不通过")));
    assert.equal(scoreCandidate(baseInput({ recipe })).vetoed, true);
  });

  it("review error 级 finding 否决", () => {
    const reasons = vetoChecks(goodRecipe(), [error("start-temp-special-process")]);
    assert.ok(reasons.some((r) => r.includes("error 级违规")));
  });

  it("Σ分段注水 ≠ grandWater 否决", () => {
    const recipe = goodRecipe({ grandWater: 240 }); // pours 合计 234
    assert.equal(pourSumEqualsGrandWater(recipe), false);
    assert.ok(vetoChecks(recipe, []).some((r) => r.includes("Σ分段")));
  });

  it("云端粉水比不可达否决（12g 无法 0.1 步进得到 200ml）", () => {
    const recipe = goodRecipe({
      doseGrams: 12,
      grandWater: 200,
      pours: [
        {
          volume: 100,
          temperature: 92,
          flowRate: 3.2,
          pattern: "center",
          pausing: 45,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 100,
          temperature: 90,
          flowRate: 3.2,
          pattern: "circular",
          pausing: 40,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    });
    assert.ok(vetoChecks(recipe, []).some((r) => r.includes("不可达")));
  });

  it("bypass 启用时最终比例越出 12-20 否决", () => {
    const recipe = goodRecipe({
      grandWater: 215,
      pours: [
        {
          volume: 115,
          temperature: 92,
          flowRate: 3.2,
          pattern: "center",
          pausing: 45,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 100,
          temperature: 90,
          flowRate: 3.2,
          pattern: "circular",
          pausing: 40,
          vibBefore: false,
          vibAfter: false,
        },
      ],
      bypassEnabled: true,
      bypassVolume: 100, // (215+100)/15 = 21 > 20
    });
    assert.equal(bypassFinalRatioInRange(recipe), false);
    assert.ok(vetoChecks(recipe, []).some((r) => r.includes("bypass")));
  });

  it("bypass 未启用时最终比例检查直接通过", () => {
    assert.equal(bypassFinalRatioInRange(goodRecipe()), true);
  });
});

describe("多维 rubric 加权（任务 #121）", () => {
  it("维度权重和恒为 100；dimensions 输出 7 条且逐条不越权重", () => {
    const weightSum = Object.values(DIMENSION_WEIGHTS).reduce((s, w) => s + w, 0);
    assert.equal(weightSum, 100);
    const s = scoreCandidate(baseInput());
    assert.equal(s.dimensions.length, 7);
    assert.equal(
      s.dimensions.reduce((sum, d) => sum + d.weight, 0),
      100,
    );
    for (const d of s.dimensions) {
      assert.ok(d.score >= 0 && d.score <= d.weight, `${d.key} 得分越界`);
      assert.ok(d.label.length > 0 && d.note.length > 0, `${d.key} 缺 label/note`);
    }
  });

  it("全合规候选不再是满分 100：结构/比例偏离按连续距离扣分", () => {
    // goodRecipe 闷蒸 100ml 对 15g = 6.7× 越出 2-3× 理想带、ratio 15.6 偏离中心
    const s = scoreCandidate(baseInput());
    assert.ok(s.score < 100, `期望 <100，实际 ${s.score}`);
    assert.ok(s.score >= 60, `基础合法配方不应被扣穿，实际 ${s.score}`);
    const structure = s.dimensions.find((d) => d.key === "structure")!;
    assert.ok(structure.score < structure.weight, "闷蒸 6.7×粉量必须在结构维度扣分");
    assert.ok(structure.note.includes("闷蒸"), "结构维度 note 说明闷蒸偏离");
  });

  it("三个真实差异候选（浅焙豆）得分互不相同，最贴近理想带者获胜", () => {
    // 浅焙理想带：水温 92-95℃、研磨 55-70、金杯比 1:15-1:17
    const mk = (opts: {
      grandWater: number;
      grinderSize: number;
      pours: Recipe["pours"];
    }): Recipe =>
      goodRecipe({
        doseGrams: 20,
        grandWater: opts.grandWater,
        grinderSize: opts.grinderSize,
        pours: opts.pours,
      });
    // A：1:15 / 92℃ / 4 段 —— 全维度贴近理想带
    const a = mk({
      grandWater: 300,
      grinderSize: 60,
      pours: [
        {
          volume: 40,
          temperature: 92,
          flowRate: 3.0,
          pattern: "center",
          pausing: 27,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 90,
          temperature: 91,
          flowRate: 3.0,
          pattern: "circular",
          pausing: 27,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 85,
          temperature: 90,
          flowRate: 3.0,
          pattern: "circular",
          pausing: 27,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 85,
          temperature: 89,
          flowRate: 3.0,
          pattern: "spiral",
          pausing: 27,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    });
    // B：1:16.5 / 90℃ / 5 段 —— 比例更近中心但水温越出浅焙带
    const b = mk({
      grandWater: 330,
      grinderSize: 66,
      pours: [
        {
          volume: 45,
          temperature: 90,
          flowRate: 3.3,
          pattern: "center",
          pausing: 21,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 70,
          temperature: 89,
          flowRate: 3.3,
          pattern: "circular",
          pausing: 21,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 70,
          temperature: 88,
          flowRate: 3.3,
          pattern: "circular",
          pausing: 21,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 70,
          temperature: 87,
          flowRate: 3.3,
          pattern: "circular",
          pausing: 21,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 75,
          temperature: 86,
          flowRate: 3.3,
          pattern: "spiral",
          pausing: 21,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    });
    // C：1:18 / 88℃ / 3 段 —— 比例/水温/研磨全部越出浅焙理想带
    const c = mk({
      grandWater: 360,
      grinderSize: 72,
      pours: [
        {
          volume: 60,
          temperature: 88,
          flowRate: 3.5,
          pattern: "center",
          pausing: 34,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 150,
          temperature: 87,
          flowRate: 3.5,
          pattern: "circular",
          pausing: 34,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 150,
          temperature: 86,
          flowRate: 3.5,
          pattern: "spiral",
          pausing: 34,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    });

    const beanText = "埃塞俄比亚 耶加雪菲 水洗 浅焙";
    const sa = scoreCandidate(baseInput({ recipe: a, beanText }));
    const sb = scoreCandidate(baseInput({ recipe: b, beanText }));
    const sc = scoreCandidate(baseInput({ recipe: c, beanText }));

    // 均未否决
    assert.equal(sa.vetoed || sb.vetoed || sc.vetoed, false);
    // 得分互不相同（告别「3 个 100」）
    assert.notEqual(sa.score, sb.score);
    assert.notEqual(sb.score, sc.score);
    assert.notEqual(sa.score, sc.score);
    // 最贴近理想带者得分最高
    assert.ok(sa.score > sb.score, `A(${sa.score}) 应高于 B(${sb.score})`);
    assert.ok(sb.score > sc.score, `B(${sb.score}) 应高于 C(${sc.score})`);

    // pickWinner 按分数择优
    const ranked: RankedCandidate[] = [sa, sb, sc].map((s, i) => ({
      ...s,
      index: i,
      completionOrder: i,
    }));
    assert.equal(pickWinner(ranked), 0);

    // 水温×焙度维度：A 带内 > B 越出 2℃ > C 越出 4℃（连续扣分）
    const tempOf = (s: typeof sa) => s.dimensions.find((d) => d.key === "tempRoast")!.score;
    assert.ok(tempOf(sa) > tempOf(sb) && tempOf(sb) > tempOf(sc));
  });

  it("无信号维度中性给满：风味标签缺失 / 调研信号缺失不参与区分", () => {
    const s = scoreCandidate(baseInput());
    const flavor = s.dimensions.find((d) => d.key === "flavor")!;
    const research = s.dimensions.find((d) => d.key === "research")!;
    assert.equal(flavor.score, flavor.weight);
    assert.ok(flavor.note.includes("中性"));
    assert.equal(research.score, research.weight);
    assert.ok(research.note.includes("中性"));
  });

  it("无焙度信息时水温/研磨维度中性给满（不误伤无豆信息场景）", () => {
    const s = scoreCandidate(baseInput()); // 无 beanText
    for (const key of ["tempRoast", "grinderRoast"] as const) {
      const d = s.dimensions.find((x) => x.key === key)!;
      assert.equal(d.score, d.weight, `${key} 应中性给满`);
      assert.ok(d.note.includes("无焙度信息"));
    }
  });

  it("口味偏好对齐：明亮向标签偏好高温细磨，醇厚向相反", () => {
    const hotFine = goodRecipe({
      pours: [
        {
          volume: 100,
          temperature: 94,
          flowRate: 3.2,
          pattern: "center",
          pausing: 45,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 134,
          temperature: 92,
          flowRate: 3.2,
          pattern: "circular",
          pausing: 40,
          vibBefore: false,
          vibAfter: false,
        },
      ],
      grinderSize: 58,
    });
    const coolCoarse = goodRecipe({
      pours: [
        {
          volume: 100,
          temperature: 86,
          flowRate: 3.2,
          pattern: "center",
          pausing: 45,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 134,
          temperature: 85,
          flowRate: 3.2,
          pattern: "circular",
          pausing: 40,
          vibBefore: false,
          vibAfter: false,
        },
      ],
      grinderSize: 76,
    });
    const bright = (recipe: Recipe) =>
      scoreCandidate(baseInput({ recipe, flavorTags: ["明亮", "花果香"] })).dimensions.find(
        (d) => d.key === "flavor",
      )!.score;
    const mellow = (recipe: Recipe) =>
      scoreCandidate(baseInput({ recipe, flavorTags: ["醇厚", "低酸"] })).dimensions.find(
        (d) => d.key === "flavor",
      )!.score;
    assert.ok(bright(hotFine) > bright(coolCoarse), "明亮向应偏好高温细磨");
    assert.ok(mellow(coolCoarse) > mellow(hotFine), "醇厚向应偏好低温粗磨");
  });

  it("调研贴合度：贴近调研参数信号者得分更高", () => {
    const signals = { temperature: 92, ratio: 15.6 };
    const near = scoreCandidate(baseInput({ researchSignals: signals })); // 首段 92℃ / ratio 15.6
    const far = scoreCandidate(
      baseInput({
        researchSignals: signals,
        recipe: goodRecipe({
          grandWater: 255,
          pours: [
            {
              volume: 120,
              temperature: 86,
              flowRate: 3.2,
              pattern: "center",
              pausing: 45,
              vibBefore: false,
              vibAfter: false,
            },
            {
              volume: 135,
              temperature: 85,
              flowRate: 3.2,
              pattern: "circular",
              pausing: 40,
              vibBefore: false,
              vibAfter: false,
            },
          ],
        }),
      }),
    );
    const rNear = near.dimensions.find((d) => d.key === "research")!;
    const rFar = far.dimensions.find((d) => d.key === "research")!;
    assert.equal(rNear.score, rNear.weight, "完全贴合调研信号应拿满");
    assert.ok(rFar.score < rNear.score, "偏离调研信号应扣分");
  });

  it("用户显式指定水量/比例时 ratio 维度中性豁免", () => {
    const recipe = goodRecipe({
      grandWater: 255,
      pours: [
        {
          volume: 120,
          temperature: 92,
          flowRate: 3.2,
          pattern: "center",
          pausing: 45,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 135,
          temperature: 90,
          flowRate: 3.2,
          pattern: "circular",
          pausing: 40,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    });
    const exempted = scoreCandidate(baseInput({ recipe, userSpecifiedRatioOrWater: true }));
    const ratioDim = exempted.dimensions.find((d) => d.key === "ratio")!;
    assert.equal(ratioDim.score, ratioDim.weight);
    assert.ok(ratioDim.note.includes("豁免"));
    const penalized = scoreCandidate(baseInput({ recipe }));
    assert.ok(
      penalized.dimensions.find((d) => d.key === "ratio")!.score < ratioDim.weight,
      "未豁免时 1:17 越出金杯带应扣分",
    );
  });

  it("parseFlavorTags：顿号/逗号/空白切分，空文本返回 undefined", () => {
    assert.deepEqual(parseFlavorTags("明亮、花果香"), ["明亮", "花果香"]);
    assert.deepEqual(parseFlavorTags("醇厚,低酸"), ["醇厚", "低酸"]);
    assert.deepEqual(parseFlavorTags("  甜  圆润 "), ["甜", "圆润"]);
    assert.equal(parseFlavorTags(undefined), undefined);
    assert.equal(parseFlavorTags("  "), undefined);
  });

  it("extractResearchSignals：从调研摘要提取水温/比例/grinderSize，未命中返回 undefined", () => {
    assert.deepEqual(
      extractResearchSignals("烘焙商建议 92℃ 冲煮，粉水比 1:16，grinderSize 建议 62"),
      { temperature: 92, ratio: 16, grinderSize: 62 },
    );
    assert.deepEqual(extractResearchSignals("粗研磨建议 grinderSize 112"), { grinderSize: 112 });
    assert.deepEqual(extractResearchSignals("建议水温 90 度，比例 1：15.5"), {
      temperature: 90,
      ratio: 15.5,
    });
    assert.equal(extractResearchSignals("这支豆子风味明亮"), undefined);
    assert.equal(extractResearchSignals(undefined), undefined);
    assert.equal(extractResearchSignals("  "), undefined);
  });
});

describe("全局扣分（warn/clamp/解读，任务 #121 保留 #106 语义）", () => {
  it("review warn 每条 -8（相对维度总分）", () => {
    const base = scoreCandidate(baseInput());
    const s = scoreCandidate(
      baseInput({ findings: [warn("bloom-pausing"), warn("vib-after-placement")] }),
    );
    assert.equal(s.warns, 2);
    assert.equal(s.score, base.score - 16);
    assert.ok(s.deductions.some((d) => d.includes("审查警告 ×2")));
  });

  it("clamp 留痕每条 -3", () => {
    const base = scoreCandidate(baseInput());
    const s = scoreCandidate(
      baseInput({ clamped: ["grinderSize: 90 → 80", "waterTemperature: 97 → 95"] }),
    );
    assert.equal(s.clamps, 2);
    assert.equal(s.score, base.score - 6);
    assert.ok(s.deductions.some((d) => d.includes("参数修正 ×2")));
  });

  it("brewRationale 缺失 -5；无知识库/硬件引用 -5；有引用不扣", () => {
    const base = scoreCandidate(baseInput());
    assert.equal(scoreCandidate(baseInput({ brewRationale: undefined })).score, base.score - 5);
    assert.equal(
      scoreCandidate(
        baseInput({ brewRationale: [{ param: "水温", choice: "92", basis: "经验值" }] }),
      ).score,
      base.score - 5,
    );
    assert.equal(base.deductions.length, 0);
  });

  it("rationaleCitesKnowledgeOrHardware：硬件/知识库关键词命中", () => {
    assert.equal(rationaleCitesKnowledgeOrHardware(undefined), false);
    assert.equal(rationaleCitesKnowledgeOrHardware([]), false);
    assert.equal(
      rationaleCitesKnowledgeOrHardware([
        { param: "流速", choice: "3.2", basis: "xBloom 设备转速与振动特性" },
      ]),
      true,
    );
    assert.equal(
      rationaleCitesKnowledgeOrHardware([{ param: "水温", choice: "92", basis: "个人喜好" }]),
      false,
    );
  });
});

describe("userSpecifiesRatioOrWater", () => {
  it("比例写法 / 粉水比字样 / 水量写法命中", () => {
    assert.equal(userSpecifiesRatioOrWater("按 1:16 来冲"), true);
    assert.equal(userSpecifiesRatioOrWater("粉水比想要 15"), true);
    assert.equal(userSpecifiesRatioOrWater("总水量 250ml"), true);
    assert.equal(userSpecifiesRatioOrWater("水量控制在 240 毫升"), true);
  });

  it("未指定水量/比例的描述不命中", () => {
    assert.equal(userSpecifiesRatioOrWater("想要花果香、明亮酸质"), false);
    assert.equal(userSpecifiesRatioOrWater(undefined), false);
    assert.equal(userSpecifiesRatioOrWater("   "), false);
  });
});

describe("pickWinner 平局五级序", () => {
  const entry = (overrides: Partial<RankedCandidate> = {}): RankedCandidate => ({
    vetoed: false,
    vetoReasons: [],
    score: 100,
    warns: 0,
    clamps: 0,
    totalSeconds: 170,
    deductions: [],
    dimensions: [],
    index: 0,
    completionOrder: 0,
    ...overrides,
  });

  it("第一级：软分高者胜", () => {
    assert.equal(pickWinner([entry({ index: 0, score: 84 }), entry({ index: 1, score: 92 })]), 1);
  });

  it("第二级：同分 clamped 少者胜", () => {
    assert.equal(
      pickWinner([
        entry({ index: 0, score: 90, clamps: 2 }),
        entry({ index: 1, score: 90, clamps: 1 }),
      ]),
      1,
    );
  });

  it("第三级：同分同修正 warn 少者胜", () => {
    assert.equal(pickWinner([entry({ index: 0, warns: 2 }), entry({ index: 1, warns: 1 })]), 1);
  });

  it("第四级：总时长更接近 170s 者胜", () => {
    assert.equal(
      pickWinner([entry({ index: 0, totalSeconds: 185 }), entry({ index: 1, totalSeconds: 165 })]),
      1,
    );
  });

  it("第五级：完全相同按生成完成顺序靠前", () => {
    assert.equal(
      pickWinner([
        entry({ index: 0, completionOrder: 2 }),
        entry({ index: 1, completionOrder: 0 }),
      ]),
      1,
    );
  });

  it("一票否决候选永远排在非否决候选之后（即便软分更高）", () => {
    assert.equal(
      pickWinner([
        entry({ index: 0, score: 100, vetoed: true, vetoReasons: ["ratio 不可达"] }),
        entry({ index: 1, score: 50 }),
      ]),
      1,
    );
  });

  it("全体否决时兜底仍择优（返回有效下标）", () => {
    assert.equal(
      pickWinner([
        entry({ index: 0, vetoed: true, score: 60 }),
        entry({ index: 1, vetoed: true, score: 80 }),
      ]),
      1,
    );
  });

  it("空候选列表返回 -1", () => {
    assert.equal(pickWinner([]), -1);
  });
});

describe("任务 #131：checkResearchConsistency 调研一致性校验", () => {
  // goodRecipe: temperature=92, grinderSize=60, grandWater=234, dose=15 → ratio=15.6
  const recipe = goodRecipe();

  it("参数与调研信号一致时 consistent=true、deviations 为空", () => {
    const signals: ResearchSignals = { temperature: 92, ratio: 15.6, grinderSize: 60 };
    const r = checkResearchConsistency(recipe, signals, false);
    assert.equal(r.consistent, true);
    assert.equal(r.deviations.length, 0);
  });

  it("温度偏离超容差（±3℃）时 consistent=false 并报告偏差", () => {
    const signals: ResearchSignals = { temperature: 96 };
    const r = checkResearchConsistency(recipe, signals, false);
    assert.equal(r.consistent, false);
    assert.equal(r.deviations.length, 1);
    assert.equal(r.deviations[0].param, "temperature");
    assert.equal(r.deviations[0].value, 92);
    assert.equal(r.deviations[0].researchValue, 96);
    assert.equal(r.deviations[0].tolerance, 3);
  });

  it("distilled=true 时容差×1.5，同样偏离 4℃ 变为一致（4≤4.5）", () => {
    const signals: ResearchSignals = { temperature: 96 };
    const rNormal = checkResearchConsistency(recipe, signals, false);
    const rDistilled = checkResearchConsistency(recipe, signals, true);
    assert.equal(rNormal.consistent, false, "非提炼模式 4>3 → 偏离");
    assert.equal(rDistilled.consistent, true, "提炼模式 4≤4.5 → 一致");
    assert.equal(rDistilled.deviations.length, 0);
  });

  it("无调研信号时 consistent=true（不否决、不改 score）", () => {
    const r = checkResearchConsistency(recipe, undefined, false);
    assert.equal(r.consistent, true);
    assert.equal(r.deviations.length, 0);
  });
});
