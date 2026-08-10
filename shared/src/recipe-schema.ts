/**
 * xBloom 内部配方数据模型 —— 全仓库唯一事实源。
 *
 * 服务端（LLM 生成 / 云端同步 / BLE 控制）与前端（表单 / 图表渲染）
 * 一律以本模块导出的类型与常量为准，禁止各自私自定义边界。
 *
 * 本产品面向纯手冲场景：cupType 仅保留 "xdripper" | "other"，
 * 已彻底移除胶囊（xPod）相关逻辑。
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// 基础枚举
// ---------------------------------------------------------------------------

export const CUP_TYPES = ["xdripper", "other"] as const;
export type CupType = (typeof CUP_TYPES)[number];

/** 注水图案（内部语义值，云端/BLE 各自的数字编码见下方映射函数） */
export const POUR_PATTERNS = ["center", "circular", "spiral"] as const;
export type PourPattern = (typeof POUR_PATTERNS)[number];

/** xBloom 支持的磨豆机转速档位 */
export const RPM_OPTIONS = [60, 70, 80, 90, 100, 110, 120] as const;
export type Rpm = (typeof RPM_OPTIONS)[number];

/** 磨豆模式：1 = 本机磨豆（默认），2 = 预磨粉（BLE 走 8004 无研磨帧） */
export const GRINDER_MODES = [1, 2] as const;
export type GrinderMode = (typeof GRINDER_MODES)[number];

/** 配方卡默认颜色（云端 theColor 字段缺省值） */
export const DEFAULT_RECIPE_COLOR = "#C9D5B8";

/** 默认粉水比（grandWater ≈ doseGrams × ratio） */
export const DEFAULT_BREW_RATIOS: Record<CupType, number> = {
  xdripper: 15.6,
  other: 15.6,
};

/** 按默认粉水比推算建议总水量（保留一位小数） */
export function suggestGrandWater(doseGrams: number, ratio: number): number;
export function suggestGrandWater(doseGrams: number, cupType: CupType): number;
export function suggestGrandWater(doseGrams: number, ratioOrCupType: number | CupType): number {
  const ratio =
    typeof ratioOrCupType === "number" ? ratioOrCupType : DEFAULT_BREW_RATIOS[ratioOrCupType];
  return Math.round(doseGrams * ratio * 10) / 10;
}

// ---------------------------------------------------------------------------
// 云端粉水比可达性（ratio 0.1 步进）
// ---------------------------------------------------------------------------

const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * 云端粉水比按 0.1 步进（官方 App UI / BLE 配方尾字节 = int(ratio×10)），
 * 且官方强校验 dose × ratio == Σ各段注水（任务#41 APK 逆向 + 2026-08-04 实测）。
 * 可达总水量定义：round1(dose × round1(T/dose)) === T 的整数 T。
 * 例：dose=12 时 200 不可达（12×16.7=200.4），就近可达为 198(1:16.5) / 204(1:17)。
 */
export function isReachableCloudTotal(doseGrams: number, total: number): boolean {
  return Math.abs(round1(doseGrams * round1(total / doseGrams)) - total) < 1e-9;
}

/**
 * 就近搜索可达整数总水量：从原值向外逐圈搜索，同距离优先向下
 * （云端单向容差只容忍 Σ 略低于 dose×ratio），最多搜 200ml，必中。
 */
export function nearestReachableCloudTotal(doseGrams: number, total: number): number {
  const base = Math.round(total);
  for (let d = 0; d <= 200; d++) {
    const down = base - d;
    if (down > 0 && isReachableCloudTotal(doseGrams, down)) return down;
    const up = base + d;
    if (d > 0 && isReachableCloudTotal(doseGrams, up)) return up;
  }
  return base; // 理论不可达；兜底保持原值
}

/** 段名默认生成规则：首段 "Bloom"，其余 "Pour n" */
export function defaultPourName(index: number): string {
  return index === 0 ? "Bloom" : `Pour ${index + 1}`;
}

/** 取段名：优先用户指定，缺省按 Bloom / Pour n 规则补齐 */
export function pourName(pour: { theName?: string }, index: number): string {
  const name = pour.theName?.trim();
  return name ? name : defaultPourName(index);
}

// ---------------------------------------------------------------------------
// 双边界常量表
// ---------------------------------------------------------------------------

export interface LimitRange {
  min: number;
  max: number;
}

