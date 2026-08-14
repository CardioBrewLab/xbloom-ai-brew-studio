/**
 * POST /api/generate —— LLM 流式配方生成（SSE）。
 *
 * 请求体：{ description, mode?, beans?, beanId?, taste?, cupType?, model?, refUrls?,
 *           roasterReference?, baseRecipe?, feedback?, research?, availableDoseGrams? }
 *   - mode：fast=不联网单案；pro=联网单案；max=联网多案优选并按阈值换源
 *   - beanId：豆库档案 id，命中时把豆档案注入 user prompt
 *   - roasterReference：烘焙商参考方案原文（任务 #38），原样注入独立文本块
 *   - availableDoseGrams：可用粉量覆盖（任务 #58），可选；提供时 dose 按该克数制定
 *   - baseRecipe + feedback：“基于反馈按萃取理论调参重生成”模式
 *   - research：联网调研开关，缺省开启；带豆信息时先联网搜索豆商/官网资料
 *     再注入提示词（任务 #22），失败/超时/无结果降级为知识库生成
 * 响应：text/event-stream，每行 `data: JSON`，事件类型：
 *   {"type":"research","stage":"start","query"} /
 *   {"type":"research","stage":"source","title","url"} /
 *   {"type":"research","stage":"done","ok","message","sources","filtered","distilled","summary?"} /
 *   {"type":"candidates","stage":"start","n"} /
 *   {"type":"candidates","stage":"progress","done","total","result"}（任务 #120：result =
 *     该候选即时结果 {index,status:"ok"|"failed",failReason?}，失败原因区分结构失败/限流/请求失败） /
 *   {"type":"candidates","stage":"picked","winner","scores","results"}（任务 #120：results =
 *     本轮逐候选完整结果，成功含 score/vetoed/vetoReasons/warns/clamps/deductions，失败含 failReason；
 *     任务 #121：成功候选另携 dimensions = 逐维度加权明细 [{key,label,weight,score,note}]） /
 *   {"type":"reasoning","delta"} / {"type":"content","delta"} /
 *   {"type":"content","content"}（任务 #113：N>1 非流式路径在 auto-fix 完成后、recipe 前
 *   恰好补发一条获胜候选原始正文，供旧 SSE 消费者渲染中栏；N=1 流式路径不发此形态） /
 *   {"type":"review","stage":"start"} / {"type":"review","stage":"findings","findings"} /
 *   {"type":"review","stage":"fixed","findings","fixed","dimensions","preFindings?"} /
 *   {"type":"recipe","recipe","clamped","refUrls?","warning?","reviewFindings?","brewRationale?","candidateScore?"}（
 *   全体候选被一票否决时 warning 附加优选兜底警告；candidateScore 在评分基于
 *   auto-fix 前形态且配方事后被改写时附 postFix:true） /
 *   {"type":"variant","stage":"start"} /
 *   {"type":"variant","stage":"result","ok":true,"recipe","clamped","improvementNotes?","reviewFindings?","refUrls?","warning?","brewRationale?"} |
 *   {"type":"variant","stage":"result","ok":false,"message"} /
 *   {"type":"error","message"} / {"type":"done"}
 * variant 事件（任务 #61 双方案）：仅在带 roasterReference 且非反馈调参模式时，
 * 于 recipe 事件之后、done 之前追加「AI 改进版」；B 的 reasoning/content 流事件附加 variant:"improved"。
 *
 * candidates 事件（任务 #106 多候选）：仅当候选数 N>1（GENERATE_CANDIDATES）时出现；
 * N 只作用于 A（原版）路径内部，获胜候选照常发 recipe 事件并作为 B 的 faithfulJson 基线；
 * N=1（回滚开关）与反馈调参模式强制单候选，事件序列与现状逐字节一致。
 *
 * 流程：联网调研（可选）→ 组 prompt → [N>1：并行非流式 N 候选 + 规则评分择优；
 *       N=1：流式转发] → 提取 JSON
 *       → 结构校验（失败带错误信息重试一次）→ clampRecipe 钳位
 *       → 自动 AI 审查（任务 #36：发现违规时 LLM 修正一轮，最多一轮）
 *       → 发 review 事件 → 发 recipe 事件（最终版）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type Request, type Response } from "express";
import {
  chatCompletion,
  isConcurrencyError,
  isTransientTransportError,
  streamChat,
  type ChatMessage,
} from "../lib/llm.js";
import { config } from "../config.js";
import { fetchReferences, researchBean, type ResearchOutcome } from "../lib/research.js";
import { clampRecipe, durationWarning, type ClampResult } from "../lib/safety.js";
import { resolveGenerationPlan, type GenerationMode } from "../lib/generation-mode.js";
import {
  isSameBeanAsRecent,
  reviewDimensionCount,
  reviewRecipe,
  type ReviewFinding,
} from "../lib/review.js";
import {
  checkResearchConsistency,
  extractResearchSignals,
  parseFlavorTags,
  pickWinner,
  scoreCandidate,
  userSpecifiesRatioOrWater,
  type RankedCandidate,
} from "../lib/candidate-scoring.js";
import type { ResearchSource } from "../lib/research.js";
import type { BrewRationaleItem, Recipe } from "../lib/recipe-schema.js";
import { beanToPromptText, ensureBeanFromFreeText, findBean } from "./beans.js";
import { FeedbackSchema, loadAll, type BrewFeedback } from "./recipes.js";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = fs.readFileSync(path.resolve(here, "../prompts/brew-system.md"), "utf8");
const KNOWLEDGE = fs.readFileSync(path.resolve(here, "../knowledge/brewing-reference.md"), "utf8");

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function sendEvent(res: Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** 候选失败原因文案（任务 #120）：结构失败带前两条校验错误；请求失败区分网关限流/并发与其他 */
function candidateFailReasonText(
  f: { kind: "structural"; content: string; errors: string[] } | { kind: "request"; err: unknown },
): string {
  const cap = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);
  if (f.kind === "structural") return `结构失败：${cap(f.errors.slice(0, 2).join("；"))}`;
  if (isConcurrencyError(f.err)) return "网关限流/并发失败";
  if (isTransientTransportError(f.err)) return "网络波动，自动重试后仍未完成";
  return "上游模型请求未完成";
}

const CANDIDATE_TRANSPORT_RETRIES = 1;
const CANDIDATE_RETRY_DELAY_MS = 350;
const CANDIDATE_DIVERSITY_RETRIES = 2;
const CANDIDATE_MODEL_TIMEOUT_MS = 60_000;
const CANDIDATE_CHAIN_BUDGET_MS = 90_000;
const CANDIDATE_DIVERSITY_BUDGET_MS = 35_000;
const CANDIDATE_REFILL_BUDGET_MS = 60_000;
const CANDIDATE_CONCURRENCY_BACKOFF_MS = 650;

const CANDIDATE_DIRECTIONS = [
  "稳健基线：优先均衡、甜感与高复现性，参数变化克制。",
  "清晰路线：在用户明确口味内，优先干净度、层次与风味辨识度。",
  "圆润路线：在用户明确口味内，优先甜感、质感与余韵完整度。",
  "效率路线：在用户明确口味内，优先更简洁的分段和更稳定的执行窗口。",
  "探索路线：在安全边界内采用不同的研磨、温度或分段组合，但保持可复现。",
] as const;

function candidateMessages(
  base: ChatMessage[],
  index: number,
  total: number,
  avoidRecipes: Recipe[] = [],
): ChatMessage[] {
  const direction = CANDIDATE_DIRECTIONS[index % CANDIDATE_DIRECTIONS.length];
  const avoid =
    avoidRecipes.length > 0
      ? `\n以下方案已存在，本次核心参数不得重复；至少在研磨度、水温曲线、分段水量、流速或停顿中的两项形成有依据的差异：\n${avoidRecipes
          .map((recipe, i) => `参考 ${i + 1}: ${JSON.stringify(recipe)}`)
          .join("\n")}`
      : "";
  return [
    ...base,
    {
      role: "user",
      content:
        `【MAX 候选 ${index + 1}/${total}】${direction}` +
        `这只是同一用户目标下的设计路径，不得改变用户明确指定的口味、粉量、水量或硬约束。` +
        `请给出有辨识度且可执行的完整方案，避免只改配方名称。${avoid}`,
    },
  ];
}

/**
 * Count materially different executable parameters. Derived values such as
 * grandWater and ratio are deliberately not counted again because pour volume
 * and bypass already determine them.
 */
export function candidateRecipeDifferenceCount(left: Recipe, right: Recipe): number {
  let differences = 0;
  const changed = (a: number, b: number, threshold: number): void => {
    if (Math.abs(a - b) >= threshold) differences += 1;
  };

  if (left.cupType !== right.cupType) differences += 1;
  changed(left.doseGrams, right.doseGrams, 0.5);
  changed(left.grinderSize, right.grinderSize, 2);
  changed(left.rpm, right.rpm, 10);
  if (left.isSetGrinderSize !== right.isSetGrinderSize) differences += 1;
  if (left.bypassEnabled !== right.bypassEnabled) differences += 1;
  if (left.bypassEnabled || right.bypassEnabled) {
    changed(left.bypassVolume, right.bypassVolume, 5);
    changed(left.bypassTemp, right.bypassTemp, 1);
  }
  if (left.pours.length !== right.pours.length) differences += 1;
  const pairedPours = Math.min(left.pours.length, right.pours.length);
  for (let index = 0; index < pairedPours; index += 1) {
    const a = left.pours[index];
    const b = right.pours[index];
    changed(a.volume, b.volume, 5);
    changed(a.temperature, b.temperature, 1);
    changed(a.flowRate, b.flowRate, 0.1);
    changed(a.pausing, b.pausing, 3);
    if (a.pattern !== b.pattern) differences += 1;
    if (a.vibBefore !== b.vibBefore) differences += 1;
    if (a.vibAfter !== b.vibAfter) differences += 1;
  }
  return differences;
}

function candidateRecipesAreDistinct(left: Recipe, right: Recipe): boolean {
  return candidateRecipeDifferenceCount(left, right) >= 2;
}

function candidateRecipeSummary(recipe: Recipe): Record<string, unknown> {
  const effectiveWater = recipe.grandWater + (recipe.bypassEnabled ? recipe.bypassVolume : 0);
  return {
    doseGrams: recipe.doseGrams,
    grandWater: recipe.grandWater,
    ratio: Math.round((effectiveWater / recipe.doseGrams) * 10) / 10,
    grinderSize: recipe.grinderSize,
    rpm: recipe.rpm,
    bypassEnabled: recipe.bypassEnabled,
    bypassVolume: recipe.bypassEnabled ? recipe.bypassVolume : 0,
    bypassTemp: recipe.bypassEnabled ? recipe.bypassTemp : 0,
    isSetGrinderSize: recipe.isSetGrinderSize,
    pours: recipe.pours.map((pour) => ({
      volume: pour.volume,
      temperature: pour.temperature,
      flowRate: pour.flowRate,
      pattern: pour.pattern,
      pausing: pour.pausing,
      vibBefore: pour.vibBefore,
      vibAfter: pour.vibAfter,
    })),
  };
}

function waitForCandidateRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("生成已中断"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("生成已中断"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * MAX 的每个候选在连接瞬断时独立补发一次完整模型链。
 * 限流留给首轮后的批次恢复：部分成功时串行补槽，全失败时走 3→2→1。
 */
async function generateCandidateContent(
  messages: ChatMessage[],
  model: string | undefined,
  signal: AbortSignal,
  seed: number,
): Promise<string> {
  const candidateSignal = AbortSignal.any([signal, AbortSignal.timeout(CANDIDATE_CHAIN_BUDGET_MS)]);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await chatCompletion(messages, {
        model,
        signal: candidateSignal,
        seed,
        reasoningEffort: "low",
        maxTokens: 3_000,
        timeoutMs: CANDIDATE_MODEL_TIMEOUT_MS,
      });
    } catch (err) {
      const mayRetry =
        !candidateSignal.aborted &&
        attempt < CANDIDATE_TRANSPORT_RETRIES &&
        !isConcurrencyError(err) &&
        isTransientTransportError(err);
      if (!mayRetry) throw err;
      console.warn(`[generate] 候选请求遇到瞬时网络故障，准备第 ${attempt + 1} 次补发`);
      await waitForCandidateRetry(CANDIDATE_RETRY_DELAY_MS, candidateSignal);
    }
  }
}

/** progress 事件逐候选结果（任务 #120）：成功仅 status，失败附原因 */
function candidateProgressResult(o: {
  index: number;
  failure?:
    { kind: "structural"; content: string; errors: string[] } | { kind: "request"; err: unknown };
}): { index: number; status: "ok" | "failed"; failReason?: string } {
  if (!o.failure) return { index: o.index, status: "ok" };
  return { index: o.index, status: "failed", failReason: candidateFailReasonText(o.failure) };
}

/** 从模型正文中提取配方 JSON：容错 ```json 代码块与前后杂文 */
function extractRecipeJson(content: string): unknown {
  const candidates: string[] = [];
  // 1) 优先取代码块内容
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  // 2) 兜底：首个 { 到最后一个 }
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(content.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* 尝试下一个候选 */
    }
  }
  throw new Error("未能从模型输出中提取到合法的配方 JSON");
}

/** zod 错误 → 人类可读字符串列表 */
function zodIssues(err: unknown): string[] {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  }
  return [(err as Error).message ?? String(err)];
}

/** 消费一次 LLM 流：转发事件并累计正文，返回完整 content。
 * emitExtra（任务 #61）：可选附加字段，逐条并入 reasoning/content 事件（如 variant:"improved"）；
 * 单方案路径不传，行为逐字节不变。
 * temperature（任务 #71）：可选采样温度透传；undefined 时 streamChat 不下发该字段，行为不变 */
async function runStream(
  messages: ChatMessage[],
  model: string | undefined,
  res: Response,
  signal: AbortSignal,
  emitExtra?: Record<string, unknown>,
  temperature?: number,
): Promise<string> {
  let content = "";
  for await (const chunk of streamChat(messages, { model, signal, temperature })) {
    if (signal.aborted) break;
    sendEvent(res, { type: chunk.type, delta: chunk.delta, ...(emitExtra ?? {}) });
    if (chunk.type === "content") content += chunk.delta;
  }
  return content;
}

/** 提取结果类型：钳位配方 + 可选的 changeNotes（调参模式）/ improvementNotes（任务 #61 改进版）
 * / brewRationale（任务 #72 方案解读） */
export type ParsedRecipe = ClampResult & {
  changeNotes?: string;
  improvementNotes?: ImprovementNote[];
  brewRationale?: BrewRationaleItem[];
};

/** 从正文到钳位后的合法配方；同时提取模型额外输出的 changeNotes（调参模式）、
 * improvementNotes（任务 #61）与 brewRationale（任务 #72，清洗后非法整体丢弃不阻塞）。
 * 结构非法时抛出带说明的错误 */
function toClampedRecipe(content: string): ParsedRecipe {
  const raw = extractRecipeJson(content);
  let changeNotes: string | undefined;
  let improvementNotes: ImprovementNote[] | undefined;
  let brewRationale: BrewRationaleItem[] | undefined;
  if (raw && typeof raw === "object") {
    const cn = (raw as Record<string, unknown>).changeNotes;
    if (typeof cn === "string" && cn.trim()) changeNotes = cn.trim().slice(0, 60);
    improvementNotes = sanitizeImprovementNotes((raw as Record<string, unknown>).improvementNotes);
    brewRationale = sanitizeBrewRationale((raw as Record<string, unknown>).brewRationale);
  }
  const result = clampRecipe(raw); // 内部做结构校验 + SAFE_LIMITS 钳位（changeNotes/improvementNotes/brewRationale 额外字段被 zod 剔除）
  return { ...result, changeNotes, improvementNotes, brewRationale };
}

// ---------------------------------------------------------------------------
// 自动 AI 审查与修正（任务 #36）
// ---------------------------------------------------------------------------

/** 修正调用超时（ms）：超时静默跳过修正，findings 照常下发 */
const FIX_TIMEOUT_MS = 30_000;

/** 是否触发自动修正：findings 含 error，或 warn 数 ≥2 */
export function needsAutoFix(findings: ReviewFinding[]): boolean {
  if (findings.some((f) => f.level === "error")) return true;
  return findings.filter((f) => f.level === "warn").length >= 2;
}

/**
 * 用 LLM 发起一次自动修正调用（最多一轮，防循环）：
 * system 沿用 brew-system.md + 知识库，user 给出当前配方 JSON + findings 清单，
 * 要求只修正列出的问题、其余参数保持不变。
 * 30s 超时 / 调用失败 / 输出无法解析时返回 null（静默跳过修正）；
 * 客户端断开（outerSignal abort）同样返回 null，由主流程检测中断。
 */
