/** 测试共享夹具：一份完全落在 SAFE_LIMITS 内的标准配方 */
import type { RecipeCore } from "../src/lib/recipe-schema.js";

/** xdripper，15g 粉 × 15.6 = 234ml 总水，两段注水 */
export function makeValidRecipe(): RecipeCore {
  return {
    name: "测试配方",
    cupType: "xdripper",
    doseGrams: 15,
    grinderSize: 60,
    rpm: 90,
    grandWater: 234,
    pours: [
      { volume: 100, temperature: 90, flowRate: 3.2, pattern: "center", pausing: 10 },
      { volume: 134, temperature: 88, flowRate: 3.2, pattern: "circular", pausing: 5 },
    ],
  };
}
