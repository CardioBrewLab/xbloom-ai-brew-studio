import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { beanGenerationDescription, reconcileModelSelection } from "../src/components/BeanForm.js";

describe("豆仓进入工作台的描述起点", () => {
  it("优先使用豆档案里的风味笔记", () => {
    assert.equal(
      beanGenerationDescription({ id: "b1", name: "波切萨", tastingNotes: "茉莉花、柑橘、红茶" }),
      "用这支豆，想把茉莉花、柑橘、红茶表现得更清楚，整体干净、平衡。",
    );
  });

  it("缺少风味笔记时组合产地、处理法与焙度", () => {
    assert.equal(
      beanGenerationDescription({
        id: "b2",
        name: "示例豆",
        origin: "埃塞俄比亚",
        process: "水洗",
        roastLevel: "浅焙",
      }),
      "用这支埃塞俄比亚、水洗、浅焙的豆子，想冲得干净、平衡，把它本身的特点表现出来。",
    );
  });

  it("模型设置刷新后移除旧选择并跟随新默认模型", () => {
    assert.equal(reconcileModelSelection("old-model", ["new-model", "backup-model"]), "");
    assert.equal(
      reconcileModelSelection("backup-model", ["new-model", "backup-model"]),
      "backup-model",
    );
  });
});
