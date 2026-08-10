/**
 * 豆推荐规则引擎（任务 #50 豆仓库存系统）：纯函数多因子打分，零 IO、零 LLM 依赖。
 *
 * 四因子加权（权重见 ADVISOR_WEIGHTS，总和 = 1）：
 *  a) 养豆窗口 roastRipeness：roastDate + restDays 未到适饮扣分、窗口内满分、
 *     超 peakWindowDays（缺省 45 天）后 30 天内线性衰减至 0；无烘焙日期中性分。
 *  b) 库存水位 stockLevel：按参考粉量折算可冲次数，≥3 次稳定、1-2 次紧迫加分、
 *     0 次或库存为 0 直接排除；stockGrams 未录入不排除但低分。
 *  c) 历史反馈 feedbackRating：按 beanId 聚合配方 feedbacks 的 rating 均值；无数据中性。
 *  d) 风味轮转 flavorRotation：最近 3 条冲煮记录中出现同处理法/同产地时轻微惩罚。
 *
 * LLM 话术润色在路由层可选叠加（见 routes/beans.ts），本引擎任何失败形态
 * 都以 fallback:true 标识「纯规则结果」。
 */

/** 推荐引擎接受的豆档案最小结构（与 routes/beans 的 Bean 结构兼容） */
export interface AdvisorBeanInput {
  id: string;
  name: string;
  origin?: string;
  process?: string;
  /** 库存克数；undefined = 未录入库存 */
  stockGrams?: number;
  /** 烘焙日期 YYYY-MM-DD */
  roastDate?: string;
  /** 养豆期天数（烘焙后多久进入适饮窗口） */
  restDays?: number;
  /** 适饮高峰期天数（烘焙后计）；缺省语义 45 */
  peakWindowDays?: number;
}

/** 推荐引擎接受的配方记录最小结构（与 routes/recipes 的 StoredRecipe 结构兼容） */
export interface AdvisorRecipeInput {
  createdAt: string;
  beanId?: string;
  beanSnapshot?: string;
  recipe?: { doseGrams?: number };
  feedbacks?: Array<{ rating?: number }>;
}

export interface BeanRecommendation {
  beanId: string;
  beanName: string;
  /** 综合得分（0-1，保留两位小数） */
  score: number;
  /** 2-4 条人类可读中文推荐理由 */
  reasons: string[];
  /** LLM 润色后的一句话推荐语（仅 LLM 可用时存在） */
  summary?: string;
}

export interface AdvisorResult {
  recommendations: BeanRecommendation[];
  /** true = 纯规则引擎结果（未经 LLM 润色或 LLM 失败） */
  fallback: boolean;
}

/** 四因子权重表（总和 = 1） */
export const ADVISOR_WEIGHTS = {
  ripeness: 0.35,
  stock: 0.25,
  feedback: 0.25,
  rotation: 0.15,
} as const;

/** 适饮高峰期缺省天数（bean 未标注 peakWindowDays 时的兜底语义） */
export const DEFAULT_PEAK_WINDOW_DAYS = 45;
/** 过峰后风味线性衰减至 0 的天数跨度 */
export const PEAK_DECAY_SPAN_DAYS = 30;
/** 参考粉量缺省值（g）：豆未关联任何配方时使用 */
export const DEFAULT_DOSE_GRAMS = 15;
/** 参与风味轮转判断的最近冲煮记录条数 */
export const ROTATION_LOOKBACK = 3;
/** 推荐返回的最大条数 */
export const TOP_N = 3;

const DAY_MS = 86_400_000;

interface FactorResult {
  score: number;
  reasons: string[];
}

/** createdAt 倒序（新 → 旧），空串排最后 */
function byRecentDesc<T extends { createdAt?: string }>(a: T, b: T): number {
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
}

