/**
 * 豆仓库存纯函数（任务 #51）：日期运算全部集中于此，组件只负责渲染。
 * - freshness：烘焙日期 + 养豆天数 → 四态（resting/prime/fading/unknown）
 * - brewsLeft：库存克数 / 参考粉量 → 剩余可冲次数
 * 日期一律按「本地日期差」计算（YYYY-MM-DD 解析为本地零点，避免 UTC 偏移）。
 */

/** 适饮高峰期缺省天数（与后端 bean-advisor 的 DEFAULT_PEAK_WINDOW_DAYS 对齐） */
export const DEFAULT_PEAK_WINDOW_DAYS = 45;
/** 参考粉量缺省值（g）：豆未关联任何配方时使用 */
export const DEFAULT_DOSE_GRAMS = 15;

export type FreshnessPhase = "resting" | "prime" | "fading" | "unknown";

export interface FreshnessInput {
  /** 烘焙日期 YYYY-MM-DD；缺失/非法 → unknown */
  roastDate?: string;
  /** 养豆期天数（烘焙后多久进入适饮窗口）；缺省 0 */
  restDays?: number;
  /** 适饮高峰期天数（烘焙后计）；缺省 45 */
  peakWindowDays?: number;
}

export interface Freshness {
  phase: FreshnessPhase;
  /** 距进入适饮窗口的天数（非养豆期为 0） */
  daysToReady: number;
  /** 适饮窗口剩余天数（fading/unknown 为 0） */
  daysLeft: number;
}

/**
 * YYYY-MM-DD → 本地零点 Date；非法返回 null。
 * 构造后回读年/月/日校验（任务 #65）：进位值（如 2026-13-01 / 2026-02-30）
 * 会被 Date 构造器进位为下月，回读不等即判非法。
 */
export function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** 两日期之间的整日差（b - a，按本地零点计算） */
function daysBetween(a: Date, b: Date): number {
  const ma = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const mb = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((mb - ma) / 86_400_000);
}

/**
 * 养豆/适饮状态（语义与后端推荐引擎一致）：
 * - days < restDays → resting（养豆中）
 * - restDays ≤ days ≤ peakWindowDays → prime（适饮期）
 * - days > peakWindowDays → fading（已过峰）
 * - roastDate 缺失/非法 → unknown
 */
export function freshness(bean: FreshnessInput, now: Date = new Date()): Freshness {
  if (!bean.roastDate) return { phase: "unknown", daysToReady: 0, daysLeft: 0 };
  const roast = parseLocalDate(bean.roastDate);
  if (!roast) return { phase: "unknown", daysToReady: 0, daysLeft: 0 };

  const days = daysBetween(roast, now);
  const rest =
    typeof bean.restDays === "number" && Number.isFinite(bean.restDays) ? bean.restDays : 0;
  const peak =
    typeof bean.peakWindowDays === "number" && Number.isFinite(bean.peakWindowDays)
      ? bean.peakWindowDays
      : DEFAULT_PEAK_WINDOW_DAYS;

  if (days < rest) {
    return { phase: "resting", daysToReady: rest - days, daysLeft: Math.max(0, peak - days) };
  }
  if (days <= peak) {
    return { phase: "prime", daysToReady: 0, daysLeft: peak - days };
  }
  return { phase: "fading", daysToReady: 0, daysLeft: 0 };
}

/** 剩余可冲次数：floor(库存 / 参考粉量)；任一输入缺失/非法返回 null */
export function brewsLeft(
  stockGrams: number | undefined | null,
  doseGrams: number | undefined | null,
): number | null {
  if (typeof stockGrams !== "number" || !Number.isFinite(stockGrams)) return null;
  if (typeof doseGrams !== "number" || !Number.isFinite(doseGrams) || doseGrams <= 0) return null;
  return Math.max(0, Math.floor(stockGrams / doseGrams));
}
