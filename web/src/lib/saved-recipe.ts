import { RecipeSchema, type Recipe } from "./recipe-schema.js";
import type { RecipeSaveResult } from "./api.js";

export interface SavedRecipeState {
  recipe: Recipe;
  normalized: boolean;
  clamped?: string[];
  warning?: string;
}

/**
 * A save response is authoritative when it contains a validated server recipe.
 * Keeping this mapping pure makes the async save paths share one response rule.
 */
export function savedRecipeState(result: RecipeSaveResult, fallback: Recipe): SavedRecipeState {
  const candidate = result.recipe ?? result.normalizedRecipe;
  const parsed = candidate ? RecipeSchema.safeParse(candidate) : null;
  const recipe = parsed?.success ? parsed.data : fallback;
  const normalized = Boolean(parsed?.success);
  return {
    recipe,
    normalized,
    ...(Array.isArray(result.clamped) ? { clamped: result.clamped } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
  };
}
