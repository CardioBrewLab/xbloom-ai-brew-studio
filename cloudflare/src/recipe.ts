export interface HostedPour {
  volume: number;
  temperature: number;
  flowRate: number;
  pattern: "center" | "circular" | "spiral";
  pausing: number;
  vibBefore: boolean;
  vibAfter: boolean;
  theName?: string;
}

export interface HostedRecipe {
  name: string;
  cupType: "xdripper" | "other";
  doseGrams: number;
  grinderSize: number;
  rpm: 60 | 70 | 80 | 90 | 100 | 110 | 120;
  grandWater: number;
  pours: HostedPour[];
  bypassEnabled: boolean;
  bypassVolume: number;
  bypassTemp: number;
  isSetGrinderSize: 1 | 2;
  theColor: string;
}

export interface HostedNormalizationResult {
  recipe: HostedRecipe;
  clamps: string[];
}

export interface HostedScoreDimension {
  key: string;
  label: string;
  weight: number;
  score: number;
  note: string;
}

export interface HostedScoreReport {
  score: number;
  /** Unrounded score used only for stable quality-based tie breaking. */
  rankScore: number;
  dimensions: HostedScoreDimension[];
  deductions: string[];
}

const rpms = [60, 70, 80, 90, 100, 110, 120] as const;
const patterns = new Set(["center", "circular", "spiral"]);
const number = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
const round1 = (value: number): number => Math.round(value * 10) / 10;

export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate.trim()) throw new Error("模型响应中没有配方 JSON");
  return JSON.parse(candidate);
}

export function normalizeRecipeWithReport(
  input: unknown,
  fallbackName = "AI Brew",
): HostedNormalizationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("配方不是对象");
  const raw = input as Record<string, unknown>;
  const doseGrams = round1(clamp(number(raw.doseGrams, 15), 5, 18));
  const rawPours = Array.isArray(raw.pours) ? raw.pours.slice(0, 6) : [];
  if (rawPours.length === 0) throw new Error("配方缺少注水段");
  const pours = rawPours.map((item, index): HostedPour => {
    const pour = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const pattern =
      typeof pour.pattern === "string" && patterns.has(pour.pattern) ? pour.pattern : "center";
    return {
      volume: round1(clamp(number(pour.volume, index === 0 ? 45 : 95), 1, 300)),
      temperature: round1(clamp(number(pour.temperature, 92), 60, 95)),
      flowRate: round1(clamp(number(pour.flowRate, 3.2), 3, 3.5)),
      pattern: pattern as HostedPour["pattern"],
      pausing: round1(clamp(number(pour.pausing, index === 0 ? 35 : 5), 0, 255)),
      vibBefore: pour.vibBefore === true,
      vibAfter: pour.vibAfter === true,
      theName:
        typeof pour.theName === "string" && pour.theName.trim()
          ? pour.theName.trim().slice(0, 48)
          : index === 0
            ? "Bloom"
            : `Pour ${index + 1}`,
    };
  });
  const grandWater = round1(pours.reduce((sum, pour) => sum + pour.volume, 0));
  const requestedRpm = number(raw.rpm, 80);
  const rpm = rpms.reduce((best, value) =>
    Math.abs(value - requestedRpm) < Math.abs(best - requestedRpm) ? value : best,
  );
  const color =
    typeof raw.theColor === "string" && /^#[0-9a-f]{6}$/i.test(raw.theColor)
      ? raw.theColor
      : "#C9D5B8";
  const recipe: HostedRecipe = {
    name:
      typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : fallbackName,
    cupType: raw.cupType === "other" ? "other" : "xdripper",
    doseGrams,
    grinderSize: round1(clamp(number(raw.grinderSize, 72), 40, 120)),
    rpm,
    grandWater,
    pours,
    bypassEnabled: raw.bypassEnabled === true,
    bypassVolume: Math.round(clamp(number(raw.bypassVolume, 5), 5, 100)),
    bypassTemp: round1(clamp(number(raw.bypassTemp, 85), 40, 95)),
    isSetGrinderSize: raw.isSetGrinderSize === 2 ? 2 : 1,
    theColor: color,
  };

  const clamps: string[] = [];
  const compareNumber = (label: string, rawValue: unknown, normalized: number): void => {
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
      clamps.push(`${label}使用安全缺省值`);
    } else if (Math.abs(rawValue - normalized) > 0.001) {
      clamps.push(`${label}修正为 ${normalized}`);
    }
  };
  compareNumber("粉量", raw.doseGrams, recipe.doseGrams);
  compareNumber("研磨度", raw.grinderSize, recipe.grinderSize);
  compareNumber("转速", raw.rpm, recipe.rpm);
  compareNumber("总水量", raw.grandWater, recipe.grandWater);
  if (raw.cupType !== "xdripper" && raw.cupType !== "other") clamps.push("滤杯类型使用 xDripper");
  if (raw.isSetGrinderSize !== 1 && raw.isSetGrinderSize !== 2)
    clamps.push("研磨设置方式使用默认值");
  if (typeof raw.bypassEnabled !== "boolean") clamps.push("旁路开关使用关闭状态");
  if (recipe.bypassEnabled) {
    compareNumber("旁路水量", raw.bypassVolume, recipe.bypassVolume);
    compareNumber("旁路水温", raw.bypassTemp, recipe.bypassTemp);
  }
  recipe.pours.forEach((pour, index) => {
    const rawPour = rawPours[index] as Record<string, unknown> | null | undefined;
    compareNumber(`第 ${index + 1} 段水量`, rawPour?.volume, pour.volume);
    compareNumber(`第 ${index + 1} 段水温`, rawPour?.temperature, pour.temperature);
    compareNumber(`第 ${index + 1} 段流速`, rawPour?.flowRate, pour.flowRate);
    compareNumber(`第 ${index + 1} 段停顿`, rawPour?.pausing, pour.pausing);
    if (
      rawPour?.pattern !== "center" &&
      rawPour?.pattern !== "circular" &&
      rawPour?.pattern !== "spiral"
    )
      clamps.push(`第 ${index + 1} 段注水轨迹使用中心注水`);
    if (typeof rawPour?.vibBefore !== "boolean")
      clamps.push(`第 ${index + 1} 段前振动开关使用关闭状态`);
    if (typeof rawPour?.vibAfter !== "boolean")
      clamps.push(`第 ${index + 1} 段后振动开关使用关闭状态`);
  });
  return { recipe, clamps };
}

