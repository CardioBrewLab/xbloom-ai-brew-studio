/**
 * 前端与后端 API 的封装（全参数契约）：
 * - get/post/del：普通 JSON 请求
 * - streamGenerate：fetch + ReadableStream 手动解析 SSE（不使用 EventSource）
 * 所有类型严格按统一 API 契约声明。
 */
import { RecipeSchema, type Recipe } from "./recipe-schema.js";
import { TASTE_TAGS } from "../../../shared/dist/data-schema.js";
import {
  createClientPasswordParams,
  deriveClientPasswordProof,
  type ClientPasswordParams,
} from "@xbloom/shared/password-auth";
import type { LlmSettingsUpdateInput } from "./llm-settings.js";
import type { GenerationMode } from "./generation-mode.js";
import type { XhsQrFailureKind } from "./xhs-qr.js";
import { backendConnectionErrorMessage } from "./companion.js";
import { createAbortScope } from "./abort.js";

// ---------------------------------------------------------------------------
// 契约类型
// ---------------------------------------------------------------------------

export interface ServerConfig {
  models: string[];
  defaultModel: string;
  limits: Record<string, unknown>;
  /** 云端区域：cn = 中国区，global = 全球区（后端 /api/config 返回） */
  cloudRegion?: "cn" | "global";
  deployment?: "cloudflare" | "local" | string;
  authenticated?: boolean;
  modelConfigured?: boolean;
}

export type ModelProvider = "openai-compatible" | "anthropic" | "gemini";

export interface ModelProviderPreset {
  id: "openai" | "anthropic" | "kimi" | "deepseek" | "qwen" | "gemini" | "custom";
  label: string;
  provider: ModelProvider;
  baseUrl: string;
  domestic: boolean;
  hint: string;
}

export interface AuthUser {
  id: string;
  loginName: string;
  displayName: string;
}

export interface AuthSession {
  ok: boolean;
  authenticated: boolean;
  user: AuthUser | null;
}

/** 本机模型设置的公开形态；服务端只返回密钥配置状态，不返回密钥正文。 */
export interface LlmSettingsPublic {
  provider?: ModelProvider;
  baseUrl: string;
  model: string;
  fallbackModel: string;
  thirdModel: string;
  apiKeyConfigured: boolean;
  fallbackApiKeyConfigured: boolean;
  source: "environment" | "local" | "user" | "unconfigured";
  localOverridePresent: boolean;
  localOverrideValid: boolean;
  updatedAt?: string;
}

export interface SavedRecipe {
  id: string;
  createdAt: string;
  recipe: Recipe;
  /** 冲煮反馈日志（含 id/resultingRecipeId 追溯字段） */
  feedbacks?: SavedFeedback[];
  /** 版本链：上一版配方 id */
  parentId?: string;
  /** 版本号（服务端推导 = parent.version + 1） */
  version?: number;
  /** 触发本版本的 feedback 条目 id */
  sourceFeedbackId?: string;
  /** 本轮调整理由（LLM changeNotes） */
  changeNotes?: string;
  /** 生成阶段联网调研的来源 URL 列表（任务 #35，旧条目无此字段属正常） */
  refUrls?: string[];
  /** 生成时用户输入的豆信息自由文本原文（任务 #35） */
  beanSnapshot?: string;
  /** 联网调研提炼后的摘要文本（任务 #35） */
  researchSummary?: string;
  /** 生成后自动审查的遗留 findings（任务 #36，旧条目无此字段属正常） */
  reviewFindings?: ReviewFinding[];
  /** 生成时所选豆库豆档案 ID（任务 #50 关联落库，旧条目无此字段属正常） */
  beanId?: string;
  /** 用户粘贴的烘焙商参考冲泡方案原文（任务 #57，旧条目无此字段属正常） */
  roasterReference?: string;
  /** 双方案对比（任务 #62）："original" = 烘焙师原版，"improved" = AI 改进版 */
  variant?: "original" | "improved";
  /** 改进版配对的原版配方 id（任务 #62，仅改进版条目存在） */
  pairId?: string;
  /** 方案解读（任务 #72）：关键参数 param/choice/basis 结构化解读，旧条目无此字段属正常 */
  brewRationale?: BrewRationaleItem[];
  /** 仅在官方云端回读确认后持久化。 */
  cloudTableId?: string;
}

export interface CloudStatus {
  reachable: boolean;
  loggedIn: boolean;
  proxyUsed: boolean;
  message: string;
  /** 云端版需要先登录工作台账号，才能按用户隔离保存 xBloom 凭据。 */
  workspaceLoginRequired?: boolean;
  /** 后端 .env 配置了凭据，具备自动登录能力 */
  autoLogin?: boolean;
  /** Hosted 版只保存加密会话令牌，登录密码不落库。 */
  passwordStored?: boolean;
  /** 当前登录账号邮箱（已登录时返回） */
  email?: string;
  region?: "cn" | "global";
}

export interface BleStatus {
  available: boolean;
  connected: boolean;
  ready: boolean;
  backend: "python-bleak" | "noble";
  device?: string;
  reason?: string;
  lastError?: string;
  supportsRemoteStart: boolean;
  guidance: string;
}

