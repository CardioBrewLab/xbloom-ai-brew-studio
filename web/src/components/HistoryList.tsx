/**
 * 冲煮历史列表：加载 / 删除 / 勾选 2 个进入对比 / 记录冲煮日志（反馈闭环）。
 * 数据由外层统一拉取后传入，保证与"对比"页共享同一份列表。
 * 版本链：按 parentId 分组缩进展示迭代链，子版本带"v2 · 源自：偏酸"徽标与 changeNotes。
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import type { SavedRecipe } from "../lib/api.js";
import { filterHistoryEntries, type HistoryFilter } from "../lib/history-tools.js";
import { Card, CardHeader, inputCls } from "./ui.js";

const FAVORITES_KEY = "xbloom-history-favorites-v1";
const FILTERS: Array<{ id: HistoryFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "favorites", label: "收藏" },
  { id: "feedback", label: "有反馈" },
  { id: "iterations", label: "迭代版" },
];

function readFavorites(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export interface HistoryListProps {
  items: SavedRecipe[] | null;
  error: string;
  onRetry: () => void;
  onLoad: (entry: SavedRecipe) => void;
  onDelete: (id: string) => void;
  /** 对比勾选 */
  compareIds: string[];
  onToggleCompare: (id: string) => void;
  /** 冲煮日志反馈 */
  onFeedback: (entry: SavedRecipe) => void;
}

