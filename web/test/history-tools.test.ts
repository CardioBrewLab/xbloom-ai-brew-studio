import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SavedRecipe } from "../src/lib/api.js";
import {
  filterHistoryEntries,
  historyMatchesFilter,
  historyMatchesQuery,
} from "../src/lib/history-tools.js";

function entry(id: string, name: string, extra: Partial<SavedRecipe> = {}): SavedRecipe {
  return {
    id,
    createdAt: "2026-08-09T00:00:00.000Z",
    recipe: {
      name,
      cupType: "xdripper",
      doseGrams: 15,
      grinderSize: 65,
      rpm: 100,
      grandWater: 240,
      bypassEnabled: false,
      bypassVolume: 0,
      bypassTemp: 85,
      isSetGrinderSize: 1,
      theColor: "#C9D5B8",
      pours: [
        {
          volume: 240,
          temperature: 92,
          flowRate: 3.5,
          pattern: "spiral",
          pausing: 30,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    },
    ...extra,
  };
}

describe("冲煮历史搜索与筛选", () => {
  const a = entry("a", "波切萨清甜版", {
    beanSnapshot: "埃塞俄比亚 水洗 茉莉花",
    feedbacks: [{ createdAt: "2026-08-09", rating: 5, taste: ["平衡"], note: "尾韵像红茶" }],
  });
  const b = entry("b", "Las Veraneras", { parentId: "a", version: 2, changeNotes: "降低尾段水温" });

  it("名称、豆信息、调整说明和反馈备注都可搜索", () => {
    assert.equal(historyMatchesQuery(a, "波切萨"), true);
    assert.equal(historyMatchesQuery(a, "水洗 茉莉"), true);
    assert.equal(historyMatchesQuery(a, "红茶"), true);
    assert.equal(historyMatchesQuery(b, "尾段 水温"), true);
    assert.equal(historyMatchesQuery(b, "日晒"), false);
  });

  it("收藏、反馈和迭代筛选口径互不混淆", () => {
    const favorites = new Set(["b"]);
    assert.equal(historyMatchesFilter(b, "favorites", favorites), true);
    assert.equal(historyMatchesFilter(a, "favorites", favorites), false);
    assert.equal(historyMatchesFilter(a, "feedback", favorites), true);
    assert.equal(historyMatchesFilter(b, "feedback", favorites), false);
    assert.equal(historyMatchesFilter(b, "iterations", favorites), true);
    assert.equal(historyMatchesFilter(a, "iterations", favorites), false);
  });

  it("搜索与筛选组合生效且保持原顺序", () => {
    const result = filterHistoryEntries([a, b], "veraneras", "favorites", new Set(["b"]));
    assert.deepEqual(
      result.map((item) => item.id),
      ["b"],
    );
  });
});