export interface LimitTable {
  /** 粉量（g） */
  doseGrams: LimitRange;
  /** 研磨度（云端标尺 40-120，越小越细；BLE 标尺 1-80） */
  grinderSize: LimitRange;
  /** 水温（℃） */
  waterTemperature: LimitRange;
  /** 注水流速（mL/s） */
  flowRate: LimitRange;
  /** 段间停顿（s） */
  pausing: LimitRange;
  /** 总水量（ml）；云端无独立范围，总水 = 粉量 × 粉水比 */
  totalWater?: LimitRange;
  /** 单段注水量（ml） */
  pourVolume?: LimitRange;
  /** 旁路水量（ml），官方整数区间 5-100 */
  bypassVolume?: LimitRange;
  /** 旁路水温（℃），官方区间 40-95，默认 85 */
  bypassTemp?: LimitRange;
}

/** xBloom 云端（Cloud Brew 分享）路径的硬边界 */
export const CLOUD_LIMITS = {
  doseGrams: { min: 1, max: 31 },
  grinderSize: { min: 40, max: 120 },
  waterTemperature: { min: 40, max: 95 },
  flowRate: { min: 3.0, max: 3.5 },
  pausing: { min: 0, max: 255 },
  bypassVolume: { min: 5, max: 100 },
  bypassTemp: { min: 40, max: 95 },
  // 云端总水量由 doseGrams × 粉水比决定，不设独立区间
} as const satisfies LimitTable;

/** BLE 直连设备路径的硬边界 */
export const BLE_LIMITS = {
  // 官方 App / Omni Dripper 2 推荐与真机验证上限均为 18g；仅约束 BLE 设备路径。
  doseGrams: { min: 5, max: 18 },
  grinderSize: { min: 1, max: 80 },
  totalWater: { min: 40, max: 500 },
  pourVolume: { min: 1, max: 300 },
  waterTemperature: { min: 40, max: 95 },
  flowRate: { min: 3.0, max: 3.5 },
  pausing: { min: 0, max: 255 },
  bypassVolume: { min: 5, max: 100 },
  bypassTemp: { min: 40, max: 95 },
} as const satisfies LimitTable;

/**
 * 默认生成的安全边界：同标尺字段取云端与真机链路的交集，确保一份
 * 配方既可上传手机 App，也可按需加载到机器。grinderSize 始终使用
 * 云端 40-120 标尺，BLE 编码前再映射为设备 1-80。
 */
export const SAFE_LIMITS = {
  doseGrams: { min: 5, max: 18 },
  grinderSize: { min: 40, max: 120 },
  totalWater: { min: 40, max: 500 },
  pourVolume: { min: 1, max: 300 },
  waterTemperature: { min: 60, max: 95 },
  flowRate: { min: 3.0, max: 3.5 },
  pausing: { min: 0, max: 255 },
  bypassVolume: { min: 5, max: 100 },
  bypassTemp: { min: 40, max: 95 },
} as const satisfies LimitTable;

/**
 * 旁路（bypass）守护：启用旁路时最终粉水比 (grandWater + bypassVolume) / dose
 * 应落在该区间内，否则视为不合理的浓缩/稀释设计。
 */
export const BYPASS_RATIO_RANGE: LimitRange = { min: 12, max: 20 };

// ---------------------------------------------------------------------------
// pattern 双映射：内部语义值 <-> 云端/BLE 数字编码
// ---------------------------------------------------------------------------

const PATTERN_TO_CLOUD: Record<PourPattern, number> = { center: 1, spiral: 2, circular: 3 };
const PATTERN_TO_BLE: Record<PourPattern, number> = { center: 0, circular: 1, spiral: 2 };

/** 内部 pattern → 云端编码（center→1, spiral→2, circular→3） */
export function patternToCloud(pattern: PourPattern): number {
  return PATTERN_TO_CLOUD[pattern];
}

/** 内部 pattern → BLE 编码（center→0, circular→1, spiral→2） */
export function patternToBle(pattern: PourPattern): number {
  return PATTERN_TO_BLE[pattern];
}

/** 云端编码 → 内部 pattern；未知编码抛错（宁可失败也不静默降级） */
export function cloudToPattern(code: number): PourPattern {
  for (const [pattern, c] of Object.entries(PATTERN_TO_CLOUD)) {
    if (c === code) return pattern as PourPattern;
  }
  throw new Error(`未知的云端 pattern 编码: ${code}`);
}