export default function HistoryList({
  items,
  error,
  onRetry,
  onLoad,
  onDelete,
  compareIds,
  onToggleCompare,
  onFeedback,
}: HistoryListProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const [favoriteIds, setFavoriteIds] = useState<string[]>(readFavorites);
  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);
  const visibleItems = useMemo(
    () => filterHistoryEntries(items ?? [], query, filter, favoriteSet),
    [favoriteSet, filter, items, query],
  );

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(favoriteIds));
    } catch {
      // 浏览器禁用本地存储时，收藏仍可在当前页面使用。
    }
  }, [favoriteIds]);

  useEffect(() => {
    if (!items) return;
    const liveIds = new Set(items.map((entry) => entry.id));
    setFavoriteIds((current) => {
      const next = current.filter((id) => liveIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [items]);

  const toggleFavorite = (id: string) => {
    setFavoriteIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  // 版本链索引：parentId → 子版本列表；id → entry。筛选后子版本可提升为根，避免命中项消失。
  const { byParent, byId } = useMemo(() => {
    const byParent = new Map<string, SavedRecipe[]>();
    const byId = new Map<string, SavedRecipe>();
    for (const e of visibleItems) {
      byId.set(e.id, e);
      if (e.parentId) byParent.set(e.parentId, [...(byParent.get(e.parentId) ?? []), e]);
    }
    for (const list of byParent.values()) {
      list.sort(
        (a, b) => (a.version ?? 0) - (b.version ?? 0) || a.createdAt.localeCompare(b.createdAt),
      );
    }
    return { byParent, byId };
  }, [visibleItems]);

  const allById = useMemo(
    () => new Map((items ?? []).map((entry) => [entry.id, entry] as const)),
    [items],
  );

  // 链首：无 parentId，或 parent 已被删除（孤儿提升为根，避免条目消失）
  const roots = visibleItems.filter((e) => !e.parentId || !byId.has(e.parentId));

  /** 单个条目卡片（含版本徽标 / changeNotes），子版本递归缩进其下 */
  const renderEntry = (entry: SavedRecipe) => {
    const checked = compareIds.includes(entry.id);
    const favorite = favoriteSet.has(entry.id);
    const ratio =
      (entry.recipe.grandWater + (entry.recipe.bypassEnabled ? entry.recipe.bypassVolume : 0)) /
      entry.recipe.doseGrams;
    const children = byParent.get(entry.id) ?? [];
    // "v2 · 源自：偏酸"：取触发本版本的 feedback 标签摘要
    const sourceFb =
      entry.parentId && entry.sourceFeedbackId
        ? allById.get(entry.parentId)?.feedbacks?.find((f) => f.id === entry.sourceFeedbackId)
        : undefined;
    return (
      <Fragment key={entry.id}>
        <li
          className={`group animate-fade-up rounded-xl border px-3 py-2.5 transition-colors duration-150 ${
            checked
              ? "border-[var(--line-strong)] bg-[var(--bg-inset)]"
              : "border-[var(--line)] bg-[var(--bg-card)] hover:border-[var(--line-strong)]"
          }`}
        >
          <div className="flex flex-col gap-2.5">
            <label className="flex min-w-0 cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggleCompare(entry.id)}
                className="h-3.5 w-3.5 shrink-0 accent-[var(--tx-1)]"
                title="勾选以加入对比"
              />
              <span
                className="h-3 w-3 shrink-0 rounded-full border border-[var(--line-strong)]"
                style={{ backgroundColor: entry.recipe.theColor }}
                title={`配方卡颜色 ${entry.recipe.theColor}`}
              />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-[var(--tx-1)]">
                    {entry.recipe.name}
                  </span>
                  {/* 自动审查遗留问题小黄点（任务 #36） */}
                  {entry.reviewFindings && entry.reviewFindings.length > 0 && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warn)]"
                      title={`自动审查遗留 ${entry.reviewFindings.length} 项问题：${entry.reviewFindings
                        .map((f) => f.message)
                        .join("；")}`}
                    />
                  )}
                  {entry.version && (
                    <span
                      className="tnum shrink-0 rounded-full border border-[var(--acc-line)] bg-[var(--acc-soft)] px-1.5 py-px text-[10px] font-medium text-[var(--acc)]"
                      title={sourceFb ? `源自反馈：${sourceFb.taste.join("、")}` : "迭代版本"}
                    >
                      v{entry.version}
                      {sourceFb && sourceFb.taste.length > 0
                        ? ` · 源自：${sourceFb.taste.join("、")}`
                        : ""}
                    </span>
                  )}
                  {/* 双方案对比小徽标（任务 #62）：原版/改进；改进版名称已带「· AI 改进版」后缀 */}
                  {entry.variant && (
                    <span
                      className={
                        entry.variant === "improved"
                          ? "shrink-0 rounded-full border border-[var(--acc-line)] bg-[var(--acc-soft)] px-1.5 py-px text-[10px] font-medium text-[var(--acc)]"
                          : "shrink-0 rounded-full border border-[var(--line-strong)] bg-[var(--bg-inset)] px-1.5 py-px text-[10px] font-medium text-[var(--tx-3)]"
                      }
                      title={
                        entry.variant === "improved"
                          ? `AI 改进版${entry.pairId ? "（配对原版已落库）" : ""}`
                          : "烘焙师原版（双方案对比）"
                      }
                    >
                      {entry.variant === "improved" ? "AI 改进版" : "原版"}
                    </span>
                  )}
                </span>
                <span className="tnum mt-0.5 block text-[11px] text-[var(--tx-3)]">
                  {new Date(entry.createdAt).toLocaleString("zh-CN", { hour12: false })} ·{" "}
                  {entry.recipe.doseGrams}g / {entry.recipe.grandWater}ml · 1:{ratio.toFixed(1)} ·{" "}
                  {entry.recipe.pours.length} 段
                </span>
                {entry.changeNotes && (
                  <span
                    className="mt-0.5 block truncate text-[11px] text-[var(--tx-2)]"
                    title={entry.changeNotes}
                  >
                    ✎ {entry.changeNotes}
                  </span>
                )}
              </span>
            </label>
            {/* 操作按钮常显：反馈调参为主入口，不依赖悬停才显现 */}
            <div className="flex shrink-0 justify-end gap-1.5 border-t border-[var(--line)] pt-2">
              <button
                type="button"
                onClick={() => toggleFavorite(entry.id)}
                aria-label={
                  favorite ? `取消收藏 ${entry.recipe.name}` : `收藏 ${entry.recipe.name}`
                }
                title={favorite ? "取消收藏" : "收藏常用配方"}
                className={`flex h-7 w-7 items-center justify-center rounded-md border text-sm transition-colors duration-150 ${
                  favorite
                    ? "border-[var(--acc-line)] bg-[var(--acc-soft)] text-[var(--acc)]"
                    : "border-[var(--line)] text-[var(--tx-3)] hover:border-[var(--acc-line)] hover:text-[var(--acc)]"
                }`}
              >
                {favorite ? "★" : "☆"}
              </button>
              <button
                type="button"
                onClick={() => onFeedback(entry)}
                className="rounded-md border border-[var(--acc-line)] bg-[var(--acc-soft)] px-2 py-1 text-[11px] font-medium text-[var(--acc)] transition-colors duration-150 hover:border-[var(--acc)]"
                title="记录杯测反馈并让 AI 按反馈调参"
              >
                反馈调参
              </button>
              <button
                type="button"
                onClick={() => onLoad(entry)}
                className="rounded-md border border-[var(--line-strong)] px-2 py-1 text-[11px] text-[var(--tx-2)] transition-colors duration-150 hover:bg-[var(--bg-inset)] hover:text-[var(--tx-1)]"
              >
                载入
              </button>
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(`确认删除“${entry.recipe.name}”？此操作会移除这条历史记录。`)
                  ) {
                    onDelete(entry.id);
                  }
                }}
                className="rounded-md border border-[var(--line)] px-2 py-1 text-[11px] text-[var(--tx-3)] transition-colors hover:border-[var(--bad)]/60 hover:text-[var(--bad)]"
              >
                删除
              </button>
            </div>
          </div>
        </li>
        {children.length > 0 && (
          <li className="list-none">
            <ul className="ml-3.5 space-y-2 border-l border-[var(--line)] pl-3 pt-0.5">
              {children.map((c) => renderEntry(c))}
            </ul>
          </li>
        )}
      </Fragment>
    );
  };

  return (
    <Card>
      <CardHeader
        icon={<IconHistory />}
        title="冲煮历史"
        sub={
          items
            ? `${visibleItems.length === items.length ? items.length : `${visibleItems.length}/${items.length}`} 个配方 · 搜索、收藏或勾选 2 个对比`
            : "加载中…"
        }
      />
      <div className="max-h-80 overflow-y-auto p-3">
        {items !== null && items.length > 0 && (
          <div className="sticky top-0 z-10 mb-3 space-y-2 bg-[var(--bg-card)] pb-1">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜配方、豆子或杯测记录"
              aria-label="搜索冲煮历史"
              className={`${inputCls} h-9 text-xs`}
            />
            <div className="flex flex-wrap gap-1.5" aria-label="冲煮历史筛选">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id)}
                  aria-pressed={filter === item.id}
                  className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors duration-150 ${
                    filter === item.id
                      ? "border-[var(--line-strong)] bg-[var(--tx-1)] text-[var(--bg-card)]"
                      : "border-[var(--line)] bg-[var(--bg-card)] text-[var(--tx-3)] hover:border-[var(--line-strong)] hover:text-[var(--tx-1)]"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {error && (
          <div className="px-2 py-3 text-center text-xs text-[var(--tx-3)]" role="alert">
            <p>{error}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-2 rounded-md border border-[var(--line-strong)] px-3 py-1.5 font-medium text-[var(--tx-2)] hover:bg-[var(--bg-inset)]"
            >
              重新加载
            </button>
          </div>
        )}
        {!error && items === null && (
          <div className="space-y-2" aria-label="冲煮历史加载中">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="rounded-xl border border-[var(--line)] bg-[var(--bg-card)] p-3"
              >
                <div className="flex items-center gap-2.5">
                  <span className="skeleton h-3.5 w-3.5 rounded" />
                  <span className="skeleton h-3 w-28" />
                  <span className="skeleton ml-auto h-5 w-12 rounded-full" />
                </div>
                <div className="mt-3 flex gap-2">
                  <span className="skeleton h-2.5 w-20" />
                  <span className="skeleton h-2.5 w-16" />
                  <span className="skeleton h-2.5 w-12" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!error && items !== null && items.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[var(--tx-3)]">
            还没有保存的配方，生成一个试试
          </p>
        )}
        {!error && items !== null && items.length > 0 && roots.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[var(--tx-3)]">没有找到符合条件的配方</p>
        )}
        <ul className="space-y-2">{roots.map((entry) => renderEntry(entry))}</ul>
      </div>
    </Card>
  );
}

function IconHistory() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <path
        d="M3 12a9 9 0 1 0 3-6.7L3.5 7.5M3 3v5h5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 7v5l3 2" strokeLinecap="round" />
    </svg>
  );
}