/** 参考粉量：该 beanId 最近一条关联配方的 doseGrams，缺省 15g */
export function referenceDoseFor(beanId: string, recipes: AdvisorRecipeInput[]): number {
  const latest = recipes.filter((r) => r.beanId === beanId).sort(byRecentDesc)[0];
  const dose = latest?.recipe?.doseGrams;
  return typeof dose === "number" && Number.isFinite(dose) && dose > 0 ? dose : DEFAULT_DOSE_GRAMS;
}

/** 按参考粉量折算剩余可冲次数；未录入库存返回 null */
export function brewsLeftFor(bean: AdvisorBeanInput, recipes: AdvisorRecipeInput[]): number | null {
  if (typeof bean.stockGrams !== "number" || !Number.isFinite(bean.stockGrams)) return null;
  return Math.floor(bean.stockGrams / referenceDoseFor(bean.id, recipes));
}

/** YYYY-MM-DD → 本地零点 Date；格式/日历非法返回 null（任务 #65） */
function parseLocalRoastDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  // 进位值（如 2026-13-01/2026-02-30）会被构造器进位，回读比对不等即非法
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** 两个时刻的本地零点（年-月-日） */
function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * 因子 a：养豆窗口。
 * 天数按「本地日期差」计算（任务 #65）：roastDate 解析为本地零点，与 now 的本地零点
 * 做 Math.round 差值，与前端 bean-math.ts 口径一致；修复 UTC 解析导致 UTC+8 每天
 * 00:00-08:00 前后端相差 1 天的问题。DST 误差由 Math.round 吸收。
 */
export function scoreRipeness(bean: AdvisorBeanInput, now: Date): FactorResult {
  if (!bean.roastDate || !/^\d{4}-\d{2}-\d{2}$/.test(bean.roastDate)) {
    return { score: 0.5, reasons: ["烘焙日期未录入，养豆状态未知"] };
  }
  const roast = parseLocalRoastDate(bean.roastDate);
  if (!roast) {
    return { score: 0.5, reasons: ["烘焙日期无法解析，养豆状态未知"] };
  }
  const days = Math.round((localMidnight(now) - roast.getTime()) / DAY_MS);
  const rest = bean.restDays ?? 0;
  const peak = bean.peakWindowDays ?? DEFAULT_PEAK_WINDOW_DAYS;
  if (days < rest) {
    return { score: 0.25, reasons: [`仍在养豆期，约 ${rest - days} 天后进入适饮窗口`] };
  }
  if (days <= peak) {
    return { score: 1, reasons: [`处于适饮高峰期（烘焙后第 ${days} 天）`] };
  }
  const score = Math.max(0, 1 - (days - peak) / PEAK_DECAY_SPAN_DAYS);
  return { score, reasons: [`已过适饮高峰 ${days - peak} 天，风味可能衰减`] };
}

/** 因子 b：库存水位（调用方已保证不会传入被排除的豆） */
export function scoreStock(bean: AdvisorBeanInput, recipes: AdvisorRecipeInput[]): FactorResult {
  if (typeof bean.stockGrams !== "number" || !Number.isFinite(bean.stockGrams)) {
    return { score: 0.3, reasons: ["库存未录入，无法估算可冲次数"] };
  }
  const brews = brewsLeftFor(bean, recipes) ?? 0;
  if (brews >= 3) {
    return { score: 0.9, reasons: [`库存充足，约可冲 ${brews} 次`] };
  }
  // 1-2 次：紧迫加分（催促在风味衰减前喝完）
  return { score: 1, reasons: [`库存紧张，约可冲 ${brews} 次，建议趁风味正好尽快饮用`] };
}

/** 因子 c：历史反馈（按 beanId 聚合 rating 均值） */
export function scoreFeedback(beanId: string, recipes: AdvisorRecipeInput[]): FactorResult {
  const ratings = recipes
    .filter((r) => r.beanId === beanId)
    .flatMap((r) => r.feedbacks ?? [])
    .map((f) => f.rating)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (ratings.length === 0) {
    return { score: 0.5, reasons: ["暂无历史冲煮反馈"] };
  }
  const avg = ratings.reduce((sum, n) => sum + n, 0) / ratings.length;
  return {
    score: Math.max(0, Math.min(1, avg / 5)),
    reasons: [`历史 ${ratings.length} 条反馈平均评分 ${avg.toFixed(1)}/5`],
  };
}