export function normalizeRecipe(input: unknown, fallbackName = "AI Brew"): HostedRecipe {
  return normalizeRecipeWithReport(input, fallbackName).recipe;
}

const closeness = (value: number, ideal: number, fullPenaltyDistance: number): number =>
  Math.max(0, 1 - Math.abs(value - ideal) / fullPenaltyDistance);

export function scoreHostedRecipe(recipe: HostedRecipe): HostedScoreReport {
  const effectiveWater = recipe.grandWater + (recipe.bypassEnabled ? recipe.bypassVolume : 0);
  const ratio = effectiveWater / recipe.doseGrams;
  const averageFlow =
    recipe.pours.reduce((sum, pour) => sum + pour.flowRate, 0) / recipe.pours.length;
  const duration = recipe.pours.reduce(
    (sum, pour) => sum + pour.volume / pour.flowRate + pour.pausing,
    0,
  );
  const specs = [
    ["ratio", "最终粉水比", 25, closeness(ratio, 16, 4), `1:${round1(ratio)}`],
    [
      "temperature",
      "首段水温",
      15,
      closeness(recipe.pours[0].temperature, 92, 10),
      `${recipe.pours[0].temperature}℃`,
    ],
    ["grinder", "研磨度", 15, closeness(recipe.grinderSize, 72, 32), `${recipe.grinderSize}`],
    [
      "bloom",
      "首段停顿",
      15,
      closeness(recipe.pours[0].pausing, 35, 35),
      `${recipe.pours[0].pausing}s`,
    ],
    ["pours", "分段数量", 10, closeness(recipe.pours.length, 3, 3), `${recipe.pours.length} 段`],
    ["flow", "平均流速", 10, closeness(averageFlow, 3.2, 0.4), `${round1(averageFlow)}ml/s`],
    ["duration", "预计时长", 10, closeness(duration, 150, 120), `${Math.round(duration)}s`],
  ] as const;
  const dimensions: HostedScoreDimension[] = specs.map(([key, label, weight, factor, note]) => ({
    key,
    label,
    weight,
    score: round1(weight * factor),
    note,
  }));
  const rankScore = specs.reduce((sum, [, , weight, factor]) => sum + weight * factor, 0);
  const score = round1(dimensions.reduce((sum, dimension) => sum + dimension.score, 0));
  return {
    score,
    rankScore,
    dimensions,
    deductions: dimensions
      .filter((dimension) => dimension.score < dimension.weight)
      .map((dimension) => `${dimension.label} ${dimension.score}/${dimension.weight}`),
  };
}

