/**
 * 多候选生成展示态（任务 #106；#120 优选明细卡始终渲染）：
 * candidates SSE 事件聚合的纯函数状态机与文案。
 * N=1 时后端不下发任何 candidates 事件，本状态恒为 CANDIDATES_IDLE，UI 逐字节不变。
 *
 * 任务 #120：progress/picked 事件携带逐候选结果（status/score/failReason/vetoReasons），
 * 状态机聚合进 results；优选明细卡（CandidatePickCard）在 N>1 时始终渲染。
 * 由于 App.tsx 仅透传字符串 prop（doneNote），本模块把结构化状态编码进
 * candidatesDoneNote 返回值（信封格式），StreamPanel 侧 parseCandidatesNote 解出，
 * N=1（idle）恒返回空串，通道不激活。
 */
import type { CandidateScoreDetail, CandidateScoreSummary, GenerateEvent } from "./api.js";

/** 逐维度加权明细条目（任务 #121：picked.results 成功候选携带） */
export interface CandidateDimensionEntry {
  key: string;
  label: string;
  weight: number;
  /** 该维度实得（0 ≤ score ≤ weight） */
  score: number;
  note: string;
}

export interface CandidateRecipeSummary {
  doseGrams: number;
  grandWater: number;
  ratio: number;
  grinderSize: number;
  rpm: number;
  bypassEnabled?: boolean;
  bypassVolume?: number;
  bypassTemp?: number;
  isSetGrinderSize?: 1 | 2;
  pours: Array<{
    volume: number;
    temperature: number;
    flowRate: number;
    pattern: "center" | "circular" | "spiral";
    pausing: number;
    vibBefore?: boolean;
    vibAfter?: boolean;
  }>;
}

/** 逐候选结果（任务 #120：progress.result / picked.results 条目） */
export interface CandidateResultEntry {
  /** 候选下标（0 起） */
  index: number;
  /** ok = 结构校验通过进入评分；failed = 结构失败/请求失败/限流 */
  status: "ok" | "failed";
  /** 成功候选的最终得分（维度加权 − 全局扣分，picked 后存在） */
  score?: number;
  /** 成功候选是否被一票否决（picked 后存在） */
  vetoed?: boolean;
  /** 一票否决原因列表（picked 后存在；空数组 = 未否决） */
  vetoReasons?: string[];
  warns?: number;
  clamps?: number;
  /** 扣分标签列表（picked 后存在） */
  deductions?: string[];
  /** 逐维度加权明细（任务 #121，picked 后存在；权重和 = 100） */
  dimensions?: CandidateDimensionEntry[];
  /** 关键参数快照，用于辨别同分方案是否真实不同。 */
  recipeSummary?: CandidateRecipeSummary;
  /** 失败原因（failed 时存在：结构失败/网关限流/请求失败） */
  failReason?: string;
}

export interface CandidatesState {
  phase: "idle" | "running" | "picked";
  /** 最近一次 start 事件的候选数 */
  n: number;
  /** 已完成候选数（progress.done） */
  done: number;
  /** 本轮候选总数（progress.total，降 N 后可能变化） */
  total: number;
  /** 获胜候选下标（picked 后存在） */
  winner?: number;
  /** 各候选评分摘要（picked 后存在；仅成功候选，向后兼容） */
  scores: CandidateScoreSummary[];
  /** 逐候选完整结果（任务 #120：progress 增量聚合，picked 全量覆盖） */
  results: CandidateResultEntry[];
  /** 获胜候选评分明细（recipe 事件 candidateScore 携带） */
  detail?: CandidateScoreDetail;
  /** 任务 #131：重调研轮次（round>0 = 第 N 轮重调研） */
  round?: number;
}

export const CANDIDATES_IDLE: CandidatesState = {
  phase: "idle",
  n: 0,
  done: 0,
  total: 0,
  scores: [],
  results: [],
};

/** 当前卡片应展示的完整候选槽位数；补发轮的 total 仅代表本轮工作量。 */
export function candidateDisplayCount(state: CandidatesState): number {
  return Math.max(
    state.n,
    state.total,
    state.results.reduce((max, result) => Math.max(max, result.index + 1), 0),
  );
}

