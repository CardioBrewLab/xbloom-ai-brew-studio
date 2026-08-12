/**
 * 配方安全层：
 * - clampRecipe：把任意越界配方钳位到 SAFE_LIMITS（云端 ∩ BLE 交集），并留痕
 * - validateForTarget：针对 cloud / ble 具体路径做专属边界校验，返回错误列表
 *
 * bypass 守护：启用旁路水时最终粉水比 (grandWater + bypassVolume) / dose
 * 必须落在 BYPASS_RATIO_RANGE（12-20）。钳位阶段会先调整 bypassVolume，
 * 调整不动时直接关闭 bypass 并留痕，保证输出永远满足守护。
 */
import { z } from "zod";
import {
  BLE_LIMITS,
  BYPASS_RATIO_RANGE,
  CLOUD_LIMITS,
  CUP_TYPES,
  DEFAULT_RECIPE_COLOR,
  POUR_PATTERNS,
  RPM_OPTIONS,
  RecipeSchema,
  SAFE_LIMITS,
  isReachableCloudTotal,
  type LimitRange,
  type LimitTable,
  type Pour,
  type Recipe,
  type Rpm,
} from "./recipe-schema.js";

/**
 * 宽松输入 schema：只校验结构与枚举，不校验数值区间。
 * LLM 输出的越界/负值参数交给后续钳位处理，而不是直接拒绝。
 * 新增官方字段（bypass / vib / theName / isSetGrinderSize / theColor）均为可选，
 * 缺省值由 RecipeSchema 的 default 补齐。
 */
const LoosePourSchema = z.object({
  volume: z.number(),
  temperature: z.number(),
  flowRate: z.number(),
  pattern: z.enum(POUR_PATTERNS),
  pausing: z.number(),
  vibBefore: z.boolean().optional(),
  vibAfter: z.boolean().optional(),
  theName: z.string().optional(),
});

const LooseRecipeSchema = z.object({
  name: z.string().min(1),
  cupType: z.enum(CUP_TYPES),
  doseGrams: z.number(),
  grinderSize: z.number(),
  rpm: z.number().refine((v): v is Rpm => (RPM_OPTIONS as readonly number[]).includes(v), {
    message: "rpm 必须是 60/70/80/90/100/110/120 之一",
  }),
  grandWater: z.number(),
  pours: z.array(LoosePourSchema).min(1).max(6),
  bypassEnabled: z.boolean().optional(),
  bypassVolume: z.number().optional(),
  bypassTemp: z.number().optional(),
  isSetGrinderSize: z.union([z.literal(1), z.literal(2)]).optional(),
  theColor: z.string().optional(),
});

export interface ClampResult {
  /** 钳位后的合法配方（通过 RecipeSchema 全量校验） */
  recipe: Recipe;
  /** 被钳位/调整项的说明列表；空数组表示原配方就在安全区间内 */
  clamped: string[];
}

const EPS = 1e-6;

