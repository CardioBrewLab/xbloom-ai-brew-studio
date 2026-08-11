import {
  nearestReachableCloudTotal,
  patternToCloud,
  pourName,
  type RecipeCore,
} from "./recipe-schema.js";

export interface CloudPayloadResult {
  payload: Record<string, unknown>;
  adjustments: string[];
  alignedGrandWater: number;
  alignedPours: RecipeCore["pours"];
}

const CUP_TYPE_TO_CLOUD: Record<RecipeCore["cupType"], number> = {
  xdripper: 2,
  other: 3,
};
const MIN_POUR_ML = 1;
const MAX_POUR_ML = 300;
const round1 = (value: number): number => Math.round(value * 10) / 10;

/** 最大余数法把各段对齐为整数，同时保持总量与官方 0.1 粉水比精确一致。 */
export function alignIntegerPours(
  scaled: number[],
  target: number,
  minValue = MIN_POUR_ML,
  maxValue = MAX_POUR_ML,
): number[] {
  const count = scaled.length;
  if (!count) throw new Error("无注水段可分配");
  if (target < count * minValue) {
    throw new Error(`总水量 ${target}ml 过小，无法分给 ${count} 段（每段至少 ${minValue}ml）`);
  }
  if (target > count * maxValue) {
    throw new Error(`总水量 ${target}ml 过大，${count} 段每段上限 ${maxValue}ml 也装不下`);
  }
  const result = scaled.map((value) => Math.max(minValue, Math.floor(value)));
  let remaining = target - result.reduce((sum, value) => sum + value, 0);
  const order = scaled
    .map((value, index) => ({
      index,
      fraction: result[index] > Math.floor(value) ? -1 : value - Math.floor(value),
    }))
    .sort((left, right) => right.fraction - left.fraction);
  for (const { index } of order) {
    if (remaining <= 0) break;
    result[index] += 1;
    remaining -= 1;
  }
  while (remaining < 0) {
    let index = -1;
    for (let current = 0; current < count; current += 1) {
      if (result[current] > minValue && (index < 0 || result[current] > result[index])) {
        index = current;
      }
    }
    if (index < 0) {
      throw new Error(`总水量 ${target}ml 无法在 ${count} 段间分配（每段至少 ${minValue}ml）`);
    }
    const take = Math.min(-remaining, result[index] - minValue);
    result[index] -= take;
    remaining += take;
  }
  for (let index = 0; remaining > 0; index = (index + 1) % count) {
    result[index] += 1;
    remaining -= 1;
  }
  for (let guard = 0; guard < count * maxValue; guard += 1) {
    let high = 0;
    let low = 0;
    for (let index = 1; index < count; index += 1) {
      if (result[index] > result[high]) high = index;
      if (result[index] < result[low]) low = index;
    }
    if (result[high] <= maxValue) break;
    if (low === high || result[low] >= maxValue) {
      throw new Error(`总水量 ${target}ml 超出 ${count} 段每段 ≤${maxValue}ml 的可分配上限`);
    }
    const move = Math.min(result[high] - maxValue, maxValue - result[low]);
    result[high] -= move;
    result[low] += move;
  }
  return result;
}

export function toCloudPayload(recipe: RecipeCore, name?: string): CloudPayloadResult {
  const initialTotal = round1(recipe.pours.reduce((sum, pour) => sum + pour.volume, 0));
  const target = nearestReachableCloudTotal(recipe.doseGrams, initialTotal);
  const ratio = round1(target / recipe.doseGrams);
  const adjustments: string[] = [];
  let pours = recipe.pours.map((pour) => ({ ...pour }));
  if (Math.abs(initialTotal - target) > 1e-9 && initialTotal > 0) {
    adjustments.push(
      `总水量: ${initialTotal}ml → ${target}ml（官方要求浇注段总量与粉水比 1:${ratio} × ${recipe.doseGrams}g 精确对齐）`,
    );
  }
  const originalVolumes = recipe.pours.map((pour) => pour.volume);
  const scale = initialTotal > 0 ? target / initialTotal : 1;
  const alignedVolumes = alignIntegerPours(
    originalVolumes.map((volume) => volume * scale),
    target,
  );
  if (alignedVolumes.some((volume, index) => volume !== originalVolumes[index])) {
    adjustments.push(
      `分段水量: [${originalVolumes.join(", ")}] → [${alignedVolumes.join(", ")}]ml（官方 App 要求整数毫升并与粉水比精确一致）`,
    );
    pours = pours.map((pour, index) => ({ ...pour, volume: alignedVolumes[index] }));
  }
  const sum = alignedVolumes.reduce((total, volume) => total + volume, 0);
  if (
    alignedVolumes.some((volume) => !Number.isInteger(volume) || volume < MIN_POUR_ML) ||
    sum !== target
  ) {
    throw new Error(`浇注对齐结果有误（Σ=${sum}，目标=${target}）`);
  }
  const pourList = pours.map((pour, index) => ({
    theName: pourName(pour, index),
    volume: pour.volume,
    temperature: pour.temperature,
    flowRate: pour.flowRate,
    pattern: patternToCloud(pour.pattern),
    pausing: pour.pausing,
    isEnableVibrationBefore: pour.vibBefore ? 1 : 2,
    isEnableVibrationAfter: pour.vibAfter ? 1 : 2,
  }));
  const bypassEnabled = recipe.bypassEnabled === true;
  return {
    adjustments,
    alignedGrandWater: sum,
    alignedPours: pours,
    payload: {
      theName: name ?? recipe.name,
      dose: recipe.doseGrams,
      grandWater: ratio,
      grinderSize: recipe.grinderSize,
      rpm: recipe.rpm,
      cupType: CUP_TYPE_TO_CLOUD[recipe.cupType],
      adaptedModel: 1,
      isEnableBypassWater: bypassEnabled ? 1 : 2,
      isSetGrinderSize: recipe.isSetGrinderSize ?? 1,
      theColor: recipe.theColor ?? "#C9D5B8",
      theSubsetId: 0,
      bypassTemp: bypassEnabled ? (recipe.bypassTemp ?? 85) : 85,
      bypassVolume: bypassEnabled ? (recipe.bypassVolume ?? 5) : 5,
      subSetType: 2,
      appPlace: [4],
      createTimeStamp: Date.now(),
      isShortcuts: 2,
      pourDataJSONStr: JSON.stringify(pourList),
    },
  };
}