export interface Capabilities {
  generate: boolean;
  cloud: boolean;
  ble: boolean;
}

/** 豆档案（豆库 CRUD + 豆仓库存，任务 #50） */
export interface Bean {
  id: string;
  name: string;
  roaster?: string;
  origin?: string;
  process?: string;
  varietal?: string;
  roastLevel?: string;
  tastingNotes?: string;
  /** 豆信息自由文本原文（可选） */
  rawDescription?: string;
  /** 剩余库存克数；undefined = 未录入库存 */
  stockGrams?: number;
  /** 烘焙日期 YYYY-MM-DD */
  roastDate?: string;
  /** 养豆期天数（烘焙后多久进入适饮窗口） */
  restDays?: number;
  /** 适饮高峰期天数（烘焙后计）；缺省语义 45 */
  peakWindowDays?: number;
}

/** 豆推荐条目（GET /api/beans/recommend，任务 #50） */
export interface BeanRecommendation {
  beanId: string;
  beanName: string;
  /** 综合评分 0-1 */
  score: number;
  /** 推荐理由 2-4 条 */
  reasons: string[];
  /** LLM 润色后的推荐语（存在时优先展示；无则纯规则形态） */
  summary?: string;
}

/** 豆信息粘贴 AI 解析结果（任务 #118）：未知字段一律 null，tastingNotes 为数组 */
export interface ParsedBeanInfo {
  name: string | null;
  roaster: string | null;
  origin: string | null;
  /** 庄园 / 处理厂（应用映射时并入产地展示） */
  estate: string | null;
  process: string | null;
  varietal: string | null;
  /** 归一为 浅焙/中浅焙/中焙/中深焙/深焙 之一，无法识别为 null */
  roastLevel: string | null;
  tastingNotes: string[];
  /** 海拔表述原文（如 1900-2100m） */
  altitude: string | null;
  /** 其余备注 */
  notes: string | null;
}

/** 冲煮反馈（闭环调参） */
export interface BrewFeedback {
  rating: number; // 1-5
  taste: string[]; // 五味型 + 三枚风味维度标签
  note?: string;
}

/** 已落盘的反馈条目（服务端补 id/createdAt，可回填 resultingRecipeId） */
export interface SavedFeedback extends BrewFeedback {
  id?: string;
  createdAt: string;
  /** 该反馈驱动的调参新版本配方 id */
  resultingRecipeId?: string;
}

export { TASTE_TAGS };

/** 云端账号配方条目 */
export interface CloudRecipeEntry {
  tableId: string;
  theName: string;
  /** 中国区必须使用服务端返回的签名分享链接；全球区也优先使用。 */
  shareUrl?: string;
  [key: string]: unknown;
}

export interface GenerateRequest {
  description: string;
  /** 生成策略：Fast=本地单案，Pro=联网单案，Max=联网三案优选并支持低分换源。 */
  mode?: GenerationMode;
  beans?: string;
  taste?: string;
  cupType?: string;
  model?: string;
  refUrls?: string[];
  /** 烘焙商参考方案原文（任务 #38）：直接粘贴的冲煮建议，后端原样注入 prompt */
  roasterReference?: string;
  /** 豆库豆档案 ID，后端带入上下文 */
  beanId?: string;
  /** 可用豆量（克，任务 #58）：可选；填写时方案按该粉量制定，留空（undefined）不发送、按 AI 推荐粉量 */
  availableDoseGrams?: number;
  /** 联网调研开关（缺省开启）：带豆信息时先联网搜索再生成 */
  research?: boolean;
  /** 反馈闭环：基于既有配方调参 */
  baseRecipe?: Recipe;
  feedback?: BrewFeedback;
  /** 基础配方在本地库的 entry id：后端据此注入该 lineage 的历史反馈 */
  baseRecipeId?: string;
  /**
   * Hosted 可由云端按当前 owner 检索小红书；本地版也可随请求提交本机调研素材。
   * Cookie 和配对令牌不进入该载荷；服务端只接收清洗后的摘要与公开来源。
   */
  researchPacket?: {
    ok: boolean;
    sources: ResearchSource[];
    summaryText: string;
    message: string;
    filtered: number;
    distilled: boolean;
    xhsLoginExpired?: boolean;
  };
}

export interface RecipeSaveOptions {
  /** Logical-write key reused after a lost response; the server returns the first committed row. */
  clientRequestId?: string;
  name?: string;
  parentId?: string;
  sourceFeedbackId?: string;
  changeNotes?: string;
  refUrls?: string[];
  beanSnapshot?: string;
  researchSummary?: string;
  reviewFindings?: ReviewFinding[];
  beanId?: string;
  roasterReference?: string;
  variant?: "original" | "improved";
  pairId?: string;
  brewRationale?: BrewRationaleItem[];
  cloudTableId?: string;
}

/** 联网调研来源（research 事件携带） */
export interface ResearchSource {
  title: string;
  url: string;
  /** 搜索引擎返回的结果摘要（任务 #94：来源列表渲染；可选，旧事件缺失不崩） */
  snippet?: string;
}

