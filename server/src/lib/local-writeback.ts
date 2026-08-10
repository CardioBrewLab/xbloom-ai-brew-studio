/**
 * 云端发布对齐值回写本地配方库（任务 #45 引入，任务 #55 修正匹配语义）。
 *
 * 背景：发布链路会把不可达的总水量/小数分段对齐为官方可接受的值，
 * 若本地条目不同步更新，本地 200ml 与云端 198ml 会永久漂移
 * （BLE 直连与云端冲煮基准不一致，复发布基准也是旧值）。
 *
 * 匹配键（任务 #55 警告1）：name + doseGrams + grandWater + 整段 pours 的规范化 JSON。
 * 发布请求与库内条目都经 RecipeSchema 归一，pours 可直接 JSON.stringify 比较——
 * 只比各段 volume 会把版本链条目中「仅温度/流速等不同」的更早版本误判为命中，
 * 把新版本整套 pours 覆写进旧版本。
 *
 * 多条完全重复条目：全部回写（任务 #55 建议3），返回首个被回写的条目 id。
 * best-effort：任何失败只记日志，不影响发布结果；未命中安全 no-op。
 */
import { loadAll, RECIPES_FILE, saveAll } from "../routes/recipes.js";
import type { Recipe } from "./recipe-schema.js";

export function writeBackAlignedRecipe(
  original: Recipe,
  alignedGrandWater: number,
  alignedPours: Recipe["pours"],
  file: string = RECIPES_FILE,
): string | undefined {
  try {
    const list = loadAll(file);
    const poursKey = JSON.stringify(original.pours);
    const hits = list.filter(
      (e) =>
        e.recipe &&
        e.recipe.name === original.name &&
        e.recipe.doseGrams === original.doseGrams &&
        e.recipe.grandWater === original.grandWater &&
        JSON.stringify(e.recipe.pours ?? []) === poursKey,
    );
    if (hits.length === 0) return undefined;
    for (const hit of hits) {
      hit.recipe = { ...hit.recipe, grandWater: alignedGrandWater, pours: alignedPours };
    }
    saveAll(list, file);
    console.log(
      `[xbloom][cloud] 对齐值已回写本地配方 [${hits.map((h) => h.id).join(", ")}]（grandWater=${alignedGrandWater}ml，Σ分段同步）`,
    );
    return hits[0].id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[xbloom][cloud] 对齐值回写本地配方失败（不影响发布）：${msg}`);
    return undefined;
  }
}