function clampNum(value: number, range: LimitRange): number {
  return Math.min(range.max, Math.max(range.min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function nearestReachableTotalInRange(
  doseGrams: number,
  desired: number,
  minTotal: number,
  maxTotal: number,
): number | null {
  const lower = Math.ceil(minTotal - EPS);
  const upper = Math.floor(maxTotal + EPS);
  if (lower > upper) return null;
  const center = Math.min(upper, Math.max(lower, Math.round(desired)));
  for (let distance = 0; distance <= upper - lower; distance += 1) {
    const down = center - distance;
    if (down >= lower && isReachableCloudTotal(doseGrams, down)) return down;
    const up = center + distance;
    if (up <= upper && isReachableCloudTotal(doseGrams, up)) return up;
  }
  return null;
}

/**
 * 将配方钳位到 SAFE_LIMITS。
 *
 * 规则：
 * 1. doseGrams / grinderSize / 各段 temperature / flowRate / pausing 独立钳位；
 * 2. grandWater 钳位到总水区间后，若与各段之和不一致，按"各段之和 = grandWater"
 *    硬约束对齐（优先缩放各段 volume 使其落在单段/总水区间内，
 *    取整差额吸收进最大段，保证总和精确贴合目标）；
 * 3. bypass：bypassVolume（整数 5-100）与 bypassTemp（40-95）独立钳位；
 *    启用时校验最终粉水比守护（12-20），先尝试调整 bypassVolume，
 *    无法满足则关闭 bypassEnabled 并留痕；
 * 4. 所有调整都会写入 clamped 列表，方便前端展示"AI 已自动修正"。
 */
export function clampRecipe(input: unknown): ClampResult {
  const base = LooseRecipeSchema.parse(input);
  const clamped: string[] = [];

  const track = (field: string, from: number, to: number): number => {
    if (Math.abs(from - to) > EPS) clamped.push(`${field}: ${from} → ${to}`);
    return to;
  };

  const doseGrams = track(
    "doseGrams",
    base.doseGrams,
    clampNum(base.doseGrams, SAFE_LIMITS.doseGrams),
  );
  const grinderSize = track(
    "grinderSize",
    base.grinderSize,
    clampNum(base.grinderSize, SAFE_LIMITS.grinderSize),
  );

  let pours: Pour[] = base.pours.map((p, i) => ({
    volume: track(`pours[${i}].volume`, p.volume, clampNum(p.volume, SAFE_LIMITS.pourVolume)),
    temperature: track(
      `pours[${i}].temperature`,
      p.temperature,
      clampNum(p.temperature, SAFE_LIMITS.waterTemperature),
    ),
    flowRate: track(`pours[${i}].flowRate`, p.flowRate, clampNum(p.flowRate, SAFE_LIMITS.flowRate)),
    pattern: p.pattern,
    pausing: track(`pours[${i}].pausing`, p.pausing, clampNum(p.pausing, SAFE_LIMITS.pausing)),
    vibBefore: p.vibBefore ?? false,
    vibAfter: p.vibAfter ?? false,
    ...(p.theName ? { theName: p.theName } : {}),
  }));

  // 总水与分段的联动对齐：grandWater 先钳位，再与各段之和强制一致
  let grandWater = track(
    "grandWater",
    base.grandWater,
    clampNum(base.grandWater, SAFE_LIMITS.totalWater),
  );

  let sum = round1(pours.reduce((s, p) => s + p.volume, 0));
  const rebalancePours = (target: number): void => {
    if (
      target < pours.length * SAFE_LIMITS.pourVolume.min ||
      target > pours.length * SAFE_LIMITS.pourVolume.max
    ) {
      throw new Error(
        `clampRecipe: ${target}ml exceeds the per-pour capacity for ${pours.length} pours`,
      );
    }
    if (sum <= 0) throw new Error("clampRecipe: pour volume sum must be positive");

    const scale = target / sum;
    pours = pours.map((p, i) => {
      const scaled = Math.min(
        SAFE_LIMITS.pourVolume.max,
        Math.max(SAFE_LIMITS.pourVolume.min, round1(p.volume * scale)),
      );
      return { ...p, volume: track(`pours[${i}].volume`, p.volume, scaled) };
    });

    let remainingUnits = Math.round(
      (target - pours.reduce((total, pour) => total + pour.volume, 0)) * 10,
    );
    while (remainingUnits !== 0) {
      const direction = remainingUnits > 0 ? 1 : -1;
      let index = -1;
      for (let current = 0; current < pours.length; current += 1) {
        const candidate = pours[current].volume;
        const eligible =
          direction > 0
            ? candidate < SAFE_LIMITS.pourVolume.max
            : candidate > SAFE_LIMITS.pourVolume.min;
        if (eligible && (index < 0 || candidate * direction < pours[index].volume * direction)) {
          index = current;
        }
      }
      if (index < 0) throw new Error(`clampRecipe: unable to rebalance pours to ${target}ml`);
      const current = pours[index].volume;
      const capacityUnits =
        direction > 0
          ? Math.round((SAFE_LIMITS.pourVolume.max - current) * 10)
          : Math.round((current - SAFE_LIMITS.pourVolume.min) * 10);
      const changeUnits = direction * Math.min(Math.abs(remainingUnits), capacityUnits);
      const adjusted = round1(current + changeUnits / 10);
      pours[index] = {
        ...pours[index],
        volume: track(`pours[${index}].volume`, current, adjusted),
      };
      remainingUnits -= changeUnits;
    }
    sum = round1(pours.reduce((s, p) => s + p.volume, 0));
  };

  const { min: minWater, max: maxWater } = SAFE_LIMITS.totalWater;
  if (sum > maxWater || sum < minWater) {
    // 各段之和超出总水区间：等比缩放各段（单段下限 1ml 兜底），
    // 取整差额吸收进最大段，保证 sum 精确等于目标总水且落在 [40,500]
    const target = sum > maxWater ? maxWater : minWater;
    rebalancePours(target);
  }
  if (Math.abs(grandWater - sum) > EPS) {
    clamped.push(`grandWater: ${grandWater} → ${sum}（对齐各段注水之和）`);
    grandWater = sum;
  }

  // --- bypass 三件套：先独立钳位，再做粉水比守护 ----------------------------
  let bypassEnabled = base.bypassEnabled ?? false;
  let bypassVolume = track(
    "bypassVolume",
    Math.round(base.bypassVolume ?? 5),
    Math.round(clampNum(Math.round(base.bypassVolume ?? 5), SAFE_LIMITS.bypassVolume!)),
  );
  const bypassTemp = track(
    "bypassTemp",
    base.bypassTemp ?? 85,
    clampNum(base.bypassTemp ?? 85, SAFE_LIMITS.bypassTemp!),
  );

  if (bypassEnabled) {
    const { min: minRatio, max: maxRatio } = BYPASS_RATIO_RANGE;
    const ratio = (grandWater + bypassVolume) / doseGrams;
    if (ratio > maxRatio) {
      // 稀释过头：把 bypassVolume 压回使最终比例 = maxRatio
      const target = Math.floor(maxRatio * doseGrams - grandWater);
      bypassVolume = track("bypassVolume", bypassVolume, target);
      if (bypassVolume < SAFE_LIMITS.bypassVolume!.min) {
        // 即便不加旁路，grandWater/dose 仍超上限：直接关闭旁路
        bypassVolume = SAFE_LIMITS.bypassVolume!.min;
        bypassEnabled = false;
        clamped.push("bypassEnabled: true → false（grandWater/dose 已超旁路粉水比上限，关闭旁路）");
      }
    } else if (ratio < minRatio) {
      // 浓缩过度：抬高 bypassVolume 使最终比例 = minRatio
      const target = Math.ceil(minRatio * doseGrams - grandWater);
      bypassVolume = track("bypassVolume", bypassVolume, target);
      if (bypassVolume > SAFE_LIMITS.bypassVolume!.max) {
        // 旁路加满 100ml 仍达不到下限：关闭旁路
        bypassVolume = SAFE_LIMITS.bypassVolume!.max;
        bypassEnabled = false;
        clamped.push("bypassEnabled: true → false（旁路 100ml 仍达不到粉水比下限，关闭旁路）");
      }
    }
  }

  // 磨豆模式与配方卡颜色：非法值回退默认（结构上已被 Loose schema 约束）
  const minPourTotal = pours.length * SAFE_LIMITS.pourVolume.min;
  const maxPourTotal = pours.length * SAFE_LIMITS.pourVolume.max;
  const reachableTotal = (enabled: boolean, volume: number): number | null =>
    nearestReachableTotalInRange(
      doseGrams,
      grandWater,
      Math.max(
        SAFE_LIMITS.totalWater.min,
        minPourTotal,
        enabled ? BYPASS_RATIO_RANGE.min * doseGrams - volume : BYPASS_RATIO_RANGE.min * doseGrams,
      ),
      Math.min(
        SAFE_LIMITS.totalWater.max,
        maxPourTotal,
        enabled ? BYPASS_RATIO_RANGE.max * doseGrams - volume : BYPASS_RATIO_RANGE.max * doseGrams,
      ),
    );

  let targetTotal = reachableTotal(bypassEnabled, bypassVolume);
  if (targetTotal === null && bypassEnabled) {
    bypassEnabled = false;
    bypassVolume = track("bypassVolume", bypassVolume, SAFE_LIMITS.bypassVolume!.min);
    clamped.push("bypassEnabled: true -> false (base water cannot satisfy cloud ratio)");
    targetTotal = reachableTotal(false, bypassVolume);
  }
  if (targetTotal === null) {
    throw new Error("clampRecipe: no cloud-valid total water is reachable within SAFE_LIMITS");
  }
  if (Math.abs(grandWater - targetTotal) > EPS) {
    clamped.push(`grandWater: ${grandWater} -> ${targetTotal} (cloud ratio/reachability)`);
    rebalancePours(targetTotal);
    grandWater = sum;
  }

  const effectiveRatio = round1((grandWater + (bypassEnabled ? bypassVolume : 0)) / doseGrams);
  if (
    !isReachableCloudTotal(doseGrams, grandWater) ||
    effectiveRatio < BYPASS_RATIO_RANGE.min ||
    effectiveRatio > BYPASS_RATIO_RANGE.max
  ) {
    throw new Error(
      `clampRecipe: cloud invariants failed (ratio=${effectiveRatio}, total=${grandWater})`,
    );
  }

  const isSetGrinderSize = base.isSetGrinderSize ?? 1;
  const theColor =
    typeof base.theColor === "string" && /^#[0-9a-fA-F]{6}$/.test(base.theColor)
      ? base.theColor
      : base.theColor !== undefined
        ? (clamped.push(`theColor: ${base.theColor} → ${DEFAULT_RECIPE_COLOR}（非法色值回退默认）`),
          DEFAULT_RECIPE_COLOR)
        : DEFAULT_RECIPE_COLOR;

  const recipe = RecipeSchema.parse({
    name: base.name,
    cupType: base.cupType,
    doseGrams,
    grinderSize,
    rpm: base.rpm,
    grandWater,
    pours,
    bypassEnabled,
    bypassVolume,
    bypassTemp,
    isSetGrinderSize,
    theColor,
  });

  return { recipe, clamped };
}

export type BrewTarget = "cloud" | "ble";

/** 总时长警告阈值（s）：估算总时长超过 3:00 时附加警告（不拦截） */
export const DURATION_WARN_SECONDS = 180;

/**
 * 估算配方总时长（s）= Σ (pours[i].volume / pours[i].flowRate + pours[i].pausing)。
 * 纯函数，只依赖 pours 字段，前后端双副本保持同步。
 */
export function estimateTotalSeconds(recipe: Pick<Recipe, "pours">): number {
  const total = recipe.pours.reduce(
    (s, p) => s + (p.flowRate > 0 ? p.volume / p.flowRate : 0) + p.pausing,
    0,
  );
  return Math.round(total * 10) / 10;
}

/**
 * 总时长警告：估算 > 180s 时返回警告文案（仅警告，不拦截）；否则 undefined。
 */
export function durationWarning(recipe: Pick<Recipe, "pours">): string | undefined {
  const seconds = estimateTotalSeconds(recipe);
  if (seconds <= DURATION_WARN_SECONDS) return undefined;
  const mm = Math.floor(seconds / 60);
  const ss = Math.round(seconds % 60);
  return `估算总时长 ≈${mm}:${String(ss).padStart(2, "0")}（${seconds}s）超过 3:00 建议线，粉床易堵塞/过萃，建议调粗研磨、减少段数或缩短段间停顿`;
}

/**
 * 针对具体下发路径的专属校验（不做钳位，只报告问题）。
 * 返回错误消息数组；空数组表示该配方可直接走该路径。
 */
export function validateBaseForTarget(recipe: Recipe, target: BrewTarget): string[] {
  const errors: string[] = [];
  const limits: LimitTable = target === "cloud" ? CLOUD_LIMITS : BLE_LIMITS;

  const check = (field: string, value: number, range: LimitRange | undefined): void => {
    if (!range) return;
    if (value < range.min || value > range.max) {
      errors.push(`${field}=${value} 超出 ${target} 路径允许范围 [${range.min}, ${range.max}]`);
    }
  };

  check("doseGrams", recipe.doseGrams, limits.doseGrams);
  // 内部 grinderSize 永远是云端 40-120 标尺；BLE 编码前会映射为 1-80。
  check("grinderSize", recipe.grinderSize, CLOUD_LIMITS.grinderSize);
  check("grandWater", recipe.grandWater, limits.totalWater);
  check("bypassVolume", recipe.bypassVolume, limits.bypassVolume);
  check("bypassTemp", recipe.bypassTemp, limits.bypassTemp);
  recipe.pours.forEach((p, i) => {
    check(`pours[${i}].volume`, p.volume, limits.pourVolume);
    check(`pours[${i}].temperature`, p.temperature, limits.waterTemperature);
    check(`pours[${i}].flowRate`, p.flowRate, limits.flowRate);
    check(`pours[${i}].pausing`, p.pausing, limits.pausing);
  });

  if (target === "ble") {
    if (!Number.isInteger(recipe.doseGrams)) {
      errors.push(`doseGrams=${recipe.doseGrams} 需为整数克，BLE 剂量帧使用单字节整数`);
    }
    if (recipe.pours.length < 2) {
      errors.push("BLE 配方至少需要闷蒸与主注水两段");
    }
    recipe.pours.forEach((pour, index) => {
      if (!Number.isInteger(pour.volume)) {
        errors.push(`pours[${index}].volume=${pour.volume} 需为整数毫升`);
      }
      if (pour.pattern !== "spiral" && (pour.vibBefore || pour.vibAfter)) {
        errors.push(`pours[${index}] 仅螺旋注水支持 BLE 振动搅拌`);
      }
    });
    if (recipe.bypassEnabled) {
      errors.push("当前真机验证的 BLE 加载协议不携带旁路水；该配方请同步到手机 xBloom App");
    }
  }

  // bypass 粉水比守护（两条路径都适用）：(grandWater + bypassVolume) / dose ∈ [12, 20]
  if (recipe.bypassEnabled) {
    const ratio = round1((recipe.grandWater + recipe.bypassVolume) / recipe.doseGrams);
    if (ratio < BYPASS_RATIO_RANGE.min || ratio > BYPASS_RATIO_RANGE.max) {
      errors.push(
        `bypass 最终粉水比 ${ratio} 超出允许区间 [${BYPASS_RATIO_RANGE.min}, ${BYPASS_RATIO_RANGE.max}]`,
      );
    }
  }

  // 云端额外约束：粉水比 grandWater/dose 落在建议区间 [12, 20] 即可
  // （15.6 只是默认值，不是唯一合法值）；启用 bypass 的浓缩冲法
  // 其最终粉水比已由上方 bypass 守护 (grandWater + bypassVolume)/dose ∈ [12, 20] 覆盖
  if (target === "cloud") {
    if (!recipe.bypassEnabled) {
      const ratio = round1(recipe.grandWater / recipe.doseGrams);
      if (ratio < BYPASS_RATIO_RANGE.min || ratio > BYPASS_RATIO_RANGE.max) {
        errors.push(
          `粉水比 grandWater/dose=${ratio} 超出允许区间 [${BYPASS_RATIO_RANGE.min}, ${BYPASS_RATIO_RANGE.max}]`,
        );
      }
    }
  }

  return errors;
}