/** 冲煮记录是否对应某豆：beanId 直连，或 beanSnapshot 文本含豆名（忽略大小写/首尾空白） */
function recipeMatchesBean(r: AdvisorRecipeInput, bean: AdvisorBeanInput): boolean {
  if (r.beanId && r.beanId === bean.id) return true;
  const snapshot = r.beanSnapshot?.trim().toLowerCase() ?? "";
  const name = bean.name.trim().toLowerCase();
  return snapshot !== "" && name !== "" && snapshot.includes(name);
}

function sameFold(a?: string, b?: string): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** 因子 d：风味轮转（最近 3 条冲煮记录的同处理法/产地轻微惩罚） */
export function scoreRotation(
  bean: AdvisorBeanInput,
  recipes: AdvisorRecipeInput[],
  beans: AdvisorBeanInput[],
): FactorResult {
  const recent = [...recipes].sort(byRecentDesc).slice(0, ROTATION_LOOKBACK);
  if (recent.length === 0) {
    return { score: 1, reasons: ["最近无冲煮记录，风味轮转无顾虑"] };
  }
  let repeats = 0;
  for (const r of recent) {
    const brewed = beans.find((b) => recipeMatchesBean(r, b));
    if (!brewed || brewed.id === bean.id) continue; // 自身记录不计轮转惩罚
    if (sameFold(brewed.process, bean.process) || sameFold(brewed.origin, bean.origin)) {
      repeats += 1;
    }
  }
  if (repeats === 0) {
    return { score: 1, reasons: ["与最近冲煮风味不同，适合轮转换换口味"] };
  }
  const score = Math.max(0.2, 1 - 0.3 * repeats);
  return { score, reasons: [`与最近 ${repeats} 次冲煮处理法/产地相近，建议适度轮转`] };
}

/**
 * 多因子打分推荐：排除库存为 0 / 不足一次的豆，按总分取 Top3。
 * 全部豆不合格（或输入为空）时返回空列表。fallback 恒为 true（纯规则结果），
 * 是否经 LLM 润色由路由层改写。
 */
export function recommendBeans(
  beans: AdvisorBeanInput[],
  recipes: AdvisorRecipeInput[],
  now: Date = new Date(),
): AdvisorResult {
  const candidates: BeanRecommendation[] = [];
  for (const bean of beans) {
    // 排除：库存为 0，或按参考粉量折算已不足一次冲煮
    if (
      typeof bean.stockGrams === "number" &&
      Number.isFinite(bean.stockGrams) &&
      bean.stockGrams <= 0
    ) {
      continue;
    }
    const brews = brewsLeftFor(bean, recipes);
    if (brews !== null && brews <= 0) continue;

    const ripeness = scoreRipeness(bean, now);
    const stock = scoreStock(bean, recipes);
    const feedback = scoreFeedback(bean.id, recipes);
    const rotation = scoreRotation(bean, recipes, beans);
    const score =
      ripeness.score * ADVISOR_WEIGHTS.ripeness +
      stock.score * ADVISOR_WEIGHTS.stock +
      feedback.score * ADVISOR_WEIGHTS.feedback +
      rotation.score * ADVISOR_WEIGHTS.rotation;
    candidates.push({
      beanId: bean.id,
      beanName: bean.name,
      score: Math.round(score * 100) / 100,
      // 每因子各贡献一条 reason，共 4 条（满足 2-4 条约束）
      reasons: [
        ...ripeness.reasons,
        ...stock.reasons,
        ...feedback.reasons,
        ...rotation.reasons,
      ].slice(0, 4),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return { recommendations: candidates.slice(0, TOP_N), fallback: true };
}
