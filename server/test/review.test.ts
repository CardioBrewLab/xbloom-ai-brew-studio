/**
 * 规则审查器测试（任务 #36）：覆盖 review.ts 各规则分支。
 * node:test + assert，纯函数无需网络/磁盘。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  beanIdentityFingerprint,
  detectRoastLevel,
  GRINDER_RANGE_TOLERANCE,
  hasSpecialProcess,
  isSameBeanAsRecent,
  isSkeletonClone,
  isUltraLightRoast,
  reviewDimensionCount,
  reviewRecipe,
  type ReviewFinding,
} from "../src/lib/review.js";
import type { Recipe } from "../src/lib/recipe-schema.js";

/** 构造一份默认"干净"的合法配方：浅焙水洗骨架，逐用例覆写参数制造违规 */
function base(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: "审查测试",
    cupType: "xdripper",
    doseGrams: 15,
    grinderSize: 62,
    rpm: 90,
    grandWater: 234,
    pours: [
      {
        volume: 60,
        temperature: 93,
        flowRate: 3.2,
        pattern: "center",
        pausing: 35,
        vibBefore: false,
        vibAfter: false,
      },
      {
        volume: 174,
        temperature: 92,
        flowRate: 3.2,
        pattern: "circular",
        pausing: 5,
        vibBefore: false,
        vibAfter: false,
      },
    ],
    bypassEnabled: false,
    bypassVolume: 5,
    bypassTemp: 85,
    isSetGrinderSize: 1,
    theColor: "#C9D5B8",
    ...overrides,
  };
}

const hasRule = (fs: ReviewFinding[], rule: string) => fs.some((f) => f.rule === rule);
const byRule = (fs: ReviewFinding[], rule: string) => fs.find((f) => f.rule === rule);

describe("特殊处理法/焙度文本识别", () => {
  it("hasSpecialProcess：命中全部触发词（含大小写不敏感）", () => {
    for (const w of [
      "厌氧发酵",
      "冷浸处理",
      "浸泡发酵",
      "SFW 蜜处理",
      "Submerged",
      "冷水漫清",
      "葡萄干蜜处理",
      "长时间发酵蜜处理",
    ]) {
      assert.equal(hasSpecialProcess(`某豆 ${w}`), true, w);
    }
    assert.equal(hasSpecialProcess("肯尼亚 水洗 SL28"), false);
    assert.equal(hasSpecialProcess("日晒 蜜处理"), false);
  });

  it("isUltraLightRoast：Agtron 95+ 与'极浅'字样命中；Agtron 90 不命中", () => {
    assert.equal(isUltraLightRoast("Agtron 95"), true);
    assert.equal(isUltraLightRoast("agtron: 98"), true);
    assert.equal(isUltraLightRoast("极浅烘焙"), true);
    assert.equal(isUltraLightRoast("Agtron 90"), false);
    assert.equal(isUltraLightRoast("浅焙"), false);
  });

  it("detectRoastLevel：匹配顺序（中深/中浅优先）与未识别", () => {
    assert.equal(detectRoastLevel("中深焙"), "medium-dark");
    assert.equal(detectRoastLevel("中浅焙"), "medium-light");
    assert.equal(detectRoastLevel("浅焙"), "light");
    assert.equal(detectRoastLevel("深焙"), "dark");
    assert.equal(detectRoastLevel("中焙"), "medium");
    assert.equal(detectRoastLevel("Agtron 96"), "light");
    assert.equal(detectRoastLevel("完全没写焙度的豆子"), null);
  });
});