/** 小红书账号状态（任务 #83：/api/xhs/status 契约） */
export interface XhsStatus {
  ok: boolean;
  /** false = 当前部署的小红书服务未就绪（区别于掉登录） */
  online: boolean;
  loggedIn: boolean;
  nickname?: string;
  /** true = 服务在线但登录态检查本身失败（浏览器异常等），前端展示「状态未知」 */
  checkFailed?: boolean;
  /** 扫码已发起且 Browser Run 会话仍在等待确认。 */
  pendingLogin?: boolean;
  /** 待确认会话的失效时刻（毫秒时间戳）。 */
  expiresAt?: number;
  failureKind?: XhsQrFailureKind;
  message?: string;
}

/** 登录二维码（任务 #83：/api/xhs/login/qrcode 契约） */
export interface XhsQrcode {
  ok: boolean;
  online?: boolean;
  /** 当前已登录：MCP 不下发二维码，切换账号需先登出 */
  alreadyLoggedIn?: boolean;
  /** 二维码图片 data URL（image/png base64） */
  qrcode?: string;
  /** 二维码失效时刻（毫秒时间戳） */
  expiresAt?: number;
  /** 小红书登录接口返回的原生 App deeplink；手机端经官方 OIA 入口唤起。 */
  launchUrl?: string;
  hint?: string;
  failureKind?: XhsQrFailureKind;
  message?: string;
}

export interface CloudReadback {
  ok: boolean;
  message: string;
  storedSum?: number;
  expectedTotal?: number;
  allInteger?: boolean;
}

export interface CloudWriteVerification {
  state: "verified" | "mismatch" | "unverified";
  message: string;
}

export interface CloudPublishResult {
  ok: boolean;
  shareUrl: string;
  tableId: string;
  adjustments?: string[];
  readback?: CloudReadback;
  verification: CloudWriteVerification;
}

/** 自动审查单条发现（任务 #36：与后端 lib/review.ts 契约一致） */
export interface ReviewFinding {
  level: "error" | "warn";
  rule: string;
  message: string;
  suggestion: string;
}

/** AI 改进版单条参数调整说明（任务 #62：variant:result 事件携带） */
export interface ImprovementNote {
  /** 参数名（≤20 字） */
  param: string;
  /** 调整前取值（≤30 字） */
  from: string;
  /** 调整后取值（≤30 字） */
  to: string;
  /** 调整依据（≤120 字） */
  rationale: string;
  /** 预期风味收益（≤80 字） */
  expectedFlavor?: string;
}

/** 方案解读单条（任务 #72：recipe/variant:result 事件携带，保存时透传持久化） */
export interface BrewRationaleItem {
  /** 参数名（≤30 字） */
  param: string;
  /** 本方案的取值或设计（≤30 字） */
  choice: string;
  /** 选择依据（须注明来源，≤120 字） */
  basis: string;
}

/** 单个候选的评分摘要（任务 #106：candidates:picked 事件 scores 条目） */
export interface CandidateScoreSummary {
  /** 候选下标（0 起） */
  index: number;
  /** 软扣分结果（起始 100） */
  score: number;
  /** 是否命中一票否决项 */
  vetoed: boolean;
  /** 审查警告数 */
  warns: number;
  /** 参数钳位修正数 */
  clamps: number;
}

/** 获胜候选评分明细（任务 #106：recipe 事件可选字段 candidateScore） */
export interface CandidateScoreDetail extends CandidateScoreSummary {
  /** 本轮实际候选数（降 N 后可能小于初始配置） */
  n: number;
  /** 获胜候选下标 */
  winner: number;
  /** 扣分标签列表（优选明细展示） */
  deductions: string[];
  /** 自动修正改变过获胜配方时，评分对应修正前形态。 */
  postFix?: boolean;
  /** 任务 #131：调研一致性校验结果（N>1 路径携带） */
  researchConsistency?: {
    consistent: boolean;
    deviations: { param: string; value: number; researchValue: number; tolerance: number }[];
  };
}

