/** web 侧 safety 总时长估算测试（node:test + assert，任务 #35 双副本同步验证） */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DURATION_WARN_SECONDS, durationWarning, estimateTotalSeconds } from "../src/lib/safety.js";

describe("estimateTotalSeconds（web 副本，任务 #35）", () => {
  it("估算总时长 = Σ(volume/flowRate + pausing)，保留一位小数", () => {
    const seconds = estimateTotalSeconds({
      pours: [
        {
          volume: 60,
          temperature: 91,
          flowRate: 3.0,
          pattern: "center",
          pausing: 35,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 174,
          temperature: 91,
          flowRate: 3.2,
          pattern: "circular",
          pausing: 0,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    });
    // 60/3+35 + 174/3.2+0 = 55 + 54.375 = 109.375 → 109.4
    assert.equal(seconds, 109.4);
  });

  it(">180s 追加警告（不拦截），≤180s 无警告", () => {
    assert.equal(DURATION_WARN_SECONDS, 180);
    const short = {
      pours: [
        {
          volume: 100,
          temperature: 90,
          flowRate: 3.2,
          pattern: "center",
          pausing: 40,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    };
    assert.equal(durationWarning(short), undefined);

    const long = {
      pours: [
        {
          volume: 100,
          temperature: 90,
          flowRate: 3.0,
          pattern: "center",
          pausing: 160,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    };
    // 100/3+160 ≈ 193.3 > 180
    const warning = durationWarning(long);
    assert.ok(warning);
    assert.ok(warning!.includes("3:00"));
  });
});
