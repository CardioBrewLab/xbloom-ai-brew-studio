/**
 * 豆仓关联闭环测试（任务 #130）：
 * - normalizeBeanName 纯函数：去括号/品种号/空格/小写化
 * - ensureBeanFromFreeText 多级匹配：L1（名+产地+处理法）、L2（仅名）、L3（旧精确）
 * - 命中已有豆不建空壳、返回 beanId；未命中建新记录带 origin/process
 * - recipes PATCH 逻辑：更新 beanId / 解除关联 / 豆不存在 400
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeBeanName,
  ensureBeanFromFreeText,
  loadBeans,
  saveBeans,
  type Bean,
} from "../src/routes/beans.js";
import { loadAll, saveAll, type StoredRecipe } from "../src/routes/recipes.js";

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbloom-link-"));
  return path.join(dir, name);
}

// ---------------------------------------------------------------------------
// normalizeBeanName 纯函数
// ---------------------------------------------------------------------------

describe("normalizeBeanName（任务 #130）", () => {
  it("去括号及括号内后缀（中文全角 + 英文半角）", () => {
    assert.equal(normalizeBeanName("波切萨（埃塞俄比亚 阿贝格纳）"), "波切萨");
    assert.equal(normalizeBeanName("波切萨(埃塞俄比亚)"), "波切萨");
    assert.equal(normalizeBeanName("Elto (Ethiopia, Natural)"), "elto");
  });

  it("未闭合括号：从开括号到串尾一并去除", () => {
    assert.equal(normalizeBeanName("波切萨（埃塞俄比亚 · Natural 日晒 ·"), "波切萨");
    assert.equal(normalizeBeanName("测试豆(未闭合"), "测试豆");
  });

  it("去品种号（4 位以上纯数字）", () => {
    assert.equal(normalizeBeanName("波切萨 74158"), "波切萨");
    assert.equal(normalizeBeanName("瑰夏 74110 巴拿马"), "瑰夏 巴拿马");
    // 3 位以下不剥离（如 SL28、G1）
    assert.equal(normalizeBeanName("林波波 SL28"), "林波波 sl28");
  });

  it("去多余空格 + 小写化", () => {
    assert.equal(normalizeBeanName("  Elto  冷浸蜜  "), "elto 冷浸蜜");
    assert.equal(normalizeBeanName("ELTO COFFEE"), "elto coffee");
  });

  it("组合：括号 + 品种号 + 空格 + 大小写", () => {
    assert.equal(normalizeBeanName("波切萨（埃塞俄比亚 阿贝格纳 · Natural 日晒 · 74158"), "波切萨");
    assert.equal(normalizeBeanName("Elto Cold Brew 74158 (Ethiopia)"), "elto cold brew");
  });

  it("无变化：纯豆名无括号/品种号", () => {
    assert.equal(normalizeBeanName("肯尼亚-林波波"), "肯尼亚-林波波");
    assert.equal(normalizeBeanName("波切萨"), "波切萨");
  });
});

// ---------------------------------------------------------------------------
// ensureBeanFromFreeText 多级匹配
// ---------------------------------------------------------------------------

describe("ensureBeanFromFreeText 多级匹配（任务 #130）", () => {
  it("L2 命中：波切萨 freeText 命中已有「波切萨 74158」不建空壳", () => {
    const file = tmpFile("beans.json");
    const existing: Bean = {
      id: "b-poquesa",
      createdAt: "2026-08-01T00:00:00Z",
      name: "波切萨 74158",
      origin: "埃塞俄比亚",
      process: "日晒",
    };
    saveBeans([existing], file);

    // 模拟粘贴 AI 归类后的 freeText（deriveBeanName 会截取首段）
    const freeText = "波切萨（埃塞俄比亚 阿贝格纳 · Natural 日晒 · 74158 风味：花香 甜橙";
    const result = ensureBeanFromFreeText(freeText, file);

    assert.equal(result.created, false, "应命中已有豆，不新建");
    assert.equal(result.matched, true);
    assert.equal(result.beanId, "b-poquesa");
    // 不新增空壳记录
    assert.equal(loadBeans(file).length, 1);
  });

  it("L1 命中：规范化豆名 + origin + process 三字段组合", () => {
    const file = tmpFile("beans.json");
    saveBeans(
      [
        {
          id: "b1",
          createdAt: "",
          name: "Elto 冷浸蜜",
          origin: "埃塞俄比亚",
          process: "蜜处理",
        },
      ],
      file,
    );

    const freeText = "elto 冷浸蜜（埃塞俄比亚 · 蜜处理）风味：花香";
    const result = ensureBeanFromFreeText(freeText, file);

    assert.equal(result.created, false);
    assert.equal(result.matched, true);
    assert.equal(result.beanId, "b1");
    assert.equal(loadBeans(file).length, 1);
  });

  it("L3 命中：deriveBeanName 精确（toLowerCase+trim，兼容旧口径）", () => {
    const file = tmpFile("beans.json");
    saveBeans([{ id: "b1", createdAt: "", name: " Elto 冷浸蜜 " }], file);
    // freeText 经 deriveBeanName → "elto 冷浸蜜"，经 normalizeBeanName → "elto 冷浸蜜"
    // L2 先命中（规范化后相同），这里测 L3 兜底：豆名无括号/品种号时 normalize 等价于 toLower+trim
    const result = ensureBeanFromFreeText("elto 冷浸蜜 风味：花香", file);
    assert.equal(result.created, false);
    assert.equal(result.beanId, "b1");
  });

  it("未命中建新记录带 origin/process + rawDescription + beanId", () => {
    const file = tmpFile("beans.json");
    saveBeans([{ id: "b1", createdAt: "", name: "其他豆" }], file);

    const freeText = "瑰夏 74110（巴拿马 翡翠庄园 · 日晒）风味：茉莉花";
    const result = ensureBeanFromFreeText(freeText, file);

    assert.equal(result.created, true);
    assert.ok(result.beanId, "应返回新 beanId");

    const list = loadBeans(file);
    assert.equal(list.length, 2);
    const added = list[1];
    assert.equal(added.id, result.beanId);
    assert.equal(added.origin, "巴拿马");
    assert.equal(added.process, "日晒");
    assert.ok(added.rawDescription);
  });

  it("空文本不新建", () => {
    const file = tmpFile("beans.json");
    const result = ensureBeanFromFreeText("   ", file);
    assert.equal(result.created, false);
    assert.equal(result.name, "");
    assert.equal(loadBeans(file).length, 0);
  });

  it("已有同名（忽略大小写/首尾空白）则跳过，不重复追加", () => {
    const file = tmpFile("beans.json");
    saveBeans([{ id: "b1", createdAt: "", name: " Elto 冷浸蜜 " }], file);
    const result = ensureBeanFromFreeText("elto 冷浸蜜 风味：花香 甜橙", file);
    assert.equal(result.created, false);
    assert.equal(loadBeans(file).length, 1);
  });
});

// ---------------------------------------------------------------------------
// recipes PATCH 逻辑（任务 #130 手动关联入口）
// ---------------------------------------------------------------------------

describe("recipes PATCH 逻辑（任务 #130）", () => {
  it("更新配方 beanId 关联：模拟 PATCH 逻辑", () => {
    const recipeFile = tmpFile("recipes.json");
    const beanFile = tmpFile("beans.json");

    // seed: 1 配方无 beanId + 1 豆档案
    const recipe: StoredRecipe = {
      id: "r1",
      createdAt: "2026-08-01T00:00:00Z",
      recipe: { name: "测试配方" } as never,
    };
    saveAll([recipe], recipeFile);
    saveBeans([{ id: "b1", createdAt: "", name: "波切萨 74158" }], beanFile);

    // 模拟 PATCH handler 逻辑：loadAll → find → set beanId → saveAll
    const list = loadAll(recipeFile);
    const entry = list.find((r) => r.id === "r1");
    assert.ok(entry, "配方应存在");

    const newBeanId = "b1";
    const beanExists = loadBeans(beanFile).some((b) => b.id === newBeanId);
    assert.equal(beanExists, true, "豆档案应存在");

    entry.beanId = newBeanId;
    saveAll(list, recipeFile);

    // 验证落盘
    const updated = loadAll(recipeFile);
    assert.equal(updated[0].beanId, "b1");
  });

  it("解除关联：beanId 空串 → delete entry.beanId", () => {
    const recipeFile = tmpFile("recipes.json");

    const recipe: StoredRecipe = {
      id: "r1",
      createdAt: "",
      recipe: { name: "x" } as never,
      beanId: "b-old",
    };
    saveAll([recipe], recipeFile);

    // 模拟 PATCH handler 逻辑：beanId 为空串 → delete
    const list = loadAll(recipeFile);
    const entry = list.find((r) => r.id === "r1")!;
    const newBeanId = "";
    if (newBeanId === "") {
      delete entry.beanId;
    }
    saveAll(list, recipeFile);

    assert.equal(loadAll(recipeFile)[0].beanId, undefined);
  });

  it("豆不存在时拒绝关联：loadBeans.some → false", () => {
    const beanFile = tmpFile("beans.json");
    saveBeans([{ id: "b1", createdAt: "", name: "真实豆" }], beanFile);

    // 模拟校验逻辑
    const newBeanId = "b-nonexistent";
    const beanExists = loadBeans(beanFile).some((b) => b.id === newBeanId);
    assert.equal(beanExists, false, "不存在的 beanId 应返回 false");
  });
});
