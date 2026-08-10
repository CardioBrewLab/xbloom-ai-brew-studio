/**
 * 多候选生成评分器（任务 #106 首版；任务 #121 重设计为多维 rubric 加权）。
 *
 * 设计原则（业界调研提炼，任务 #121）：
 * 1. 连续距离扣分优于全有全无：每个维度按参数距理想带/中心点的连续距离扣分，
 *    提供密集排序信号（dense reward shaping），避免「全合规人人 100」的评分退化；
 * 2. 维度加权透明可解释：满分 100 按固定权重拆到 7 个维度，每维输出
 *    {key,label,weight,score,note}，前端可逐项展示得分依据；
 * 3. 保留硬否决层：veto 五项（云端校验/审查 error/段和/可达性/bypass 越界）
 *    独立于 rubric 之外，一票否决候选永远排在非否决候选之后；
 * 4. 无信号维度中性给满：焙度未知/无风味标签/无调研信号时该维度中性给满，
 *    不引入噪声、不参与区分（不幻觉评分）；
 * 5. 评分服务于排序（best-of-N）：绝对分只是相对优劣的载体，平局五级序保留。
 *
 * 一票否决（vetoed，与 #106 完全一致）：
 * - validateForTarget(recipe, "cloud") 非空（云端路径硬校验不通过）
 * - 规则审查器 error 级 finding
 * - Σ各段 volume ≠ grandWater
 * - 云端粉水比不可达（ratio 0.1 步进，isReachableCloudTotal）
 * - bypass 启用时最终比例 (grandWater + bypassVolume) / dose 越出 [12, 20]
 *
 * 维度加权 rubric（权重和 = 100）：
 * - ratio        20  粉水比最优性（金杯带 1:15-1:17，中心 1:16）
 * - tempRoast    18  水温×烘焙度匹配（知识库 §3 焙度水温带）
 * - grinderRoast 15  研磨×烘焙度匹配（GRINDER_RANGE_BY_ROAST 带内位置+中心距离）
 * - structure    17  注水结构（闷蒸水量 2-3×粉量 / 段数 vs 粉量 / 分段水温递减一致性）
 * - duration     12  总时长合理带（2:00-3:30）
 * - flavor       10  口味偏好对齐（flavorTags；无标签中性给满）
 * - research      8  调研贴合度（research 参数信号；无信号中性给满）
 *
 * 全局扣分（维度总分之上继续扣，可为负，供排序用）：
 * - review warn 每条 -8；clampRecipe clamped 留痕每条 -3；
 * - brewRationale 缺失或无一条引用知识库 §9/硬件特性 -5
 *
 * 平局五级序（pickWinner）：软分高 → clamped 少 → warn 少 → 总时长近 170s
 * → 生成完成顺序靠前。不引入 LLM judge。
 */
import {
  BYPASS_RATIO_RANGE,
  isReachableCloudTotal,
  type BrewRationaleItem,
  type Recipe,
} from "./recipe-schema.js";
import { estimateTotalSeconds, validateForTarget } from "./safety.js";
import { detectRoastLevel, GRINDER_RANGE_BY_ROAST, type RoastKey } from "./review.js";
import type { ReviewFinding } from "./review.js";

// ---------------------------------------------------------------------------
// 权重与理想带常量（调整评分策略只改这里）
// ---------------------------------------------------------------------------

/** 维度权重表（任务 #121）：和恒为 100，单测固化校验 */
export const DIMENSION_WEIGHTS = {
  ratio: 20,
  tempRoast: 18,
  grinderRoast: 15,
  structure: 17,
  duration: 12,
  flavor: 10,
  research: 8,
} as const;

export type DimensionKey = keyof typeof DIMENSION_WEIGHTS;

/** 全局扣分与平局序常量（#106 语义保留） */
export const SCORE_WEIGHTS = {
  /** review warn 每条扣分 */
  perWarn: 8,
  /** clampRecipe 留痕每条扣分 */
  perClamp: 3,
  /** brewRationale 缺失/未引用知识库 -5 */
  rationaleMissing: 5,
  /** 平局第四级：总时长靠近该目标值（s）优先 */
  tieBreakTargetSeconds: 170,
} as const;