/** candidates / recipe(candidateScore) 事件 → 新状态；无关事件原样返回 */
export function reduceCandidatesEvent(state: CandidatesState, ev: GenerateEvent): CandidatesState {
  if (ev.type === "candidates") {
    const w = ev;
    if (w.stage === "start") {
      const followup = (w.round ?? 0) > 0 && state.phase !== "idle";
      return {
        phase: "running",
        n: w.n,
        done: 0,
        total: w.n,
        scores: followup ? state.scores : [],
        results: followup ? state.results : [],
        ...(followup && state.winner !== undefined ? { winner: state.winner } : {}),
        ...(w.round ? { round: w.round } : {}),
      };
    }
    if (w.stage === "progress") {
      const results = w.result
        ? [...state.results.filter((r) => r.index !== w.result!.index), w.result]
        : state.results;
      return {
        ...state,
        done: w.done,
        total: w.total,
        results,
        ...(w.round ? { round: w.round } : {}),
      };
    }
    const resultCount = w.results?.length ?? 0;
    return {
      ...state,
      phase: "picked",
      n: resultCount > 0 ? resultCount : state.n,
      winner: w.winner,
      scores: w.scores,
      results: w.results && w.results.length > 0 ? w.results : state.results,
      // 兜底：缺失 start 的直接 picked（测试/异常序列）时从 results/scores 推断 total
      total:
        (w.results?.length ?? 0) > 0
          ? w.results!.length
          : state.total > 0
            ? state.total
            : w.scores.length,
      ...(w.round ? { round: w.round } : {}),
    };
  }
  if (ev.type === "recipe" && ev.candidateScore) {
    return { ...state, detail: ev.candidateScore };
  }
  return state;
}

/**
 * 候选阶段进度文案：「正在并行生成 N 份方案…(k/N)」；
 * 非 running 阶段返回空串（调用方据此决定是否渲染进度行）。
 */
export function candidatesProgressText(state: CandidatesState): string {
  if (state.phase !== "running" || state.total <= 0) return "";
  if ((state.round ?? 0) > 0) {
    return `第 ${(state.round ?? 0) + 1} 轮正在补发 ${state.total} 份方案…(${state.done}/${state.total})`;
  }
  return `正在并行生成 ${state.total} 份方案…(${state.done}/${state.total})`;
}

/**
 * 优选明细标题（任务 #121：维度加权语义）：如「3 选 1｜得分 87.5 · 维度加权」。
 * 有警告/修正时追加如实数量，避免「得分 100：无违规」式的无信息量文案。
 */
export function candidatePickHeadline(detail: CandidateScoreDetail): string {
  const extra =
    detail.warns === 0 && detail.clamps === 0
      ? ""
      : `（${detail.warns} 项警告、${detail.clamps} 项修正）`;
  return `${detail.n} 选 1｜得分 ${detail.score} · 维度加权${extra}`;
}

/**
 * 成功候选行得分文案（任务 #121）：携带 dimensions 时「得分 NN · 维度加权」；
 * 旧形态（无 dimensions）回退「得分 NN · 警告 X · 修正 Y」，绝不拼出 undefined。
 */
export function candidateRowScoreText(entry: CandidateResultEntry): string {
  const score = entry.score ?? "—";
  if (entry.dimensions && entry.dimensions.length > 0) {
    return `得分 ${score} · 维度加权`;
  }
  return `得分 ${score} · 警告 ${entry.warns ?? 0} · 修正 ${entry.clamps ?? 0}`;
}

export function candidateRecipeSummaryLines(entry: CandidateResultEntry): string[] {
  const recipe = entry.recipeSummary;
  if (!recipe) return [];
  const patternName = { center: "中心", circular: "环绕", spiral: "螺旋" } as const;
  const bypass = recipe.bypassEnabled
    ? ` + 旁路 ${recipe.bypassVolume ?? 0}ml·${recipe.bypassTemp ?? 0}℃`
    : "";
  const grinderAction =
    recipe.isSetGrinderSize === 2
      ? " · 预磨粉（机器跳过研磨）"
      : ` · 研磨 ${recipe.grinderSize} · ${recipe.rpm} rpm`;
  const overview =
    `${recipe.doseGrams}g / 萃取 ${recipe.grandWater}ml${bypass}（最终 1:${recipe.ratio}）` +
    grinderAction;
  const pours = recipe.pours
    .map(
      (pour) =>
        `${pour.volume}ml·${pour.temperature}℃·${pour.flowRate}ml/s·${patternName[pour.pattern]}` +
        (pour.pausing > 0 ? `·停 ${pour.pausing}s` : "") +
        (pour.vibBefore ? "·前振" : "") +
        (pour.vibAfter ? "·后振" : ""),
    )
    .join(" → ");
  return [overview, `${recipe.pours.length} 段：${pours}`];
}

/** 同分不等于同配方；仅在两边都有参数快照且快照不同的时候给 UI 明示。 */
export function candidateHasDistinctScoreTie(
  entry: CandidateResultEntry | undefined,
  entries: CandidateResultEntry[],
): boolean {
  if (entry?.status !== "ok" || typeof entry.score !== "number" || !entry.recipeSummary)
    return false;
  const ownSummary = JSON.stringify(entry.recipeSummary);
  return entries.some(
    (other) =>
      other.index !== entry.index &&
      other.status === "ok" &&
      other.score === entry.score &&
      !!other.recipeSummary &&
      JSON.stringify(other.recipeSummary) !== ownSummary,
  );
}

