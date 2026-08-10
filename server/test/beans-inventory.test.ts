/**
 * 豆仓库存系统测试（任务 #50/#65，node:test + assert）：
 * - POST 落盘 number 字段（回归「非空值」过滤器修复：旧实现静默丢 number）
 * - PATCH 白名单部分更新 / 未命中 404 / 非法字段 400 / null 清空字段（任务 #65）
 * - roastDate 真实日历日期校验（任务 #65：2026-13-01 等进位值 400）
 * - DELETE 核心函数：命中删除/未命中 404（任务 #65 抽出可注入路径）
 * - consume 正常扣减 / 扣到 0 / 超扣钳位 + warning / 无库存 400 / brewsLeft 计算
 * 全部用临时 data 文件隔离，不污染真实 data/。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BeanSchema,
  consumeBean,
  createBean,
  deleteBean,
  isCalendarDate,
  loadBeans,
  patchBean,
  saveBeans,
  type Bean,
} from "../src/routes/beans.js";
import { saveAll, type StoredRecipe } from "../src/routes/recipes.js";

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xbloom-test-"));
  return path.join(dir, name);
}

function seedBean(file: string, overrides: Partial<Bean> = {}): Bean {
  const bean: Bean = {
    id: overrides.id ?? "b1",
    createdAt: "2026-08-01T00:00:00Z",
    name: "测试豆",
    ...overrides,
  };
  saveBeans([bean], file);
  return bean;
}

describe("豆档案 schema 库存字段（任务 #50）", () => {
  it("stockGrams/roastDate/restDays/peakWindowDays 合法值通过", () => {
    const parsed = BeanSchema.safeParse({
      name: "耶加雪菲",
      stockGrams: 120,
      roastDate: "2026-07-20",
      restDays: 7,
      peakWindowDays: 45,
    });
    assert.equal(parsed.success, true);
  });

  it("非法值拒绝：负库存 / 错误日期格式 / 负养豆期 / peakWindowDays < 1", () => {
    assert.equal(BeanSchema.safeParse({ name: "x", stockGrams: -1 }).success, false);
    assert.equal(BeanSchema.safeParse({ name: "x", roastDate: "2026/07/20" }).success, false);
    assert.equal(BeanSchema.safeParse({ name: "x", roastDate: "07-20-2026" }).success, false);
    assert.equal(BeanSchema.safeParse({ name: "x", restDays: -3 }).success, false);
    assert.equal(BeanSchema.safeParse({ name: "x", peakWindowDays: 0 }).success, false);
  });

  it("roastDate 日历合法性（任务 #65）：进位值拒绝，真实日期（含闰年 2/29）通过", () => {
    assert.equal(BeanSchema.safeParse({ name: "x", roastDate: "2026-13-01" }).success, false);
    assert.equal(BeanSchema.safeParse({ name: "x", roastDate: "2026-02-30" }).success, false);
    assert.equal(BeanSchema.safeParse({ name: "x", roastDate: "2026-00-10" }).success, false);
    assert.equal(BeanSchema.safeParse({ name: "x", roastDate: "2026-04-31" }).success, false);
    assert.equal(BeanSchema.safeParse({ name: "x", roastDate: "2025-02-29" }).success, false); // 非闰年
    assert.equal(BeanSchema.safeParse({ name: "x", roastDate: "2024-02-29" }).success, true); // 闰年
    assert.equal(BeanSchema.safeParse({ name: "x", roastDate: "2026-08-04" }).success, true);
  });

  it("isCalendarDate 辅助函数：格式/日历双重校验", () => {
    assert.equal(isCalendarDate("2026-08-04"), true);
    assert.equal(isCalendarDate("2026-13-01"), false);
    assert.equal(isCalendarDate("2026-02-30"), false);
    assert.equal(isCalendarDate("bad"), false);
    assert.equal(isCalendarDate(""), false);
  });
});

describe("POST 豆库落盘（回归 number 字段过滤器修复）", () => {
  it("number 字段（stockGrams/restDays/peakWindowDays）不再被静默丢弃", async () => {
    const file = tmpFile("beans.json");
    const { status, payload } = await createBean(
      {
        name: "林波波 肯尼亚",
        origin: "肯尼亚",
        stockGrams: 100,
        roastDate: "2026-07-20",
        restDays: 7,
        peakWindowDays: 40,
      },
      file,
    );
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    const [bean] = loadBeans(file);
    assert.equal(bean.stockGrams, 100);
    assert.equal(bean.roastDate, "2026-07-20");
    assert.equal(bean.restDays, 7);
    assert.equal(bean.peakWindowDays, 40);
    assert.equal(bean.origin, "肯尼亚");
  });

  it("空白字符串仍被丢弃、stockGrams 为 0 照常落盘（0 是有效库存语义）", async () => {
    const file = tmpFile("beans.json");
    await createBean({ name: "豆", origin: "   ", stockGrams: 0 }, file);
    const [bean] = loadBeans(file);
    assert.equal(bean.origin, undefined);
    assert.equal(bean.stockGrams, 0);
  });

  it("校验失败 400：缺 name / 日期格式错误 / 非法日历日期（任务 #65）", async () => {
    const file = tmpFile("beans.json");
    assert.equal((await createBean({}, file)).status, 400);
    assert.equal((await createBean({ name: "豆", roastDate: "2026-7-1" }, file)).status, 400);
    assert.equal((await createBean({ name: "豆", roastDate: "2026-13-01" }, file)).status, 400);
    assert.deepEqual(loadBeans(file), []);
  });
});

describe("PATCH null 清空字段（任务 #65）", () => {
  it("显式 null 删除 roastDate/stockGrams/restDays/peakWindowDays 字段", async () => {
    const file = tmpFile("beans.json");
    seedBean(file, {
      stockGrams: 80,
      roastDate: "2026-07-20",
      restDays: 7,
      peakWindowDays: 40,
      origin: "肯尼亚",
    });
    const { status, payload } = await patchBean(
      "b1",
      { roastDate: null, stockGrams: null, restDays: null, peakWindowDays: null },
      file,
    );
    assert.equal(status, 200);
    const [bean] = loadBeans(file);
    assert.equal("roastDate" in bean, false);
    assert.equal("stockGrams" in bean, false);
    assert.equal("restDays" in bean, false);
    assert.equal("peakWindowDays" in bean, false);
    assert.equal(bean.origin, "肯尼亚"); // 未触碰字段不受影响
    assert.equal(payload.ok, true);
  });

  it("null 与正常值混合：各自生效；null 清空后再赋值可恢复", async () => {
    const file = tmpFile("beans.json");
    seedBean(file, { stockGrams: 80, roastDate: "2026-07-20" });
    await patchBean("b1", { roastDate: null, tastingNotes: "花香" }, file);
    let [bean] = loadBeans(file);
    assert.equal("roastDate" in bean, false);
    assert.equal(bean.tastingNotes, "花香");
    assert.equal(bean.stockGrams, 80);
    await patchBean("b1", { roastDate: "2026-08-01" }, file);
    [bean] = loadBeans(file);
    assert.equal(bean.roastDate, "2026-08-01");
  });

  it("null 非法日历日期不经过：roastDate null 合法（清空），非法字符串仍 400", async () => {
    const file = tmpFile("beans.json");
    seedBean(file);
    assert.equal((await patchBean("b1", { roastDate: null }, file)).status, 200);
    assert.equal((await patchBean("b1", { roastDate: "2026-02-30" }, file)).status, 400);
    assert.equal((await patchBean("b1", { stockGrams: null }, file)).status, 200);
    assert.equal((await patchBean("b1", { stockGrams: -1 }, file)).status, 400);
  });
});

describe("PATCH /api/beans/:id 部分更新", () => {
  it("白名单字段部分更新，未传字段保持原样", async () => {
    const file = tmpFile("beans.json");
    seedBean(file, { origin: "埃塞俄比亚", stockGrams: 80 });
    const { status, payload } = await patchBean(
      "b1",
      { stockGrams: 60, tastingNotes: "莓果 花香" },
      file,
    );
    assert.equal(status, 200);
    const [bean] = loadBeans(file);
    assert.equal(bean.stockGrams, 60);
    assert.equal(bean.tastingNotes, "莓果 花香");
    assert.equal(bean.origin, "埃塞俄比亚"); // 未传字段不变
    assert.equal(payload.ok, true);
  });

  it("未命中 id 返回 404 { ok:false }", async () => {
    const file = tmpFile("beans.json");
    seedBean(file);
    const { status, payload } = await patchBean("missing", { stockGrams: 1 }, file);
    assert.equal(status, 404);
    assert.equal(payload.ok, false);
  });

  it("非法字段 400；空补丁 400", async () => {
    const file = tmpFile("beans.json");
    seedBean(file);
    assert.equal((await patchBean("b1", { stockGrams: -5 }, file)).status, 400);
    assert.equal((await patchBean("b1", { roastDate: "bad" }, file)).status, 400);
    assert.equal((await patchBean("b1", {}, file)).status, 400);
  });
});

describe("DELETE /api/beans/:id 核心（任务 #65 抽出可注入文件路径）", () => {
  it("删除存在条目：列表变空，返回 { ok:true }", async () => {
    const file = tmpFile("beans.json");
    seedBean(file);
    const { status, payload } = await deleteBean("b1", file);
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.deepEqual(loadBeans(file), []);
  });

  it("删除多个条目中的指定 id：只删目标，其余保留", async () => {
    const file = tmpFile("beans.json");
    const a: Bean = { id: "a", createdAt: "", name: "豆A" };
    const b: Bean = { id: "b", createdAt: "", name: "豆B" };
    saveBeans([a, b], file);
    await deleteBean("a", file);
    const list = loadBeans(file);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "b");
  });

  it("删除不存在 id → 404 { ok:false }，文件不变", async () => {
    const file = tmpFile("beans.json");
    seedBean(file);
    const { status, payload } = await deleteBean("missing", file);
    assert.equal(status, 404);
    assert.equal(payload.ok, false);
    assert.equal(loadBeans(file).length, 1);
  });

  it("并发创建/删除串行执行不丢写入（文件互斥锁，任务 #65 锁覆盖）", async () => {
    const file = tmpFile("beans.json");
    await Promise.all(Array.from({ length: 10 }, (_, i) => createBean({ name: `豆${i}` }, file)));
    assert.equal(loadBeans(file).length, 10); // 并发追加无丢失
    const ids = loadBeans(file).map((b) => b.id);
    await Promise.all(ids.map((id) => deleteBean(id, file)));
    assert.deepEqual(loadBeans(file), []);
  });
});

describe("POST /api/beans/:id/consume 库存扣减", () => {
  it("正常扣减：返回 remainingGrams 与 brewsLeft（缺省参考粉量 15g）", async () => {
    const beansFile = tmpFile("beans.json");
    const recipesFile = tmpFile("recipes.json");
    seedBean(beansFile, { stockGrams: 100 });
    const { status, payload } = await consumeBean("b1", { grams: 20 }, beansFile, recipesFile);
    assert.equal(status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.remainingGrams, 80);
    assert.equal(payload.brewsLeft, Math.floor(80 / 15)); // 5
    assert.equal(payload.warning, undefined);
    assert.equal(loadBeans(beansFile)[0].stockGrams, 80); // 落盘
  });

  it("body.doseGrams 优先作为参考粉量", async () => {
    const beansFile = tmpFile("beans.json");
    const recipesFile = tmpFile("recipes.json");
    seedBean(beansFile, { stockGrams: 100 });
    const { payload } = await consumeBean(
      "b1",
      { grams: 20, doseGrams: 20 },
      beansFile,
      recipesFile,
    );
    assert.equal(payload.remainingGrams, 80);
    assert.equal(payload.brewsLeft, 4); // 80 / 20
  });

  it("参考粉量取该 beanId 最近一条关联配方的 doseGrams", async () => {
    const beansFile = tmpFile("beans.json");
    const recipesFile = tmpFile("recipes.json");
    seedBean(beansFile, { stockGrams: 100 });
    const recipes: StoredRecipe[] = [
      {
        id: "r-old",
        createdAt: "2026-07-01T00:00:00Z",
        recipe: { doseGrams: 12 } as never,
        beanId: "b1",
      },
      {
        id: "r-new",
        createdAt: "2026-07-20T00:00:00Z",
        recipe: { doseGrams: 18 } as never,
        beanId: "b1",
      },
      { id: "r-other", createdAt: "2026-08-01T00:00:00Z", recipe: { doseGrams: 30 } as never },
    ];
    saveAll(recipes, recipesFile);
    const { payload } = await consumeBean("b1", { grams: 10 }, beansFile, recipesFile);
    assert.equal(payload.remainingGrams, 90);
    assert.equal(payload.brewsLeft, 5); // 90 / 18 = 5
  });

  it("恰好扣到 0：remainingGrams 与 brewsLeft 均为 0、无 warning", async () => {
    const beansFile = tmpFile("beans.json");
    const recipesFile = tmpFile("recipes.json");
    seedBean(beansFile, { stockGrams: 30 });
    const { status, payload } = await consumeBean("b1", { grams: 30 }, beansFile, recipesFile);
    assert.equal(status, 200);
    assert.equal(payload.remainingGrams, 0);
    assert.equal(payload.brewsLeft, 0);
    assert.equal(payload.warning, undefined);
  });

  it("超扣钳位到 0 且响应带 warning", async () => {
    const beansFile = tmpFile("beans.json");
    const recipesFile = tmpFile("recipes.json");
    seedBean(beansFile, { stockGrams: 10 });
    const { status, payload } = await consumeBean("b1", { grams: 25 }, beansFile, recipesFile);
    assert.equal(status, 200);
    assert.equal(payload.remainingGrams, 0);
    assert.ok(typeof payload.warning === "string" && payload.warning.includes("库存不足"));
    assert.equal(loadBeans(beansFile)[0].stockGrams, 0);
  });

  it("豆未录入库存（stockGrams undefined）→ 400 友好错误", async () => {
    const beansFile = tmpFile("beans.json");
    const recipesFile = tmpFile("recipes.json");
    seedBean(beansFile); // 无 stockGrams
    const { status, payload } = await consumeBean("b1", { grams: 10 }, beansFile, recipesFile);
    assert.equal(status, 400);
    assert.equal(payload.ok, false);
    assert.ok(String(payload.error).includes("未录入库存"));
  });

  it("豆不存在 → 404；grams 越界/非数 → 400", async () => {
    const beansFile = tmpFile("beans.json");
    const recipesFile = tmpFile("recipes.json");
    seedBean(beansFile, { stockGrams: 50 });
    assert.equal((await consumeBean("missing", { grams: 5 }, beansFile, recipesFile)).status, 404);
    assert.equal((await consumeBean("b1", { grams: 0 }, beansFile, recipesFile)).status, 400);
    assert.equal((await consumeBean("b1", { grams: 201 }, beansFile, recipesFile)).status, 400);
    assert.equal((await consumeBean("b1", {}, beansFile, recipesFile)).status, 400);
    assert.equal(loadBeans(beansFile)[0].stockGrams, 50); // 未发生任何扣减
  });

  it("并发扣减串行执行不丢更新（文件互斥锁）", async () => {
    const beansFile = tmpFile("beans.json");
    const recipesFile = tmpFile("recipes.json");
    seedBean(beansFile, { stockGrams: 100 });
    await Promise.all(
      Array.from({ length: 10 }, () => consumeBean("b1", { grams: 8 }, beansFile, recipesFile)),
    );
    assert.equal(loadBeans(beansFile)[0].stockGrams, 20); // 100 - 10×8
  });
});
