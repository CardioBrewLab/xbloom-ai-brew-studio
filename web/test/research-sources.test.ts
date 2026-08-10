/**
 * 调研来源列表渲染辅助逻辑单测（任务 #94）：
 * - sourceCategoryOf：域名/关键词启发式类别映射（徽章）
 * - cleanSnippet：snippet 展示前归一化
 * 运行：npx tsx --test "test/*.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanSnippet,
  countXhsSources,
  extractXhsDisclosure,
  sourceCategoryOf,
} from "../src/components/StreamPanel.js";

// ---------------------------------------------------------------------------
// sourceCategoryOf：徽章映射规则
// ---------------------------------------------------------------------------

test("sourceCategoryOf：小红书域名（主域 + 子域 + xhslink 短链）", () => {
  assert.equal(sourceCategoryOf("https://www.xiaohongshu.com/explore/abc123"), "小红书");
  assert.equal(sourceCategoryOf("https://share.xiaohongshu.com/note/1"), "小红书");
  assert.equal(sourceCategoryOf("https://xhslink.com/a/xyz"), "小红书");
});

test("sourceCategoryOf：Reddit 主域与短链", () => {
  assert.equal(sourceCategoryOf("https://www.reddit.com/r/Coffee/comments/x/"), "Reddit");
  assert.equal(sourceCategoryOf("https://old.reddit.com/r/pourover/"), "Reddit");
  assert.equal(sourceCategoryOf("https://redd.it/abc"), "Reddit");
});

test("sourceCategoryOf：home-barista 归专业论坛；xbloom 系归官方", () => {
  assert.equal(sourceCategoryOf("https://www.home-barista.com/knives/t123.html"), "论坛");
  assert.equal(sourceCategoryOf("https://share-h5.xbloom.com/share/abc"), "官方");
  assert.equal(sourceCategoryOf("https://www.xbloom.com/recipes"), "官方");
});

test("sourceCategoryOf：烘焙商/媒体关键词粗分（.coffee 顶级域、域名或标题命中均可）", () => {
  assert.equal(
    sourceCategoryOf("https://onyyx.coffee/products/ethiopia"),
    "烘焙商",
    ".coffee 顶级域归烘焙商",
  );
  assert.equal(sourceCategoryOf("https://example.com/a", "某某咖啡烘焙 手冲参数分享"), "烘焙商");
  assert.equal(sourceCategoryOf("https://sprudge.com/some-post"), "媒体");
  assert.equal(sourceCategoryOf("https://example.com/a", "咖啡评测周刊：手冲器具横评"), "媒体");
});

test("sourceCategoryOf：未命中任何规则归网页；非法 URL 不抛错", () => {
  assert.equal(sourceCategoryOf("https://zh.wikipedia.org/wiki/咖啡"), "网页");
  assert.equal(sourceCategoryOf("not a url", "随便一个标题"), "网页");
});

// ---------------------------------------------------------------------------
// cleanSnippet：摘要归一化
// ---------------------------------------------------------------------------

test("cleanSnippet：空白折叠 + 去首尾；缺失/空串返回空（渲染时不占位）", () => {
  assert.equal(cleanSnippet(undefined), "");
  assert.equal(cleanSnippet("   "), "");
  assert.equal(cleanSnippet("  水温\n92℃\t闷蒸 30s "), "水温 92℃ 闷蒸 30s");
});

test("cleanSnippet：超过 160 字符截断加省略号", () => {
  const long = "咖".repeat(200);
  const out = cleanSnippet(long);
  assert.equal(out.length, 161);
  assert.ok(out.endsWith("…"));
  const short = "短摘要";
  assert.equal(cleanSnippet(short), short, "短文本原样返回");
});

// ---------------------------------------------------------------------------
// countXhsSources：小红书命中数前端统计（任务 #122）
// ---------------------------------------------------------------------------

test("countXhsSources：按徽章口径统计小红书条数（主域/子域/xhslink）", () => {
  const sources = [
    { title: "手冲笔记", url: "https://www.xiaohongshu.com/explore/a" },
    { title: "短链笔记", url: "https://xhslink.com/a/b" },
    { title: "Reddit 帖", url: "https://www.reddit.com/r/pourover/" },
    { title: "网页", url: "https://sprudge.com/x" },
  ];
  assert.equal(countXhsSources(sources), 2);
});

test("countXhsSources：空数组/无小红书来源返回 0", () => {
  assert.equal(countXhsSources([]), 0);
  assert.equal(countXhsSources([{ title: "烘焙商参数", url: "https://onyyx.coffee/a" }]), 0);
});

// ---------------------------------------------------------------------------
// extractXhsDisclosure：MCP 三态披露行提取（任务 #122）
// ---------------------------------------------------------------------------

test("extractXhsDisclosure：提取 MCP 直连命中披露行", () => {
  const summary =
    "【联网调研摘要】\n搜索词：x\n引用来源：\n1. a — b\n小红书笔记（MCP 直连）命中 3 条真实笔记，其中 2 条进入最终引用来源。\n正文…";
  const line = extractXhsDisclosure(summary);
  assert.ok(line.startsWith("小红书笔记（MCP 直连）命中 3 条"));
});

test("extractXhsDisclosure：三态措辞（零召回/超时/未连接/登录过期）均可提取", () => {
  assert.ok(
    extractXhsDisclosure("a\n小红书定向检索：MCP 搜索执行超时，已降级。\nb").startsWith(
      "小红书定向检索：MCP 搜索执行超时",
    ),
  );
  assert.ok(
    extractXhsDisclosure("小红书登录已过期：MCP 凭证失效。").startsWith("小红书登录已过期"),
  );
});

test("extractXhsDisclosure：无披露行/undefined 返回空串", () => {
  assert.equal(extractXhsDisclosure(undefined), "");
  assert.equal(extractXhsDisclosure("【摘要】\n搜索词：x\n正文…"), "");
});