describe("起步水温规则", () => {
  it("特殊处理法首段 >92℃ → error；=92℃ 通过", () => {
    const ctx = { text: "哥斯达黎加 厌氧葡萄干蜜处理 SL9" };
    const bad = base();
    bad.pours[0] = { ...bad.pours[0], temperature: 95 };
    const fs = reviewRecipe(bad, ctx);
    assert.equal(byRule(fs, "start-temp-special-process")?.level, "error");

    const ok = base();
    ok.pours[0] = { ...ok.pours[0], temperature: 92 };
    assert.equal(hasRule(reviewRecipe(ok, ctx), "start-temp-special-process"), false);
  });

  it("极浅烘首段 <93℃ → warn；≥93℃ 通过", () => {
    const ctx = { text: "埃塞俄比亚 水洗 74158 Agtron 96 极浅" };
    const fs = reviewRecipe(base(), ctx); // 默认 93 → 不报
    assert.equal(hasRule(fs, "start-temp-ultra-light"), false);
    const cool = base();
    cool.pours[0] = { ...cool.pours[0], temperature: 90 };
    assert.equal(byRule(reviewRecipe(cool, ctx), "start-temp-ultra-light")?.level, "warn");
  });

  it("特殊处理法 + 极浅烘同时出现：处理法硬约束优先，不报高温倾向 warn", () => {
    const ctx = { text: "SFW 冷浸 极浅 Agtron 97" };
    const hot = base();
    hot.pours[0] = { ...hot.pours[0], temperature: 94 };
    const fs = reviewRecipe(hot, ctx);
    assert.equal(hasRule(fs, "start-temp-special-process"), true);
    assert.equal(hasRule(fs, "start-temp-ultra-light"), false);
  });

  it("无豆信息文本时水温规则不误报", () => {
    const hot = base();
    hot.pours[0] = { ...hot.pours[0], temperature: 95 };
    assert.equal(hasRule(reviewRecipe(hot), "start-temp-special-process"), false);
    assert.equal(hasRule(reviewRecipe(hot, { text: "   " }), "start-temp-ultra-light"), false);
  });
});

describe("研磨度 vs 焙度区间", () => {
  it("浅焙 55-70 越界 warn；区间内通过", () => {
    const ctx = { text: "浅焙 水洗" };
    assert.equal(
      byRule(reviewRecipe(base({ grinderSize: 75 }), ctx), "grinder-range")?.level,
      "warn",
    );
    assert.equal(
      byRule(reviewRecipe(base({ grinderSize: 50 }), ctx), "grinder-range")?.level,
      "warn",
    );
    assert.equal(hasRule(reviewRecipe(base({ grinderSize: 55 }), ctx), "grinder-range"), false);
    assert.equal(hasRule(reviewRecipe(base({ grinderSize: 70 }), ctx), "grinder-range"), false);
  });

  it("深焙区间 76-80；中深 70-80（任务 #105 C1：收敛到 SAFE 40-80 交集）", () => {
    assert.equal(
      byRule(reviewRecipe(base({ grinderSize: 60 }), { text: "深焙" }), "grinder-range")?.level,
      "warn",
    );
    assert.equal(
      hasRule(reviewRecipe(base({ grinderSize: 80 }), { text: "深焙" }), "grinder-range"),
      false,
    );
    assert.equal(
      hasRule(reviewRecipe(base({ grinderSize: 78 }), { text: "中深焙" }), "grinder-range"),
      false,
    );
    // 旧口径合法的中深 84 / 深 84 现已越出收敛后区间（含容忍带）→ warn
    assert.equal(
      byRule(reviewRecipe(base({ grinderSize: 84 }), { text: "中深焙" }), "grinder-range")?.level,
      "warn",
    );
    assert.equal(
      byRule(reviewRecipe(base({ grinderSize: 84 }), { text: "深焙" }), "grinder-range")?.level,
      "warn",
    );
  });

  it("±3 容忍带（任务 #105 C9）：区间边缘 ±3 内不报，超出才报", () => {
    // 浅焙 55-70：上缘 73（=70+3）不报，74 报；下缘 52（=55-3）不报，51 报
    const light = { text: "浅焙 水洗" };
    assert.equal(hasRule(reviewRecipe(base({ grinderSize: 73 }), light), "grinder-range"), false);
    assert.equal(
      byRule(reviewRecipe(base({ grinderSize: 74 }), light), "grinder-range")?.level,
      "warn",
    );
    assert.equal(hasRule(reviewRecipe(base({ grinderSize: 52 }), light), "grinder-range"), false);
    assert.equal(
      byRule(reviewRecipe(base({ grinderSize: 51 }), light), "grinder-range")?.level,
      "warn",
    );
    // Chiroso 品种专项场景：浅焙取 72-73（较同焙度稍粗 +2~3）不再误报
    const chiroso = { text: "哥伦比亚 Chiroso 浅焙 水洗" };
    assert.equal(hasRule(reviewRecipe(base({ grinderSize: 72 }), chiroso), "grinder-range"), false);
    assert.equal(hasRule(reviewRecipe(base({ grinderSize: 73 }), chiroso), "grinder-range"), false);
    // 容忍带常量可调：默认 ±3
    assert.equal(GRINDER_RANGE_TOLERANCE, 3);
  });

  it("未识别焙度不检查研磨区间", () => {
    assert.equal(
      hasRule(reviewRecipe(base({ grinderSize: 40 }), { text: "某豆 水洗" }), "grinder-range"),
      false,
    );
  });
});

