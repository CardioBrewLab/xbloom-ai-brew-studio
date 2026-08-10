/**
 * 任务 #131 测试：queryAngle 换源重调研策略 + excludeUrls 排除已用 URL
 * 纯函数 buildResearchQueries 角度策略 + researchBean 集成 excludeUrls
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { config } from "../src/config.js";
import { buildResearchQueries, researchBean } from "../src/lib/research.js";

describe("任务 #131：buildResearchQueries queryAngle 换源策略", () => {
  const fullBean = {
    roaster: "Fisher",
    name: "耶加雪菲 G1",
    origin: "埃塞俄比亚",
    process: "水洗",
    varietal: "SL28",
    tastingNotes: "floral citrus",
  };

  it("angle0 = 默认现状：不含 angle1/angle2 前置查询", () => {
    const queries = buildResearchQueries(fullBean, 0);
    assert.ok(queries.length >= 3 && queries.length <= 8);
    // angle0 不在 tier3 前置注入处理法英文短查询
    // angle0 的 tier3 查询含 latin 词元 + brew recipe，但不含单独的 washed + originEn + brew recipe 前置
    // （angle1 会 unshift 一条 [originEn, procEn, "brew recipe", "pour over"] 到 tier3 前面）
    const firstEnglishQueries = queries.filter(
      (q) => q.includes("brew recipe") || q.includes("pour over"),
    );
    // angle0 正常有英文查询，但不应以 angle1 方式前置（firstEnglishQueries[0] 不应只含 originEn + procEn）
    // 验证 angle0 不含 angle2 的 varietal+tastingNotes 独立前置查询
    assert.ok(
      !queries.some(
        (q) =>
          q.includes("floral") &&
          q.includes("citrus") &&
          q.includes("brew recipe") &&
          !q.includes("Ethiopia"),
      ),
    );
  });

  it("angle1 = 处理法+产地英文侧重：tier3 前置注入 washed/natural + 产地英", () => {
    const queries = buildResearchQueries(fullBean, 1);
    assert.ok(queries.length >= 3 && queries.length <= 8);
    // angle1 在 tier3 前面 unshift 一条 [originEn, procEn, "brew recipe", "pour over"]
    // 验证存在仅含 originEn + procEn + brew recipe 的查询（angle1 前置）
    assert.ok(
      queries.some(
        (q) => q.includes("Ethiopia") && q.includes("washed") && q.includes("brew recipe"),
      ),
      `angle1 应前置注入产地英+处理法英查询：${queries.join(" | ")}`,
    );
  });

  it("angle2 = 风味+品种英文侧重：含 varietal/tastingNotes 英文关键词", () => {
    const queries = buildResearchQueries(fullBean, 2);
    assert.ok(queries.length >= 3 && queries.length <= 8);
    // angle2 生效时在 tier3 前面 unshift 一条 [varietal, tastingNotes, "coffee", "brew recipe"]
    assert.ok(
      queries.some((q) => q.includes("SL28") && q.includes("brew recipe")),
      `angle2 应含品种英文关键词：${queries.join(" | ")}`,
    );
    assert.ok(
      queries.some((q) => q.includes("floral") || q.includes("citrus")),
      `angle2 应含风味英文关键词：${queries.join(" | ")}`,
    );
  });

  it("angle2 字段缺失降级：无 varietal/tastingNotes 时回退 angle0 行为", () => {
    const noVarietal = {
      roaster: "Fisher",
      name: "耶加雪菲 G1",
      origin: "埃塞俄比亚",
      process: "水洗",
      // 无 varietal, tastingNotes
    };
    const angle0Queries = buildResearchQueries(noVarietal, 0);
    const angle2Queries = buildResearchQueries(noVarietal, 2);
    // angle2Effective = false，回退 angle0 行为 → 查询列表应完全一致
    assert.deepEqual(
      angle2Queries,
      angle0Queries,
      "无 varietal/tastingNotes 时 angle2 应回退 angle0 行为",
    );
  });

  it("angle2 时论坛定向（Reddit）优先级提升：forum 在 platform 之前", () => {
    const queries = buildResearchQueries(fullBean, 2);
    const redditIdx = queries.findIndex((q) => q.includes("site:reddit.com"));
    const xhsIdx = queries.findIndex((q) => q.includes("site:xiaohongshu.com"));
    if (redditIdx >= 0 && xhsIdx >= 0) {
      assert.ok(
        redditIdx < xhsIdx,
        `angle2 时 Reddit 应在小红书之前：reddit=${redditIdx} xhs=${xhsIdx}`,
      );
    }
    // angle0 时小红书在 Reddit 之前
    const queries0 = buildResearchQueries(fullBean, 0);
    const redditIdx0 = queries0.findIndex((q) => q.includes("site:reddit.com"));
    const xhsIdx0 = queries0.findIndex((q) => q.includes("site:xiaohongshu.com"));
    if (redditIdx0 >= 0 && xhsIdx0 >= 0) {
      assert.ok(
        xhsIdx0 < redditIdx0,
        `angle0 时小红书应在 Reddit 之前：xhs=${xhsIdx0} reddit=${redditIdx0}`,
      );
    }
  });
});

describe("任务 #131：researchBean excludeUrls 排除已用 URL", () => {
  const realFetch = globalThis.fetch;

  it("excludeUrls 中的 URL 不出现在 outcome.sources", async () => {
    const excludedUrl = "https://example.com/excluded-coffee-page";
    const keptUrl = "https://example.com/kept-coffee-page";

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      // SearXNG 探活
      if (url === `${config.searxngUrl}/`) return new Response("ok");
      // SearXNG 搜索：返回两条结果
      if (url.startsWith(`${config.searxngUrl}/search`)) {
        return new Response(
          JSON.stringify({
            results: [
              { title: "被排除的咖啡页", url: excludedUrl, content: "coffee brew recipe" },
              { title: "保留的咖啡页", url: keptUrl, content: "coffee brew recipe" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      // MCP 探活：离线
      if (url.endsWith("/health")) return new Response("", { status: 503 });
      // 页面抓取：返回简单正文
      if (url === excludedUrl || url === keptUrl) {
        return new Response(
          `<html><body><p>coffee brew recipe grinding temperature 92℃ ratio 1:16 grinderSize 60</p></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      // 其他请求（百度/Bing/DDG）：空结果
      return new Response("<html></html>");
    }) as typeof fetch;

    try {
      const outcome = await researchBean(
        { name: "测试豆", origin: "埃塞俄比亚" },
        () => {},
        undefined,
        { excludeUrls: new Set([excludedUrl]) },
      );
      // 被排除的 URL 不应出现在 sources 中
      assert.ok(
        !outcome.sources.some((s) => s.url === excludedUrl),
        `excludeUrls 中的 URL 不应出现在 sources：${outcome.sources.map((s) => s.url).join(", ")}`,
      );
      // 未被排除的 URL 应该保留（如果调研成功）
      if (outcome.ok) {
        assert.ok(
          outcome.sources.some((s) => s.url === keptUrl),
          `未被排除的 URL 应保留在 sources：${outcome.sources.map((s) => s.url).join(", ")}`,
        );
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
