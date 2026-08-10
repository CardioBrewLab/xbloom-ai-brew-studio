import type { SavedRecipe } from "./api.js";

export type HistoryFilter = "all" | "favorites" | "feedback" | "iterations";

/** 历史搜索统一口径：名称、豆信息、调研摘要、调整说明与杯测记录均可命中。 */
export function historySearchText(entry: SavedRecipe): string {
  const feedback = (entry.feedbacks ?? []).flatMap((item) => [
    item.taste.join(" "),
    item.note ?? "",
  ]);
  return [
    entry.recipe.name,
    entry.beanSnapshot ?? "",
    entry.researchSummary ?? "",
    entry.changeNotes ?? "",
    ...feedback,
  ]
    .join(" ")
    .toLocaleLowerCase("zh-CN");
}

export function historyMatchesQuery(entry: SavedRecipe, query: string): boolean {
  const words = query.trim().toLocaleLowerCase("zh-CN").split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = historySearchText(entry);
  return words.every((word) => haystack.includes(word));
}

export function historyMatchesFilter(
  entry: SavedRecipe,
  filter: HistoryFilter,
  favoriteIds: ReadonlySet<string>,
): boolean {
  if (filter === "favorites") return favoriteIds.has(entry.id);
  if (filter === "feedback") return (entry.feedbacks?.length ?? 0) > 0;
  if (filter === "iterations") return Boolean(entry.parentId || (entry.version ?? 1) > 1);
  return true;
}

export function filterHistoryEntries(
  entries: SavedRecipe[],
  query: string,
  filter: HistoryFilter,
  favoriteIds: ReadonlySet<string>,
): SavedRecipe[] {
  return entries.filter(
    (entry) =>
      historyMatchesQuery(entry, query) && historyMatchesFilter(entry, filter, favoriteIds),
  );
}