/** 逐维度明细展开数据（任务 #121）：无 dimensions 时返回空数组（行不可展开） */
export function candidateDimensionLines(entry?: CandidateResultEntry): CandidateDimensionEntry[] {
  return entry?.dimensions ?? [];
}

// ---------------------------------------------------------------------------
// 信封通道（任务 #120）：App.tsx 仅透传字符串 prop，结构化状态经 doneNote 字符串
// 通道下发给 StreamPanel。格式：MAGIC + base64(JSON state) + MAGIC + 展示文案。
// N=1 恒 idle → 返回空串，通道不激活，UI 逐字节不变。
// ---------------------------------------------------------------------------

const ENV_MAGIC = "\u0000xc120\u0000";

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64decode(b: string): string {
  const bin = atob(b);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 状态 + 展示文案 → 信封字符串（供 candidatesDoneNote 使用） */
export function encodeCandidatesNote(state: CandidatesState, text: string): string {
  return `${ENV_MAGIC}${b64encode(JSON.stringify(state))}${ENV_MAGIC}${text}`;
}

/**
 * 解析 doneNote 字符串通道：返回展示文案与结构化状态。
 * 无信封（N=1 / 旧形态）时 text 原样返回、state=null，调用方行为不变。
 */
export function parseCandidatesNote(raw: string | undefined): {
  text: string;
  state: CandidatesState | null;
} {
  if (!raw || !raw.startsWith(ENV_MAGIC)) return { text: raw ?? "", state: null };
  const rest = raw.slice(ENV_MAGIC.length);
  const end = rest.indexOf(ENV_MAGIC);
  if (end < 0) return { text: raw, state: null };
  try {
    const state = JSON.parse(b64decode(rest.slice(0, end))) as CandidatesState;
    if (!state || typeof state.total !== "number") return { text: raw, state: null };
    return { text: rest.slice(end + ENV_MAGIC.length), state };
  } catch {
    return { text: raw, state: null };
  }
}

/**
 * content 事件载荷提取（任务 #116）：N=1 流式增量在 delta；N>1 recipe 前补发的
 * 获胜者原始正文在 content 字段（服务端契约固化于 server/test/generate-candidates.test.ts）。
 * 优先 delta、回退 content、都缺失返回空串，绝不拼出 "undefined" 脏文本。
 */
export function contentChunkOf(ev: Extract<GenerateEvent, { type: "content" }>): string {
  return ev.delta ?? ev.content ?? "";
}

/**
 * error 事件归位（任务 #114）：多候选全体失败时后端发 error+done，
 * running 态须回 idle，避免「正在并行生成 N 份方案…」进度行与错误框永久并存；
 * 其他阶段（idle/picked）原样返回，不侵入既有状态机。
 */
export function candidatesErrorReset(state: CandidatesState): CandidatesState {
  return state.phase === "running" ? CANDIDATES_IDLE : state;
}

/**
 * winnerJson 兜底卡互斥判定（任务 #114）：仅当 recipe 事件带 candidateScore（N>1）
 * 且本次生成始终未收到 content 事件时才渲染获胜载荷快照卡；
 * content 到达后一律走标准 splitSegments/RecipeJsonCard 渲染路径，二者不得同时出现。
 */
export function shouldShowWinnerJson(
  hasCandidateScore: boolean,
  contentReceived: boolean,
): boolean {
  return hasCandidateScore && !contentReceived;
}

/**
 * 完成态副标题文案（任务 #111 O4；#120 信封通道）：N>1 且状态机激活时返回
 * 信封字符串（展示文案「N 选 1 完成 · 得分 X」+ 结构化状态）；
 * idle（N=1 / 未开始）返回空串，调用方据此回退原文案。
 */
export function candidatesDoneNote(state: CandidatesState): string {
  if (state.phase === "idle") return "";
  const text = state.detail ? `${state.detail.n} 选 1 完成 · 得分 ${state.detail.score}` : "";
  return encodeCandidatesNote(state, text);
}

/**
 * 仅 1 个成功候选时的明示文案（任务 #120）：
 * 「其余 N-1 个候选失败：<逐候选原因>，采用唯一成功候选」。
 * 非 picked / 成功数≠1 / 无失败候选时返回空串。
 */
export function candidatesSoloWinNote(state: CandidatesState): string {
  if (state.phase !== "picked") return "";
  const ok = state.results.filter((r) => r.status === "ok");
  const failed = state.results.filter((r) => r.status === "failed");
  if (state.total <= 1 || ok.length !== 1 || failed.length === 0) return "";
  const reasons = failed.map((f) => `候选 ${f.index + 1} ${f.failReason ?? "失败"}`).join("；");
  return `其余 ${failed.length} 个候选失败：${reasons}，采用唯一成功候选`;
}
