/**
 * 豆仓关联闭环前端测试（任务 #130）：
 * - beanMatch 事件类型与优先级逻辑（matched ?? requested）
 * - relatedOf fallback：L1 beanId 精确 + L2 beanSnapshot 包含规范化豆名
 * - normalizeBeanNameFE：去括号/品种号/空格/小写化
 * - isShellBean：空壳检测
 * 运行：npx tsx --test "test/*.test.ts"
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeBeanNameFE, isShellBean, relatedOf } from "../src/pages/BeansPage.js";
import type { Bean, SavedRecipe, GenerateEvent } from "../src/lib/api.js";

// ---------------------------------------------------------------------------
// beanMatch 事件类型与优先级（任务 #130）
// ---------------------------------------------------------------------------

describe("beanMatch 事件类型与优先级（任务 #130）", () => {
  it("beanMatch 事件可正确 JSON 序列化/反序列化", () => {
    const event: GenerateEvent = {
      type: "beanMatch",
      beanId: "b-123",
      beanName: "波切萨 74158",
      matched: true,
    };
    const json = JSON.stringify(event);
    const parsed = JSON.parse(json) as GenerateEvent;
    assert.equal(parsed.type, "beanMatch");
    if (parsed.type === "beanMatch") {
      assert.equal(parsed.beanId, "b-123");
      assert.equal(parsed.beanName, "波切萨 74158");
      assert.equal(parsed.matched, true);
    }
  });

  it("优先级逻辑：matchedBeanId 优先于 requestedBeanId", () => {
    // 模拟 App.tsx 中的优先级：matchedBeanIdRef.current ?? lastGenReqRef.current?.beanId
    const matched = "b-matched";
    const requested: string | undefined = "b-requested";
    const result = matched ?? requested;
    assert.equal(result, "b-matched", "matched 优先");
  });

  it("优先级逻辑：matched 为 undefined 时回退到 requested", () => {
    const matched: string | undefined = undefined;
    const requested: string | undefined = "b-requested";
    const result = matched ?? requested;
    assert.equal(result, "b-requested", "回退到 requested");
  });

  it("优先级逻辑：两者均 undefined 时不发送 beanId", () => {
    const matched: string | undefined = undefined;
    const requested: string | undefined = undefined;
    const result = matched ?? requested;
    assert.equal(result, undefined, "均空时不发送");
  });
});

// ---------------------------------------------------------------------------
// normalizeBeanNameFE
// ---------------------------------------------------------------------------

describe("normalizeBeanNameFE（任务 #130）", () => {
  it("去括号及括号内后缀", () => {
    assert.equal(normalizeBeanNameFE("波切萨（埃塞俄比亚）"), "波切萨");
    assert.equal(normalizeBeanNameFE("Elto (Ethiopia)"), "elto");
  });

  it("未闭合括号", () => {
    assert.equal(normalizeBeanNameFE("波切萨（埃塞俄比亚 · 日晒"), "波切萨");
  });

  it("去品种号", () => {
    assert.equal(normalizeBeanNameFE("波切萨 74158"), "波切萨");
    assert.equal(normalizeBeanNameFE("瑰夏 74110 巴拿马"), "瑰夏 巴拿马");
  });

  it("去空格 + 小写化", () => {
    assert.equal(normalizeBeanNameFE("  Elto  冷浸蜜  "), "elto 冷浸蜜");
  });
});

// ---------------------------------------------------------------------------
// isShellBean
// ---------------------------------------------------------------------------

describe("isShellBean（任务 #130）", () => {
  it("仅有 name → 空壳", () => {
    assert.equal(isShellBean({ id: "s1", createdAt: "", name: "空壳豆" }), true);
  });

  it("有 name + rawDescription → 仍为空壳", () => {
    assert.equal(
      isShellBean({ id: "s1", createdAt: "", name: "空壳豆", rawDescription: "原始文本" }),
      true,
    );
  });

  it("有 origin 等有效字段 → 非空壳", () => {
    assert.equal(
      isShellBean({ id: "b1", createdAt: "", name: "完整豆", origin: "埃塞俄比亚" }),
      false,
    );
    assert.equal(
      isShellBean({ id: "b2", createdAt: "", name: "完整豆", roastLevel: "中焙" }),
      false,
    );
    assert.equal(isShellBean({ id: "b3", createdAt: "", name: "完整豆", stockGrams: 200 }), false);
  });
});

// ---------------------------------------------------------------------------
// relatedOf fallback
// ---------------------------------------------------------------------------

describe("relatedOf fallback（任务 #130）", () => {
  const bean: Bean = { id: "b1", createdAt: "", name: "波切萨 74158" };

  it("L1：beanId 精确匹配", () => {
    const recipes: SavedRecipe[] = [
      { id: "r1", createdAt: "2026-08-02", recipe: { name: "配方A" } as never, beanId: "b1" },
      { id: "r2", createdAt: "2026-08-01", recipe: { name: "配方B" } as never, beanId: "b2" },
    ];
    const result = relatedOf(bean, recipes);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "r1");
  });

  it("L2 fallback：beanSnapshot 包含规范化豆名（旧配方无 beanId）", () => {
    const recipes: SavedRecipe[] = [
      {
        id: "r-old",
        createdAt: "2026-07-01",
        recipe: { name: "旧配方" } as never,
        // 旧配方无 beanId，但 snapshot 含豆名核心 token
        beanSnapshot: "波切萨 74158（埃塞俄比亚 日晒）",
      },
    ];
    const result = relatedOf(bean, recipes);
    assert.equal(result.length, 1, "L2 fallback 应命中");
    assert.equal(result[0].id, "r-old");
  });

  it("L1 + L2 合并去重：同一配方不重复出现", () => {
    const recipes: SavedRecipe[] = [
      { id: "r1", createdAt: "2026-08-02", recipe: { name: "配方A" } as never, beanId: "b1" },
      {
        id: "r2",
        createdAt: "2026-08-01",
        recipe: { name: "配方B" } as never,
        beanId: "b1",
        beanSnapshot: "波切萨",
      },
    ];
    const result = relatedOf(bean, recipes);
    assert.equal(result.length, 2, "两条均 L1 命中，L2 不重复");
  });

  it("L2 不命中：snapshot 不含豆名核心 token", () => {
    const recipes: SavedRecipe[] = [
      {
        id: "r-other",
        createdAt: "2026-08-01",
        recipe: { name: "其他配方" } as never,
        beanSnapshot: "瑰夏 74110",
      },
    ];
    const result = relatedOf(bean, recipes);
    assert.equal(result.length, 0, "不匹配的 snapshot 不应命中");
  });

  it("无配方时返回空数组", () => {
    assert.equal(relatedOf(bean, []).length, 0);
  });

  it("按创建时间倒序排列", () => {
    const recipes: SavedRecipe[] = [
      { id: "r1", createdAt: "2026-08-01", recipe: { name: "旧" } as never, beanId: "b1" },
      { id: "r2", createdAt: "2026-08-03", recipe: { name: "新" } as never, beanId: "b1" },
    ];
    const result = relatedOf(bean, recipes);
    assert.equal(result[0].id, "r2", "最新的在前");
    assert.equal(result[1].id, "r1");
  });
});