/** 粉水比金杯带（知识库 §1）：1:15-1:17，中心 1:16 */
export const GOLDEN_RATIO_BAND = { min: 15, max: 17, center: 16 } as const;

/** 焙度 → 起步水温建议带（知识库 §3 / 提示词 §4 口径一致） */
export const TEMP_BAND_BY_ROAST: Record<RoastKey, { min: number; max: number }> = {
  light: { min: 92, max: 95 },
  "medium-light": { min: 90, max: 93 },
  medium: { min: 88, max: 92 },
  "medium-dark": { min: 85, max: 90 },
  dark: { min: 80, max: 88 },
};

/** 总时长合理带（s）：2:00-3:30，带外连续扣分 */
export const DURATION_BAND = { min: 120, max: 210 } as const;

/** 注水结构子项权重（和 = structure 维度权重 17） */
const STRUCTURE_PARTS = { bloom: 7, pourCount: 5, tempConsistency: 5 } as const;

/** 闷蒸水量理想倍数带（相对粉量；知识库 §2 名家通则 2-3×） */
const BLOOM_MULTIPLIER_BAND = { min: 2, max: 3 } as const;

/** rubric 连续扣分形状参数 */
const SHAPE = {
  /** 带内：距中心满半宽时扣掉的权重比例（带缘 = weight×(1-centerPenalty)） */
  centerPenalty: 0.25,
  /** 研磨维度带内中心惩罚（研磨带较宽，惩罚略重以强化中心趋近） */
  grinderCenterPenalty: 0.3,
  /** 带外：偏离多少个单位扣到 0 */
  ratioOutScale: 4,
  tempOutScale: 3,
  grinderOutScale: 6,
  bloomOutScale: 2,
  pourCountOutScale: 2,
  durationOutScale: 60,
} as const;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 联网调研提炼出的参数信号（任务 #121 调研贴合度维度输入） */
export interface ResearchSignals {
  temperature?: number;
  ratio?: number;
  grinderSize?: number;
}

export interface ScoreCandidateInput {
  recipe: Recipe;
  /** clampRecipe 留痕列表（空数组 = 原配方就在安全区间内） */
  clamped: string[];
  /** reviewRecipe findings */
  findings: ReviewFinding[];
  /** LLM 附加的方案解读（可选） */
  brewRationale?: BrewRationaleItem[];
  /** 用户在需求描述中显式指定了水量或粉水比 → ratio 维度中性豁免 */
  userSpecifiedRatioOrWater?: boolean;
  /** 豆信息合并文本（供焙度识别；缺失时水温/研磨维度中性给满） */
  beanText?: string;
  /** 用户风味偏好标签（如「明亮」「花果香」；缺失时 flavor 维度中性给满） */
  flavorTags?: string[];
  /** 联网调研参数信号（缺失时 research 维度中性给满） */
  researchSignals?: ResearchSignals;
}

/** 单维度评分明细（前端「优选明细」逐维展开用） */
export interface ScoreDimension {
  key: DimensionKey;
  label: string;
  weight: number;
  /** 该维度实得（0 ≤ score ≤ weight，round1） */
  score: number;
  /** 得分依据一句话说明 */
  note: string;
}