/** BLE 编码 → 内部 pattern；未知编码抛错 */
export function bleToPattern(code: number): PourPattern {
  for (const [pattern, c] of Object.entries(PATTERN_TO_BLE)) {
    if (c === code) return pattern as PourPattern;
  }
  throw new Error(`未知的 BLE pattern 编码: ${code}`);
}

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

/** 单段注水 */
export const PourSchema = z.object({
  /** 注水量（ml） */
  volume: z.number().positive(),
  /** 水温（℃） */
  temperature: z.number(),
  /** 流速（mL/s） */
  flowRate: z.number().positive(),
  pattern: z.enum(POUR_PATTERNS),
  /** 段后停顿（s） */
  pausing: z.number().min(0),
  /** 注水前振动搅拌（云端独立字段；实验 BLE 会折叠为单一 agitation 开关） */
  vibBefore: z.boolean().default(false),
  /** 注水后振动搅拌（云端独立字段；实验 BLE 会折叠为单一 agitation 开关） */
  vibAfter: z.boolean().default(false),
  /** 段名（"Bloom"/"Pour 2"…）；缺省由 pourName() 按序号补齐 */
  theName: z.string().min(1).optional(),
});
export type Pour = z.infer<typeof PourSchema>;

/** 结构校验（不含"各段之和 = grandWater"的整体约束），供钳位等中间步骤复用 */
export const RecipeCoreSchema = z.object({
  name: z.string().min(1),
  cupType: z.enum(CUP_TYPES),
  /** 粉量（g） */
  doseGrams: z.number().positive(),
  /** 研磨度（云端标尺 40-120，越小越细） */
  grinderSize: z.number(),
  rpm: z.number().refine((v): v is Rpm => (RPM_OPTIONS as readonly number[]).includes(v), {
    message: "rpm 必须是 60/70/80/90/100/110/120 之一",
  }),
  /** 总水量（ml），必须等于各段 volume 之和 */
  grandWater: z.number().positive(),
  pours: z.array(PourSchema).min(1).max(6),
  /** 是否启用旁路水（bypass）：滤杯外直接补稀释水 */
  bypassEnabled: z.boolean().default(false),
  /** 旁路水量（ml），整数 5-100 */
  bypassVolume: z.number().int().min(5).max(100).default(5),
  /** 旁路水温（℃），40-95，默认 85 */
  bypassTemp: z.number().min(40).max(95).default(85),
  /** 磨豆模式：1 = 本机磨豆（默认），2 = 预磨粉 */
  isSetGrinderSize: z.union([z.literal(1), z.literal(2)]).default(1),
  /** 配方卡颜色（#RRGGBB），默认 #C9D5B8 */
  theColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "theColor 必须是 #RRGGBB 十六进制色值")
    .default(DEFAULT_RECIPE_COLOR),
});
export type RecipeCore = z.infer<typeof RecipeCoreSchema>;

/** 完整配方 schema：在结构校验之上强制"各段 volume 之和 === grandWater" */
export const RecipeSchema = RecipeCoreSchema.superRefine((recipe, ctx) => {
  const total = recipe.pours.reduce((sum, p) => sum + p.volume, 0);
  if (Math.abs(total - recipe.grandWater) > 1e-6) {
    ctx.addIssue({
      code: "custom",
      path: ["pours"],
      message: `各段注水之和 (${total}ml) 必须等于 grandWater (${recipe.grandWater}ml)`,
    });
  }
});
export type Recipe = z.infer<typeof RecipeSchema>;

// ---------------------------------------------------------------------------
// 生成附加字段（任务 #72）
// ---------------------------------------------------------------------------

/**
 * 方案解读条目（任务 #72）：LLM 在配方 JSON 末尾附加的 brewRationale 数组项，
 * 解释关键参数「为什么这么选」。后端经 sanitizeBrewRationale 清洗后随
 * recipe/variant 事件下发并透传持久化；缺失/非法时整体丢弃不阻塞。
 */
export interface BrewRationaleItem {
  /** 参数名（清洗后 ≤30 字） */
  param: string;
  /** 本方案的取值或设计（清洗后 ≤30 字） */
  choice: string;
  /** 选择依据（须注明来源，清洗后 ≤120 字） */
  basis: string;
}
