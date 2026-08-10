/** 单配方异步保存完成时，确认请求和配方都仍是发起保存时的同一版本。 */
export function saveCompletionIsCurrent(
  requestId: number,
  recipeRevision: number,
  currentRequestId: number,
  currentRecipeRevision: number,
): boolean {
  return requestId === currentRequestId && recipeRevision === currentRecipeRevision;
}