async function attemptAutoFix(
  recipe: Recipe,
  findings: ReviewFinding[],
  model: string | undefined,
  outerSignal: AbortSignal,
): Promise<ClampResult | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FIX_TIMEOUT_MS);
  const onOuterAbort = (): void => ctrl.abort();
  outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  try {
    if (outerSignal.aborted) return null;
    const findingsText = findings
      .map((f, i) => `${i + 1}. [${f.level}] ${f.message} → 建议：${f.suggestion}`)
      .join("\n");
    const messages: ChatMessage[] = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n---\n\n${KNOWLEDGE}` },
      {
        role: "user",
        content:
          `【生成后自动审查：违规修正】\n` +
          `以下是刚生成的配方 JSON：\n\`\`\`json\n${JSON.stringify(recipe, null, 2)}\n\`\`\`\n\n` +
          `自动审查发现的问题清单：\n${findingsText}\n\n` +
          `要求：只修正上面列出的问题，其余参数（名称/粉量/研磨/段结构等未涉及项）保持不变；` +
          `修正后各段 volume 之和必须仍等于 grandWater，所有参数落在安全边界内。` +
          `只在正文输出一个 \`\`\`json 代码块，内含完整修正后的配方 JSON，不要输出其他内容。`,
      },
    ];
    let content = "";
    for await (const chunk of streamChat(messages, {
      model,
      signal: ctrl.signal,
      temperature: config.llm.temperature,
    })) {
      if (chunk.type === "content") content += chunk.delta;
    }
    return toClampedRecipe(content);
  } catch {
    return null; // 失败/超时/中断 → 静默跳过修正
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener("abort", onOuterAbort);
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

export const generateRouter = Router();

interface GenerateBody {
  description?: string;
  /** 显式生成策略；缺省时兼容旧版 research + 环境配置。 */
  mode?: GenerationMode;
  beans?: string;
  /** 豆库档案 id：命中时注入豆档案（与 beans 自由文本可同时存在） */
  beanId?: string;
  taste?: string;
  cupType?: string;
  model?: string;
  refUrls?: string[];
  /** 烘焙商参考方案原文（任务 #38）：用户粘贴的冲煮建议，原样注入 */
  roasterReference?: string;
  /** 联网调研开关（缺省 true）：带豆信息时先联网搜索再生成 */
  research?: boolean;
  /** 反馈重生成模式：基础配方 + 冲煮反馈 */
  baseRecipe?: unknown;
  feedback?: unknown;
  /** 基础配方在本地库的 entry id：命中时注入该 lineage 的历史反馈 */
  baseRecipeId?: string;
  /** 可用粉量覆盖（任务 #58）：可选，1-200 克；缺省按 AI 推荐粉量 */
  availableDoseGrams?: unknown;
}

// ---------------------------------------------------------------------------
// 可用粉量覆盖（任务 #58）
// ---------------------------------------------------------------------------

/** availableDoseGrams 上限（克） */
export const AVAILABLE_DOSE_MAX = 200;

const AvailableDoseSchema = z
  .number("availableDoseGrams 必须是数字")
  .min(1, "availableDoseGrams 必须在 1-200 克之间")
  .max(AVAILABLE_DOSE_MAX, "availableDoseGrams 必须在 1-200 克之间");

/**
 * 解析可选的可用粉量字段（任务 #58）：undefined/null 视为未提供；
 * 其余一律经 zod 校验（1-200 的数字），非法时抛出 ZodError（路由层转 400）。
 */
export function parseAvailableDoseGrams(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  return AvailableDoseSchema.parse(raw);
}

/**
 * 可用粉量覆盖的 prompt 段（任务 #58）：明确 dose 按用户克数制定、不得高于该值；
 * 总水按目标粉水比重算并保证可达性。未提供时返回 null（按 AI 推荐粉量）。
 */
export function availableDoseSection(grams: number | undefined): string | null {
  if (grams === undefined) return null;
  return (
    `【可用粉量约束（覆盖 AI 推荐粉量）】用户现有豆量仅 ${grams} 克，` +
    `本方案 dose 必须按 ${grams} 克制定（不得高于 ${grams} 克），AI 默认推荐粉量作废。` +
    `dose 确定后总水按目标粉水比重算，须满足粉水比可达性（0.1 步进）与整数毫升分段。`
  );
}

// ---------------------------------------------------------------------------
// 烘焙商参考方案注入（任务 #38）
// ---------------------------------------------------------------------------

/** roasterReference 上限（字符）：超出截断并在日志提示 */
export const ROASTER_REFERENCE_MAX = 4000;

// ---------------------------------------------------------------------------
// 他滤杯信号检测与转换标注（任务 #125）
// ---------------------------------------------------------------------------

/** 他滤杯词表（generate.ts 内部用，检测烘焙商参考方案/调研来源文本中的他滤杯信号） */
const ROASTER_DRIPPER_WORDS = [
  "v60",
  "kalita",
  "origami",
  "chemex",
  "aeropress",
  "orea",
  "pulsar",
  "melitta",
  "espro",
  "锥形滤杯",
  "蛋糕滤杯",
];

/**
 * 检测文本中他滤杯信号（任务 #125，纯函数可测）：返回命中的他滤杯词列表（去重）。
 * 拉丁词按词边界匹配，中文词按 includes。
 */
export function detectDripperSignal(text: string): string[] {
  const lower = text.toLowerCase();
  return ROASTER_DRIPPER_WORDS.filter((w) => {
    const lw = w.toLowerCase();
    return /[a-z0-9]/.test(lw)
      ? new RegExp(`\\b${lw.replace(/\s+/g, "\\s+")}\\b`, "i").test(lower)
      : lower.includes(lw);
  });
}

/**
 * 他滤杯 → xBloom 官方滤杯转换表（任务 #125）：
 * 按检测到的他滤杯词返回对应转换指示文本，供 roasterReferenceSection / 调研来源注入追加。
 * 转换量级参考 #124 调研结论与知识库 §9 扩展表。
 */
function dripperConversionBlock(dripperWords: string[]): string {
  if (dripperWords.length === 0) return "";
  const lines: string[] = [];
  for (const w of dripperWords) {
    const lw = w.toLowerCase();
    if (lw === "v60" || lw === "锥形滤杯") {
      lines.push(
        `■ V60（锥形）→ xBloom 官方滤杯（平底+底部限流孔）：研磨 +2~4（略粗，平底限流延长接触时间，禁止照搬 V60 偏细值）；水温 -1~2℃（浅焙尤其）；段数/比例/闷蒸忠实复刻；总时长比 V60 长 15-30s 属正常。`,
      );
    } else if (lw === "kalita") {
      lines.push(
        `■ Kalita Wave → xBloom 官方滤杯：同构平底+波形滤纸，基本直接复用；研磨维持或略粗 +0~2；水温维持或微降 0~1℃；段数/比例/闷蒸忠实复刻。`,
      );
    } else if (lw === "orea") {
      lines.push(
        `■ Orea（平底快流速）→ xBloom 官方滤杯：平底但流速更快，研磨维持或略细 -1~2（补偿快流速带来的萃取不足风险）；水温维持；段数/比例/闷蒸忠实复刻。`,
      );
    } else if (lw === "origami") {
      lines.push(
        `■ Origami → xBloom 官方滤杯：可用锥形或波形滤纸。若用波形滤纸则同 Kalita 同构，研磨 +0~2、水温 -0~1℃；若用锥形滤纸则同 V60 但幅度更小，研磨 +1~2、水温 -0~1℃。段数/比例/闷蒸忠实复刻。`,
      );
    } else if (lw === "chemex") {
      lines.push(
        `■ Chemex → xBloom 官方滤杯：Chemex 滤纸更厚、流速更慢、萃取更充分，研磨 +3~5（明显略粗，补偿厚滤纸高萃取）；水温 -1~2℃；段数/比例/闷蒸忠实复刻；总时长可能缩短。`,
      );
    } else if (lw === "aeropress") {
      lines.push(
        `■ AeroPress → xBloom 官方滤杯：机理完全不同（浸泡+按压），不可机械转换。仅参考其比例与水温作为大方向参考，研磨/段数/节奏须按 xBloom 官方滤杯经验重新设计。`,
      );
    } else {
      lines.push(
        `■ ${w} → xBloom 官方滤杯：该器具参数不可直接照搬，按 xBloom 官方滤杯（平底+底部限流孔）特性重新设计研磨/水温/节奏。`,
      );
    }
  }
  return (
    `【滤杯转换参考】检测到烘焙商方案标注以下他滤杯：${dripperWords.join("、")}。\n` +
    `用户滤杯是 xBloom 官方滤杯（Omni Dripper，平底+底部限流孔，灵感 Kalita Wave，非 V60 锥形）。` +
    `请按以下转换量级修正研磨/水温等参数，段数/比例/闷蒸节奏仍忠实复刻烘焙商骨架：\n` +
    lines.join("\n") +
    "\n" +
    `reasoning 中须写明「烘焙商为 X 滤杯参数，已按 xBloom 官方滤杯修正研磨/水温…」式的说明。`
  );
}

/**
 * 把用户粘贴的烘焙商参考方案原文组装为独立 prompt 文本块（任务 #38）。
 * 原文保留换行原样注入，块尾附纪律提示：时间轴/分段结构/比例为必须复刻的骨架，
 * 仅水温/研磨按处理法/焙度/滤杯规则裁决；总水因可达性微调时按各段占比等比缩放。
 * 任务 #125：检测原文中他滤杯信号（V60/Orea/Kalita/Origami/Chemex），命中则尾部
 * 追加【滤杯转换参考】块，含该滤杯→xBloom 官方滤杯的研磨/水温/段数/总时长方向与量级。
 * 空/非字符串返回 null；超过上限截断并 console.warn 提示。
 */
export function roasterReferenceSection(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text === "") return null;
  if (text.length > ROASTER_REFERENCE_MAX) {
    console.warn(
      `[generate] roasterReference 超长（${text.length} 字符），已截断至 ${ROASTER_REFERENCE_MAX}`,
    );
    text = text.slice(0, ROASTER_REFERENCE_MAX);
  }
  const dripperWords = detectDripperSignal(text);
  const conversionBlock = dripperConversionBlock(dripperWords);
  return (
    `【烘焙商参考方案】\n${text}\n\n` +
    `以上烘焙商方案的时间轴、分段结构与累计注水比例是必须逐段复刻的骨架` +
    `（按《规则优先级与冲突裁决》总表定位为 L2 级：用户显式粘贴优先于联网调研转述）：` +
    `段数、各段累计占比、停顿节奏照此还原，不得合并/拆分/改段数或改用其他模板重建骨架。` +
    `仅水温与研磨按处理法/焙度/滤杯规则裁决，并在理由中说明取舍。` +
    `粉量被用户可用豆量覆盖（L1）时，按 L1→L2 重算总水后按各段占比等比缩放，段数与停顿不变。` +
    `总水量因粉水比可达性需微调时（如 12g 的 200ml 就近取 198ml），` +
    `按烘焙商各段累计占比等比缩放各段注水量（取整为整数毫升，各段之和等于新总水量），` +
    `段数与停顿节奏保持不变。` +
    (conversionBlock ? `\n${conversionBlock}` : "")
  );
}

// ---------------------------------------------------------------------------
// 双方案对比生成（任务 #61）
// ---------------------------------------------------------------------------

/** 改进版结构化改动说明条目（随 variant:result 事件下发，前端 #62 按此对接） */
export interface ImprovementNote {
  /** 被调整的参数名 */
  param: string;
  /** 改前值（文本化） */
  from: string;
  /** 改后值（文本化） */
  to: string;
  /** 调整理由（须标注依据来源：调研 URL 编号或知识库章节） */
  rationale: string;
  /** 预期风味效果 */
  expectedFlavor: string;
}

/** improvementNotes 条数上限 */
export const IMPROVEMENT_NOTES_MAX = 5;

/**
 * improvementNotes 入库/下发前清洗（任务 #61）：非数组整体丢弃；逐项校验字段类型，
 * 缺字段/类型不符的条目剔除；文本截断（param≤20、from/to≤30、rationale≤120、expectedFlavor≤80）；
 * 至多保留 5 条；清洗后为空返回 undefined，绝不阻塞主流程。
 * from/to 兼容模型输出数字（转为文本）。
 */
