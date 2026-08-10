/**
 * 服务端安全入口：共用规则来自 shared；云端比例可达性与 BLE 编码上限在此追加。
 * 原导入路径和公开函数名保持稳定。
 */
import { validateBaseForTarget, type BrewTarget } from "@xbloom/shared/safety";
import { BLE_RATIO_MAX } from "./ble-protocol.js";
import { isReachableCloudTotal, nearestReachableCloudTotal, type Recipe } from "./recipe-schema.js";

export {
  DURATION_WARN_SECONDS,
  clampRecipe,
  durationWarning,
  estimateTotalSeconds,
} from "@xbloom/shared/safety";
export type { BrewTarget, ClampResult } from "@xbloom/shared/safety";

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 执行共用边界校验，再追加仅服务端下发链路掌握的协议约束。 */
export function validateForTarget(recipe: Recipe, target: BrewTarget): string[] {
  const errors = validateBaseForTarget(recipe, target);

  if (target === "cloud" && !isReachableCloudTotal(recipe.doseGrams, recipe.grandWater)) {
    const nearest = nearestReachableCloudTotal(recipe.doseGrams, recipe.grandWater);
    errors.push(
      `云端粉水比不可达：${recipe.doseGrams}g 粉无法用 0.1 步进的粉水比精确得到 ${recipe.grandWater}ml 总水（官方校验 Σ 分段水量 = dose × ratio），请将总水量调整为最近的可达值 ${nearest}ml（1:${round1(nearest / recipe.doseGrams)}）`,
    );
  }

  if (target === "ble" && recipe.doseGrams > 0) {
    const ratio = round1(recipe.grandWater / recipe.doseGrams);
    if (ratio > BLE_RATIO_MAX) {
      errors.push(
        `粉水比 grandWater/dose=${ratio} 超出 BLE 尾字节单字节编码上限 ${BLE_RATIO_MAX}（int(ratio×10) ≤ 255），下发会被 &0xFF 截断导致机器误读，请加大粉量或减少总水量`,
      );
    }
  }

  return errors;
}

/** BLE 直连采用单字节粉水比编码；不可达组合保留提醒，但不改变直连行为。 */
export function bleReachabilityWarnings(recipe: Recipe): string[] {
  if (isReachableCloudTotal(recipe.doseGrams, recipe.grandWater)) return [];

  const nearest = nearestReachableCloudTotal(recipe.doseGrams, recipe.grandWater);
  return [
    `粉水比不可达提示：${recipe.doseGrams}g 粉无法用 0.1 步进的粉水比精确得到 ${recipe.grandWater}ml 总水，BLE 直连下发时机器可能拒载（建议总水量 ${nearest}ml，1:${round1(nearest / recipe.doseGrams)}）`,
  ];
}
