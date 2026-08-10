/**
 * 规则审查器（任务 #36）：对生成后的配方做一轮纯函数规则审查，
 * 复刻人工测评的检查维度，规则依据 server/src/knowledge/brewing-reference.md。
 *
 * 检查维度：
 * 1. 起步水温 vs 特殊处理法（厌氧/冷浸/浸泡发酵/SFW/submerged/冷水漫清/
 *    葡萄干蜜/长时间发酵）→ 首段温度 ≤92℃（error，知识库硬约束）
 * 2. 起步水温 vs 极浅烘（Agtron 95+ 或"极浅"字样）→ 首段 ≥93℃（warn；
 *    与特殊处理法同时出现时处理法规则优先，不再报高温倾向警告）
 * 3. 研磨度 vs 焙度建议区间（浅 55-70 / 中浅 60-74 / 中 64-78 / 中深 70-80 / 深 76-80，
 *    这是风味起点而非 40-120 云端标尺的硬上限；
 *    判定带 ±3 容忍带，容纳品种专项等受控偏离（任务 #105 C9），warn）
 * 4. 闷蒸 pausing ≥30s（首段，warn）
 * 5. 粉水比 ∈ [12,20]（复用 safety 的 BYPASS_RATIO_RANGE，warn）
 * 6. 估算总时长 >180s（复用 safety 的 estimateTotalSeconds，warn）
 * 7. 骨架雷同：与近期配方 pours 段量+pausing 序列逐段完全相同（warn）
 * 8. vibAfter 合理性：仅首段允许（warn）
 *
 * beanContext 缺失（无豆信息文本）时跳过依赖文本的规则（1/2/3），不误报；
 * 骨架雷同仅在有近期配方清单时检查；hasRoasterReference 命中时豁免规则 4/7（任务 #60）；
 * sameBeanAsRecent 命中时豁免规则 7（任务 #105 C3：同豆配方本应按确定性纪律收敛一致，
 * 重生成与已存同豆配方骨架相同不视为雷同违规）。
 */
import { estimateTotalSeconds, DURATION_WARN_SECONDS } from "./safety.js";
import { BYPASS_RATIO_RANGE, type Recipe } from "./recipe-schema.js";

export interface ReviewFinding {
  level: "error" | "warn";
  /** 规则标识（stable id，前端/持久化索引用） */
  rule: string;
  message: string;
  suggestion: string;
}

/** 审查上下文：豆信息合并文本（豆库档案文本 + 自由文本）；
 * hasRoasterReference（任务 #60）：本次生成含烘焙商参考方案骨架时为 true，
 * 命中时豁免骨架雷同与闷蒸偏短两条 warn（忠实复刻烘焙商骨架不视为违规，
 * 见 brew-system.md《规则优先级与冲突裁决》裁决条款 4/5）。
 * sameBeanAsRecent（任务 #105 C3）：本次豆身份（beanId 或豆信息指纹）与近期
 * 已存配方中某条相同时为 true，命中时豁免骨架雷同 warn（确定性纪律要求
 * 同豆配方收敛一致，重生成命中旧骨架不是模板化违规）。 */
export interface BeanReviewContext {
  text?: string;
  hasRoasterReference?: boolean;
  sameBeanAsRecent?: boolean;
}

/** 焙度 → 研磨度建议起点（brewing-reference.md §3）。
 * 建议区间用于风味审查，与内部 40-120 云端标尺的硬边界分开。 */
export type RoastKey = "light" | "medium-light" | "medium" | "medium-dark" | "dark";

export const GRINDER_RANGE_BY_ROAST: Record<RoastKey, { min: number; max: number; label: string }> =
  {
    light: { min: 55, max: 70, label: "浅焙" },
    "medium-light": { min: 60, max: 74, label: "中浅焙" },
    medium: { min: 64, max: 78, label: "中焙" },
    "medium-dark": { min: 70, max: 80, label: "中深焙" },
    dark: { min: 76, max: 80, label: "深焙" },
  };

/** grinder-range 判定容忍带（任务 #105 C9）：品种专项（如 Chiroso「较同焙度稍粗 +2~3」）
 * 等 L5 受控偏离会略微越出焙度区间，±3 以内不报 warn，避免 auto-fix 把合法偏离修回去 */
export const GRINDER_RANGE_TOLERANCE = 3;

/** 特殊处理法触发词（§4 降温硬约束）：命中即要求起步水温 ≤92℃ */
export const SPECIAL_PROCESS_TRIGGERS = [
  "厌氧",
  "冷浸",
  "浸泡发酵",
  "冷水漫清",
  "葡萄干蜜",
  "长时间发酵",
  "sfw",
  "submerged",
] as const;