export interface CandidateScore {
  vetoed: boolean;
  vetoReasons: string[];
  /** 最终得分 = Σ维度分 − 全局扣分（warn/clamp/解读），可为负，供排序用 */
  score: number;
  warns: number;
  clamps: number;
  totalSeconds: number;
  /** 扣分标签列表（全局 warn/clamp/解读缺失；前端「优选明细」展示） */
  deductions: string[];
  /** 逐维度加权明细（任务 #121） */
  dimensions: ScoreDimension[];
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------------------
// 一票否决（与 #106 完全一致）
// ---------------------------------------------------------------------------

/** Σ各段注水是否等于 grandWater（RecipeSchema 已强校验，此处冗余兜底） */
export function pourSumEqualsGrandWater(recipe: Recipe): boolean {
  const sum = round1(recipe.pours.reduce((s, p) => s + p.volume, 0));
  return Math.abs(sum - recipe.grandWater) <= 1e-6;
}

/** bypass 启用时最终比例是否落在 [12, 20]；未启用 bypass 直接通过 */
export function bypassFinalRatioInRange(recipe: Recipe): boolean {
  if (!recipe.bypassEnabled) return true;
  const ratio = round1((recipe.grandWater + recipe.bypassVolume) / recipe.doseGrams);
  return ratio >= BYPASS_RATIO_RANGE.min && ratio <= BYPASS_RATIO_RANGE.max;
}

/**
 * 一票否决检查：返回否决原因列表（空数组 = 未否决）。
 * 注意：否决候选仍会被保留（全否决时择优兜底），但排在所有非否决候选之后。
 */
export function vetoChecks(recipe: Recipe, findings: ReviewFinding[]): string[] {
  const reasons: string[] = [];
  const targetErrors = validateForTarget(recipe, "cloud");
  if (targetErrors.length > 0) {
    reasons.push(`云端路径校验不通过（${targetErrors.length} 项）：${targetErrors[0]}`);
  }
  const errors = findings.filter((f) => f.level === "error");
  if (errors.length > 0) {
    reasons.push(`审查器 error 级违规（${errors.length} 项）：${errors[0].message}`);
  }
  if (!pourSumEqualsGrandWater(recipe)) {
    reasons.push("Σ分段注水量 ≠ grandWater");
  }
  if (!isReachableCloudTotal(recipe.doseGrams, recipe.grandWater)) {
    reasons.push(
      `云端粉水比不可达（${recipe.doseGrams}g 无法用 0.1 步进得到 ${recipe.grandWater}ml）`,
    );
  }
  if (!bypassFinalRatioInRange(recipe)) {
    const ratio = round1((recipe.grandWater + recipe.bypassVolume) / recipe.doseGrams);
    reasons.push(
      `bypass 最终比例 ${ratio} 越出 [${BYPASS_RATIO_RANGE.min}, ${BYPASS_RATIO_RANGE.max}]`,
    );
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// 连续带评分基础件：带内中心距离扣分 + 带外连续衰减（带缘取值连续衔接）
// ---------------------------------------------------------------------------

/**
 * 通用连续带评分：
 * - 带内：weight × (1 − centerPenalty × |v − center| / halfWidth)，中心满分、带缘最低；
 * - 带外：带缘值 × max(0, 1 − 越出距离 / outScale)，连续衰减至 0。
 */
function bandScore(
  value: number,
  band: { min: number; max: number },
  weight: number,
  opts: { centerPenalty: number; outScale: number },
): { score: number; deviation: number; inside: boolean } {
  const center = (band.min + band.max) / 2;
  const halfWidth = Math.max((band.max - band.min) / 2, 1e-6);
  if (value >= band.min && value <= band.max) {
    const score = weight * (1 - opts.centerPenalty * (Math.abs(value - center) / halfWidth));
    return { score, deviation: Math.abs(value - center), inside: true };
  }
  const edgeValue = weight * (1 - opts.centerPenalty);
  const dev = value < band.min ? band.min - value : value - band.max;
  return {
    score: Math.max(0, edgeValue * (1 - dev / opts.outScale)),
    deviation: dev,
    inside: false,
  };
}

// ---------------------------------------------------------------------------
// 各维度评分（纯函数）
// ---------------------------------------------------------------------------

function dimRatio(recipe: Recipe, userSpecified: boolean): ScoreDimension {
  const weight = DIMENSION_WEIGHTS.ratio;
  const effectiveWater = recipe.grandWater + (recipe.bypassEnabled ? recipe.bypassVolume : 0);
  const ratio = round1(effectiveWater / recipe.doseGrams);
  if (userSpecified) {
    return {
      key: "ratio",
      label: "粉水比最优性",
      weight,
      score: weight,
      note: `用户显式指定水量/比例（1:${ratio}），豁免偏离扣分`,
    };
  }
  const r = bandScore(ratio, GOLDEN_RATIO_BAND, weight, {
    centerPenalty: SHAPE.centerPenalty,
    outScale: SHAPE.ratioOutScale,
  });
  const note = r.inside
    ? `1:${ratio} 落在金杯带 1:15-1:17（中心 1:16，偏离 ${round1(r.deviation)}）`
    : `1:${ratio} 越出金杯带 1:15-1:17 达 ${round1(r.deviation)}，连续扣分`;
  return { key: "ratio", label: "粉水比最优性", weight, score: round1(r.score), note };
}

function dimTempRoast(recipe: Recipe, roast: RoastKey | null): ScoreDimension {
  const weight = DIMENSION_WEIGHTS.tempRoast;
  const firstTemp = recipe.pours[0]?.temperature ?? 0;
  if (!roast) {
    return {
      key: "tempRoast",
      label: "水温×烘焙度匹配",
      weight,
      score: weight,
      note: `无焙度信息，首段 ${firstTemp}℃ 中性给满`,
    };
  }
  const band = TEMP_BAND_BY_ROAST[roast];
  const r = bandScore(firstTemp, band, weight, {
    centerPenalty: SHAPE.centerPenalty,
    outScale: SHAPE.tempOutScale,
  });
  const label = GRINDER_RANGE_BY_ROAST[roast].label;
  const note = r.inside
    ? `首段 ${firstTemp}℃ 落在${label}建议带 ${band.min}-${band.max}℃`
    : `首段 ${firstTemp}℃ 越出${label}建议带 ${band.min}-${band.max}℃ 达 ${round1(r.deviation)}℃`;
  return { key: "tempRoast", label: "水温×烘焙度匹配", weight, score: round1(r.score), note };
}

function dimGrinderRoast(recipe: Recipe, roast: RoastKey | null): ScoreDimension {
  const weight = DIMENSION_WEIGHTS.grinderRoast;
  if (!roast) {
    return {
      key: "grinderRoast",
      label: "研磨×烘焙度一致性",
      weight,
      score: weight,
      note: `无焙度信息，研磨 ${recipe.grinderSize} 中性给满`,
    };
  }
  const range = GRINDER_RANGE_BY_ROAST[roast];
  const r = bandScore(recipe.grinderSize, range, weight, {
    centerPenalty: SHAPE.grinderCenterPenalty,
    outScale: SHAPE.grinderOutScale,
  });
  const center = round1((range.min + range.max) / 2);
  const note = r.inside
    ? `研磨 ${recipe.grinderSize} 在${range.label}区间 ${range.min}-${range.max}（中心 ${center}）`
    : `研磨 ${recipe.grinderSize} 越出${range.label}区间 ${range.min}-${range.max} 达 ${round1(r.deviation)}`;
  return { key: "grinderRoast", label: "研磨×烘焙度一致性", weight, score: round1(r.score), note };
}

function dimStructure(recipe: Recipe): ScoreDimension {
  const weight = DIMENSION_WEIGHTS.structure;
  const notes: string[] = [];

  // 1) 闷蒸水量：2-3×粉量，带外连续扣分
  const bloom = recipe.pours[0]?.volume ?? 0;
  const mult = recipe.doseGrams > 0 ? bloom / recipe.doseGrams : 0;
  const bloomR = bandScore(mult, BLOOM_MULTIPLIER_BAND, STRUCTURE_PARTS.bloom, {
    centerPenalty: SHAPE.centerPenalty,
    outScale: SHAPE.bloomOutScale,
  });
  notes.push(
    bloomR.inside ? `闷蒸 ${round1(mult)}×粉量` : `闷蒸 ${round1(mult)}×粉量偏离 2-3× 理想带`,
  );

  // 2) 段数 vs 粉量：低粉量（<13g）2-3 段，常规 2-5 段，带外连续扣分
  const countBand = recipe.doseGrams < 13 ? { min: 2, max: 3 } : { min: 2, max: 5 };
  const countR = bandScore(recipe.pours.length, countBand, STRUCTURE_PARTS.pourCount, {
    centerPenalty: SHAPE.centerPenalty,
    outScale: SHAPE.pourCountOutScale,
  });
  notes.push(
    countR.inside
      ? `${recipe.pours.length} 段在 ${countBand.min}-${countBand.max} 段合理带`
      : `${recipe.pours.length} 段偏离 ${countBand.min}-${countBand.max} 段合理带`,
  );

  // 3) 分段水温递减一致性：任何升温回跳按占比扣分
  let rises = 0;
  for (let i = 1; i < recipe.pours.length; i += 1) {
    if (recipe.pours[i].temperature > recipe.pours[i - 1].temperature) rises += 1;
  }
  const steps = Math.max(recipe.pours.length - 1, 1);
  const tempScore = STRUCTURE_PARTS.tempConsistency * (1 - rises / steps);
  notes.push(rises === 0 ? "分段水温递减一致" : `分段水温回跳 ${rises} 次`);

  const score = round1(bloomR.score + countR.score + tempScore);
  return { key: "structure", label: "注水结构合理性", weight, score, note: notes.join("，") };
}

function dimDuration(recipe: Recipe): ScoreDimension {
  const weight = DIMENSION_WEIGHTS.duration;
  const totalSeconds = estimateTotalSeconds(recipe);
  const r = bandScore(totalSeconds, DURATION_BAND, weight, {
    centerPenalty: 0, // 带内全给满，带外连续扣分（带缘=权重）
    outScale: SHAPE.durationOutScale,
  });
  const fmt = (s: number): string =>
    `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const note = r.inside
    ? `估算总时长 ${fmt(totalSeconds)} 落在 2:00-3:30 合理带`
    : `估算总时长 ${fmt(totalSeconds)} 越出 2:00-3:30 合理带 ${Math.round(r.deviation)}s`;
  return { key: "duration", label: "总时长合理带", weight, score: round1(r.score), note };
}

/** 风味方向词表（任务 #121）：明亮向 = 高温细磨，醇厚向 = 低温粗磨（知识库 §3 经验规则） */
const BRIGHT_TAGS = ["明亮", "酸", "花果", "花香", "柑橘", "莓", "果汁", "清爽", "茶"];
const MELLOW_TAGS = ["醇厚", "甜", "低酸", "坚果", "可可", "巧克力", "圆润", "厚重", "浓郁"];

/** 期望风味文本 → 标签数组（顿号/逗号/分号/斜线/空白切分；空 → undefined） */
export function parseFlavorTags(taste: string | undefined): string[] | undefined {
  const tags = (taste ?? "")
    .split(/[、，,；;\/\s]+/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  return tags.length > 0 ? tags : undefined;
}

function flavorDirection(tags?: string[]): "bright" | "mellow" | null {
  if (!tags || tags.length === 0) return null;
  // 按命中词数裁决：「低酸」同时含明亮向「酸」字与醇厚向「低酸」词，
  // 全有全无的 includes 会误判为双向冲突；命中数多者胜，平手才视为无方向
  const count = (words: string[]) => words.filter((w) => tags.some((t) => t.includes(w))).length;
  const bright = count(BRIGHT_TAGS);
  const mellow = count(MELLOW_TAGS);
  if (bright === 0 && mellow === 0) return null;
  if (bright > mellow) return "bright";
  if (mellow > bright) return "mellow";
  return null;
}

function dimFlavor(recipe: Recipe, tags?: string[]): ScoreDimension {
  const weight = DIMENSION_WEIGHTS.flavor;
  const dir = flavorDirection(tags);
  if (!tags || tags.length === 0) {
    return {
      key: "flavor",
      label: "口味偏好对齐",
      weight,
      score: weight,
      note: "无风味偏好标签，中性给满",
    };
  }
  if (!dir) {
    return {
      key: "flavor",
      label: "口味偏好对齐",
      weight,
      score: weight,
      note: `偏好标签（${tags.join("、")}）未命中明确方向，中性给满`,
    };
  }
  // bright → 高温细磨（grinderSize 数值小）；mellow → 低温粗磨
  // （mellow 目标 88℃ 取知识库/云端可达低温下限，避免幻觉目标）
  const target =
    dir === "bright"
      ? { temp: 94, grinder: 58, label: "明亮向（高温细磨）" }
      : { temp: 88, grinder: 76, label: "醇厚向（低温粗磨）" };
  const firstTemp = recipe.pours[0]?.temperature ?? 0;
  const tempClose = clamp01(1 - Math.abs(firstTemp - target.temp) / 6);
  const grinderClose = clamp01(1 - Math.abs(recipe.grinderSize - target.grinder) / 10);
  const score = round1(weight * (0.5 * tempClose + 0.5 * grinderClose));
  return {
    key: "flavor",
    label: "口味偏好对齐",
    weight,
    score,
    note: `偏好${target.label}：首段 ${firstTemp}℃ / 研磨 ${recipe.grinderSize} 贴近度 ${Math.round(((tempClose + grinderClose) / 2) * 100)}%`,
  };
}

/**
 * 从调研摘要文本提取参数信号（纯函数，任务 #121）：
 * - 水温：首个 80-95 的「N℃/度」数字；粉水比：首个 1:12-1:19 写法；
 * - grinderSize：文本中出现 grinderSize 字样后的数字（40-120 云端标尺）。
 * 全部未命中返回 undefined（research 维度中性给满）。
 */
export function extractResearchSignals(text: string | undefined): ResearchSignals | undefined {
  const t = (text ?? "").trim();
  if (!t) return undefined;
  const signals: ResearchSignals = {};
  const temp = t.match(/(\d{2}(?:\.\d)?)\s*(?:℃|°C|度)/);
  if (temp) {
    const v = Number(temp[1]);
    if (v >= 80 && v <= 95) signals.temperature = v;
  }
  const ratio = t.match(/1\s*[:：]\s*(1[2-9](?:\.\d)?)/);
  if (ratio) signals.ratio = Number(ratio[1]);
  const grinder = t.match(/grinderSize[^\d]{0,12}(\d{2,3})/i);
  if (grinder) {
    const v = Number(grinder[1]);
    if (v >= 40 && v <= 120) signals.grinderSize = v;
  }
  return Object.keys(signals).length > 0 ? signals : undefined;
}

function dimResearch(recipe: Recipe, signals?: ResearchSignals): ScoreDimension {
  const weight = DIMENSION_WEIGHTS.research;
  if (!signals) {
    return {
      key: "research",
      label: "调研贴合度",
      weight,
      score: weight,
      note: "无调研参数信号，中性给满",
    };
  }
  const effectiveWater = recipe.grandWater + (recipe.bypassEnabled ? recipe.bypassVolume : 0);
  const ratio = round1(effectiveWater / recipe.doseGrams);
  const firstTemp = recipe.pours[0]?.temperature ?? 0;
  const parts: number[] = [];
  const hits: string[] = [];
  if (signals.temperature !== undefined) {
    parts.push(clamp01(1 - Math.abs(firstTemp - signals.temperature) / 4));
    hits.push(`水温 ${signals.temperature}℃`);
  }
  if (signals.ratio !== undefined) {
    parts.push(clamp01(1 - Math.abs(ratio - signals.ratio) / 1.5));
    hits.push(`粉水比 1:${signals.ratio}`);
  }
  if (signals.grinderSize !== undefined) {
    parts.push(clamp01(1 - Math.abs(recipe.grinderSize - signals.grinderSize) / 8));
    hits.push(`研磨 ${signals.grinderSize}`);
  }
  if (parts.length === 0) {
    return {
      key: "research",
      label: "调研贴合度",
      weight,
      score: weight,
      note: "无调研参数信号，中性给满",
    };
  }
  const avg = parts.reduce((s, v) => s + v, 0) / parts.length;
  return {
    key: "research",
    label: "调研贴合度",
    weight,
    score: round1(weight * avg),
    note: `调研建议 ${hits.join("、")}，贴近度 ${Math.round(avg * 100)}%`,
  };
}

// ---------------------------------------------------------------------------
// 调研一致性校验（任务 #131）：防刷分——获胜候选参数须在调研信号硬容差内
// ---------------------------------------------------------------------------

/** 调研一致性校验结果（任务 #131） */
export interface ResearchConsistencyResult {
  consistent: boolean;
  /** 逐项越界偏差（空数组 = 一致） */
  deviations: {
    param: string;
    value: number;
    researchValue: number;
    tolerance: number;
  }[];
}

/** 调研一致性硬容差基准（任务 #131）：distilled 时 ×1.5 */
const CONSISTENCY_TOLERANCE = {
  temperature: 3,
  ratio: 1.0,
  grinderSize: 5,
} as const;

/**
 * 调研一致性校验（任务 #131，纯函数）：
 * 用 extractResearchSignals 提取的 temperature/ratio/grinderSize 校验获胜候选
 * 对应参数是否在硬容差内——temperature ±3℃、ratio ±1.0、grinderSize ±5；
 * distilled=true 时容差×1.5（提炼摘要本身有偏差）。
 * 任一越界返回 {consistent:false, deviations:[…]}，空 deviations = 一致。
 * **不否决、不改 score**，仅作采用判定输入。
 */
export function checkResearchConsistency(
  recipe: Recipe,
  researchSignals: ResearchSignals | undefined,
  distilled = false,
): ResearchConsistencyResult {
  if (!researchSignals) return { consistent: true, deviations: [] };
  const mult = distilled ? 1.5 : 1;
  const deviations: ResearchConsistencyResult["deviations"] = [];

  if (researchSignals.temperature !== undefined) {
    const firstTemp = recipe.pours[0]?.temperature ?? 0;
    const tol = CONSISTENCY_TOLERANCE.temperature * mult;
    if (Math.abs(firstTemp - researchSignals.temperature) > tol) {
      deviations.push({
        param: "temperature",
        value: firstTemp,
        researchValue: researchSignals.temperature,
        tolerance: tol,
      });
    }
  }

  if (researchSignals.ratio !== undefined) {
    const effectiveWater = recipe.grandWater + (recipe.bypassEnabled ? recipe.bypassVolume : 0);
    const ratio = round1(effectiveWater / recipe.doseGrams);
    const tol = CONSISTENCY_TOLERANCE.ratio * mult;
    if (Math.abs(ratio - researchSignals.ratio) > tol) {
      deviations.push({
        param: "ratio",
        value: ratio,
        researchValue: researchSignals.ratio,
        tolerance: tol,
      });
    }
  }

  if (researchSignals.grinderSize !== undefined) {
    const tol = CONSISTENCY_TOLERANCE.grinderSize * mult;
    if (Math.abs(recipe.grinderSize - researchSignals.grinderSize) > tol) {
      deviations.push({
        param: "grinderSize",
        value: recipe.grinderSize,
        researchValue: researchSignals.grinderSize,
        tolerance: tol,
      });
    }
  }

  return { consistent: deviations.length === 0, deviations };
}

// ---------------------------------------------------------------------------
// 方案解读引用检查（#106 保留）
// ---------------------------------------------------------------------------

/** brewRationale 引用知识库 §9 / xBloom 硬件特性的关键词（命中任一即视为有引用） */
const RATIONALE_CITATION_WORDS = [
  "§9",
  "知识库",
  "brewing-reference",
  "滤杯",
  "硬件",
  "设备特性",
  "xbloom",
  "流速",
  "转速",
  "rpm",
  "振动",
  "搅拌",
  "x dripper",
  "xdripper",
] as const;

/** brewRationale 是否存在且至少一条引用知识库 §9/硬件特性 */
export function rationaleCitesKnowledgeOrHardware(items?: BrewRationaleItem[]): boolean {
  if (!items || items.length === 0) return false;
  return items.some((item) => {
    const text = `${item.param} ${item.choice} ${item.basis}`.toLowerCase();
    return RATIONALE_CITATION_WORDS.some((w) => text.includes(w.toLowerCase()));
  });
}

/**
 * 用户需求描述是否显式指定了水量或粉水比（命中即豁免 ratio 偏离扣分）：
 * - 1:15.6 / 1：16 等比例写法；“粉水比”字样
 * - 数字 + ml/毫升/克水 等水量写法；“总水量/水量”字样
 */
export function userSpecifiesRatioOrWater(description: string | undefined): boolean {
  const text = (description ?? "").trim();
  if (!text) return false;
  if (/1\s*[:：]\s*\d+(\.\d+)?/.test(text)) return true;
  if (text.includes("粉水比")) return true;
  if (/\d+(\.\d+)?\s*(ml|毫升|克水)/i.test(text)) return true;
  if (text.includes("总水量") || text.includes("水量")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 评分入口
// ---------------------------------------------------------------------------

/**
 * 对单个候选评分（纯函数，任务 #121 多维 rubric 加权）。
 * 最终得分 = Σ7 维度分（满分 100） − 全局扣分（warn/clamp/解读缺失）。
 * vetoed 时 score 仍照常计算（用于全否决兜底排序），但 winner 选择优先非否决池。
 */
export function scoreCandidate(input: ScoreCandidateInput): CandidateScore {
  const {
    recipe,
    clamped,
    findings,
    brewRationale,
    userSpecifiedRatioOrWater,
    beanText,
    flavorTags,
    researchSignals,
  } = input;
  const vetoReasons = vetoChecks(recipe, findings);
  const roast = beanText?.trim() ? detectRoastLevel(beanText) : null;

  const dimensions: ScoreDimension[] = [
    dimRatio(recipe, !!userSpecifiedRatioOrWater),
    dimTempRoast(recipe, roast),
    dimGrinderRoast(recipe, roast),
    dimStructure(recipe),
    dimDuration(recipe),
    dimFlavor(recipe, flavorTags),
    dimResearch(recipe, researchSignals),
  ];
  const dimSum = dimensions.reduce((s, d) => s + d.score, 0);

  // 全局扣分（#106 语义保留）
  const deductions: string[] = [];
  const warns = findings.filter((f) => f.level === "warn");
  if (warns.length > 0) {
    const d = warns.length * SCORE_WEIGHTS.perWarn;
    deductions.push(`审查警告 ×${warns.length}（-${d}）`);
  }
  if (clamped.length > 0) {
    const d = clamped.length * SCORE_WEIGHTS.perClamp;
    deductions.push(`参数修正 ×${clamped.length}（-${d}）`);
  }
  if (!rationaleCitesKnowledgeOrHardware(brewRationale)) {
    deductions.push(`方案解读缺失或未引用知识库/硬件特性（-${SCORE_WEIGHTS.rationaleMissing}）`);
  }
  const globalDeduction =
    warns.length * SCORE_WEIGHTS.perWarn +
    clamped.length * SCORE_WEIGHTS.perClamp +
    (rationaleCitesKnowledgeOrHardware(brewRationale) ? 0 : SCORE_WEIGHTS.rationaleMissing);

  return {
    vetoed: vetoReasons.length > 0,
    vetoReasons,
    score: round1(dimSum - globalDeduction),
    warns: warns.length,
    clamps: clamped.length,
    totalSeconds: estimateTotalSeconds(recipe),
    deductions,
    dimensions,
  };
}

// ---------------------------------------------------------------------------
// 择优
// ---------------------------------------------------------------------------

/** 候选排序条目：评分结果 + 候选索引与完成顺序（平局第五级） */
export interface RankedCandidate extends CandidateScore {
  /** 候选在批次中的下标（0 起） */
  index: number;
  /** 生成完成的先后顺序（0 起，越小越先完成） */
  completionOrder: number;
}

/**
 * 平局五级序择优（纯函数）：
 * 软分高 → clamped 少 → warn 少 → 总时长近 170s → 生成完成顺序靠前。
 * 优先从非否决候选中选；全体否决时兜底在否决池中按同一顺序选（路由侧会带警告下发：
 * 任务 #113 已在 recipe 事件的 warning 通道附加「优选兜底」警告）。
 * 返回获胜候选的 index（批次下标）。空数组返回 -1。
 */
export function pickWinner(ranked: RankedCandidate[]): number {
  if (ranked.length === 0) return -1;
  const pool = ranked.filter((c) => !c.vetoed);
  const candidates = pool.length > 0 ? pool : ranked;
  const target = SCORE_WEIGHTS.tieBreakTargetSeconds;
  const sorted = [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score; // 1) 软分高
    if (a.clamps !== b.clamps) return a.clamps - b.clamps; // 2) clamped 少
    if (a.warns !== b.warns) return a.warns - b.warns; // 3) warn 少
    const da = Math.abs(a.totalSeconds - target);
    const db = Math.abs(b.totalSeconds - target);
    if (da !== db) return da - db; // 4) 总时长近 170s
    return a.completionOrder - b.completionOrder; // 5) 完成顺序靠前
  });
  return sorted[0].index;
}
