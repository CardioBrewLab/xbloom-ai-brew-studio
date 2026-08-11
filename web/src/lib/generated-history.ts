import type { GenerateEvent, GenerateRequest, RecipeSaveOptions } from "./api.js";
import type { Recipe } from "./recipe-schema.js";

type RecipeEvent = Extract<GenerateEvent, { type: "recipe" }>;

export interface GeneratedSaveCheckpoint<T> {
  generationId: number;
  recipeRevision: number;
  promise: Promise<T>;
  recipe?: Recipe;
  /** Stable across transport retries so the server can return the first committed row. */
  clientRequestId?: string;
  /** Original metadata must survive retries (version lineage, feedback link, variant, etc.). */
  saveOptions?: RecipeSaveOptions;
}

/** Reuse the one save already started for this exact generated recipe. */
export function reusableGeneratedSave<T>(
  checkpoint: GeneratedSaveCheckpoint<T> | null,
  generationId: number,
  recipeRevision?: number,
): Promise<T> | null {
  if (!checkpoint || checkpoint.generationId !== generationId) return null;
  if (recipeRevision !== undefined && checkpoint.recipeRevision !== recipeRevision) return null;
  return checkpoint.promise;
}

export function sameRecipeSnapshot(left: Recipe | null | undefined, right: Recipe): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}

/** 配方切换会改变 revision；内容仍是同一快照时复用已完成写入。 */
export function reusableGeneratedSaveForRecipe<T>(
  checkpoint: GeneratedSaveCheckpoint<T> | null,
  generationId: number,
  recipe: Recipe,
): Promise<T> | null {
  return (
    reusableGeneratedSaveCheckpointForRecipe(checkpoint, generationId, recipe)?.promise ?? null
  );
}

/** Return the whole checkpoint when retry metadata (not just its Promise) is required. */
export function reusableGeneratedSaveCheckpointForRecipe<T>(
  checkpoint: GeneratedSaveCheckpoint<T> | null,
  generationId: number,
  recipe: Recipe,
): GeneratedSaveCheckpoint<T> | null {
  if (!checkpoint || checkpoint.generationId !== generationId) return null;
  return sameRecipeSnapshot(checkpoint.recipe, recipe) ? checkpoint : null;
}

/** Async completions may mutate the workbench only while both identities still match. */
export function generatedRecipeIsCurrent(
  generationId: number,
  recipeRevision: number,
  currentGenerationId: number,
  currentRecipeRevision: number,
): boolean {
  return generationId === currentGenerationId && recipeRevision === currentRecipeRevision;
}

/**
 * 保存双方案后，当前工作台可能已经在原版与改进版之间切换。
 * 按配方快照而不是旧 revision 认领对应历史 ID；若用户已编辑，则不把旧保存结果回写给新内容。
 */
export function savedPairVariantForRecipe(
  current: Recipe | null,
  original: Recipe,
  improved: Recipe,
  preferredVariant?: "original" | "improved",
): "original" | "improved" | null {
  if (!current) return null;
  const matchesOriginal = sameRecipeSnapshot(current, original);
  const matchesImproved = sameRecipeSnapshot(current, improved);
  if (matchesOriginal && matchesImproved) return preferredVariant ?? "original";
  if (matchesOriginal) return "original";
  if (matchesImproved) return "improved";
  return null;
}

/**
 * 生成结果与历史记录共用同一份元数据装配规则。
 * 明确选择的 beanId 优先于服务端自由文本匹配，避免旧流或异常事件改写用户选豆意图。
 */
export function generatedRecipeSaveOptions(
  request: GenerateRequest | null,
  event: RecipeEvent,
  researchSummary: string,
  matchedBeanId?: string,
): RecipeSaveOptions {
  const selectedBeanId = request?.beanId?.trim();
  const matched = matchedBeanId?.trim();
  const beanId = selectedBeanId || matched || undefined;
  return {
    ...(event.refUrls?.length ? { refUrls: event.refUrls } : {}),
    ...(request?.beans?.trim() ? { beanSnapshot: request.beans.trim() } : {}),
    ...(researchSummary.trim() ? { researchSummary: researchSummary.trim() } : {}),
    ...(event.reviewFindings?.length ? { reviewFindings: event.reviewFindings } : {}),
    ...(beanId ? { beanId } : {}),
    ...(request?.roasterReference?.trim()
      ? { roasterReference: request.roasterReference.trim() }
      : {}),
    ...(event.brewRationale?.length ? { brewRationale: event.brewRationale } : {}),
    variant: "original",
  };
}
