/**
 * 数据层与 LLM 配置测试（node:test + assert）：
 * - 豆库 CRUD 纯函数（loadBeans/saveBeans/findBean/beanToPromptText）
 * - 本地配方库读写与反馈 schema（loadAll/saveAll/FeedbackSchema/TASTE_TAGS）
 * - 版本链与追溯（deriveVersion/buildFeedbackEntry/backfillResulting）
 * - LLM 双 key 兜底：config 模型 ID 从环境读取、keyForModel、modelChain
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  beanToPromptText,
  deriveBeanName,
  ensureBeanFromFreeText,
  findBean,
  loadBeans,
  saveBeans,
  type Bean,
} from "../src/routes/beans.js";
import {
  backfillResulting,
  buildFeedbackEntry,
  deriveVersion,
  FeedbackSchema,
  loadAll,
  saveAll,
  sanitizeReviewFindings,
  sanitizeRoasterReference,
  TASTE_TAGS,
  type StoredRecipe,
} from "../src/routes/recipes.js";
import {
  availableDoseSection,
  AVAILABLE_DOSE_MAX,
  BREW_RATIONALE_MAX,
  detectDripperSignal,
  feedbackSection,
  IMPROVEMENT_NOTES_MAX,
  improvedVariantSection,
  needsAutoFix,
  parseAvailableDoseGrams,
  ROASTER_REFERENCE_MAX,
  roasterReferenceSection,
  sanitizeBrewRationale,
  sanitizeImprovementNotes,
  shouldPersistFreeTextBean,
  shouldRunDualGeneration,
  variantFailEvent,
} from "../src/routes/generate.js";
import { keyForModel, modelChain } from "../src/lib/llm.js";
import { config } from "../src/config.js";

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbloom-test-"));
  return path.join(dir, name);
}

describe("豆库数据层 CRUD", () => {
  it("文件不存在时 loadBeans 返回空库", () => {
    assert.deepEqual(loadBeans(tmpFile("nope.json")), []);
  });

  it("saveBeans → loadBeans 往返一致", () => {
    const file = tmpFile("beans.json");
    const bean: Bean = {
      id: "b1",
      createdAt: new Date().toISOString(),
      name: "耶加雪菲 G1",
      origin: "埃塞俄比亚",
      roastLevel: "浅焙",
    };
    saveBeans([bean], file);
    const list = loadBeans(file);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], bean);
  });

  it("findBean 命中与未命中", () => {
    const file = tmpFile("beans.json");
    saveBeans(
      [
        { id: "b1", createdAt: "", name: "豆一" },
        { id: "b2", createdAt: "", name: "豆二" },
      ],
      file,
    );
    assert.equal(findBean("b2", file)?.name, "豆二");
    assert.equal(findBean("missing", file), null);
  });

  it("损坏的 JSON 文件视为空库（不抛错）", () => {
    const file = tmpFile("broken.json");
    fs.writeFileSync(file, "{不是合法 JSON", "utf8");
    assert.deepEqual(loadBeans(file), []);
  });

  it("beanToPromptText 仅拼接已有字段", () => {
    const text = beanToPromptText({ id: "x", createdAt: "", name: "测试豆", roastLevel: "中焙" });
    assert.equal(text, "豆名：测试豆；烘焙度：中焙");
  });
});

describe("自由文本豆信息落档（任务 #35）", () => {
  it("deriveBeanName：取首段并截去“风味：”之后内容，限长 30 字符", () => {
    assert.equal(
      deriveBeanName("林波波 肯尼亚 水洗 SL28 风味：杨梅 青梅绿茶"),
      "林波波 肯尼亚 水洗 SL28",
    );
    assert.equal(deriveBeanName("\n  \n首行豆名\n其他"), "首行豆名");
    assert.equal(deriveBeanName(""), "");
    assert.ok(deriveBeanName("a".repeat(50)).length <= 30);
  });

  it("ensureBeanFromFreeText：同名不存在时追加最小档案（name/rawDescription/createdAt），不破坏既有结构", () => {
    const file = tmpFile("beans.json");
    const existing: Bean = {
      id: "b1",
      createdAt: "2026-08-01T00:00:00Z",
      name: "肯尼亚-林波波",
      origin: "肯尼亚",
    };
    saveBeans([existing], file);

    const freeText = "埃塞俄比亚 Elto Coffee Songo处理厂 SFW冷水漫清蜜处理 74158 风味：花香 甜橙";
    const result = ensureBeanFromFreeText(freeText, file);
    assert.equal(result.created, true);

    const list = loadBeans(file);
    assert.equal(list.length, 2);
    assert.deepEqual(list[0], existing); // 既有条目未被改动
    const added = list[1];
    assert.equal(added.name, result.name);
    assert.equal(added.rawDescription, freeText);
    assert.ok(added.id && added.createdAt);
  });

  it("ensureBeanFromFreeText：已有同名（忽略大小写/首尾空白）则跳过，不重复追加", () => {
    const file = tmpFile("beans.json");
    saveBeans([{ id: "b1", createdAt: "", name: " Elto 冷浸蜜 " }], file);
    const result = ensureBeanFromFreeText("elto 冷浸蜜 风味：花香 甜橙", file);
    assert.equal(result.created, false);
    assert.equal(loadBeans(file).length, 1);
  });

  it("ensureBeanFromFreeText：空文本不新建", () => {
    const file = tmpFile("beans.json");
    assert.deepEqual(ensureBeanFromFreeText("   ", file), { created: false, name: "" });
    assert.deepEqual(loadBeans(file), []);
  });
});

describe("豆库豆生成跳过重复落档（任务 #65）", () => {
  it("beanId 命中豆档案时不落档：避免选豆场景每次生成追加重复档案", () => {
    // 前端选豆发送的 beans 文本形如「豆名（产地，处理法…）」，命中时不得再落档
    assert.equal(shouldPersistFreeTextBean("耶加雪菲 G1（埃塞俄比亚，水洗）", true), false);
    assert.equal(shouldPersistFreeTextBean("任意文本", true), false);
  });

  it("beanId 未命中/无 beanId 且文本非空 → 保留既有自动落档行为", () => {
    assert.equal(shouldPersistFreeTextBean("林波波 肯尼亚 水洗", false), true);
  });

  it("文本缺失/空白/非字符串 → 不落档", () => {
    assert.equal(shouldPersistFreeTextBean(undefined, false), false);
    assert.equal(shouldPersistFreeTextBean("   ", false), false);
    assert.equal(shouldPersistFreeTextBean("", false), false);
    assert.equal(shouldPersistFreeTextBean(123, false), false);
    assert.equal(shouldPersistFreeTextBean(null, false), false);
  });
});

describe("本地配方库与反馈 schema", () => {
  it("loadAll/saveAll 往返一致；文件缺失返回空库", () => {
    assert.deepEqual(loadAll(tmpFile("nope.json")), []);
    const file = tmpFile("recipes.json");
    const entry = { id: "r1", createdAt: "", recipe: { name: "x" } };
    saveAll([entry] as never, file);
    const list = loadAll(file);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "r1");
  });

  it("refUrls/beanSnapshot/researchSummary 新字段持久化往返；旧条目无新字段仍正常读取（任务 #35）", () => {
    const file = tmpFile("recipes.json");
    const withMeta: StoredRecipe = {
      id: "r-new",
      createdAt: "",
      recipe: { name: "带调研元数据" } as never,
      refUrls: ["https://example.com/a"],
      beanSnapshot: "埃塞 Elto SFW 蜜处理 74158",
      researchSummary: "调研摘要文本",
    };
    const legacy: StoredRecipe = {
      id: "r-old",
      createdAt: "",
      recipe: { name: "旧条目" } as never,
    };
    saveAll([withMeta, legacy], file);
    const list = loadAll(file);
    assert.equal(list.length, 2);
    assert.deepEqual(list[0].refUrls, ["https://example.com/a"]);
    assert.equal(list[0].beanSnapshot, "埃塞 Elto SFW 蜜处理 74158");
    assert.equal(list[0].researchSummary, "调研摘要文本");
    // 旧条目无新字段也正常（向后兼容）
    assert.equal(list[1].refUrls, undefined);
    assert.equal(list[1].beanSnapshot, undefined);
  });

  it("已验证 cloudTableId 随本地历史持久化，旧条目保持兼容", () => {
    const file = tmpFile("recipes-cloud-binding.json");
    const bound: StoredRecipe = {
      id: "r-cloud",
      createdAt: "",
      recipe: { name: "云端绑定" } as never,
      cloudTableId: "123456",
    };
    const legacy: StoredRecipe = {
      id: "r-local",
      createdAt: "",
      recipe: { name: "本地" } as never,
    };
    saveAll([bound, legacy], file);
    const loaded = loadAll(file);
    assert.equal(loaded[0].cloudTableId, "123456");
    assert.equal(loaded[1].cloudTableId, undefined);
  });
});

describe("烘焙商参考方案原文持久化（任务 #57）", () => {
  it("sanitizeRoasterReference：非字符串/空白返回 undefined，非空 trim 后原样返回", () => {
    assert.equal(sanitizeRoasterReference(undefined), undefined);
    assert.equal(sanitizeRoasterReference(42), undefined);
    assert.equal(sanitizeRoasterReference("   \n  "), undefined);
    assert.equal(sanitizeRoasterReference("  总水 200g 三段式  "), "总水 200g 三段式");
  });

  it("sanitizeRoasterReference：超过 ROASTER_REFERENCE_MAX 截断至上限", () => {
    const long = "咖".repeat(ROASTER_REFERENCE_MAX + 500);
    const out = sanitizeRoasterReference(long);
    assert.equal(out?.length, ROASTER_REFERENCE_MAX);
    assert.equal(out, long.slice(0, ROASTER_REFERENCE_MAX));
  });

  it("POST 落库/GET 读取：携带 roasterReference 的条目持久化往返；旧条目无此字段仍正常（向后兼容）", () => {
    const file = tmpFile("recipes.json");
    // 模拟 POST /api/recipes 白名单透传：清洗后非空才落字段
    const cleaned = sanitizeRoasterReference("  烘焙商建议：15g 粉 240g 水，92℃  ");
    const withRef: StoredRecipe = {
      id: "r-ref",
      createdAt: "",
      recipe: { name: "带烘焙商参考" } as never,
      ...(cleaned ? { roasterReference: cleaned } : {}),
    };
    const legacy: StoredRecipe = {
      id: "r-old",
      createdAt: "",
      recipe: { name: "旧条目" } as never,
    };
    saveAll([withRef, legacy], file);
    const list = loadAll(file);
    assert.equal(list.length, 2);
    assert.equal(list[0].roasterReference, "烘焙商建议：15g 粉 240g 水，92℃");
    assert.equal(list[1].roasterReference, undefined);
  });

  it("POST 落库：超长 roasterReference 截断后落库，GET 读回长度为上限", () => {
    const file = tmpFile("recipes.json");
    const cleaned = sanitizeRoasterReference("x".repeat(ROASTER_REFERENCE_MAX + 1));
    const entry: StoredRecipe = {
      id: "r-long",
      createdAt: "",
      recipe: { name: "超长参考" } as never,
      ...(cleaned ? { roasterReference: cleaned } : {}),
    };
    saveAll([entry], file);
    assert.equal(loadAll(file)[0].roasterReference?.length, ROASTER_REFERENCE_MAX);
  });

  it("POST 落库：空/非字符串 roasterReference 不落字段", () => {
    const file = tmpFile("recipes.json");
    const cleanedEmpty = sanitizeRoasterReference("   ");
    const cleanedNonStr = sanitizeRoasterReference(123);
    const entry: StoredRecipe = {
      id: "r-empty",
      createdAt: "",
      recipe: { name: "无参考" } as never,
      ...(cleanedEmpty ? { roasterReference: cleanedEmpty } : {}),
      ...(cleanedNonStr ? { roasterReference: cleanedNonStr } : {}),
    };
    saveAll([entry], file);
    assert.equal("roasterReference" in loadAll(file)[0], false);
  });
});

describe("反馈味型与 schema 校验", () => {
  it("TASTE_TAGS：五味型标签 + 三枚风味维度标签", () => {
    assert.deepEqual(
      [...TASTE_TAGS],
      ["偏酸", "偏苦", "偏弱", "过强", "平衡", "香气不足", "风味不突出", "甜感不足"],
    );
  });

  it("FeedbackSchema：合法反馈通过；越界 rating / 空 taste / 非法标签拒绝；新风味标签合法", () => {
    assert.equal(FeedbackSchema.safeParse({ rating: 4, taste: ["偏酸"] }).success, true);
    assert.equal(
      FeedbackSchema.safeParse({ rating: 4, taste: ["偏酸"], note: "干净" }).success,
      true,
    );
    assert.equal(
      FeedbackSchema.safeParse({ rating: 4, taste: ["香气不足", "甜感不足"] }).success,
      true,
    );
    assert.equal(FeedbackSchema.safeParse({ rating: 0, taste: ["偏酸"] }).success, false);
    assert.equal(FeedbackSchema.safeParse({ rating: 6, taste: ["偏酸"] }).success, false);
    assert.equal(FeedbackSchema.safeParse({ rating: 4, taste: [] }).success, false);
    assert.equal(FeedbackSchema.safeParse({ rating: 4, taste: ["太淡"] }).success, false);
  });
});

describe("自动审查 findings 清洗（任务 #36）", () => {
  it("合法 findings 保留；非法形状/空数组/非数组 → undefined", () => {
    const ok = sanitizeReviewFindings([
      { level: "warn", rule: "bloom-pausing", message: "闷蒸不足", suggestion: "提升" },
      {
        level: "error",
        rule: "start-temp-special-process",
        message: "水温超标",
        suggestion: "降温",
      },
    ]);
    assert.equal(ok?.length, 2);
    assert.equal(sanitizeReviewFindings([{ level: "info", rule: "x" }]), undefined);
    assert.equal(sanitizeReviewFindings([]), undefined);
    assert.equal(sanitizeReviewFindings("not-array"), undefined);
    assert.equal(sanitizeReviewFindings(undefined), undefined);
  });

  it("非法条目被过滤，超长字段被截断", () => {
    const res = sanitizeReviewFindings([
      null,
      42,
      { level: "warn", rule: "r", message: "m".repeat(500), suggestion: "s" },
    ]);
    assert.equal(res?.length, 1);
    assert.equal(res![0].message.length, 300);
  });
});

describe("版本链与反馈追溯", () => {
  it("deriveVersion：无 parent → undefined；parent 未标版本视为 v1 → 2；逐级 +1", () => {
    assert.equal(deriveVersion(undefined), undefined);
    assert.equal(deriveVersion(null), undefined);
    assert.equal(deriveVersion({}), 2);
    assert.equal(deriveVersion({ version: 1 }), 2);
    assert.equal(deriveVersion({ version: 4 }), 5);
  });

  it("buildFeedbackEntry：feedback 条目携带唯一 id 与 createdAt（feedbackId 返回契约）", () => {
    const a = buildFeedbackEntry({ rating: 3, taste: ["偏酸"] });
    const b = buildFeedbackEntry({ rating: 3, taste: ["偏酸"] });
    assert.ok(a.id && /^[0-9a-f-]{36}$/.test(a.id));
    assert.ok(a.createdAt);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(a.taste, ["偏酸"]);
  });

  it("backfillResulting：命中 parent 的 sourceFeedback 条目并写入 resultingRecipeId；未命中返回 false", () => {
    const fb = buildFeedbackEntry({ rating: 2, taste: ["偏酸"] });
    const parent: StoredRecipe = {
      id: "p1",
      createdAt: "",
      recipe: {} as never,
      feedbacks: [fb],
    };
    const list: StoredRecipe[] = [parent];
    assert.equal(backfillResulting(list, "p1", fb.id!, "r-new"), true);
    assert.equal(parent.feedbacks![0].resultingRecipeId, "r-new");
    assert.equal(backfillResulting(list, "p1", "不存在", "r-x"), false);
    assert.equal(backfillResulting(list, "不存在", fb.id!, "r-x"), false);
  });
});

describe("反馈调参提示词（feedbackSection）", () => {
  const baseRecipe = {
    name: "基础版",
    cupType: "xdripper",
    doseGrams: 15,
    grinderSize: 60,
    rpm: 90,
    grandWater: 234,
    pours: [
      { volume: 60, temperature: 92, flowRate: 3.2, pattern: "center", pausing: 35 },
      { volume: 174, temperature: 92, flowRate: 3.2, pattern: "circular", pausing: 0 },
    ],
  };
  const feedback = { rating: 3, taste: ["偏酸"], note: "尾韵短" };

  it("无历史反馈时仍输出基础调参段；含 dial-in 纪律与 changeNotes 要求", () => {
    const text = feedbackSection(baseRecipe, feedback);
    assert.ok(text);
    assert.ok(text!.includes("基于冲煮反馈的调参重生成"));
    assert.ok(text!.includes("上一版关键参数"));
    assert.ok(text!.includes("每轮最多只改 1-2 个变量"));
    // 任务 #60：烘焙商骨架来源的 dial-in 约束
    assert.ok(
      text!.includes(
        "若 baseRecipe 源自烘焙商骨架，dial-in 优先改水温/研磨，节奏调整以不破坏段数为限",
      ),
    );
    assert.ok(text!.includes("changeNotes"));
    assert.ok(!text!.includes("历史反馈"));
  });

  it("注入 lineage 历史反馈：文本包含“历史反馈”要素与防震荡约束，且至多取最近 5 条", () => {
    const history = Array.from({ length: 7 }, (_, i) => ({
      rating: 3,
      taste: ["偏酸"],
      createdAt: `2026-08-0${(i % 9) + 1}T00:00:00Z`,
      note: `第${i + 1}轮`,
    }));
    const text = feedbackSection(baseRecipe, feedback, history);
    assert.ok(text);
    assert.ok(text!.includes("历史反馈"));
    assert.ok(text!.includes("最近 5 条"));
    assert.ok(text!.includes("不得反向推翻上一轮"));
    assert.ok(!text!.includes("第1轮")); // 最早的被截掉
    assert.ok(text!.includes("第7轮"));
  });

  it("风味维度规则分支：香气/风味不突出与甜感不足均有专属指引", () => {
    const text = feedbackSection(baseRecipe, { rating: 3, taste: ["香气不足"] });
    assert.ok(text!.includes("香气不足 / 风味不突出"));
    assert.ok(text!.includes("bypass"));
    assert.ok(text!.includes("甜感不足"));
  });

  it("反馈或基础配方非法时返回 null（降级为普通生成）", () => {
    assert.equal(feedbackSection(baseRecipe, { rating: 9, taste: [] }), null);
    assert.equal(feedbackSection({ name: "不完整" }, feedback), null);
  });
});

describe("烘焙商参考方案注入（任务 #38）", () => {
  const sample =
    "冲煮建议信息：\n12g粉-200g水\n95°C40 #20-25格\n0.00 注水到30克\n0.30 注水到70克\n1.00 注水到110克\n1.30 注水到160克\n2.00注水到200克";

  it("原文保留换行原样注入，块首标题、块尾骨架纪律提示齐备", () => {
    const text = roasterReferenceSection(sample);
    assert.ok(text);
    assert.ok(text!.startsWith("【烘焙商参考方案】\n"));
    assert.ok(text!.includes("0.30 注水到70克\n1.00 注水到110克"));
    assert.ok(text!.includes("以上烘焙商方案的时间轴、分段结构与累计注水比例是必须逐段复刻的骨架"));
    assert.ok(text!.includes("仅水温与研磨按处理法/焙度/滤杯规则裁决"));
    assert.ok(text!.includes("按烘焙商各段累计占比等比缩放各段注水量"));
    // 任务 #60：骨架声明改为引用《规则优先级》L2，不再独立宣称最高优先级
    assert.ok(text!.includes("按《规则优先级与冲突裁决》总表定位为 L2 级"));
    assert.ok(
      text!.includes(
        "粉量被用户可用豆量覆盖（L1）时，按 L1→L2 重算总水后按各段占比等比缩放，段数与停顿不变",
      ),
    );
    assert.ok(!text!.includes("最高优先级"));
  });

  it("空/空白/非字符串返回 null", () => {
    assert.equal(roasterReferenceSection(""), null);
    assert.equal(roasterReferenceSection("   \n  "), null);
    assert.equal(roasterReferenceSection(undefined), null);
    assert.equal(roasterReferenceSection(123), null);
  });

  it("超过上限截断至 4000 字符", () => {
    const long = "冲".repeat(ROASTER_REFERENCE_MAX + 500);
    const text = roasterReferenceSection(long);
    assert.ok(text);
    assert.ok(text!.includes("冲".repeat(ROASTER_REFERENCE_MAX)));
    assert.ok(!text!.includes("冲".repeat(ROASTER_REFERENCE_MAX + 1)));
  });
});

describe("任务 #125：滤杯转换标注（roasterReferenceSection + detectDripperSignal）", () => {
  it("detectDripperSignal：V60/Kalita/Orea/Chemex/Origami/AeroPress 均可检出", () => {
    assert.ok(detectDripperSignal("V60 手冲参数表").includes("v60"));
    assert.ok(detectDripperSignal("Kalita Wave 冲煮").includes("kalita"));
    assert.ok(detectDripperSignal("Orea v3 recipe").includes("orea"));
    assert.ok(detectDripperSignal("Chemex 6 cups").includes("chemex"));
    assert.ok(detectDripperSignal("Origami 滤杯").includes("origami"));
    assert.ok(detectDripperSignal("AeroPress recipe").includes("aeropress"));
    // 多词同时检出
    const multi = detectDripperSignal("V60 和 Kalita 对比冲煮");
    assert.ok(multi.includes("v60"));
    assert.ok(multi.includes("kalita"));
  });

  it("detectDripperSignal：无他滤杯词返回空数组", () => {
    assert.deepEqual(detectDripperSignal("12g 粉 200g 水 92℃"), []);
    assert.deepEqual(detectDripperSignal(""), []);
  });

  it("detectDripperSignal：xbloom/omni 不判为他滤杯", () => {
    assert.deepEqual(detectDripperSignal("xBloom Omni Dripper 官方滤杯方案"), []);
  });

  it("roasterReference 含 V60 时注入【滤杯转换参考】块", () => {
    const v60Ref =
      "V60 冲煮建议：\n15g 粉 240g 水\n92℃ #20\n0:00 注水到 50g\n0:45 注水到 120g\n1:30 注水到 240g";
    const text = roasterReferenceSection(v60Ref);
    assert.ok(text);
    assert.ok(text!.includes("【滤杯转换参考】"));
    assert.ok(text!.includes("V60（锥形）→ xBloom 官方滤杯"));
    assert.ok(text!.includes("研磨 +2~4"));
    assert.ok(text!.includes("水温 -1~2℃"));
    assert.ok(text!.includes("段数/比例/闷蒸忠实复刻"));
    assert.ok(text!.includes("烘焙商为 X 滤杯参数，已按 xBloom 官方滤杯修正"));
  });

  it("roasterReference 含 Orea 时注入 Orea 专属转换规则", () => {
    const oreaRef = "Orea 冲煮方案：\n12g 粉 200g 水\n93℃ #18\n0:00 注水到 40g\n1:00 注水到 200g";
    const text = roasterReferenceSection(oreaRef);
    assert.ok(text);
    assert.ok(text!.includes("【滤杯转换参考】"));
    assert.ok(text!.includes("Orea（平底快流速）→ xBloom 官方滤杯"));
    assert.ok(text!.includes("研磨维持或略细 -1~2"));
    assert.ok(text!.includes("补偿快流速带来的萃取不足风险"));
  });

  it("roasterReference 含 Chemex 时注入厚滤纸高萃取修正", () => {
    const chemexRef = "Chemex 冲煮：15g 粉 250g 水 90℃";
    const text = roasterReferenceSection(chemexRef);
    assert.ok(text);
    assert.ok(text!.includes("Chemex → xBloom 官方滤杯"));
    assert.ok(text!.includes("研磨 +3~5"));
    assert.ok(text!.includes("厚滤纸高萃取"));
  });

  it("roasterReference 含 AeroPress 时标注不可机械转换", () => {
    const apRef = "AeroPress 浸泡 1:15 80℃";
    const text = roasterReferenceSection(apRef);
    assert.ok(text);
    assert.ok(text!.includes("AeroPress → xBloom 官方滤杯"));
    assert.ok(text!.includes("机理完全不同"));
    assert.ok(text!.includes("不可机械转换"));
  });

  it("roasterReference 不含他滤杯词时不追加转换块", () => {
    const normal = "冲煮建议：\n15g 粉 240g 水\n92℃ #20\n0:00 注水到 50g\n0:45 注水到 240g";
    const text = roasterReferenceSection(normal);
    assert.ok(text);
    assert.ok(!text!.includes("【滤杯转换参考】"));
    assert.ok(!text!.includes("烘焙商为 X 滤杯参数"));
  });

  it("roasterReference 含多他滤杯词时每个均注入对应转换行", () => {
    const multi = "V60 与 Kalita 对比冲煮：15g 粉 240g 水";
    const text = roasterReferenceSection(multi);
    assert.ok(text);
    assert.ok(text!.includes("V60（锥形）→ xBloom 官方滤杯"));
    assert.ok(text!.includes("Kalita Wave → xBloom 官方滤杯"));
  });
});

describe("自动修正触发条件（任务 #36）", () => {
  const warn = { level: "warn" as const, rule: "r", message: "m", suggestion: "s" };
  const error = { level: "error" as const, rule: "r", message: "m", suggestion: "s" };
  it("含 error 触发；warn ≥2 触发；单个 warn / 空清单不触发", () => {
    assert.equal(needsAutoFix([error]), true);
    assert.equal(needsAutoFix([warn, warn]), true);
    assert.equal(needsAutoFix([error, warn]), true);
    assert.equal(needsAutoFix([warn]), false);
    assert.equal(needsAutoFix([]), false);
  });
});

describe("可用粉量覆盖（任务 #58）", () => {
  it("parseAvailableDoseGrams：合法数字原样返回；undefined/null 视为未提供", () => {
    assert.equal(parseAvailableDoseGrams(12), 12);
    assert.equal(parseAvailableDoseGrams(1), 1);
    assert.equal(parseAvailableDoseGrams(AVAILABLE_DOSE_MAX), 200);
    assert.equal(parseAvailableDoseGrams(12.5), 12.5);
    assert.equal(parseAvailableDoseGrams(undefined), undefined);
    assert.equal(parseAvailableDoseGrams(null), undefined);
  });

  it("越界/非数字抛 zod 错误（路由层转 400）", () => {
    assert.throws(() => parseAvailableDoseGrams(0));
    assert.throws(() => parseAvailableDoseGrams(-3));
    assert.throws(() => parseAvailableDoseGrams(201));
    assert.throws(() => parseAvailableDoseGrams("12"));
    assert.throws(() => parseAvailableDoseGrams(NaN));
    assert.throws(() => parseAvailableDoseGrams({}));
  });

  it("注入文案含“仅 X 克 / 必须按 X 克制定 / 不得高于 X 克”硬约束；未提供返回 null", () => {
    const text = availableDoseSection(12);
    assert.ok(text);
    assert.ok(text!.startsWith("【可用粉量约束"));
    assert.ok(text!.includes("用户现有豆量仅 12 克"));
    assert.ok(text!.includes("本方案 dose 必须按 12 克制定"));
    assert.ok(text!.includes("不得高于 12 克"));
    assert.ok(text!.includes("粉水比可达性"));
    assert.equal(availableDoseSection(undefined), null);
  });
});

describe("LLM 双 key 兜底配置", () => {
  it("模型 ID 一律从配置读取且非空（主/第二兜底）", () => {
    assert.ok(config.llm.model.length > 0, "主模型不能为空");
    assert.ok(config.llm.fallbackModel.length > 0, "第二兜底模型不能为空");
  });

  it("modelChain：主 → 第二兜底 → 第三兜底，去重去空", () => {
    const chain = modelChain(config.llm.model);
    assert.equal(chain[0], config.llm.model);
    if (config.llm.fallbackModel && config.llm.fallbackModel !== config.llm.model) {
      assert.ok(chain.includes(config.llm.fallbackModel));
    }
    if (config.llm.thirdModel) {
      assert.ok(chain.includes(config.llm.thirdModel));
    }
    // 去重
    assert.equal(new Set(chain).size, chain.length);
  });

  it("keyForModel：Claude 系模型用兜底渠道 key，其余（GPT 系）用主 key", () => {
    const { apiKey, fallbackApiKey, fallbackModel } = config.llm;
    assert.equal(keyForModel(config.llm.model), apiKey);
    if (fallbackModel.toLowerCase().startsWith("claude") && fallbackApiKey) {
      assert.equal(keyForModel(fallbackModel), fallbackApiKey);
      // 兜底渠道 key 与主 key 相互独立
      assert.notEqual(apiKey, fallbackApiKey);
    }
  });

  it("keyForModel：原生 Anthropic 协议不读取兼容网关的兜底 key", () => {
    const previous = { ...config.llm };
    try {
      config.llm.provider = "anthropic";
      config.llm.apiKey = "native-primary";
      config.llm.fallbackApiKey = "gateway-fallback";
      assert.equal(keyForModel("claude-model"), "native-primary");
    } finally {
      Object.assign(config.llm, previous);
    }
  });
});

describe("规则优先级与冲突裁决提示词（任务 #60）", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const prompt = fs.readFileSync(path.resolve(here, "../src/prompts/brew-system.md"), "utf8");
  const knowledge = fs.readFileSync(
    path.resolve(here, "../src/knowledge/brewing-reference.md"),
    "utf8",
  );

  it("七层优先级总表完整（L0-L7）", () => {
    assert.ok(prompt.includes("## 3. 规则优先级与冲突裁决（总表）"));
    for (const layer of [
      "L0 平台硬约束",
      "L1 用户显式事实覆盖",
      "L2 烘焙商参考方案骨架",
      "L3 领域硬规则",
      "L4 联网调研摘要",
      "L5 豆属性经验规则",
      "L6 知识库模板",
      "L7 默认值",
    ]) {
      assert.ok(prompt.includes(layer), `缺少层级 ${layer}`);
    }
  });

  it("显式裁决条款关键句存在", () => {
    assert.ok(prompt.includes("当 L1 粉量覆盖与 L2 骨架冲突时"));
    assert.ok(prompt.includes("当 L0 可达性缩放与 L2 骨架冲突时"));
    assert.ok(prompt.includes("禁止改用低粉量模板重建骨架"));
    assert.ok(prompt.includes("当 L3 降温上限与裁决折中冲突时"));
    assert.ok(prompt.includes("不存在突破上限的折中"));
    assert.ok(prompt.includes("当闷蒸下限与 L2 冲突时"));
    assert.ok(prompt.includes("忠实复刻烘焙商骨架不视为雷同违规"));
    assert.ok(prompt.includes("当 L4 调研与 L2 用户粘贴冲突时"));
    assert.ok(prompt.includes("以 L2 为准"));
    // AI 改进版模式 L2 豁免条款（任务 #105 C4）：总表中有显式豁免位
    assert.ok(prompt.includes("当请求含【AI 改进版生成】段时"));
    assert.ok(prompt.includes("L2 骨架由复刻义务降级为改进基线"));
  });

  it("负面清单关键句存在", () => {
    assert.ok(prompt.includes("**负面清单**"));
    assert.ok(prompt.includes("输出不可达 ratio / 非整数分段"));
    assert.ok(prompt.includes("改 L2 段数"));
    assert.ok(prompt.includes("照搬 V60 偏细研磨"));
    assert.ok(prompt.includes("劝用户改粉量"));
  });

  it("矛盾措辞已消歧（绝对上限 / C40 钳位 / 闷蒸豁免 / L6 注解 / 双“最高”消除）", () => {
    // 92℃ 绝对上限：提示词与知识库表述一致，不再留“折中可接近上限”口径
    assert.ok(prompt.includes("92℃ 是绝对上限，不存在突破上限的折中"));
    assert.ok(knowledge.includes("92℃ 是绝对上限，不存在突破上限的折中"));
    // C40 换算保持内部/云端 40-120 标尺，BLE 下发再映射到设备 1-80。
    assert.ok(prompt.includes("换算结果钳位 40-120"));
    assert.ok(prompt.includes("BLE 下发时再映射到设备 1-80"));
    assert.ok(!prompt.includes("不是换算钳位边界"));
    assert.ok(!prompt.includes("换算结果钳位 40-80"));
    // 闷蒸 L2 豁免条款
    assert.ok(prompt.includes("L2 豁免条款"));
    // 知识库 §10 低粉量模板 L6 注解
    assert.ok(knowledge.includes("本表所有数值仅当无烘焙商方案时生效"));
    // 原“优先参考”模糊表述已改为引用总表
    assert.ok(prompt.includes("用户显式粘贴的烘焙商方案 = L2，联网调研摘要 = L4"));
    assert.ok(!prompt.includes("以其中的豆子信息与建议冲煮参数为优先参考"));
  });

  it("改进版输出约定：brew-system.md 输出要求含 improvementNotes 说明（任务 #61）", () => {
    assert.ok(prompt.includes("improvementNotes"));
    assert.ok(prompt.includes("【AI 改进版生成（任务 #61：双方案对比）】"));
  });
});

describe("双方案生成闸门（任务 #61）", () => {
  const roaster = "12g粉-200g水\n95°C 三段式\n0.00 注水到30克";

  it("真值表：无 roasterReference / 带 feedback / 带 baseRecipe / 三者齐备", () => {
    assert.equal(shouldRunDualGeneration({}), false);
    assert.equal(shouldRunDualGeneration({ roasterReference: "   " }), false);
    assert.equal(
      shouldRunDualGeneration({
        roasterReference: roaster,
        feedback: { rating: 3, taste: ["偏酸"] },
      }),
      false,
    );
    assert.equal(
      shouldRunDualGeneration({ roasterReference: roaster, baseRecipe: { name: "基础" } }),
      false,
    );
    assert.equal(
      shouldRunDualGeneration({ roasterReference: roaster, baseRecipe: {}, feedback: {} }),
      false,
    );
    assert.equal(shouldRunDualGeneration({ roasterReference: roaster }), true);
  });

  it("空白/非字符串 roasterReference → 不触发双方案", () => {
    assert.equal(shouldRunDualGeneration({ roasterReference: "" }), false);
    assert.equal(shouldRunDualGeneration({ roasterReference: 123 }), false);
    assert.equal(shouldRunDualGeneration({ roasterReference: undefined }), false);
  });
});

describe("AI 改进版 prompt 段（任务 #61）", () => {
  const faithful = JSON.stringify({ name: "原版", grandWater: 198, doseGrams: 12 }, null, 2);
  const roaster = "12g粉-200g水\n95°C 研磨 #20-25格";

  it("内容要点：原版基线 + 1-3 变量 + 逐项理由 + L0 硬约束 + improvementNotes 结构与来源标注", () => {
    const text = improvedVariantSection(roaster, faithful);
    assert.ok(text.startsWith("【AI 改进版生成（任务 #61：双方案对比）】"));
    assert.ok(text.includes(faithful)); // 原版 JSON 作为基线嵌入
    assert.ok(text.includes(roaster)); // 烘焙商原文嵌入
    assert.ok(text.includes("1-3 个变量"));
    for (const v of ["水温", "研磨", "比例", "节奏", "bypass"]) {
      assert.ok(text.includes(v), `缺少变量 ${v}`);
    }
    assert.ok(text.includes("逐项说明理由"));
    assert.ok(text.includes("L0 平台硬约束"));
    assert.ok(text.includes("0.1 步进可达性"));
    assert.ok(text.includes("整数毫升"));
    assert.ok(text.includes("SAFE_LIMITS"));
    assert.ok(text.includes("improvementNotes"));
    assert.ok(text.includes("param, from, to, rationale, expectedFlavor"));
    assert.ok(text.includes("联网调研 URL 编号"));
    assert.ok(text.includes("知识库章节"));
    assert.ok(text.includes("至多 5 条"));
  });

  it("roasterText 复用 ROASTER_REFERENCE_MAX 截断逻辑", () => {
    const long = "冲".repeat(ROASTER_REFERENCE_MAX + 100);
    const text = improvedVariantSection(long, faithful);
    assert.ok(text.includes("冲".repeat(ROASTER_REFERENCE_MAX)));
    assert.ok(!text.includes("冲".repeat(ROASTER_REFERENCE_MAX + 1)));
  });

  it("空 roasterText 不输出参照块，仍以原版 JSON 为基线", () => {
    const text = improvedVariantSection(undefined, faithful);
    assert.ok(text.includes(faithful));
    assert.ok(!text.includes("烘焙商参考方案原文（改进参照）"));
  });
});

describe("improvementNotes 清洗（任务 #61）", () => {
  const mkNote = (i: number) => ({
    param: `参数${i}`,
    from: "93℃",
    to: "91℃",
    rationale: "知识库 §3 厌氧降温",
    expectedFlavor: "减少苦涩杂味",
  });

  it("合法数组保留；字段截断上限生效（param≤20/from,to≤30/rationale≤120/expectedFlavor≤80）", () => {
    const res = sanitizeImprovementNotes([
      {
        param: "p".repeat(50),
        from: "f".repeat(60),
        to: "t".repeat(60),
        rationale: "r".repeat(200),
        expectedFlavor: "e".repeat(100),
      },
    ]);
    assert.equal(res?.length, 1);
    assert.equal(res![0].param.length, 20);
    assert.equal(res![0].from.length, 30);
    assert.equal(res![0].to.length, 30);
    assert.equal(res![0].rationale.length, 120);
    assert.equal(res![0].expectedFlavor.length, 80);
  });

  it("from/to 兼容模型输出数字（转为文本）", () => {
    const res = sanitizeImprovementNotes([
      { param: "研磨", from: 70, to: 66, rationale: "知识库 §3", expectedFlavor: "更细提萃" },
    ]);
    assert.deepEqual(res?.[0].from, "70");
    assert.deepEqual(res?.[0].to, "66");
  });

  it("非数组/空数组整体丢弃（undefined，不阻塞）", () => {
    assert.equal(sanitizeImprovementNotes("not-array"), undefined);
    assert.equal(sanitizeImprovementNotes({ param: "x" }), undefined);
    assert.equal(sanitizeImprovementNotes(undefined), undefined);
    assert.equal(sanitizeImprovementNotes([]), undefined);
  });

  it("超条数截断至 5 条", () => {
    const many = Array.from({ length: 8 }, (_, i) => mkNote(i));
    const res = sanitizeImprovementNotes(many);
    assert.equal(res?.length, IMPROVEMENT_NOTES_MAX);
    assert.equal(res![0].param, "参数0");
    assert.equal(res![IMPROVEMENT_NOTES_MAX - 1].param, `参数${IMPROVEMENT_NOTES_MAX - 1}`);
  });

  it("缺字段/类型不符的条目剔除，其余保留", () => {
    const res = sanitizeImprovementNotes([
      { param: "水温", to: "91℃", rationale: "r", expectedFlavor: "e" }, // 缺 from
      { from: "93℃", to: "91℃", rationale: "r", expectedFlavor: "e" }, // 缺 param
      { param: "水温", from: "93℃", to: "91℃", rationale: 42, expectedFlavor: "e" }, // rationale 非字符串
      null,
      42,
      mkNote(9),
    ]);
    assert.equal(res?.length, 1);
    assert.equal(res![0].param, "参数9");
  });
});

describe("双方案尾段失败降级（任务 #61）", () => {
  it("variantFailEvent：ok:false 分支归一 Error/字符串/未知错误为尾事件", () => {
    const ev = variantFailEvent(new Error("未能从模型输出中提取到合法的配方 JSON"));
    assert.deepEqual(
      { type: ev.type, stage: ev.stage, ok: ev.ok },
      {
        type: "variant",
        stage: "result",
        ok: false,
      },
    );
    assert.ok(ev.message.includes("未能从模型输出中提取到合法的配方 JSON"));
    assert.ok(variantFailEvent("上游超时").message.includes("上游超时"));
    assert.ok(variantFailEvent(undefined).message.includes("未知错误"));
  });
});

describe("双方案 variant/pairId 持久化（任务 #61）", () => {
  it("saveAll/loadAll 往返：variant/pairId 落库可读回；旧条目无此字段仍正常", () => {
    const file = tmpFile("recipes.json");
    const pair = "pair-61-demo";
    const original: StoredRecipe = {
      id: "r-a",
      createdAt: "",
      recipe: { name: "林波波复刻" } as never,
      variant: "original",
      pairId: pair,
    };
    const improved: StoredRecipe = {
      id: "r-b",
      createdAt: "",
      recipe: { name: "林波波复刻· AI 改进版" } as never,
      variant: "improved",
      pairId: pair,
    };
    const legacy: StoredRecipe = {
      id: "r-old",
      createdAt: "",
      recipe: { name: "旧条目" } as never,
    };
    saveAll([original, improved, legacy], file);
    const list = loadAll(file);
    assert.equal(list.length, 3);
    assert.equal(list[0].variant, "original");
    assert.equal(list[0].pairId, pair);
    assert.equal(list[1].variant, "improved");
    assert.equal(list[1].pairId, pair);
    assert.equal(list[2].variant, undefined);
    assert.equal(list[2].pairId, undefined);
  });

  it("POST 白名单语义：variant 仅接受枚举值；pairId 非空字符串才落，空值不落字段", () => {
    // 照 POST /api/recipes 白名单透传逻辑：与 beanId 模式一致
    const mk = (variant: unknown, pairId: unknown): StoredRecipe => ({
      id: "r-x",
      createdAt: "",
      recipe: { name: "x" } as never,
      ...(variant === "original" || variant === "improved" ? { variant } : {}),
      ...(typeof pairId === "string" && pairId.trim() ? { pairId: pairId.trim() } : {}),
    });
    assert.equal("variant" in mk("hacked", "p1"), false);
    assert.equal("variant" in mk(undefined, "p1"), false);
    assert.equal("pairId" in mk("original", ""), false);
    assert.equal("pairId" in mk("original", "   "), false);
    assert.equal("pairId" in mk("original", 123), false);
    assert.equal(mk("improved", " p1 ").pairId, "p1");
    assert.equal(mk("original", "p1").variant, "original");
  });
});

describe("方案解读 brewRationale 清洗与持久化（任务 #72）", () => {
  const mkItem = (i: number) => ({
    param: `参数${i}`,
    choice: "92℃ 三段式",
    basis: "知识库 §3 厌氧降温；L2 烘焙商骨架",
  });

  it("合法数组保留；字段截断上限生效（param/choice ≤30、basis ≤160）", () => {
    const res = sanitizeBrewRationale([
      { param: "p".repeat(50), choice: "c".repeat(50), basis: "b".repeat(200) },
    ]);
    assert.equal(res?.length, 1);
    assert.equal(res![0].param.length, 30);
    assert.equal(res![0].choice.length, 30);
    assert.equal(res![0].basis.length, 160);
  });

  it("非数组/空数组/条目全空字段 → 整体丢弃（undefined，不阻塞）", () => {
    assert.equal(sanitizeBrewRationale("not-array"), undefined);
    assert.equal(sanitizeBrewRationale({ param: "x" }), undefined);
    assert.equal(sanitizeBrewRationale(undefined), undefined);
    assert.equal(sanitizeBrewRationale([]), undefined);
    assert.equal(sanitizeBrewRationale([{ param: "", choice: "", basis: "" }]), undefined);
  });

  it("缺字段/类型不符的条目剔除，其余保留；超条数截断至 8 条", () => {
    const res = sanitizeBrewRationale([
      { param: "水温", choice: "92℃" }, // 缺 basis
      { param: "研磨", choice: 60, basis: "知识库 §8" }, // choice 非字符串
      { choice: "三段式", basis: "L2 烘焙商骨架" }, // 缺 param
      null,
      42,
      mkItem(5),
    ]);
    assert.equal(res?.length, 1);
    assert.equal(res![0].param, "参数5");

    const many = Array.from({ length: 12 }, (_, i) => mkItem(i));
    const capped = sanitizeBrewRationale(many);
    assert.equal(capped?.length, BREW_RATIONALE_MAX);
    assert.equal(capped![0].param, "参数0");
    assert.equal(capped![BREW_RATIONALE_MAX - 1].param, `参数${BREW_RATIONALE_MAX - 1}`);
  });

  it("POST 落库/GET 读取：合法 brewRationale 持久化往返；非法输入不落字段；旧条目无此字段仍正常", () => {
    const file = tmpFile("recipes.json");
    // 模拟 POST /api/recipes 白名单透传：清洗后非空才落字段（recipe/variant 事件同源同一清洗函数）
    const cleaned = sanitizeBrewRationale([mkItem(1)]);
    const withRationale: StoredRecipe = {
      id: "r-rationale",
      createdAt: "",
      recipe: { name: "带方案解读" } as never,
      ...(cleaned ? { brewRationale: cleaned } : {}),
    };
    const cleanedBad = sanitizeBrewRationale({ param: "非数组" });
    const legacy: StoredRecipe = {
      id: "r-old",
      createdAt: "",
      recipe: { name: "旧条目" } as never,
      ...(cleanedBad ? { brewRationale: cleanedBad } : {}),
    };
    saveAll([withRationale, legacy], file);
    const list = loadAll(file);
    assert.equal(list.length, 2);
    assert.equal(list[0].brewRationale?.length, 1);
    assert.equal(list[0].brewRationale?.[0].param, "参数1");
    assert.equal(list[0].brewRationale?.[0].basis, "知识库 §3 厌氧降温；L2 烘焙商骨架");
    // 非法输入被清洗剔除，不落字段；旧条目向后兼容
    assert.equal("brewRationale" in list[1], false);
  });
});