/** 豆信息文本是否命中特殊处理法触发词（大小写不敏感） */
export function hasSpecialProcess(text: string): boolean {
  const t = text.toLowerCase();
  return SPECIAL_PROCESS_TRIGGERS.some((w) => t.includes(w));
}

/** 是否极浅烘：Agtron 95+（95-99）或"极浅"字样 */
export function isUltraLightRoast(text: string): boolean {
  return /agtron\s*[:：]?\s*9[5-9]\b/i.test(text) || text.includes("极浅");
}

/**
 * 从豆信息文本识别焙度；无法识别返回 null。
 * 匹配顺序注意：中深焙/中浅焙必须先于浅焙/中焙/深焙判定；
 * "极浅"按浅焙区间处理（研磨仍参照浅焙档）。
 */
export function detectRoastLevel(text: string): RoastKey | null {
  if (text.includes("中深")) return "medium-dark";
  if (text.includes("中浅")) return "medium-light";
  if (isUltraLightRoast(text)) return "light";
  if (text.includes("深焙") || text.includes("深烘")) return "dark";
  if (text.includes("浅焙") || text.includes("浅烘")) return "light";
  if (text.includes("中焙") || text.includes("中烘")) return "medium";
  return null;
}

/** 本次审查实际执行的检查维度数（前端展示"已检查 N 个维度"） */
export function reviewDimensionCount(
  beanContext?: BeanReviewContext,
  recentRecipes?: Recipe[],
): number {
  // 固定 4 项：闷蒸 / 粉水比 / 总时长 / vibAfter
  let n = 4;
  if (beanContext?.text?.trim()) n += 3; // 特殊处理法水温 / 极浅烘水温 / 研磨区间
  if (recentRecipes && recentRecipes.length > 0) n += 1; // 骨架雷同
  return n;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** 骨架雷同判定：pours 段数、各段 volume、各段 pausing 逐段完全一致 */
export function isSkeletonClone(a: Pick<Recipe, "pours">, b: Pick<Recipe, "pours">): boolean {
  if (a.pours.length !== b.pours.length || a.pours.length === 0) return false;
  return a.pours.every(
    (p, i) => round1(p.volume) === round1(b.pours[i].volume) && p.pausing === b.pours[i].pausing,
  );
}

/**
 * 纯函数审查入口：返回 findings 数组（空数组 = 审查通过）。
 * @param recentRecipes 近期配方清单（用于骨架雷同检查），缺省跳过该维度
 */
export function reviewRecipe(
  recipe: Recipe,
  beanContext: BeanReviewContext = {},
  recentRecipes?: Recipe[],
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const firstPour = recipe.pours[0];
  const beanText = beanContext.text?.trim() ?? "";

  // ---- 依赖豆信息文本的规则（无文本则跳过，不误报） ------------------------
  if (beanText) {
    const special = hasSpecialProcess(beanText);

    // 1) 特殊处理法起步水温硬约束（error）
    if (special && firstPour.temperature > 92) {
      findings.push({
        level: "error",
        rule: "start-temp-special-process",
        message: `豆信息命中特殊处理法/发酵标注，但首段水温 ${firstPour.temperature}℃ 超过 92℃ 硬约束`,
        suggestion:
          "将首段（及各段）水温降至 89-92℃ 区间，避免刺激性发酵味；该约束优先于烘焙商水温与极浅烘高温倾向",
      });
    }

    // 2) 极浅烘起步水温倾向（warn）：与特殊处理法冲突时处理法优先，不报
    if (!special && isUltraLightRoast(beanText) && firstPour.temperature < 93) {
      findings.push({
        level: "warn",
        rule: "start-temp-ultra-light",
        message: `极浅烘（Agtron 95+ / 极浅标注）首段水温 ${firstPour.temperature}℃ 偏低，难以托出花香与明亮酸质`,
        suggestion: "将首段水温提升至 93-95℃（设备上限 95℃）",
      });
    }

    // 3) 研磨度 vs 焙度区间（warn）；带 ±GRINDER_RANGE_TOLERANCE 容忍带（任务 #105 C9）
    const roast = detectRoastLevel(beanText);
    if (roast) {
      const range = GRINDER_RANGE_BY_ROAST[roast];
      if (
        recipe.grinderSize < range.min - GRINDER_RANGE_TOLERANCE ||
        recipe.grinderSize > range.max + GRINDER_RANGE_TOLERANCE
      ) {
        findings.push({
          level: "warn",
          rule: "grinder-range",
          message: `研磨度 ${recipe.grinderSize} 超出${range.label}建议区间 ${range.min}-${range.max}（含 ±${GRINDER_RANGE_TOLERANCE} 容忍带）`,
          suggestion: `将 grinderSize 调整到 ${range.min}-${range.max}（数值越小越细），或说明该豆需要偏离常规区间的理由（如品种专项）`,
        });
      }
    }
  }

  // ---- 与豆信息无关的通用规则 ----------------------------------------------

  // 4) 闷蒸 pausing ≥30s（首段）；烘焙商骨架复刻豁免（任务 #60，裁决条款 4）
  if (firstPour.pausing < 30 && !beanContext.hasRoasterReference) {
    findings.push({
      level: "warn",
      rule: "bloom-pausing",
      message: `首段闷蒸停顿 ${firstPour.pausing}s 不足 30s，排气与浸润不充分`,
      suggestion: "将首段 pausing 提升到 30-45s（闷蒸硬下限 30s）",
    });
  }

  // 5) 粉水比 ∈ [12,20]（启用 bypass 时按最终比例 grandWater+bypassVolume）
  const effectiveWater = recipe.grandWater + (recipe.bypassEnabled ? recipe.bypassVolume : 0);
  const ratio = round1(effectiveWater / recipe.doseGrams);
  if (ratio < BYPASS_RATIO_RANGE.min || ratio > BYPASS_RATIO_RANGE.max) {
    findings.push({
      level: "warn",
      rule: "brew-ratio",
      message: `粉水比 ${ratio} 超出建议区间 [${BYPASS_RATIO_RANGE.min}, ${BYPASS_RATIO_RANGE.max}]`,
      suggestion: `调整 grandWater${recipe.bypassEnabled ? "（含 bypassVolume）" : ""} 或 doseGrams，使粉水比落在 ${BYPASS_RATIO_RANGE.min}-${BYPASS_RATIO_RANGE.max}`,
    });
  }

  // 6) 估算总时长 >180s（复用 safety.estimateTotalSeconds）
  const seconds = estimateTotalSeconds(recipe);
  if (seconds > DURATION_WARN_SECONDS) {
    findings.push({
      level: "warn",
      rule: "total-duration",
      message: `估算总时长 ${seconds}s 超过 ${DURATION_WARN_SECONDS}s（3:00）建议线，粉床易堵塞/过萃`,
      suggestion: "调粗研磨、减少段数或缩短段间 pausing",
    });
  }

  // 7) 骨架雷同（与近期配方逐段 volume+pausing 完全相同）；
  //    烘焙商骨架复刻豁免（任务 #60，裁决条款 5：忠实复刻不视为雷同违规）；
  //    同豆身份豁免（任务 #105 C3：与近期某条配方同豆时，骨架一致是确定性纪律的
  //    预期结果，不报雷同 warn，避免叠加其他 warn 触发 auto-fix 扰动同豆配方）
  if (
    recentRecipes &&
    recentRecipes.length > 0 &&
    !beanContext.hasRoasterReference &&
    !beanContext.sameBeanAsRecent
  ) {
    if (recentRecipes.some((r) => isSkeletonClone(recipe, r))) {
      findings.push({
        level: "warn",
        rule: "skeleton-clone",
        message: "与近期配方骨架雷同（分段水量与停顿序列完全相同）",
        suggestion: "建议随处理法/焙度差异化：调整分段结构、闷蒸水量或段间节奏，避免模板化输出",
      });
    }
  }

  // 8) vibAfter 合理性：仅首段允许
  recipe.pours.forEach((p, i) => {
    if (i > 0 && p.vibAfter) {
      findings.push({
        level: "warn",
        rule: "vib-after-placement",
        message: `第 ${i + 1} 段开启了 vibAfter，振动注水后搅拌仅适用于闷蒸段（首段）`,
        suggestion: "关闭非首段的 vibAfter，避免过度扰动粉床带来杂味",
      });
    }
  });

  return findings;
}

// ---------------------------------------------------------------------------
// 豆身份比对（任务 #105 C3）：骨架雷同豁免的依据
// ---------------------------------------------------------------------------

/** 豆信息文本指纹：trim + 空白折叠 + 小写化；空文本返回 undefined */
export function beanIdentityFingerprint(text: string | null | undefined): string | undefined {
  const t = (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return t ? t : undefined;
}

/**
 * 本次豆身份是否与近期已存配方中某条相同（任务 #105 C3）：
 * ① beanId 精确匹配（豆库选豆场景）；② 豆信息文本指纹与 beanSnapshot 相等
 * （自由文本场景，比对前经 beanIdentityFingerprint 归一化）。
 * 近期清单为空或双方均无可比对字段时返回 false。
 */
export function isSameBeanAsRecent(
  current: { beanId?: string; beanText?: string },
  recent: Array<{ beanId?: string; beanSnapshot?: string }>,
): boolean {
  const curFp = beanIdentityFingerprint(current.beanText);
  return recent.some((r) => {
    if (current.beanId && r.beanId && current.beanId === r.beanId) return true;
    const rFp = beanIdentityFingerprint(r.beanSnapshot);
    return !!curFp && !!rFp && curFp === rFp;
  });
}