export function scoreRecipe(recipe: HostedRecipe): number {
  return scoreHostedRecipe(recipe).score;
}

/** 名称与卡片颜色不参与冲煮差异判定；其余可执行参数形成稳定指纹。 */
export function hostedRecipeFingerprint(recipe: HostedRecipe): string {
  return JSON.stringify({
    cupType: recipe.cupType,
    doseGrams: recipe.doseGrams,
    grinderSize: recipe.grinderSize,
    rpm: recipe.rpm,
    grandWater: recipe.grandWater,
    bypassEnabled: recipe.bypassEnabled,
    bypassVolume: recipe.bypassEnabled ? recipe.bypassVolume : 0,
    bypassTemp: recipe.bypassEnabled ? recipe.bypassTemp : 0,
    isSetGrinderSize: recipe.isSetGrinderSize,
    pours: recipe.pours.map(
      ({ volume, temperature, flowRate, pattern, pausing, vibBefore, vibAfter }) => ({
        volume,
        temperature,
        flowRate,
        pattern,
        pausing,
        vibBefore,
        vibAfter,
      }),
    ),
  });
}

export function hostedRecipeDifferenceCount(left: HostedRecipe, right: HostedRecipe): number {
  let differences = 0;
  const changed = (a: number, b: number, threshold: number): void => {
    if (Math.abs(a - b) >= threshold) differences += 1;
  };
  if (left.cupType !== right.cupType) differences += 1;
  changed(left.doseGrams, right.doseGrams, 0.5);
  changed(left.grinderSize, right.grinderSize, 2);
  changed(left.rpm, right.rpm, 10);
  if (left.isSetGrinderSize !== right.isSetGrinderSize) differences += 1;
  if (left.bypassEnabled !== right.bypassEnabled) differences += 1;
  if (left.bypassEnabled || right.bypassEnabled) {
    changed(left.bypassVolume, right.bypassVolume, 5);
    changed(left.bypassTemp, right.bypassTemp, 1);
  }
  if (left.pours.length !== right.pours.length) differences += 1;
  const pairedPours = Math.min(left.pours.length, right.pours.length);
  for (let index = 0; index < pairedPours; index += 1) {
    const a = left.pours[index];
    const b = right.pours[index];
    changed(a.volume, b.volume, 5);
    changed(a.temperature, b.temperature, 1);
    changed(a.flowRate, b.flowRate, 0.1);
    changed(a.pausing, b.pausing, 3);
    if (a.pattern !== b.pattern) differences += 1;
    if (a.vibBefore !== b.vibBefore) differences += 1;
    if (a.vibAfter !== b.vibAfter) differences += 1;
  }
  return differences;
}

export function hostedRecipesAreDistinct(left: HostedRecipe, right: HostedRecipe): boolean {
  return hostedRecipeDifferenceCount(left, right) >= 2;
}

export function hostedRecipeSummary(recipe: HostedRecipe) {
  const effectiveWater = recipe.grandWater + (recipe.bypassEnabled ? recipe.bypassVolume : 0);
  return {
    doseGrams: recipe.doseGrams,
    grandWater: recipe.grandWater,
    ratio: Math.round((effectiveWater / recipe.doseGrams) * 10) / 10,
    grinderSize: recipe.grinderSize,
    rpm: recipe.rpm,
    bypassEnabled: recipe.bypassEnabled,
    bypassVolume: recipe.bypassEnabled ? recipe.bypassVolume : 0,
    bypassTemp: recipe.bypassEnabled ? recipe.bypassTemp : 0,
    isSetGrinderSize: recipe.isSetGrinderSize,
    pours: recipe.pours.map(
      ({ volume, temperature, flowRate, pattern, pausing, vibBefore, vibAfter }) => ({
        volume,
        temperature,
        flowRate,
        pattern,
        pausing,
        vibBefore,
        vibAfter,
      }),
    ),
  };
}