describe("闷蒸 / 粉水比 / 总时长", () => {
  it("首段 pausing <30s → warn；=30s 通过", () => {
    const short = base();
    short.pours[0] = { ...short.pours[0], pausing: 20 };
    assert.equal(byRule(reviewRecipe(short), "bloom-pausing")?.level, "warn");
    const ok = base();
    ok.pours[0] = { ...ok.pours[0], pausing: 30 };
    assert.equal(hasRule(reviewRecipe(ok), "bloom-pausing"), false);
  });

  it("粉水比越界 warn（含 bypass 按最终比例）", () => {
    // 234/15 = 15.6 正常
    assert.equal(hasRule(reviewRecipe(base()), "brew-ratio"), false);
    // 350/15 ≈ 23.3 超上限
    const over = base({
      grandWater: 350,
      pours: [
        {
          volume: 175,
          temperature: 93,
          flowRate: 3.2,
          pattern: "center",
          pausing: 35,
          vibBefore: false,
          vibAfter: false,
        },
        {
          volume: 175,
          temperature: 92,
          flowRate: 3.2,
          pattern: "circular",
          pausing: 5,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    });
    assert.equal(byRule(reviewRecipe(over), "brew-ratio")?.level, "warn");
    // bypass：180+100=280/15≈18.7 仍合法
    const bypass = base({
      grandWater: 180,
      bypassEnabled: true,
      bypassVolume: 100,
      pours: [
        {
          volume: 180,
          temperature: 93,
          flowRate: 3.2,
          pattern: "circular",
          pausing: 35,
          vibBefore: false,
          vibAfter: false,
        },
      ],
    });
    assert.equal(hasRule(reviewRecipe(bypass), "brew-ratio"), false);
  });

  it("估算总时长 >180s → warn", () => {
    const slow = base();
    slow.pours = [
      { ...slow.pours[0], pausing: 120 },
      { ...slow.pours[1], pausing: 90 },
    ];
    assert.equal(byRule(reviewRecipe(slow), "total-duration")?.level, "warn");
    assert.equal(hasRule(reviewRecipe(base()), "total-duration"), false);
  });
});

describe("骨架雷同与 vibAfter", () => {
  it("与近期配方 volume+pausing 逐段完全相同 → warn；任一差异则不报", () => {
    const recent = base();
    assert.equal(byRule(reviewRecipe(base(), {}, [recent]), "skeleton-clone")?.level, "warn");
    const diff = base();
    diff.pours[1] = { ...diff.pours[1], pausing: 10 };
    assert.equal(hasRule(reviewRecipe(diff, {}, [recent]), "skeleton-clone"), false);
    // 未提供近期清单时跳过该维度
    assert.equal(hasRule(reviewRecipe(base(), {}, []), "skeleton-clone"), false);
  });

  it("isSkeletonClone：段数不同/空段返回 false", () => {
    const a = base();
    const b = base();
    b.pours = [{ ...b.pours[0], volume: 234 }];
    assert.equal(isSkeletonClone(a, b), false);
  });

  it("vibAfter 仅首段允许：其他段开启 → warn", () => {
    const bad = base();
    bad.pours[1] = { ...bad.pours[1], vibAfter: true };
    assert.equal(byRule(reviewRecipe(bad), "vib-after-placement")?.level, "warn");
    const first = base();
    first.pours[0] = { ...first.pours[0], vibAfter: true };
    assert.equal(hasRule(reviewRecipe(first), "vib-after-placement"), false);
  });
});

describe("烘焙商骨架复刻豁免（任务 #60）", () => {
  /** 闷蒸偏短（20s）且与近期配方骨架完全雷同的配方 */
  function cloneShort(): Recipe {
    const r = base();
    r.pours[0] = { ...r.pours[0], pausing: 20 };
    return r;
  }

  it("无标志时：闷蒸偏短与骨架雷同照常报 warn（行为不变）", () => {
    const recent = cloneShort();
    const fs = reviewRecipe(cloneShort(), {}, [recent]);
    assert.equal(byRule(fs, "bloom-pausing")?.level, "warn");
    assert.equal(byRule(fs, "skeleton-clone")?.level, "warn");
  });

  it("hasRoasterReference 命中时：两条 finding 直接不产生，不触发 needsAutoFix 门槛", () => {
    const recent = cloneShort();
    const fs = reviewRecipe(cloneShort(), { hasRoasterReference: true }, [recent]);
    assert.equal(hasRule(fs, "bloom-pausing"), false);
    assert.equal(hasRule(fs, "skeleton-clone"), false);
    // 无其他 findings → 零条，绝不满足 needsAutoFix（需 error 或 ≥2 warn）
    assert.deepEqual(fs, []);
  });

  it("豁免只针对这两条：其他规则（水温硬约束/粉水比/vibAfter）照常生效", () => {
    const bad = cloneShort();
    bad.pours[0] = { ...bad.pours[0], temperature: 95 };
    bad.pours[1] = { ...bad.pours[1], vibAfter: true };
    const fs = reviewRecipe(bad, { text: "厌氧发酵", hasRoasterReference: true }, [cloneShort()]);
    assert.equal(byRule(fs, "start-temp-special-process")?.level, "error");
    assert.equal(byRule(fs, "vib-after-placement")?.level, "warn");
    assert.equal(hasRule(fs, "bloom-pausing"), false);
    assert.equal(hasRule(fs, "skeleton-clone"), false);
  });
});

describe("骨架雷同豆身份豁免（任务 #105 C3）", () => {
  it("同豆重生成（sameBeanAsRecent=true）：骨架与已存同豆配方一致不报雷同 warn", () => {
    const recent = base();
    const fs = reviewRecipe(base(), { text: "肯尼亚 水洗 SL28 浅焙", sameBeanAsRecent: true }, [
      recent,
    ]);
    assert.equal(hasRule(fs, "skeleton-clone"), false);
    // 无其他违规 → 零 findings，不会触发 needsAutoFix 门槛
    assert.deepEqual(fs, []);
  });

  it("异豆雷同（sameBeanAsRecent=false/缺省）：照常报骨架雷同 warn", () => {
    const recent = base();
    const fsA = reviewRecipe(base(), { text: "另一支豆 日晒 中焙", sameBeanAsRecent: false }, [
      recent,
    ]);
    assert.equal(byRule(fsA, "skeleton-clone")?.level, "warn");
    const fsB = reviewRecipe(base(), { text: "另一支豆 日晒 中焙" }, [recent]);
    assert.equal(byRule(fsB, "skeleton-clone")?.level, "warn");
  });

  it("豁免只针对骨架雷同：闷蒸偏短等其他 warn 照常生效", () => {
    const short = base();
    short.pours[0] = { ...short.pours[0], pausing: 20 };
    const fs = reviewRecipe(short, { sameBeanAsRecent: true }, [short]);
    assert.equal(hasRule(fs, "skeleton-clone"), false);
    assert.equal(byRule(fs, "bloom-pausing")?.level, "warn");
  });

  it("beanIdentityFingerprint：trim/空白折叠/小写归一化；空文本 → undefined", () => {
    assert.equal(beanIdentityFingerprint("  埃塞  水洗\n74158 "), "埃塞 水洗 74158");
    assert.equal(beanIdentityFingerprint("Colombia CHIROSO"), "colombia chiroso");
    assert.equal(beanIdentityFingerprint("   "), undefined);
    assert.equal(beanIdentityFingerprint(undefined), undefined);
    assert.equal(beanIdentityFingerprint(null), undefined);
  });

  it("isSameBeanAsRecent：beanId 精确匹配 / 指纹匹配 / 不匹配 / 空清单", () => {
    const recent = [
      { beanId: "bean-a", beanSnapshot: "哥斯达黎加 厌氧蜜处理" },
      { beanSnapshot: "  埃塞  水洗 74158 " },
      {},
    ];
    // beanId 命中
    assert.equal(isSameBeanAsRecent({ beanId: "bean-a" }, recent), true);
    // 自由文本指纹命中（大小写/空白差异不影响）
    assert.equal(isSameBeanAsRecent({ beanText: "埃塞 水洗\n74158" }, recent), true);
    assert.equal(isSameBeanAsRecent({ beanText: "ETHIOPIA irrelevant" }, recent), false);
    // 异豆：beanId 不同且指纹不同
    assert.equal(isSameBeanAsRecent({ beanId: "bean-b", beanText: "巴西 日晒" }, recent), false);
    // 空清单 / 无可比对字段
    assert.equal(isSameBeanAsRecent({ beanId: "bean-a" }, []), false);
    assert.equal(isSameBeanAsRecent({}, recent), false);
  });
});

describe("整体行为", () => {
  it("干净配方 + 豆信息 → 零 findings（审查通过）", () => {
    const fs = reviewRecipe(base(), { text: "肯尼亚 水洗 SL28 浅焙" }, [
      base({
        pours: [
          {
            volume: 50,
            temperature: 90,
            flowRate: 3.0,
            pattern: "center",
            pausing: 40,
            vibBefore: false,
            vibAfter: false,
          },
          {
            volume: 100,
            temperature: 90,
            flowRate: 3.0,
            pattern: "circular",
            pausing: 30,
            vibBefore: false,
            vibAfter: false,
          },
          {
            volume: 84,
            temperature: 88,
            flowRate: 3.0,
            pattern: "spiral",
            pausing: 0,
            vibBefore: false,
            vibAfter: false,
          },
        ],
        grandWater: 234,
      }),
    ]);
    assert.deepEqual(fs, []);
  });

  it("reviewDimensionCount：无文本无近期 = 4；全量 = 8", () => {
    assert.equal(reviewDimensionCount(), 4);
    assert.equal(reviewDimensionCount({ text: "浅焙" }), 7);
    assert.equal(reviewDimensionCount({ text: "浅焙" }, [base()]), 8);
    assert.equal(reviewDimensionCount(undefined, []), 4); // 空清单不算骨架维度
  });

  it("多项违规叠加时逐条输出，findings 含 rule/message/suggestion", () => {
    const bad = base({ grinderSize: 40 });
    bad.pours[0] = { ...bad.pours[0], temperature: 95, pausing: 10 };
    const fs = reviewRecipe(bad, { text: "厌氧 深焙" });
    assert.ok(hasRule(fs, "start-temp-special-process"));
    assert.ok(hasRule(fs, "grinder-range"));
    assert.ok(hasRule(fs, "bloom-pausing"));
    for (const f of fs) {
      assert.ok(f.rule && f.message && f.suggestion);
      assert.ok(f.level === "error" || f.level === "warn");
    }
  });
});
