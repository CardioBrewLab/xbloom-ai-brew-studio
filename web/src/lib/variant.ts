/**
 * 双方案对比（任务 #62）：variant SSE 事件归并的纯函数状态机。
 * - 原版生成路径零感知：无 roasterReference 时不会出现任何 variant 事件；
 * - 带 variant:"improved" 的 reasoning/content 不并入主思考流，单独缓冲供对比卡展示；
 * - variant:start → running；variant:result 按 ok 终结为 ready / failed。
 * App 侧仅负责 setState(reduceVariantEvent(...))，逻辑全部在此可测。
 */
import type { BrewRationaleItem, GenerateEvent, ImprovementNote, ReviewFinding } from "./api.js";
import { contentChunkOf } from "./candidates.js";
import type { Recipe } from "./recipe-schema.js";

export type VariantPhase = "idle" | "running" | "ready" | "failed";

/** 改进版就绪后的完整载荷 */
export interface ImprovedPayload {
  recipe: Recipe;
  clamped: string[];
  improvementNotes?: ImprovementNote[];
  reviewFindings?: ReviewFinding[];
  /** 改进版方案解读（任务 #73）：variant result 携带时透传，采用改进版后展示其解读 */
  brewRationale?: BrewRationaleItem[];
  refUrls?: string[];
  warning?: string;
}

/** 双方案对比展示态（每轮生成开始时重置为 VARIANT_IDLE） */
export interface VariantState {
  phase: VariantPhase;
  /** 失败时的降级文案（如「AI 改进版生成失败：…」） */
  message: string;
  /** ok:true 时的改进版载荷 */
  improved: ImprovedPayload | null;
  /** 改进版 reasoning/content 静默累计缓冲（供对比卡折叠查看进度） */
  buffer: string;
}

export const VARIANT_IDLE: VariantState = {
  phase: "idle",
  message: "",
  improved: null,
  buffer: "",
};

/**
 * 单事件归并。规则：
 * - reasoning/content 带 variant:"improved" → 累计进 buffer（主思考流由调用方自行跳过）；
 *   不带 variant 的 reasoning/content 与本状态无关（返回原状态引用，便于上层判定归属）；
 * - variant:start → running（清空上轮残留的 message/improved）；
 * - variant:result ok:true → ready + 载荷；ok:false → failed + message；
 * - 其余事件一律透传不变。
 */
export function reduceVariantEvent(state: VariantState, event: GenerateEvent): VariantState {
  if ((event.type === "reasoning" || event.type === "content") && event.variant === "improved") {
    // content 事件 delta 已改可选（任务 #116）：content 回退 content 字段/空串，不拼 "undefined"
    const chunk = event.type === "content" ? contentChunkOf(event) : event.delta;
    return { ...state, buffer: state.buffer + chunk };
  }
  if (event.type !== "variant") return state;
  if (event.stage === "start") {
    return { phase: "running", message: "", improved: null, buffer: state.buffer };
  }
  // stage === "result"
  if (event.ok) {
    return {
      phase: "ready",
      message: "",
      buffer: state.buffer,
      improved: {
        recipe: event.recipe,
        clamped: event.clamped,
        ...(event.improvementNotes?.length ? { improvementNotes: event.improvementNotes } : {}),
        ...(event.reviewFindings?.length ? { reviewFindings: event.reviewFindings } : {}),
        // 方案解读透传（任务 #73）：改进版携带时保留，供采用后展示与 saveBoth 落库
        ...(event.brewRationale?.length ? { brewRationale: event.brewRationale } : {}),
        ...(event.refUrls?.length ? { refUrls: event.refUrls } : {}),
        ...(event.warning ? { warning: event.warning } : {}),
      },
    };
  }
  return { phase: "failed", message: event.message, improved: null, buffer: state.buffer };
}

/**
 * 改进版落库名称：原名自动附「· AI 改进版」后缀（幂等：已带后缀不重复追加）。
 */
export function improvedRecipeName(baseName: string): string {
  const name = baseName.trim();
  return name.endsWith("· AI 改进版") ? name : `${name} · AI 改进版`;
}