export interface CandidateDimensionEntry {
  key: string;
  label: string;
  weight: number;
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

export interface CandidateResultEntry {
  index: number;
  status: "ok" | "failed";
  score?: number;
  vetoed?: boolean;
  vetoReasons?: string[];
  warns?: number;
  clamps?: number;
  deductions?: string[];
  dimensions?: CandidateDimensionEntry[];
  recipeSummary?: CandidateRecipeSummary;
  failReason?: string;
}

export type GenerateEvent =
  // 任务 #130：自由文本豆信息匹配到豆仓豆后，在下发 recipe 前发出；
  // 前端据此设 genMeta.beanId，使保存配方时带 beanId（修复关联断裂根因）。
  // 选中豆库豆时（beanId 已有）不发——已命中无需重复通知。
  | { type: "beanMatch"; beanId: string; beanName: string; matched: boolean }
  // variant:"improved" = 该增量属于 AI 改进版生成（任务 #62），不并入主思考流
  | { type: "reasoning"; delta: string; variant?: "improved" }
  // 载荷二选一（任务 #116）：N=1 流式增量走 delta；N>1 recipe 前补发的获胜者原始正文走 content 字段，二者至少其一
  | { type: "content"; delta?: string; content?: string; variant?: "improved" }
  | {
      type: "recipe";
      recipe: Recipe;
      clamped: string[];
      /** 调参模式的调整理由（≤60 字，LLM changeNotes） */
      changeNotes?: string;
      refUrls?: string[];
      /** 估算总时长 >3:00 的警告（不拦截，任务 #35） */
      warning?: string;
      /** 自动审查遗留 findings（任务 #36，保存时透传持久化） */
      reviewFindings?: ReviewFinding[];
      /** 方案解读（任务 #72，缺失时不下发） */
      brewRationale?: BrewRationaleItem[];
      /** 多候选择优评分明细（任务 #106，仅 N>1 时携带） */
      candidateScore?: CandidateScoreDetail;
    }
  | { type: "error"; message: string }
  | { type: "done" }
  // 多候选生成（任务 #106）：仅当候选数 N>1 时出现；N=1 不下发任何 candidates 事件
  | { type: "candidates"; stage: "start"; n: number; round?: number }
  | {
      type: "candidates";
      stage: "progress";
      done: number;
      total: number;
      result?: CandidateResultEntry;
      round?: number;
    }
  | {
      type: "candidates";
      stage: "picked";
      winner: number;
      scores: CandidateScoreSummary[];
      results?: CandidateResultEntry[];
      round?: number;
    }
  | {
      type: "review";
      stage: "start" | "findings" | "fixed";
      /** 最终（或首轮）审查发现列表 */
      findings?: ReviewFinding[];
      /** 修正前的问题清单（仅发生过自动修正时携带） */
      preFindings?: ReviewFinding[];
      /** 是否已自动修正一轮 */
      fixed?: boolean;
      /** 本次审查执行的检查维度数 */
      dimensions?: number;
    }
  | {
      type: "research";
      stage: "start" | "source" | "done";
      query?: string;
      title?: string;
      url?: string;
      /** source 阶段的搜索摘要（任务 #94：可选，后端未下发时缺失） */
      snippet?: string;
      ok?: boolean;
      message?: string;
      sources?: ResearchSource[];
      /** 被相关性过滤丢弃的低相关来源数（任务 #26） */
      filtered?: number;
      /** 注入文本是否经 LLM 提炼 */
      distilled?: boolean;
      /** 调研摘要文本（done 时携带，保存配方时透传持久化，任务 #35） */
      summary?: string;
      /** 任务 #83：小红书登录失效标记（done 时携带，前端非阻断提醒扫码续期） */
      xhsLoginExpired?: boolean;
      /** 任务 #131：重调研轮次（round>0 = 第 N 轮重调研） */
      round?: number;
    }
  // 双方案对比（任务 #62）：仅当粘贴了 roasterReference 且非调参模式时出现
  | { type: "variant"; stage: "start" }
  | ((
      | {
          stage: "result";
          ok: true;
          recipe: Recipe;
          clamped: string[];
          /** 逐条参数调整说明（param/from/to/rationale/expectedFlavor） */
          improvementNotes?: ImprovementNote[];
          /** 改进版审查遗留 findings */
          reviewFindings?: ReviewFinding[];
          /** 方案解读（任务 #72，缺失时不下发） */
          brewRationale?: BrewRationaleItem[];
          refUrls?: string[];
          warning?: string;
        }
      | { stage: "result"; ok: false; message: string }
    ) & { type: "variant" });

// ---------------------------------------------------------------------------
// 基础请求
// ---------------------------------------------------------------------------

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`服务返回了非 JSON 内容（HTTP ${res.status}）`);
  }
}

/** 保留服务端结构化失败分类，二维码弹窗可据此显示准确的恢复动作。 */
export class ApiRequestError extends Error {
  readonly failureKind?: XhsQrFailureKind;

  constructor(message: string, failureKind?: XhsQrFailureKind) {
    super(message);
    this.name = "ApiRequestError";
    this.failureKind = failureKind;
  }
}

export function xhsFailureKindFromError(error: unknown): XhsQrFailureKind | undefined {
  return error instanceof ApiRequestError ? error.failureKind : undefined;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 任务#88：云端操作超时保护。Vite 代理在后端 tsx watch 重启窗口内遇到
  // ECONNREFUSED 时只记日志、不向浏览器返回任何响应，无超时的 fetch 会永久挂起
  // （表现为发布按钮永远停在"发布中…"）。云端接口统一 60s 超时兜底。
  const isCloud = path.startsWith("/api/cloud/");
  const isXhsQr = path === "/api/xhs/login/qrcode";
  const isXhsPoll = path === "/api/xhs/login/poll";
  const timeoutMs = isCloud ? 60_000 : isXhsQr ? 25_000 : isXhsPoll ? 22_000 : 45_000;
  const abortScope = createAbortScope([init?.signal], timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      ...init,
      signal: abortScope.signal,
    });
  } catch (e) {
    if (isCloud && abortScope.timedOut()) {
      throw new Error("云端请求超过 60 秒未响应（可能后端正在热重载或网络异常），请重试");
    }
    if ((isXhsQr || isXhsPoll) && abortScope.timedOut()) {
      throw new ApiRequestError("小红书登录窗口响应超时，请稍后重试", "browser_timeout");
    }
    if (abortScope.timedOut()) {
      throw new Error("请求超过 45 秒未响应，请检查网络后重试");
    }
    throw new Error(backendConnectionErrorMessage(location.hostname));
  } finally {
    abortScope.cleanup();
  }
  if (!res.ok) {
    let msg = `请求失败（HTTP ${res.status}）`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      msg = body.error ?? body.message ?? msg;
    } catch {
      // 保留默认消息
    }
    throw new Error(msg);
  }
  const body = await parseJson<T>(res);
  // 统一错误契约：HTTP 200 但 body.ok === false 也视为失败（服务端不改）
  if (body && typeof body === "object" && (body as { ok?: unknown }).ok === false) {
    const b = body as { message?: string; error?: string; failureKind?: XhsQrFailureKind };
    throw new ApiRequestError(b.message ?? b.error ?? "请求失败", b.failureKind);
  }
  return body;
}

