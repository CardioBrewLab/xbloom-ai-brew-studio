/**
 * SSE 正常结束却没有 recipe/error 事件时给出可见兜底，避免结果栏进入无反馈终态。
 */
export function missingRecipeMessage(
  receivedRecipe: boolean,
  receivedError: boolean,
): string | undefined {
  if (receivedRecipe || receivedError) return undefined;
  return "生成流程已经结束，但本次没有收到可展示的配方。输入内容仍保留，请重新生成。";
}
