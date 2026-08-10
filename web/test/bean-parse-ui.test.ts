/**
 * 豆信息粘贴 AI 解析归类的纯函数测试（任务 #118，node:test + assert）：
 * - beanParseTransition：解析状态机合法转移链 + 非法转移保持原态
 * - beanParseAutoApply：解析成功即自动应用（任务 #123）
 * - mergeParsedDraft：draft 覆盖层合并（任务 #123 实时同步依赖）
 * - parsedFieldToText：tastingNotes 顿号连接 / null 归空串
 * - mapParsedToBeanFields：应用映射（豆名打头、元信息串联、风味收尾、全空 undefined）
 * - missingCoreFields：核心字段缺失键计算
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  beanParseAutoApply,
  beanParseTransition,
  mapParsedToBeanFields,
  mergeParsedDraft,
  missingCoreFields,
  PARSED_FIELD_META,
  parsedFieldToText,
  type BeanParseState,
} from "../src/components/BeanForm.js";
import type { ParsedBeanInfo } from "../src/lib/api.js";

const IDLE: BeanParseState = { phase: "idle" };

const PARSED_FULL: ParsedBeanInfo = {
  name: "耶加雪菲 G1 科契尔",
  roaster: "某烘焙工坊",
  origin: "埃塞俄比亚 · 耶加雪菲",
  estate: null,
  process: "水洗",
  varietal: "原生种",
  roastLevel: "浅焙",
  tastingNotes: ["茉莉花", "柑橘"],
  altitude: "1900-2100m",
  notes: null,
};

const PARSED_EMPTY: ParsedBeanInfo = {
  name: null,
  roaster: null,
  origin: null,
  estate: null,
  process: null,
  varietal: null,
  roastLevel: null,
  tastingNotes: [],
  altitude: null,
  notes: null,
};

describe("解析状态机 beanParseTransition（任务 #118）", () => {
  it("合法转移链：idle→loading→done→applied 与 loading→error", () => {
    const loading = beanParseTransition(IDLE, "PARSE_START");
    assert.equal(loading.phase, "loading");
    assert.equal(beanParseTransition(loading, "PARSE_OK").phase, "done");
    assert.equal(beanParseTransition(loading, "PARSE_FAIL", "LLM 挂了").error, "LLM 挂了");
    assert.equal(beanParseTransition(loading, "PARSE_FAIL").phase, "error");
    const done = beanParseTransition(loading, "PARSE_OK");
    assert.equal(beanParseTransition(done, "APPLY").phase, "applied");
    // applied 态允许重新解析与再应用
    const applied = beanParseTransition(done, "APPLY");
    assert.equal(beanParseTransition(applied, "PARSE_START").phase, "loading");
    assert.equal(beanParseTransition(applied, "APPLY").phase, "applied");
  });

  it("非法转移保持原态（返回同一对象，绝不抛错）", () => {
    assert.equal(beanParseTransition(IDLE, "PARSE_OK"), IDLE);
    assert.equal(beanParseTransition(IDLE, "APPLY"), IDLE);
    assert.equal(beanParseTransition(IDLE, "RESET"), IDLE);
    const loading = beanParseTransition(IDLE, "PARSE_START");
    assert.equal(beanParseTransition(loading, "PARSE_START"), loading);
    assert.equal(beanParseTransition(loading, "APPLY"), loading);
    assert.equal(beanParseTransition({ phase: "error" }, "APPLY").phase, "error");
    assert.equal(beanParseTransition(IDLE, "不存在的动作"), IDLE);
  });

  it("RESET：done/error/applied → idle（原文变更回可重新解析态）", () => {
    for (const phase of ["done", "error", "applied"] as const) {
      assert.equal(beanParseTransition({ phase }, "RESET").phase, "idle");
    }
  });
});

describe("解析成功即自动应用（任务 #123）", () => {
  it("beanParseAutoApply：loading 一步直达 applied（PARSE_OK 串联 APPLY）", () => {
    assert.equal(beanParseAutoApply({ phase: "loading" }).phase, "applied");
  });

  it("beanParseAutoApply：非 loading 态 → PARSE_OK 非法保持原态；done 态 APPLY 合法则应用", () => {
    for (const phase of ["idle", "error", "applied"] as const) {
      assert.equal(beanParseAutoApply({ phase }).phase, phase);
    }
    // done --PARSE_OK--> 非法保持 done --APPLY--> applied（两步链的第二步仍合法）
    assert.equal(beanParseAutoApply({ phase: "done" }).phase, "applied");
  });

  it("重解析覆盖应用：applied --PARSE_START--> loading --自动应用--> applied", () => {
    const loading = beanParseTransition({ phase: "applied" }, "PARSE_START");
    assert.equal(loading.phase, "loading");
    assert.equal(beanParseAutoApply(loading).phase, "applied");
  });

  it("mergeParsedDraft：draft 覆盖 AI 归类值，未触碰字段保持原值", () => {
    const merged = mergeParsedDraft(PARSED_FULL, { name: "花魁 日晒", roaster: "" });
    assert.equal(merged.name, "花魁 日晒");
    assert.equal(merged.roaster, null); // 空串归 null
    assert.equal(merged.origin, PARSED_FULL.origin); // 未触碰保持
    assert.deepEqual(merged.tastingNotes, PARSED_FULL.tastingNotes);
  });

  it("mergeParsedDraft：tastingNotes 编辑文本按顿号/逗号/换行拆分为数组", () => {
    const merged = mergeParsedDraft(PARSED_EMPTY, { tastingNotes: "草莓、蓝莓，蜂蜜\n玫瑰" });
    assert.deepEqual(merged.tastingNotes, ["草莓", "蓝莓", "蜂蜜", "玫瑰"]);
  });

  it("自动应用链路：解析豆 → 映射文本含豆名（generate beans 通道来源）", () => {
    const composed = mapParsedToBeanFields(mergeParsedDraft(PARSED_FULL, {}));
    assert.ok(composed?.startsWith("耶加雪菲 G1 科契尔"));
  });
});

describe("解析结果展示与应用映射（任务 #118）", () => {
  it("PARSED_FIELD_META：十个字段且顺序固定（豆名打头、备注收尾）", () => {
    assert.equal(PARSED_FIELD_META.length, 10);
    assert.equal(PARSED_FIELD_META[0].key, "name");
    assert.equal(PARSED_FIELD_META[PARSED_FIELD_META.length - 1].key, "notes");
    assert.ok(PARSED_FIELD_META.every((m) => m.label.length > 0));
  });

  it("parsedFieldToText：数组顿号连接、null 归空串、字符串原样", () => {
    assert.equal(parsedFieldToText(PARSED_FULL, "tastingNotes"), "茉莉花、柑橘");
    assert.equal(parsedFieldToText(PARSED_FULL, "estate"), "");
    assert.equal(parsedFieldToText(PARSED_FULL, "name"), "耶加雪菲 G1 科契尔");
    assert.equal(parsedFieldToText(PARSED_EMPTY, "tastingNotes"), "");
  });

  it("mapParsedToBeanFields：豆名（元信息 · 串联 · 风味收尾）", () => {
    assert.equal(
      mapParsedToBeanFields(PARSED_FULL),
      "耶加雪菲 G1 科契尔（某烘焙工坊 · 埃塞俄比亚 · 耶加雪菲 · 水洗 · 原生种 · 浅焙 · 1900-2100m · 风味：茉莉花、柑橘）",
    );
  });

  it("mapParsedToBeanFields：estate 并入产地；部分缺失时只串联非空字段", () => {
    const partial: ParsedBeanInfo = {
      ...PARSED_EMPTY,
      name: "花魁",
      origin: "埃塞俄比亚",
      estate: "古吉产区处理站",
      tastingNotes: ["草莓"],
    };
    assert.equal(
      mapParsedToBeanFields(partial),
      "花魁（埃塞俄比亚 · 古吉产区处理站 · 风味：草莓）",
    );
    const onlyName: ParsedBeanInfo = { ...PARSED_EMPTY, name: "曼特宁" };
    assert.equal(mapParsedToBeanFields(onlyName), "曼特宁");
  });

  it("mapParsedToBeanFields：全空 → undefined（不覆盖表单）", () => {
    assert.equal(mapParsedToBeanFields(PARSED_EMPTY), undefined);
  });

  it("missingCoreFields：仅统计七个核心字段，estate/altitude/notes 不算缺失", () => {
    assert.deepEqual(missingCoreFields(PARSED_EMPTY).sort(), [
      "name",
      "origin",
      "process",
      "roastLevel",
      "roaster",
      "tastingNotes",
      "varietal",
    ]);
    assert.deepEqual(missingCoreFields(PARSED_FULL), []);
    const noRoast: ParsedBeanInfo = { ...PARSED_FULL, roastLevel: null };
    assert.deepEqual(missingCoreFields(noRoast), ["roastLevel"]);
  });
});