async function xhsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init);
}

export const api = {
  getConfig: () => request<ServerConfig>("/api/config"),
  getStatus: () => request<{ ok: boolean; capabilities: Capabilities }>("/api/status"),

  // ---- Hosted 多用户账号；本地版可按 404 视为免账号模式 ----
  authSession: () => request<AuthSession>("/api/auth/session"),
  register: async (loginName: string, password: string) => {
    const credential = await deriveClientPasswordProof(password, createClientPasswordParams());
    return request<AuthSession>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        loginName,
        passwordProof: credential.proof,
        passwordSalt: credential.salt,
        passwordIterations: credential.iterations,
        passwordScheme: credential.scheme,
      }),
    });
  },
  login: async (loginName: string, password: string) => {
    const params = await request<ClientPasswordParams & { ok: boolean }>(
      "/api/auth/password-params",
      { method: "POST", body: JSON.stringify({ loginName }) },
    );
    const credential = await deriveClientPasswordProof(password, params);
    return request<AuthSession>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ loginName, passwordProof: credential.proof }),
    });
  },
  logout: () => request<AuthSession>("/api/auth/logout", { method: "POST" }),

  // ---- 本机模型接口设置（不改变服务地址或第三方登录态） ----
  getLlmSettings: () =>
    request<{ ok: boolean; settings: LlmSettingsPublic }>("/api/settings/llm").then(
      (result) => result.settings,
    ),
  updateLlmSettings: (input: LlmSettingsUpdateInput) =>
    request<{
      ok: boolean;
      settings: LlmSettingsPublic;
      test?: { model: string; latencyMs: number };
    }>("/api/settings/llm", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  resetLlmSettings: () =>
    request<{ ok: boolean; settings: LlmSettingsPublic }>("/api/settings/llm", {
      method: "DELETE",
    }).then((result) => result.settings),
  testLlmSettings: () =>
    request<{ ok: boolean; model: string; latencyMs: number }>("/api/settings/llm/test", {
      method: "POST",
    }),
  testLlmDraft: (input: LlmSettingsUpdateInput) =>
    request<{ ok: boolean; provider?: ModelProvider; model: string; latencyMs: number }>(
      "/api/settings/llm/test",
      { method: "POST", body: JSON.stringify(input) },
    ),
  detectLlmModels: (input: Pick<LlmSettingsUpdateInput, "provider" | "baseUrl" | "apiKey">) =>
    request<{
      ok: boolean;
      provider: ModelProvider;
      baseUrl: string;
      models: string[];
      latencyMs: number;
    }>("/api/settings/llm/detect", { method: "POST", body: JSON.stringify(input) }),
  listLlmProviders: () =>
    request<{ ok: boolean; providers: ModelProviderPreset[] }>("/api/settings/llm/providers").then(
      (result) => result.providers,
    ),

  // ---- 本地配方库 ----
  listRecipes: () => request<{ ok: boolean; recipes: SavedRecipe[] }>("/api/recipes"),
  saveRecipe: (recipe: Recipe, opts?: RecipeSaveOptions) =>
    request<{ ok: boolean; id: string; version?: number; warning?: string }>("/api/recipes", {
      method: "POST",
      body: JSON.stringify({ recipe, ...opts }),
    }),
  deleteRecipe: (id: string) =>
    request<{ ok: boolean }>(`/api/recipes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** 冲煮日志反馈闭环（返回 feedbackId 供版本链追溯） */
  postFeedback: (id: string, feedback: BrewFeedback) =>
    request<{ ok: boolean; feedbackId?: string }>(
      `/api/recipes/${encodeURIComponent(id)}/feedback`,
      {
        method: "POST",
        body: JSON.stringify(feedback),
      },
    ),
  /** 追溯回填：把调参结果配方 id 写回对应 feedback 条目 */
  patchFeedbackResulting: (id: string, feedbackId: string, resultingRecipeId: string) =>
    request<{ ok: boolean }>(
      `/api/recipes/${encodeURIComponent(id)}/feedback/${encodeURIComponent(feedbackId)}`,
      { method: "PATCH", body: JSON.stringify({ resultingRecipeId }) },
    ),
  /**
   * 手动关联配方到豆档案（任务 #130）：beanId 非空则关联（后端校验豆存在），
   * 空串则解除关联。
   */
  linkRecipeBean: (recipeId: string, beanId: string) =>
    request<{ ok: boolean }>(`/api/recipes/${encodeURIComponent(recipeId)}`, {
      method: "PATCH",
      body: JSON.stringify({ beanId }),
    }),
  bindRecipeCloud: (recipeId: string, cloudTableId: string) =>
    request<{ ok: boolean }>(`/api/recipes/${encodeURIComponent(recipeId)}`, {
      method: "PATCH",
      body: JSON.stringify({ cloudTableId }),
    }),
  bindRecipePair: (recipeId: string, pairId: string, name?: string) =>
    request<{ ok: boolean }>(`/api/recipes/${encodeURIComponent(recipeId)}`, {
      method: "PATCH",
      body: JSON.stringify({ pairId, variant: "improved", ...(name ? { name } : {}) }),
    }),

  // ---- 豆库 ----
  listBeans: () => request<{ ok: boolean; beans: Bean[] }>("/api/beans"),
  // 新建态不会发送 null（后端 schema 也不接受 null），类型放宽仅为与编辑态共用同一 fields 对象
  createBean: (
    bean: Omit<Bean, "id" | "roastDate" | "stockGrams" | "restDays" | "peakWindowDays"> & {
      roastDate?: string | null;
      stockGrams?: number | null;
      restDays?: number | null;
      peakWindowDays?: number | null;
    },
  ) =>
    request<{ ok: boolean; id: string }>("/api/beans", {
      method: "POST",
      body: JSON.stringify(bean),
    }),
  deleteBean: (id: string) =>
    request<{ ok: boolean }>(`/api/beans/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /**
   * 豆档案部分更新（白名单字段子集；任务 #50）。
   * roastDate/stockGrams/restDays/peakWindowDays 允许显式 null = 清空该字段（任务 #65），
   * 区分「未触碰（undefined）」与「清空（null）」。
   */
  patchBean: (
    id: string,
    patch: Partial<
      Omit<Bean, "id" | "roastDate" | "stockGrams" | "restDays" | "peakWindowDays">
    > & {
      roastDate?: string | null;
      stockGrams?: number | null;
      restDays?: number | null;
      peakWindowDays?: number | null;
    },
  ) =>
    request<{ ok: boolean; bean: Bean }>(`/api/beans/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  /** 冲一杯库存扣减（任务 #50）：grams(0,200]；无库存豆后端返回 400 */
  consumeBean: (id: string, body: { grams: number; recipeId?: string; doseGrams?: number }) =>
    request<{ ok: boolean; remainingGrams: number; brewsLeft: number; warning?: string }>(
      `/api/beans/${encodeURIComponent(id)}/consume`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** 豆推荐 Top3：LLM 话术 + 规则兜底（fallback=true 即纯规则形态；任务 #50） */
  recommendBeans: () =>
    request<{ ok: boolean; recommendations: BeanRecommendation[]; fallback: boolean }>(
      "/api/beans/recommend",
    ),

  // ---- 云端 ----
  cloudStatus: () => request<CloudStatus>("/api/cloud/status"),
  cloudLogin: (email: string, password: string, region?: "cn" | "global") =>
    request<{ ok: boolean; memberId: string; email: string }>("/api/cloud/login", {
      method: "POST",
      body: JSON.stringify({ email, password, ...(region ? { region } : {}) }),
    }),
  cloudLogout: () => request<{ ok: boolean }>("/api/cloud/logout", { method: "POST" }),
  cloudPublish: (recipe: Recipe, name?: string) =>
    request<CloudPublishResult>("/api/cloud/publish", {
      method: "POST",
      body: JSON.stringify({ recipe, name }),
    }),
  /** 发布前预演：返回对齐官方 ratio 0.1 步进后实际上传的总水量/分段与调整说明（任务 #39） */
  cloudPublishPreview: (recipe: Recipe, name?: string) =>
    request<{
      ok: boolean;
      adjustments: string[];
      alignedGrandWater: number;
      cloudRatio: number;
      pours: { theName?: string; volume: number }[];
      /** 预演校验失败时的错误信息（任务 #55，前端需显式降级提示） */
      message?: string;
    }>("/api/cloud/publish-preview", {
      method: "POST",
      body: JSON.stringify({ recipe, name }),
    }),
  cloudRecipes: () => request<{ ok: boolean; recipes: CloudRecipeEntry[] }>("/api/cloud/recipes"),
  /** 拉取分享/云端配方全量详情（免登录），支持完整官方分享链接或 shareId */
  cloudDetail: (shareId: string) =>
    request<{ ok: boolean; recipe: Recipe; raw: Record<string, unknown> }>(
      `/api/cloud/detail/${encodeURIComponent(shareId)}`,
    ),
  cloudUpdateRecipe: (tableId: string, patch: Record<string, unknown>) =>
    request<CloudPublishResult>(`/api/cloud/recipes/${encodeURIComponent(tableId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  cloudVerifyRecipe: (tableId: string) =>
    request<{
      ok: boolean;
      readback: CloudReadback;
      verification: CloudWriteVerification;
    }>(`/api/cloud/verify/${encodeURIComponent(tableId)}`, { method: "POST" }),
  cloudDeleteRecipe: (tableId: string) =>
    request<{ ok: boolean }>(`/api/cloud/recipes/${encodeURIComponent(tableId)}`, {
      method: "DELETE",
    }),

  // ---- 小红书账号（任务 #83） ----
  /** 登录态探活：online:false = 当前部署的小红书服务未就绪（区别于掉登录） */
  xhsStatus: () => xhsRequest<XhsStatus>("/api/xhs/status"),
  /** 获取登录二维码（base64 data URL + 失效时刻）；alreadyLoggedIn 时需先登出切号 */
  xhsQrcode: () => xhsRequest<XhsQrcode>("/api/xhs/login/qrcode", { method: "POST" }),
  /** 扫码确认轮询（前端 2-3s 间隔，二维码过期自动停） */
  xhsPoll: () => xhsRequest<XhsStatus>("/api/xhs/login/poll"),
  /** 登出重置登录态（切换账号前置） */
  xhsLogout: () =>
    xhsRequest<{ ok: boolean; message?: string }>("/api/xhs/logout", { method: "POST" }),
  /** 扫码风控兜底（任务 #97）：粘贴浏览器 Cookie 导入登录，后端写入后立即验证 */
  xhsCookieImport: (cookie: string) =>
    xhsRequest<XhsStatus & { message?: string }>("/api/xhs/login/cookie-import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookie }),
    }),

  // ---- BLE ----
  bleStatus: () => request<BleStatus>("/api/ble/status"),
  bleConnect: () =>
    request<{ ok: boolean; found?: boolean; device?: string; discoveredCount?: number }>(
      "/api/ble/connect",
      { method: "POST" },
    ),
  bleBrew: (recipe: Recipe) =>
    request<{
      ok: boolean;
      loaded?: boolean;
      requiresMachineConfirmation?: boolean;
      message?: string;
      warnings?: string[];
    }>("/api/ble/brew", {
      method: "POST",
      body: JSON.stringify({ recipe, confirmSafety: true }),
    }),
  bleStop: () => request<{ ok: boolean }>("/api/ble/stop", { method: "POST" }),
};

// ---------------------------------------------------------------------------
// 豆信息粘贴 AI 智能解析归类（任务 #118）：普通 fetch，非 SSE
// ---------------------------------------------------------------------------

export interface ParseBeanInfoResult {
  ok: boolean;
  parsed?: ParsedBeanInfo;
  error?: string;
}

/**
 * POST /api/beans/parse：把混乱豆信息文本交给 AI 归类为结构化字段。
 * 后端约定结构化错误（HTTP 200 + ok:false），不走 request<T> 的 ok:false 抛错路径，
 * 由调用方（BeanForm 状态机）自行分流 done / error 态。
 */
export async function parseBeanInfo(text: string): Promise<ParseBeanInfoResult> {
  const abortScope = createAbortScope([], 45_000);
  let res: Response;
  try {
    res = await fetch("/api/beans/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: abortScope.signal,
    });
  } catch {
    return {
      ok: false,
      error: abortScope.timedOut()
        ? "豆信息解析等待超时，请稍后重试"
        : backendConnectionErrorMessage(location.hostname),
    };
  } finally {
    abortScope.cleanup();
  }
  try {
    const body = (await res.json()) as ParseBeanInfoResult;
    if (res.ok && body.ok === true && body.parsed) return body;
    return { ok: false, error: body.error ?? `解析失败（HTTP ${res.status}）` };
  } catch {
    return { ok: false, error: `服务返回了非 JSON 内容（HTTP ${res.status}）` };
  }
}

// ---------------------------------------------------------------------------
// SSE 流式生成（fetch + ReadableStream 手动解析）
// ---------------------------------------------------------------------------

export interface StreamCallbacks {
  onEvent: (event: GenerateEvent) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * SSE 是外部输入。先做运行时校验再进入 React 状态机，避免残缺 recipe 触发结果区白屏。
 * 这里校验会被页面实际读取的字段；额外字段保持向后兼容。
 */
export function parseGenerateEvent(value: unknown): GenerateEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("事件缺少 type");
  }
  switch (value.type) {
    case "done":
      return { type: "done" };
    case "error":
      if (typeof value.message !== "string" || !value.message.trim())
        throw new Error("error 事件缺少 message");
      return value as unknown as GenerateEvent;
    case "reasoning":
      if (typeof value.delta !== "string") throw new Error("reasoning 事件缺少 delta");
      return value as unknown as GenerateEvent;
    case "content":
      if (typeof value.delta !== "string" && typeof value.content !== "string")
        throw new Error("content 事件缺少正文");
      return value as unknown as GenerateEvent;
    case "beanMatch":
      if (
        typeof value.beanId !== "string" ||
        typeof value.beanName !== "string" ||
        typeof value.matched !== "boolean"
      ) {
        throw new Error("beanMatch 事件字段不完整");
      }
      return value as unknown as GenerateEvent;
    case "recipe": {
      const recipe = RecipeSchema.safeParse(value.recipe);
      if (
        !recipe.success ||
        !Array.isArray(value.clamped) ||
        !value.clamped.every((item) => typeof item === "string")
      ) {
        throw new Error("recipe 事件字段不完整");
      }
      return {
        ...(value as unknown as Extract<GenerateEvent, { type: "recipe" }>),
        recipe: recipe.data,
      };
    }
    case "research":
      if (!(["start", "source", "done"] as const).includes(value.stage as never))
        throw new Error("research stage 无效");
      return value as unknown as GenerateEvent;
    case "review":
      if (!(["start", "findings", "fixed"] as const).includes(value.stage as never))
        throw new Error("review stage 无效");
      return value as unknown as GenerateEvent;
    case "candidates":
      if (!(["start", "progress", "picked"] as const).includes(value.stage as never))
        throw new Error("candidates stage 无效");
      return value as unknown as GenerateEvent;
    case "variant":
      if (value.stage === "start") return value as unknown as GenerateEvent;
      if (value.stage !== "result" || typeof value.ok !== "boolean")
        throw new Error("variant 事件字段不完整");
      if (value.ok) {
        const recipe = RecipeSchema.safeParse(value.recipe);
        if (!recipe.success || !Array.isArray(value.clamped))
          throw new Error("variant result 配方不完整");
        return { ...value, recipe: recipe.data } as unknown as GenerateEvent;
      }
      if (typeof value.message !== "string") throw new Error("variant 失败事件缺少 message");
      return value as unknown as GenerateEvent;
    default:
      throw new Error(`未知生成事件：${value.type}`);
  }
}

/**
 * 调用 POST /api/generate 并逐事件回调。
 * 兼容两种后端行为：
 * 1. text/event-stream：逐行解析 `data: JSON`；
 * 2. 非 SSE 响应（如后端降级为一次性 JSON）：整体按 recipe 事件处理。
 */
export async function streamGenerate(
  payload: GenerateRequest,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const watchdog = new AbortController();
  const abortScope = createAbortScope([signal, watchdog.signal]);
  const totalTimer = setTimeout(() => watchdog.abort(new Error("生成总时长超过 190 秒")), 190_000);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touchIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => watchdog.abort(new Error("生成流超过 75 秒没有新进度")), 75_000);
  };
  const clearWatchdogs = (): void => {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    abortScope.cleanup();
  };
  touchIdleTimer();
  let res: Response;
  try {
    res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: abortScope.signal,
    });
  } catch (err) {
    clearWatchdogs();
    if (signal?.aborted) return;
    if (watchdog.signal.aborted) {
      callbacks.onError("生成等待时间过长，已保留当前页面状态；请重试本次请求");
      callbacks.onDone();
      return;
    }
    if ((err as Error).name === "AbortError") return;
    callbacks.onError(backendConnectionErrorMessage(location.hostname));
    callbacks.onDone();
    return;
  }

  if (!res.ok) {
    clearWatchdogs();
    let msg = `生成失败（HTTP ${res.status}）`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      msg = body.error ?? body.message ?? msg;
    } catch {
      // 保留默认消息
    }
    callbacks.onError(msg);
    callbacks.onDone();
    return;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    clearWatchdogs();
    try {
      const body = (await res.json()) as { recipe?: Recipe; clamped?: string[] };
      if (body.recipe) {
        callbacks.onEvent({ type: "recipe", recipe: body.recipe, clamped: body.clamped ?? [] });
      } else {
        callbacks.onError("后端返回了意料之外的响应格式");
      }
    } catch {
      callbacks.onError("后端返回了意料之外的响应格式");
    }
    callbacks.onDone();
    return;
  }

  if (!res.body) {
    clearWatchdogs();
    callbacks.onError("浏览器不支持流式响应");
    callbacks.onDone();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedDone = false;
  let protocolError = false;

  const dispatch = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const json = line.slice(5).trim();
    if (!json) return;
    let event: GenerateEvent;
    try {
      event = parseGenerateEvent(JSON.parse(json));
    } catch {
      protocolError = true;
      callbacks.onError("生成流返回了不完整的数据，请重试");
      return;
    }
    try {
      if (event.type === "done") receivedDone = true;
      callbacks.onEvent(event);
    } catch {
      protocolError = true;
      callbacks.onError("页面处理生成结果时发生异常，请重试");
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touchIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) dispatch(line);
      if (protocolError) {
        await reader.cancel();
        break;
      }
    }
    if (!protocolError) {
      buffer += decoder.decode();
      for (const line of buffer.split(/\r?\n/)) dispatch(line);
    }
  } catch (err) {
    // 用户主动取消：静默退出，不派发任何合成事件（避免过期流污染新状态）
    if (signal?.aborted) {
      clearWatchdogs();
      return;
    }
    protocolError = true;
    callbacks.onError(
      watchdog.signal.aborted
        ? "生成等待时间过长，已保留当前页面状态；请重试本次请求"
        : "流式连接中断，请重试",
    );
  }

  clearWatchdogs();
  if (!receivedDone && !protocolError)
    callbacks.onError("生成连接提前结束，未收到完成确认，请重试");
  callbacks.onDone();
}