export function sanitizeImprovementNotes(raw: unknown): ImprovementNote[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned: ImprovementNote[] = [];
  for (const item of raw) {
    if (cleaned.length >= IMPROVEMENT_NOTES_MAX) break;
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const param = typeof it.param === "string" ? it.param.trim() : "";
    const rationale = typeof it.rationale === "string" ? it.rationale.trim() : "";
    const expectedFlavor = typeof it.expectedFlavor === "string" ? it.expectedFlavor.trim() : "";
    const from =
      typeof it.from === "string"
        ? it.from.trim()
        : typeof it.from === "number"
          ? String(it.from)
          : "";
    const to =
      typeof it.to === "string" ? it.to.trim() : typeof it.to === "number" ? String(it.to) : "";
    if (!param || !from || !to || !rationale || !expectedFlavor) continue;
    cleaned.push({
      param: param.slice(0, 20),
      from: from.slice(0, 30),
      to: to.slice(0, 30),
      rationale: rationale.slice(0, 120),
      expectedFlavor: expectedFlavor.slice(0, 80),
    });
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/** brewRationale 条数上限（任务 #72） */
export const BREW_RATIONALE_MAX = 8;

/** brewRationale basis 单条字数上限（任务 #72；任务 #105 C5：120→160，
 * 容纳「机制→预期风味→调整方向」三要素完整表达，与 brew-system.md 话术范式同步） */
export const BREW_RATIONALE_BASIS_MAX = 160;

/**
 * brewRationale 下发/入库前清洗（任务 #72）：非数组整体丢弃；逐条校验
 * param/choice/basis 均为非空字符串，缺字段/类型不符的条目剔除；
 * 文本截断（param/choice ≤30、basis ≤BREW_RATIONALE_BASIS_MAX）；至多保留 8 条；
 * 清洗后为空返回 undefined，绝不阻塞主流程。
 */
export function sanitizeBrewRationale(raw: unknown): BrewRationaleItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned: BrewRationaleItem[] = [];
  for (const item of raw) {
    if (cleaned.length >= BREW_RATIONALE_MAX) break;
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const param = typeof it.param === "string" ? it.param.trim() : "";
    const choice = typeof it.choice === "string" ? it.choice.trim() : "";
    const basis = typeof it.basis === "string" ? it.basis.trim() : "";
    if (!param || !choice || !basis) continue;
    cleaned.push({
      param: param.slice(0, 30),
      choice: choice.slice(0, 30),
      basis: basis.slice(0, BREW_RATIONALE_BASIS_MAX),
    });
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * 双方案生成闸门（任务 #61）纯函数：仅当带有效烘焙商参考方案、
 * 且非反馈调参模式（无 baseRecipe 且无 feedback）时才追加 AI 改进版；
 * 其余场景事件序列与现状逐字节一致。
 */
export function shouldRunDualGeneration(
  body: Pick<GenerateBody, "roasterReference" | "baseRecipe" | "feedback">,
): boolean {
  return (
    roasterReferenceSection(body.roasterReference) !== null &&
    body.baseRecipe === undefined &&
    body.feedback === undefined
  );
}

/**
 * AI 改进版 prompt 段（任务 #61）：以原版 JSON 为基线，允许并鼓励在联网调研/知识库
 * 支撑下调整 1-3 个变量（水温/研磨/比例/节奏/bypass）；可偏离烘焙商骨架但逐项说明理由；
 * 仍受《规则优先级》L0 平台硬约束；强制额外输出结构化 improvementNotes。
 * roasterText 复用 ROASTER_REFERENCE_MAX 截断逻辑。
 */
export function improvedVariantSection(roasterText: unknown, faithfulRecipeJson: string): string {
  let roaster = typeof roasterText === "string" ? roasterText.trim() : "";
  if (roaster.length > ROASTER_REFERENCE_MAX) {
    console.warn(
      `[generate] 改进版烘焙商原文超长（${roaster.length} 字符），已截断至 ${ROASTER_REFERENCE_MAX}`,
    );
    roaster = roaster.slice(0, ROASTER_REFERENCE_MAX);
  }
  return (
    `【AI 改进版生成（任务 #61：双方案对比）】\n` +
    `以下是已交付的「原版」配方 JSON（忠实复刻烘焙商方案、已钳位合法），请以它为唯一改进基线：\n` +
    `\`\`\`json\n${faithfulRecipeJson}\n\`\`\`\n` +
    (roaster ? `烘焙商参考方案原文（改进参照）：\n${roaster}\n` : "") +
    `改进要求（严格执行）：\n` +
    `■ 允许并鼓励调整 1-3 个变量（水温 / 研磨 grinderSize / 比例 grandWater与doseGrams / 节奏 pausing与分段结构 / bypass），` +
    `前提是有上文联网调研资料或随附知识库案例支撑；不要面面俱到地全部改动。\n` +
    `■ 可以偏离烘焙商方案的骨架（段数、比例、节奏），但每一处偏离都必须逐项说明理由，` +
    `理由须落到调研资料/知识库/萃取理论上，不得凭空臆断。\n` +
    `■ 仍受《规则优先级与冲突裁决》L0 平台硬约束：粉水比 0.1 步进可达性（doseGrams×比例===grandWater 精确成立）、` +
    `各段 volume 为整数毫升且总和严格等于 grandWater、所有参数落在 SAFE_LIMITS 边界内。\n` +
    `■ 输出：正文只输出一个 \`\`\`json 代码块，内含完整改进后配方 JSON；` +
    `并在同一 JSON 对象中额外输出字段 "improvementNotes"：数组、至多 5 条，` +
    `每条形如 {param, from, to, rationale, expectedFlavor}（param=被调参数名，from/to=改前/改后值，` +
    `rationale=调整理由并标注依据来源，expectedFlavor=预期风味效果）；` +
    `rationale 必须注明依据来源（联网调研 URL 编号或知识库章节，如“知识库 §3”）；未改动的变量不要虚构条目。`
  );
}

/**
 * 双方案尾段失败事件（任务 #61）：B 的任何失败（解析/超时/abort）都归一为
 * ok:false 尾事件，绝不让 B 失败吞掉已交付的 A。抽出纯函数便于单测 ok:false 分支。
 */
export function variantFailEvent(err: unknown): {
  type: "variant";
  stage: "result";
  ok: false;
  message: string;
} {
  const msg =
    err instanceof Error && err.message
      ? err.message
      : typeof err === "string" && err
        ? err
        : "未知错误";
  return { type: "variant", stage: "result", ok: false, message: `AI 改进版生成失败：${msg}` };
}

export function shouldEmitVariantFailure(
  abortKind: "client" | "timeout" | null,
  writableEnded: boolean,
): boolean {
  return abortKind !== "client" && !writableEnded;
}

/** 反馈重生成模式的 prompt 段：基础配方 + 反馈 + 历史反馈 + dial-in 调参规则 */
export function feedbackSection(
  baseRecipe: unknown,
  feedback: unknown,
  history?: BrewFeedback[],
): string | null {
  const fb = FeedbackSchema.safeParse(feedback);
  if (!fb.success) return null;
  let baseText: string;
  try {
    baseText = JSON.stringify(clampRecipe(baseRecipe).recipe, null, 2);
  } catch {
    return null;
  }
  const { rating, taste, note } = fb.data;
  const parts: string[] = [
    `【基于冲煮反馈的调参重生成】\n` +
      `用户已按下面的基础配方冲煮并给出反馈，请以它为骨架做针对性微调（dial-in），而不是从零重新设计：\n` +
      `上一版关键参数（已钳位合法，即本轮调参的起点）：\n${baseText}\n` +
      `本轮反馈：评分 ${rating}/5；味型标签：${taste.join("、")}${note ? `；备注：${note}` : ""}`,
  ];

  // lineage 历史反馈（最近 5 条）：多轮迭代累积，约束不反向推翻、避免震荡
  if (history && history.length > 0) {
    const lines = history
      .slice(-5)
      .map(
        (h, i) =>
          `${i + 1}. ${h.createdAt}｜评分 ${h.rating}/5｜${h.taste.join("、")}${h.note ? `｜备注：${h.note}` : ""}`,
      );
    parts.push(
      `【历史反馈（该配方 lineage 最近 ${lines.length} 条）】\n${lines.join("\n")}\n` +
        `多轮迭代约束：本轮反馈与历史反馈叠加理解；不得反向推翻上一轮已生效的调整，` +
        `避免在同一变量上来回震荡；历史反馈与本轮反馈冲突时，以本轮为准并在 changeNotes 中说明取舍。`,
    );
  }

  parts.push(
    `调参规则（严格按此执行）：\n` +
      `■ dial-in 纪律：每轮最多只改 1-2 个变量；调整优先级 研磨（grinderSize）> 水温（temperature）> 分段节奏（volume/pausing）；` +
      `若 baseRecipe 源自烘焙商骨架，dial-in 优先改水温/研磨，节奏调整以不破坏段数为限；` +
      `某参数已触 SAFE_LIMITS 边界（如 grinderSize 40-120、水温 60-95℃）时，不再继续压该参数，换到其他维度解决。\n` +
      `■ 萃取维度：\n` +
      `- 偏酸（欠萃）→ 研磨更细（grinderSize 数值减小）、水温提高、节奏放慢（pausing 加长或多分段）\n` +
      `- 偏苦（过萃）→ 反向：研磨更粗、水温降低、节奏加快\n` +
      `- 偏弱（浓度不足）→ 提高浓度：减总水或加粉量（比例向 1:14 靠拢）、研磨更细\n` +
      `- 过强（浓度过高）→ 反向：加总水或减粉量（比例向 1:17 靠拢）、研磨更粗\n` +
      `- 平衡 → 保留原骨架，仅做细节优化（段名、bypass、振动等）\n` +
      `■ 风味维度：\n` +
      `- 香气不足 / 风味不突出 → 水温提高 1-2℃、研磨略细、缩短闷蒸（首段 pausing 减小，但不得低于 30s 闷蒸下限）以保留挥发性香气；` +
      `必要时改浓缩冲法（grandWater 向 1:10-1:14 收窄）+ bypassEnabled 稀释回正常浓度，放大风味层次\n` +
      `- 甜感不足 → 水温略降（1-2℃）并延长萃取时间（pausing 加长/节奏放慢），促甜感物质溶出\n` +
      `■ 输出要求：完整新配方 JSON（含全部官方字段），而不是只输出差异；` +
      `并在 JSON 中额外增加一个字段 "changeNotes"：≤60 字的中文调整理由（说明改了哪 1-2 个变量、为什么）。`,
  );
  return parts.join("\n\n");
}

generateRouter.post("/api/generate", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as GenerateBody;
  if (!body.description || typeof body.description !== "string" || !body.description.trim()) {
    res.status(400).json({ ok: false, error: "description 不能为空" });
    return;
  }

  // 可用粉量覆盖（任务 #58）：非法值在 SSE 开启前 400 拒绝
  let availableDoseGrams: number | undefined;
  try {
    availableDoseGrams = parseAvailableDoseGrams(body.availableDoseGrams);
  } catch (err) {
    res
      .status(400)
      .json({ ok: false, error: `availableDoseGrams 非法：${zodIssues(err).join("；")}` });
    return;
  }

  // SSE 响应头
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const aborter = new AbortController();
  const generationTimeoutMs = Math.min(
    30 * 60_000,
    Math.max(60_000, Number(process.env.GENERATION_TIMEOUT_MS) || 5 * 60_000),
  );
  let abortKind: "client" | "timeout" | null = null;
  let deliverTimeoutCheckpoint: (() => boolean) | null = null;
  const generationTimer = setTimeout(() => {
    abortKind = "timeout";
    aborter.abort(new Error("整轮生成超时"));
  }, generationTimeoutMs);
  const endAbortedGeneration = (): void => {
    clearTimeout(generationTimer);
    if (abortKind === "timeout" && !res.writableEnded) {
      const delivered = deliverTimeoutCheckpoint?.() ?? false;
      if (!delivered) {
        sendEvent(res, {
          type: "error",
          message: `本轮生成超过 ${Math.round(generationTimeoutMs / 60_000)} 分钟，已停止并保留输入内容`,
        });
        sendEvent(res, { type: "done" });
      }
    }
    if (!res.writableEnded) res.end();
  };
  res.on("close", () => {
    clearTimeout(generationTimer);
    if (!res.writableEnded) {
      abortKind = "client";
      aborter.abort(new Error("客户端已断开"));
    }
  });

  try {
    // --- 组装 user message -------------------------------------------------
    const refText = await fetchReferences(body.refUrls);
    const bean = body.beanId && typeof body.beanId === "string" ? findBean(body.beanId) : null;
    // 自由文本豆信息自动落档（任务 #35）：同名已存在则跳过；落档失败不阻塞生成。
    // 任务 #65：beanId 已命中豆档案时跳过落档，避免选豆场景每次生成追加重复档
    // 任务 #130：升级为多级匹配——命中已有豆则返回 beanId，不建空壳；
    // 命中的 beanId 通过 beanMatch SSE 事件下发前端，使保存配方时带 beanId。
    /** 本次自由文本落档匹配到的 beanId（任务 #130：beanMatch 事件用） */
    let matchedBeanId: string | undefined;
    if (shouldPersistFreeTextBean(body.beans, body.beanId)) {
      try {
        const persisted = ensureBeanFromFreeText(body.beans.trim());
        matchedBeanId = persisted.beanId;
      } catch {
        /* 磁盘异常不影响本次生成 */
      }
    }
    const userParts = [`【冲煮需求】${body.description.trim()}`];
    if (bean) userParts.push(`【豆子信息（豆库档案）】${beanToPromptText(bean)}`);
    if (body.beans) userParts.push(`【豆子信息】${body.beans}`);
    // 烘焙商参考方案（任务 #38）：豆信息之后、风味/偏好之前，独立成块
    const roasterSection = roasterReferenceSection(body.roasterReference);
    if (roasterSection) userParts.push(roasterSection);
    // 可用粉量覆盖（任务 #58）：与 beanId 注入、烘焙商参考方案共存
    const doseSection = availableDoseSection(availableDoseGrams);
    if (doseSection) userParts.push(doseSection);
    if (body.taste) userParts.push(`【期望风味】${body.taste}`);
    if (body.cupType) userParts.push(`【器具】cupType = ${body.cupType}`);
    // 反馈重生成模式：baseRecipe + feedback 同时提供时注入调参分支（附 lineage 历史反馈）
    if (body.baseRecipe !== undefined && body.feedback !== undefined) {
      let history: BrewFeedback[] | undefined;
      if (typeof body.baseRecipeId === "string" && body.baseRecipeId) {
        const entry = loadAll().find((r) => r.id === body.baseRecipeId);
        if (entry?.feedbacks && entry.feedbacks.length > 0) history = entry.feedbacks.slice(-5);
      }
      const section = feedbackSection(body.baseRecipe, body.feedback, history);
      if (section) userParts.push(section);
    }
    if (refText) userParts.push(`【参考资料（来自用户提供的网页）】\n${refText}`);

    // 任务 #131：保存调研前 base userParts——重调研轮次重置 userParts 后重新追加调研摘要
    const baseUserParts = [...userParts];

    // --- 联网调研（任务 #22）：带豆信息且未关闭时，先调研再调 LLM -------
    let refUrls: string[] = [];
    /** 调研摘要文本（任务 #121：评分阶段提取参数信号供调研贴合度维度使用） */
    let researchSummaryText = "";
    /** 任务 #131：调研是否经 LLM 提炼（一致性容差×1.5） */
    let researchDistilled = false;
    const hasBeanInfo = !!bean || (typeof body.beans === "string" && body.beans.trim() !== "");
    // 任务 #131：重调研换源——前轮已用 URL 集合，后续轮次 researchBean excludeUrls 排除
    const usedSourceUrls = new Set<string>();
    /** 所有换源轮次真正采用过的来源与摘要；最终配方保留完整审计链，而非只留末轮。 */
    const allSourceUrls = new Set<string>();
    // 任务 #131：单调收敛——本轮最高分≤上轮则提前终止降级披露
    let prevMaxScore = -Infinity;
    // 任务 #131：一致性校验结果，随 candidateScore 下发前端
    let researchConsistency:
      | {
          consistent: boolean;
          deviations: { param: string; value: number; researchValue: number; tolerance: number }[];
        }
      | undefined;

    // --- 审查上下文前置（任务 #106：多候选评分与后续自动审查共用同一口径） ---
    const beanText = [bean ? beanToPromptText(bean) : "", body.beans ?? ""]
      .filter((s) => s.trim() !== "")
      .join("\n");
    const recentEntries = loadAll().slice(-5);
    const recentSkeletons = recentEntries.map((r) => r.recipe);
    const beanCtx = {
      text: beanText || undefined,
      hasRoasterReference: roasterSection !== null,
      sameBeanAsRecent: isSameBeanAsRecent(
        { beanId: body.beanId, beanText: typeof body.beans === "string" ? body.beans : undefined },
        recentEntries,
      ),
    };
    const feedbackMode = body.baseRecipe !== undefined && body.feedback !== undefined;
    const generationPlan = resolveGenerationPlan(body.mode, body.research, {
      candidateCount: config.generateCandidates,
      maxResearchRounds: config.researchRetryMaxRounds,
    });
    const candidateN = feedbackMode ? 1 : generationPlan.candidateCount;
    const maxResearchRounds = feedbackMode ? 0 : generationPlan.maxResearchRounds;
    const systemContent = `${SYSTEM_PROMPT}\n\n---\n\n${KNOWLEDGE}`;

    // 任务 #131：跨轮持久变量（在 round 循环外声明）
    let result: ParsedRecipe | null = null;
    let candidateScorePayload:
      | {
          index: number;
          n: number;
          winner: number;
          score: number;
          vetoed: boolean;
          warns: number;
          clamps: number;
          deductions: string[];
          postFix?: boolean;
          /** 任务 #131：调研一致性校验结果 */
          researchConsistency?: {
            consistent: boolean;
            deviations: {
              param: string;
              value: number;
              researchValue: number;
              tolerance: number;
            }[];
          };
        }
      | undefined;
    let winnerRawContent: string | undefined;
    let allCandidatesVetoed = false;
    type CandidatePickedEvent = {
      type: "candidates";
      stage: "picked";
      round: number;
      winner: number;
      scores: Array<{
        index: number;
        score: number;
        vetoed: boolean;
        warns: number;
        clamps: number;
      }>;
      results: Record<string, unknown>[];
    };
    let candidatePickedEvent: CandidatePickedEvent | undefined;
    let restoredCandidatePickedEvent: CandidatePickedEvent | undefined;
    // 任务 #131：降级标记——未通过分数阈值/一致性/单调收敛时走 warning 通道披露
    let researchDegraded = false;
    let researchDegradeReason = "";
    // 任务 #131：跨轮持久——循环外声明、循环内赋值（autoFix/dual gen 需引用最终轮值）
    let userContent = "";
    let reviewFindings: ReviewFinding[] = [];
    type ResearchDoneEvent = Record<string, unknown> & { type: "research"; stage: "done" };
    type ReviewCompletedEvent = Record<string, unknown> & { type: "review"; stage: "fixed" };
    type CompletedRound = {
      score: number;
      result: ParsedRecipe;
      candidateScorePayload: NonNullable<typeof candidateScorePayload>;
      winnerRawContent?: string;
      allCandidatesVetoed: boolean;
      reviewFindings: ReviewFinding[];
      researchConsistency: typeof researchConsistency;
      userContent: string;
      candidatePickedEvent: CandidatePickedEvent;
      researchDoneEvent?: ResearchDoneEvent;
      reviewCompletedEvent: ReviewCompletedEvent;
    };
    let completedRound: CompletedRound | null = null;
    let restoredResearchDoneEvent: ResearchDoneEvent | undefined;
    let restoredReviewCompletedEvent: ReviewCompletedEvent | undefined;
    const restoreCompletedRound = (reason: string): boolean => {
      if (!completedRound) return false;
      result = completedRound.result;
      candidateScorePayload = completedRound.candidateScorePayload;
      winnerRawContent = completedRound.winnerRawContent;
      allCandidatesVetoed = completedRound.allCandidatesVetoed;
      reviewFindings = completedRound.reviewFindings;
      researchConsistency = completedRound.researchConsistency;
      userContent = completedRound.userContent;
      restoredCandidatePickedEvent = completedRound.candidatePickedEvent;
      restoredResearchDoneEvent = completedRound.researchDoneEvent;
      restoredReviewCompletedEvent = completedRound.reviewCompletedEvent;
      researchDegraded = true;
      researchDegradeReason = reason;
      return true;
    };
    deliverTimeoutCheckpoint = () => {
      if (!restoreCompletedRound("后续优选达到时间上限，已采用上一轮最高分方案")) return false;
      if (restoredResearchDoneEvent) sendEvent(res, restoredResearchDoneEvent);
      if (restoredCandidatePickedEvent) sendEvent(res, restoredCandidatePickedEvent);
      if (restoredReviewCompletedEvent) sendEvent(res, restoredReviewCompletedEvent);
      if (winnerRawContent) sendEvent(res, { type: "content", content: winnerRawContent });
      if (matchedBeanId) {
        const matchedBean = findBean(matchedBeanId);
        sendEvent(res, {
          type: "beanMatch",
          beanId: matchedBeanId,
          beanName: matchedBean?.name ?? "",
          matched: true,
        });
      }
      const timeoutWarnings = [
        durationWarning(result!.recipe),
        allCandidatesVetoed
          ? "优选兜底：全部候选均触发一票否决，已按相对最优下发，请人工核对"
          : undefined,
        researchDegradeReason,
      ].filter((value): value is string => Boolean(value));
      sendEvent(res, {
        type: "recipe",
        recipe: result!.recipe,
        clamped: result!.clamped,
        ...(result!.changeNotes ? { changeNotes: result!.changeNotes } : {}),
        ...(result!.brewRationale ? { brewRationale: result!.brewRationale } : {}),
        ...(allSourceUrls.size > 0 ? { refUrls: [...allSourceUrls] } : {}),
        ...(timeoutWarnings.length > 0 ? { warning: timeoutWarnings.join("；") } : {}),
        ...(reviewFindings.length > 0 ? { reviewFindings } : {}),
        ...(candidateScorePayload ? { candidateScore: candidateScorePayload } : {}),
      });
      sendEvent(res, { type: "done" });
      return true;
    };

    // 任务 #131：低分重调研 round 循环——包裹调研+多候选+autoFix+一致性校验
    // 第0轮正常；第1+轮 researchBean 传 excludeUrls + queryAngle 换源重调研
    // 单调收敛：本轮最高分≤上轮则提前终止降级披露；用尽也降级披露
    roundLoop: for (let round = 0; round <= maxResearchRounds; round++) {
      let researchDoneEvent: ResearchDoneEvent | undefined;
      // 每轮重置 userParts（保留 base，重新追加本轮调研摘要）
      userParts.length = 0;
      userParts.push(...baseUserParts);
      researchSummaryText = "";
      refUrls = [];
      researchDistilled = false;
      researchConsistency = undefined;

      // --- 联网调研（任务 #22）：带豆信息且未关闭时，先调研再调 LLM -------
      if (hasBeanInfo && generationPlan.research) {
        const researchOpts =
          round > 0 ? { excludeUrls: usedSourceUrls, queryAngle: round % 3 } : undefined;
        let outcome: ResearchOutcome | null;
        try {
          outcome = await researchBean(
            {
              name: bean?.name,
              roaster: bean?.roaster,
              origin: bean?.origin,
              process: bean?.process,
              varietal: bean?.varietal,
              roastLevel: bean?.roastLevel,
              tastingNotes: bean?.tastingNotes,
              freeText: bean ? undefined : body.beans,
            },
            (stage, payload) => {
              if (!aborter.signal.aborted)
                sendEvent(res, { type: "research", stage, round, ...payload });
            },
            aborter.signal,
            researchOpts,
          );
        } catch {
          outcome = null;
        }
        if (aborter.signal.aborted) {
          endAbortedGeneration();
          return;
        }
        const done = outcome ?? {
          ok: false,
          sources: [],
          summaryText: "",
          message: "联网调研异常，已跳过",
          filtered: 0,
          distilled: false,
          xhsLoginExpired: false,
        };
        researchDoneEvent = {
          type: "research",
          stage: "done",
          round,
          ok: done.ok,
          message: done.ok ? done.message : `${done.message}，基于知识库生成`,
          sources: done.sources,
          filtered: done.filtered,
          distilled: done.distilled,
          ...(done.ok && done.summaryText ? { summary: done.summaryText } : {}),
          ...(done.xhsLoginExpired ? { xhsLoginExpired: true } : {}),
        };
        sendEvent(res, researchDoneEvent);
        if (done.ok && done.summaryText) {
          researchSummaryText = done.summaryText;
          researchDistilled = done.distilled;
          // 任务 #131：每轮把 outcome.sources 的 url 加入 usedSourceUrls，下轮排除
          for (const s of done.sources) {
            usedSourceUrls.add(s.url);
            allSourceUrls.add(s.url);
          }
          const dripperFromSources = done.sources
            .map((s) => s.dripperSignal)
            .filter((d): d is string => !!d)
            .filter((v, i, a) => a.indexOf(v) === i);
          const researchDripperBlock = dripperConversionBlock(dripperFromSources);
          userParts.push(
            `${done.summaryText}\n\n` +
              `请在思考中参考以上联网调研资料：从中提取产地/处理法/风味描述，` +
              `特别是烘焙商给出的冲煮建议（研磨度/水温/粉水比），与知识库交叉验证后采纳；` +
              `烘焙商参数与处理法/焙度经验规则冲突时，按系统提示词第 3-4 节（优先级总表与裁决策略）修正（如厌氧降至 89-92℃）并在 reasoning 说明，` +
              `以不越安全边界为前提择优采信。` +
              (researchDripperBlock ? `\n${researchDripperBlock}` : ""),
          );
          refUrls = done.sources.map((s) => s.url);
        }
      }

      userContent = userParts.join("\n\n");
      const messages: ChatMessage[] = [
        { role: "system", content: systemContent },
        { role: "user", content: userContent },
      ];

      // 任务 #131：每轮重置 result/payload（round 0 正常、round>0 重调研后重生成）
      result = null;
      candidateScorePayload = undefined;
      candidatePickedEvent = undefined;
      winnerRawContent = undefined;
      allCandidatesVetoed = false;

      if (candidateN <= 1) {
        // --- N=1：现状链路逐字节不变（流式生成 + 带错误的一次结构重试） ---------------
        let content = await runStream(
          messages,
          body.model,
          res,
          aborter.signal,
          undefined,
          config.llm.temperature,
        );

        let firstErrors: string[] = [];
        try {
          result = toClampedRecipe(content);
        } catch (err) {
          firstErrors = zodIssues(err);
        }

        // --- 失败则带错误信息自动重试一次 ---------------------------------------
        if (!result) {
          messages.push(
            { role: "assistant", content },
            {
              role: "user",
              content:
                `你上一次的输出无法使用，问题如下：\n- ${firstErrors.join("\n- ")}\n\n` +
                `请严格按系统提示词要求重新生成：只在正文输出一个 \`\`\`json 代码块，` +
                `内含单个合法配方 JSON，各段 volume 之和必须等于 grandWater，所有参数落在边界内。`,
            },
          );
          content = await runStream(
            messages,
            body.model,
            res,
            aborter.signal,
            undefined,
            config.llm.temperature,
          );
          try {
            result = toClampedRecipe(content);
          } catch (err) {
            sendEvent(res, {
              type: "error",
              message: `配方生成失败（已重试）：${zodIssues(err).join("；")}`,
            });
            sendEvent(res, { type: "done" });
            res.end();
            return;
          }
        }
      } else {
        // --- 多候选并行生成 + 规则评分择优（任务 #106） -------------------------------
        // N 个候选 Promise.all 并行、非流式调用（复用同一份 system+knowledge+userParts，
        // 调研只做一次共享注入）；候选互不可见；单候选失败/解析失败即丢弃，≥1 有效即继续；
        // 网关 429/并发失败自动降 N（3→2→1）重试本次；全体候选结构失败时对首候选执行
        // 一次带错误的结构重试；客户端断开（AbortSignal）全部取消。
        const userSpec = userSpecifiesRatioOrWater(body.description);
        let n = candidateN;
        // 结构重试标志（任务 #113）：与降 N 重试轮次解耦——旧实现用 attempt 计数，
        // 「先限流降 N、后结构失败」组合下结构重试门被降 N 轮吞噬失效
        let structuralRetried = false;
        outer: while (true) {
          sendEvent(res, { type: "candidates", stage: "start", n, round });
          let candidateEventRound = round;
          interface CandidateOutcome {
            index: number;
            /** 成功时的原始非流式正文（任务 #113：获胜后补发 content 事件用） */
            content?: string;
            parsed?: ParsedRecipe;
            completionOrder: number;
            failure?:
              | { kind: "structural"; content: string; errors: string[] }
              | { kind: "request"; err: unknown };
          }
          let doneCount = 0;
          let completionSeq = 0;
          const outcomes: CandidateOutcome[] = await Promise.all(
            Array.from({ length: n }, (_, i) =>
              (async (): Promise<CandidateOutcome> => {
                let outcome: CandidateOutcome | undefined;
                try {
                  const candidateContent = await generateCandidateContent(
                    candidateMessages(messages, i, n),
                    body.model,
                    aborter.signal,
                    42 + round * 100 + i,
                  );
                  try {
                    const parsed = toClampedRecipe(candidateContent);
                    outcome = {
                      index: i,
                      content: candidateContent,
                      parsed,
                      completionOrder: completionSeq++,
                    };
                  } catch (err) {
                    outcome = {
                      index: i,
                      completionOrder: completionSeq++,
                      failure: {
                        kind: "structural",
                        content: candidateContent,
                        errors: zodIssues(err),
                      },
                    };
                  }
                } catch (err) {
                  if (aborter.signal.aborted) throw err; // 客户端断开 → 外层 catch 统一处理
                  outcome = {
                    index: i,
                    completionOrder: completionSeq++,
                    failure: { kind: "request", err },
                  };
                } finally {
                  doneCount += 1;
                  if (!aborter.signal.aborted) {
                    // 任务 #120：progress 携带逐候选结果，前端优选明细卡实时渲染失败原因
                    sendEvent(res, {
                      type: "candidates",
                      stage: "progress",
                      round,
                      done: doneCount,
                      total: n,
                      ...(outcome ? { result: candidateProgressResult(outcome) } : {}),
                    });
                  }
                }
                return outcome!;
              })(),
            ),
          );

          // A gateway with a one-request concurrency window can accept the first MAX
          // candidate and reject the other two. The old all-failed 3→2→1 branch never
          // ran in that partial-success shape, so the UI received one recipe plus red
          // failure rows. Keep the fast parallel first pass, then refill only retryable
          // failed slots serially while preserving the successful work.
          const successfulBeforeRefill = outcomes.filter(
            (outcome): outcome is CandidateOutcome & { parsed: ParsedRecipe } => !!outcome.parsed,
          );
          const refillable = outcomes.filter((outcome) => {
            if (!outcome.failure) return false;
            return (
              outcome.failure.kind === "structural" ||
              isConcurrencyError(outcome.failure.err) ||
              isTransientTransportError(outcome.failure.err)
            );
          });
          if (successfulBeforeRefill.length > 0 && refillable.length > 0) {
            candidateEventRound = round + 1;
            sendEvent(res, {
              type: "candidates",
              stage: "start",
              n: refillable.length,
              round: candidateEventRound,
            });
            const refillSignal = AbortSignal.any([
              aborter.signal,
              AbortSignal.timeout(CANDIDATE_REFILL_BUDGET_MS),
            ]);
            const acceptedRecipes = successfulBeforeRefill.map((outcome) => outcome.parsed.recipe);
            let refillDone = 0;
            for (const failed of refillable.sort((left, right) => left.index - right.index)) {
              let replacement: CandidateOutcome;
              try {
                if (failed.failure?.kind === "request" && isConcurrencyError(failed.failure.err)) {
                  await waitForCandidateRetry(CANDIDATE_CONCURRENCY_BACKOFF_MS, refillSignal);
                }
                const content = await generateCandidateContent(
                  candidateMessages(messages, failed.index, n, acceptedRecipes),
                  body.model,
                  refillSignal,
                  5_042 + round * 100 + failed.index,
                );
                try {
                  const parsed = toClampedRecipe(content);
                  replacement = {
                    index: failed.index,
                    content,
                    parsed,
                    completionOrder: completionSeq++,
                  };
                  acceptedRecipes.push(parsed.recipe);
                } catch (err) {
                  replacement = {
                    index: failed.index,
                    completionOrder: completionSeq++,
                    failure: { kind: "structural", content, errors: zodIssues(err) },
                  };
                }
              } catch (err) {
                if (aborter.signal.aborted) throw err;
                replacement = {
                  index: failed.index,
                  completionOrder: completionSeq++,
                  failure: { kind: "request", err },
                };
              }
              outcomes[failed.index] = replacement;
              refillDone += 1;
              sendEvent(res, {
                type: "candidates",
                stage: "progress",
                round: candidateEventRound,
                done: refillDone,
                total: refillable.length,
                result: candidateProgressResult(replacement),
              });
            }
          }

          // 相同提示词 + 固定 seed 会让部分 OpenAI 兼容网关重放同一配方。
          // 首轮仍并行；仅对核心参数指纹重复的槽位做定向补发，保留 MAX 的速度与三案真实性。
          const accepted: Array<CandidateOutcome & { parsed: ParsedRecipe }> = [];
          // Diversity repair is optional. Share one short phase budget across all
          // duplicate slots so a usable first candidate is never lost to serial
          // 90-second replacement chains.
          const diversitySignal = AbortSignal.any([
            aborter.signal,
            AbortSignal.timeout(CANDIDATE_DIVERSITY_BUDGET_MS),
          ]);
          for (const outcome of outcomes.sort((a, b) => a.index - b.index)) {
            if (!outcome.parsed) continue;
            if (
              accepted.every((entry) =>
                candidateRecipesAreDistinct(entry.parsed.recipe, outcome.parsed!.recipe),
              )
            ) {
              accepted.push(outcome as CandidateOutcome & { parsed: ParsedRecipe });
              continue;
            }

            const existingRecipes = accepted.map((entry) => entry.parsed.recipe);
            let replacement: CandidateOutcome | undefined;
            for (let retry = 1; retry <= CANDIDATE_DIVERSITY_RETRIES; retry += 1) {
              try {
                const content = await generateCandidateContent(
                  candidateMessages(messages, outcome.index, n, existingRecipes),
                  body.model,
                  diversitySignal,
                  42 + round * 100 + outcome.index + retry * 1_000,
                );
                const parsed = toClampedRecipe(content);
                if (
                  accepted.some(
                    (entry) => !candidateRecipesAreDistinct(entry.parsed.recipe, parsed.recipe),
                  )
                )
                  continue;
                replacement = {
                  index: outcome.index,
                  content,
                  parsed,
                  completionOrder: completionSeq++,
                };
                break;
              } catch (err) {
                if (aborter.signal.aborted) throw err;
                replacement = {
                  index: outcome.index,
                  completionOrder: completionSeq++,
                  failure: { kind: "request", err },
                };
              }
            }

            if (!replacement?.parsed) {
              replacement = {
                index: outcome.index,
                completionOrder: completionSeq++,
                failure: {
                  kind: "structural",
                  content: outcome.content ?? "",
                  errors: ["与已有候选的核心参数重复，定向补发后仍未形成有效差异"],
                },
              };
            } else {
              accepted.push(replacement as CandidateOutcome & { parsed: ParsedRecipe });
            }
            outcomes[outcome.index] = replacement;
          }

          const valid = outcomes.filter(
            (o): o is CandidateOutcome & { parsed: ParsedRecipe } => !!o.parsed,
          );

          if (valid.length === 0) {
            const failures = outcomes.map((o) => o.failure!);
            const allConcurrency = failures.every(
              (f) => f.kind === "request" && isConcurrencyError(f.err),
            );
            if (allConcurrency && n > 1) {
              // 网关 429/并发限流：自动降 N（3→2→1）重试本次
              console.warn(`[generate] 候选全体遭遇网关限流/并发失败，N=${n} 降级为 ${n - 1} 重试`);
              n -= 1;
              continue outer;
            }
            // 全体候选结构失败 → 对首候选执行一次带错误的结构重试（与单候选同策略）
            const structural = failures.find(
              (f): f is { kind: "structural"; content: string; errors: string[] } =>
                f.kind === "structural",
            );
            if (structural && !structuralRetried) {
              structuralRetried = true;
              const retryMessages: ChatMessage[] = [
                ...messages,
                { role: "assistant", content: structural.content },
                {
                  role: "user",
                  content:
                    `你上一次的输出无法使用，问题如下：\n- ${structural.errors.join("\n- ")}\n\n` +
                    `请严格按系统提示词要求重新生成：只在正文输出一个 \`\`\`json 代码块，` +
                    `内含单个合法配方 JSON，各段 volume 之和必须等于 grandWater，所有参数落在边界内。`,
                },
              ];
              try {
                const retryContent = await chatCompletion(retryMessages, {
                  model: body.model,
                  signal: aborter.signal,
                });
                const parsed = toClampedRecipe(retryContent);
                valid.push({ index: 0, content: retryContent, parsed, completionOrder: 0 });
              } catch (err) {
                if (aborter.signal.aborted) throw err;
                if (
                  round > 0 &&
                  restoreCompletedRound(
                    `第 ${round + 1} 轮补发未取得有效方案，已采用上一轮最高分方案`,
                  )
                ) {
                  break roundLoop;
                }
                sendEvent(res, {
                  type: "error",
                  message: `配方生成失败（已重试）：${zodIssues(err).join("；")}`,
                });
                sendEvent(res, { type: "done" });
                res.end();
                return;
              }
            } else {
              // 全失败（请求类错误或无重试机会）→ 现有错误路径
              if (
                round > 0 &&
                restoreCompletedRound(`第 ${round + 1} 轮候选全部失败，已采用上一轮最高分方案`)
              ) {
                break roundLoop;
              }
              const firstFailure = failures[0];
              const msg =
                firstFailure.kind === "structural"
                  ? firstFailure.errors.join("；")
                  : ((firstFailure.err as Error)?.message ?? String(firstFailure.err));
              sendEvent(res, {
                type: "error",
                message: `配方生成失败（${n} 份候选全部失败）：${msg}`,
              });
              sendEvent(res, { type: "done" });
              res.end();
              return;
            }
          }

          // --- 评分择优（纯函数规则评分器，任务 #121 多维 rubric 加权，不引入 LLM judge） ---
          const ranked: RankedCandidate[] = valid.map((o) => {
            const findings = reviewRecipe(o.parsed.recipe, beanCtx, recentSkeletons);
            const sc = scoreCandidate({
              recipe: o.parsed.recipe,
              clamped: o.parsed.clamped,
              findings,
              brewRationale: o.parsed.brewRationale,
              userSpecifiedRatioOrWater: userSpec,
              beanText: beanCtx.text,
              flavorTags: parseFlavorTags(body.taste),
              researchSignals: extractResearchSignals(researchSummaryText),
            });
            return { ...sc, index: o.index, completionOrder: o.completionOrder };
          });
          const winnerIndex = pickWinner(ranked);
          const winner = valid.find((o) => o.index === winnerIndex)!;
          const winnerRanked = ranked.find((r) => r.index === winnerIndex)!;
          // 任务 #120：逐候选完整结果——失败候选携带原因；成功候选携带评分/否决项/扣分项；
          // 结构重试成功的候选（index 0）以 ranked 覆盖其原失败记录
          const resultsByIndex = new Map<number, Record<string, unknown>>();
          for (const o of outcomes) {
            if (o.failure) {
              resultsByIndex.set(o.index, {
                index: o.index,
                status: "failed",
                failReason: candidateFailReasonText(o.failure),
              });
            }
          }
          for (const r of ranked) {
            resultsByIndex.set(r.index, {
              index: r.index,
              status: "ok",
              score: r.score,
              vetoed: r.vetoed,
              vetoReasons: r.vetoReasons,
              warns: r.warns,
              clamps: r.clamps,
              deductions: r.deductions,
              recipeSummary: candidateRecipeSummary(
                valid.find((o) => o.index === r.index)!.parsed.recipe,
              ),
              // 任务 #121：逐维度加权明细（前端优选明细卡获胜行可展开）
              dimensions: r.dimensions,
            });
          }
          const results = Array.from({ length: n }, (_, i) => resultsByIndex.get(i)).filter(
            (r): r is Record<string, unknown> => !!r,
          );
          candidatePickedEvent = {
            type: "candidates",
            stage: "picked",
            round: candidateEventRound,
            winner: winnerIndex,
            scores: ranked.map((r) => ({
              index: r.index,
              score: r.score,
              vetoed: r.vetoed,
              warns: r.warns,
              clamps: r.clamps,
            })),
            results,
          };
          sendEvent(res, candidatePickedEvent);
          result = winner.parsed;
          // 任务 #113：获胜候选原始非流式正文（recipe 前补发 content 事件，旧 SSE 消费者兼容）
          winnerRawContent = winner.content;
          // 任务 #113：获胜者被否决 = 全体候选均被一票否决（pickWinner 优先非否决池）
          // → recipe 事件的 warning 通道附加兜底警告
          allCandidatesVetoed = winnerRanked.vetoed;
          candidateScorePayload = {
            index: winnerIndex,
            n,
            winner: winnerIndex,
            score: winnerRanked.score,
            vetoed: winnerRanked.vetoed,
            warns: winnerRanked.warns,
            clamps: winnerRanked.clamps,
            deductions: winnerRanked.deductions,
          };
          break outer;
        }
      }

      if (!result) {
        // 防御兜底：两条路径都应已赋值或带错误返回
        sendEvent(res, { type: "error", message: "配方生成失败" });
        sendEvent(res, { type: "done" });
        res.end();
        return;
      }

      // --- 自动 AI 审查（任务 #36）：recipe 产出后、下发前跑一轮规则审查 -------
      // 任务 #106：auto-fix 只对获胜候选跑（维持一轮上限）；N=1 时即唯一候选
      // 任务 #113：记录 auto-fix 前配方序列化形态，供 candidateScore postFix 判定
      const preFixRecipeJson = JSON.stringify(result.recipe);
      sendEvent(res, { type: "review", stage: "start" });
      reviewFindings = reviewRecipe(result.recipe, beanCtx, recentSkeletons);
      let reviewFixed = false;
      let preFixFindings: ReviewFinding[] | undefined;

      if (needsAutoFix(reviewFindings)) {
        preFixFindings = reviewFindings;
        sendEvent(res, { type: "review", stage: "findings", findings: reviewFindings });
        // 修正最多一轮（防循环）；失败/超时静默跳过，findings 照常下发
        const fixed = await attemptAutoFix(
          result.recipe,
          reviewFindings,
          body.model,
          aborter.signal,
        );
        if (aborter.signal.aborted) {
          endAbortedGeneration();
          return;
        }
        if (fixed) {
          result = {
            recipe: fixed.recipe,
            clamped: [...result.clamped, ...fixed.clamped],
            changeNotes: result.changeNotes,
            brewRationale: result.brewRationale,
          };
          reviewFindings = reviewRecipe(result.recipe, beanCtx, recentSkeletons);
          reviewFixed = true;
        }
      }
      // 审查终结事件：携带最终 findings 与是否修正；修正后仍有 error 也不阻塞交付
      const reviewCompletedEvent: ReviewCompletedEvent = {
        type: "review",
        stage: "fixed",
        findings: reviewFindings,
        fixed: reviewFixed,
        dimensions: reviewDimensionCount(beanCtx, recentSkeletons),
        ...(preFixFindings ? { preFindings: preFixFindings } : {}),
      };
      sendEvent(res, reviewCompletedEvent);

      // 任务 #113：candidateScore 评分基于 auto-fix 前形态；auto-fix 改写了配方时
      // 追加 postFix:true 标记（纯增量、向后兼容），提示前端「评分基于修正前形态」
      if (candidateScorePayload && JSON.stringify(result.recipe) !== preFixRecipeJson) {
        candidateScorePayload = { ...candidateScorePayload, postFix: true };
      }

      // 任务 #131：一致性校验 + round 循环控制（autoFix 后以最终配方为准）
      // N=1 路径无评分，直接采用；N>1 路径校验分数阈值 + 调研一致性
      if (candidateN > 1 && candidateScorePayload) {
        const signals = extractResearchSignals(researchSummaryText);
        researchConsistency = checkResearchConsistency(result.recipe, signals, researchDistilled);
        candidateScorePayload = { ...candidateScorePayload, researchConsistency };
        if (!candidatePickedEvent) throw new Error("候选优选状态缺失");
        const currentRound: CompletedRound = {
          score: candidateScorePayload.score,
          result,
          candidateScorePayload,
          ...(winnerRawContent ? { winnerRawContent } : {}),
          allCandidatesVetoed,
          reviewFindings: [...reviewFindings],
          researchConsistency,
          userContent,
          candidatePickedEvent,
          ...(researchDoneEvent ? { researchDoneEvent } : {}),
          reviewCompletedEvent,
        };
        if (!completedRound || currentRound.score > completedRound.score) {
          completedRound = currentRound;
        }

        const pass =
          candidateScorePayload.score >= config.candidateScoreThreshold &&
          researchConsistency.consistent;
        if (pass) break roundLoop;
        // 降级标记：未通过分数阈值或一致性校验
        if (round < maxResearchRounds) {
          // 单调收敛：本轮最高分≤上轮则提前终止降级披露
          if (candidateScorePayload.score <= prevMaxScore) {
            restoreCompletedRound(
              `候选评分 ${candidateScorePayload.score} 未超过上轮 ${prevMaxScore}，已采用较高分方案`,
            );
            break roundLoop;
          }
          prevMaxScore = candidateScorePayload.score;
          continue roundLoop;
        }
        // round == max，用尽重调研轮次仍不达标 → 降级披露
        const exhaustedReason = researchConsistency.consistent
          ? `候选评分 ${candidateScorePayload.score} 低于阈值 ${config.candidateScoreThreshold}，已用尽 ${maxResearchRounds} 轮重调研`
          : `调研一致性校验未通过（${researchConsistency.deviations.map((d) => d.param).join("、")} 偏离），已用尽 ${maxResearchRounds} 轮重调研`;
        if (completedRound.score > candidateScorePayload.score) {
          restoreCompletedRound(`${exhaustedReason}，已采用全过程最高分方案`);
        } else {
          researchDegraded = true;
          researchDegradeReason = exhaustedReason;
        }
        break roundLoop;
      }
      // N=1 路径或无评分 payload，直接采用
      break roundLoop;
    } // end roundLoop

    // 防御兜底：round 循环正常退出时 result 必已赋值（否则循环内已 return）
    if (!result) {
      sendEvent(res, { type: "error", message: "配方生成失败" });
      sendEvent(res, { type: "done" });
      res.end();
      return;
    }
    // 后续轮次失败、超时或分数回退时，恢复上一轮候选明细，避免界面停留在
    // “补发中”或只留下失败记录；配方、评分卡与最终历史条目保持同一轮。
    if (restoredResearchDoneEvent) sendEvent(res, restoredResearchDoneEvent);
    if (restoredCandidatePickedEvent) sendEvent(res, restoredCandidatePickedEvent);
    if (restoredReviewCompletedEvent) sendEvent(res, restoredReviewCompletedEvent);

    // 任务 #113：N>1 非流式路径补发 content 事件（旧 SSE 消费者兼容）——获胜候选
    // auto-fix 完成后、recipe 前，恰好补发一条其原始非流式正文；N=1 流式路径不发
    if (winnerRawContent) {
      sendEvent(res, { type: "content", content: winnerRawContent });
    }

    // 任务 #130：beanMatch 事件——自由文本落档匹配到的 beanId 下发前端，
    // 使保存配方时带 beanId（修复豆仓关联断裂根因）。
    // 选中豆库豆时（beanId 已有）不发 beanMatch——已命中无需重复通知。
    if (matchedBeanId) {
      const matchedBean = findBean(matchedBeanId);
      sendEvent(res, {
        type: "beanMatch",
        beanId: matchedBeanId,
        beanName: matchedBean?.name ?? "",
        matched: true,
      });
    }

    // 总时长估算警告（任务 #35）：>180s 仅警告不拦截（以审查/修正后的最终配方为准）
    // 任务 #113：全体候选被否决时同一 warning 通道附加优选兜底警告
    const warningParts: string[] = [];
    const durationWarn = durationWarning(result.recipe);
    if (durationWarn) warningParts.push(durationWarn);
    if (allCandidatesVetoed) {
      warningParts.push("优选兜底：全部候选均触发一票否决，已按相对最优下发，请人工核对");
    }
    // 任务 #131：重调研降级披露（低分/一致性失败/单调收敛终止）
    if (researchDegraded && researchDegradeReason) {
      warningParts.push(researchDegradeReason);
    }
    const warning = warningParts.length > 0 ? warningParts.join("；") : undefined;
    sendEvent(res, {
      type: "recipe",
      recipe: result.recipe,
      clamped: result.clamped,
      ...(result.changeNotes ? { changeNotes: result.changeNotes } : {}),
      // 方案解读随 recipe 事件下发，前端保存时透传持久化（任务 #72；缺失时逐字节不变）
      ...(result.brewRationale ? { brewRationale: result.brewRationale } : {}),
      ...(allSourceUrls.size > 0 ? { refUrls: [...allSourceUrls] } : {}),
      ...(warning ? { warning } : {}),
      // 审查结果随 recipe 事件下发，前端保存时透传持久化（任务 #36）
      ...(reviewFindings.length > 0 ? { reviewFindings } : {}),
      // 多候选择优评分摘要（任务 #106）：仅 N>1 时存在，N=1 时逐字节不变
      ...(candidateScorePayload ? { candidateScore: candidateScorePayload } : {}),
    });

    // --- 双方案尾段（任务 #61）：烘焙商复刻原版交付后、done 前追加 AI 改进版 -------
    // 整段 try/catch：B 的任何失败（解析/超时/abort）只降级为 ok:false 尾事件，
    // 绝不让 B 失败吞掉已交付的 A；无 roasterReference / 反馈调参模式时本段不执行，
    // 事件序列与现状逐字节一致。
    if (shouldRunDualGeneration(body) && !aborter.signal.aborted) {
      try {
        sendEvent(res, { type: "variant", stage: "start" });
        const faithfulJson = JSON.stringify(result.recipe, null, 2);
        // 组 B messages：同一 system+knowledge；user 复用 userParts（含调研摘要，不重复 researchBean）
        // + 原版完整 JSON + 改进版 prompt 段
        const variantMessages: ChatMessage[] = [
          { role: "system", content: systemContent },
          {
            role: "user",
            content:
              `${userContent}\n\n` +
              `【原版配方完整 JSON（改进基线）】\n\`\`\`json\n${faithfulJson}\n\`\`\`\n\n` +
              improvedVariantSection(body.roasterReference, faithfulJson),
          },
        ];
        // B 的流式事件附加 variant:"improved"，前端据此区分双方案两段流
        let bContent = await runStream(
          variantMessages,
          body.model,
          res,
          aborter.signal,
          {
            variant: "improved",
          },
          config.llm.temperature,
        );
        let bResult: ParsedRecipe | null = null;
        let bErrors: string[] = [];
        try {
          bResult = toClampedRecipe(bContent);
        } catch (err) {
          bErrors = zodIssues(err);
        }
        // 结构失败重试一次（与 A 同策略）
        if (!bResult) {
          variantMessages.push(
            { role: "assistant", content: bContent },
            {
              role: "user",
              content:
                `你上一次的输出无法使用，问题如下：\n- ${bErrors.join("\n- ")}\n\n` +
                `请重新生成改进版：只在正文输出一个 \`\`\`json 代码块，内含单个合法配方 JSON，` +
                `各段 volume 之和必须等于 grandWater，所有参数落在边界内，` +
                `并保留 improvementNotes 数组（≤5 条，每条 {param, from, to, rationale, expectedFlavor}）。`,
            },
          );
          bContent = await runStream(
            variantMessages,
            body.model,
            res,
            aborter.signal,
            {
              variant: "improved",
            },
            config.llm.temperature,
          );
          bResult = toClampedRecipe(bContent); // 再次失败抛出 → 外层 catch → ok:false
        }
        // B 同样过自动审查（带烘焙商参考上下文）+ 最多一轮自动修正
        const bCtx = { text: beanText || undefined, hasRoasterReference: true };
        let bFindings = reviewRecipe(bResult.recipe, bCtx, recentSkeletons);
        if (needsAutoFix(bFindings)) {
          const fixed = await attemptAutoFix(bResult.recipe, bFindings, body.model, aborter.signal);
          if (fixed) {
            bResult = {
              recipe: fixed.recipe,
              clamped: [...bResult.clamped, ...fixed.clamped],
              improvementNotes: bResult.improvementNotes,
              brewRationale: bResult.brewRationale,
            };
            bFindings = reviewRecipe(bResult.recipe, bCtx, recentSkeletons);
          }
        }
        // B 同样过 clamp（toClampedRecipe 内已钳位）与时长警告：warning 并入 result 事件
        const bWarning = durationWarning(bResult.recipe);
        sendEvent(res, {
          type: "variant",
          stage: "result",
          ok: true,
          recipe: bResult.recipe,
          clamped: bResult.clamped,
          ...(bResult.improvementNotes ? { improvementNotes: bResult.improvementNotes } : {}),
          ...(bResult.brewRationale ? { brewRationale: bResult.brewRationale } : {}),
          ...(bFindings.length > 0 ? { reviewFindings: bFindings } : {}),
          ...(allSourceUrls.size > 0 ? { refUrls: [...allSourceUrls] } : {}),
          ...(bWarning ? { warning: bWarning } : {}),
        });
      } catch (err) {
        if (shouldEmitVariantFailure(abortKind, res.writableEnded)) {
          try {
            sendEvent(res, variantFailEvent(err));
          } catch {
            /* 连接可能已断开 */
          }
        }
      }
    }
    clearTimeout(generationTimer);
    sendEvent(res, { type: "done" });
    res.end();
  } catch (err) {
    if (aborter.signal.aborted) {
      endAbortedGeneration();
      return;
    }
    try {
      sendEvent(res, { type: "error", message: (err as Error).message ?? String(err) });
      sendEvent(res, { type: "done" });
      res.end();
    } catch {
      /* 连接可能已断开 */
    }
  }
});

export default generateRouter;

/**
 * 是否需要把自由文本豆信息自动落档（任务 #65）：
 * 仅当请求未携带 beanId 且 beans 文本非空时才落档。
 * beanId 是用户明确选择豆档案的意图；即使该档案刚被其他页面修改、当前读取暂未命中，
 * 也不得把其上下文文本再次当作自由输入建档。
 */
export function shouldPersistFreeTextBean(
  beansText: unknown,
  selectedBeanId: unknown,
): beansText is string {
  const hasSelectedBean = typeof selectedBeanId === "string" && selectedBeanId.trim() !== "";
  return !hasSelectedBean && typeof beansText === "string" && beansText.trim() !== "";
}
