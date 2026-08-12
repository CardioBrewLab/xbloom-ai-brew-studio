import {
  extractJsonObject,
  hostedRecipeFingerprint,
  hostedRecipesAreDistinct,
  hostedRecipeSummary,
  normalizeRecipeWithReport,
  scoreHostedRecipe,
  type HostedRecipe,
} from "./recipe.ts";
import { generateModelText } from "../../shared/src/model-provider.ts";
import {
  BEAN_EXTRACTION_SYSTEM_PROMPT,
  beanExtractionUserPrompt,
  parseBeanExtractionOutput,
  type BeanExtractionResult,
} from "../../shared/src/bean-extraction.ts";
import {
  BeanInputSchema,
  BeanPatchSchema,
  FeedbackInputSchema,
  MAX_FEEDBACKS_PER_RECIPE,
} from "../../shared/src/data-schema.ts";
import { handleAuthRoute, resolveIdentity, type AuthUser, type RequestIdentity } from "./auth.ts";
import {
  handleModelSettingsRoute,
  modelConnectionForUser,
  publicModelSettings,
  type ModelSettingsEnv,
} from "./model-settings.ts";
import { generationQuotaSubjects, sameOriginMutation } from "./session.ts";
import { handleXbloomRoute } from "./xbloom-cloud.ts";
import { handleXhsBrowserRoute, researchXhsWithBrowser } from "./xhs-browser.ts";
import { createSseResponse, type SseSender } from "./sse.ts";
import {
  HOSTED_BEAN_PARSE_TOTAL_BUDGET_MS,
  HOSTED_MAX_TOTAL_BUDGET_MS,
  HOSTED_SINGLE_TOTAL_BUDGET_MS,
} from "./hosted-budgets.ts";

export interface Env extends ModelSettingsEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_SESSION_SECRET: string;
  APP_PASSWORD_PEPPER: string;
  APP_DATA_ENCRYPTION_KEY?: string;
  EDGE_PROXY_SECRET?: string;
  BROWSER?: import("@cloudflare/puppeteer").BrowserWorker;
  XHS_BROWSER_PROFILE?: string;
  XHS_BROWSER_QR_DAILY_LIMIT?: string;
  XHS_BROWSER_SEARCH_DAILY_LIMIT?: string;
  XHS_BROWSER_QR_OWNER_DAILY_LIMIT?: string;
  XHS_BROWSER_SEARCH_OWNER_DAILY_LIMIT?: string;
  XHS_RESEARCH_CACHE_TTL_SECONDS?: string;
  HOSTED_ITEM_OWNER_HOURLY_LIMIT?: string;
  HOSTED_ITEM_NETWORK_HOURLY_LIMIT?: string;
  HOSTED_ITEM_GLOBAL_HOURLY_LIMIT?: string;
  HOSTED_ITEM_OWNER_STORAGE_LIMIT?: string;
}

interface ItemRow {
  id: string;
  created_at: string;
  json: string;
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "strict-transport-security": "max-age=31536000",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      ...headers,
    },
  });

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:8787 http://localhost:8787",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

function securedResponse(response: Response, includeDocumentPolicy = false): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  headers.set("strict-transport-security", "max-age=31536000");
  headers.set("x-frame-options", "DENY");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (includeDocumentPolicy) headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function trustedEdgeProxy(request: Request, env: Env): boolean {
  const expected = env.EDGE_PROXY_SECRET?.trim() ?? "";
  const supplied = request.headers.get("x-xbloom-proxy-secret")?.trim() ?? "";
  if (expected.length < 32 || !constantTimeTextEqual(supplied, expected)) return false;
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;

  const forwardedHost = request.headers.get("x-forwarded-host")?.trim() ?? "";
  const forwardedProto = request.headers.get("x-forwarded-proto")?.trim().toLowerCase() ?? "";
  const origin = request.headers.get("origin")?.trim() ?? "";
  if (!forwardedHost || forwardedProto !== "https" || !origin) return false;
  try {
    const forwardedOrigin = new URL(`https://${forwardedHost}`);
    if (forwardedOrigin.host !== forwardedHost.toLowerCase()) return false;
    return origin === forwardedOrigin.origin;
  } catch {
    return false;
  }
}

const MAX_REQUEST_BODY_BYTES = 262_144;

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("请求体超过 256KB");
    this.name = "RequestBodyTooLargeError";
  }
}

class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

async function readRequestText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestBodyTooLargeError();
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body too large").catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function requestBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readRequestText(request, MAX_REQUEST_BODY_BYTES);
  const parsed = JSON.parse(text || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("请求体必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}

function normalizeRecipeSaveRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    normalized,
  )
    ? normalized
    : undefined;
}

async function listItems(env: Env, owner: string, kind: "recipe" | "bean"): Promise<unknown[]> {
  const result = await env.DB.prepare(
    "SELECT id, created_at, json FROM user_items WHERE owner=? AND kind=? ORDER BY created_at DESC",
  )
    .bind(owner, kind)
    .all<ItemRow>();
  return result.results.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    ...JSON.parse(row.json),
  }));
}

async function putItem(
  env: Env,
  owner: string,
  kind: "recipe" | "bean",
  id: string,
  createdAt: string,
  value: unknown,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO user_items(owner,kind,id,created_at,json) VALUES(?,?,?,?,?) ON CONFLICT(owner,kind,id) DO UPDATE SET json=excluded.json",
  )
    .bind(owner, kind, id, createdAt, JSON.stringify(value))
    .run();
}

async function mutateItem(
  env: Env,
  owner: string,
  kind: "recipe" | "bean",
  id: string,
  mutate: (value: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await env.DB.prepare(
      "SELECT json FROM user_items WHERE owner=? AND kind=? AND id=?",
    )
      .bind(owner, kind, id)
      .first<{ json: string }>();
    if (!row) return null;
    const next = mutate(JSON.parse(row.json) as Record<string, unknown>);
    const result = await env.DB.prepare(
      "UPDATE user_items SET json=? WHERE owner=? AND kind=? AND id=? AND json=?",
    )
      .bind(JSON.stringify(next), owner, kind, id, row.json)
      .run();
    if ((result.meta.changes ?? 0) === 1) return next;
  }
  throw new Error("数据正在被另一项操作更新，请重试");
}

class FeedbackLimitError extends Error {
  constructor() {
    super(`每个配方最多保留 ${MAX_FEEDBACKS_PER_RECIPE} 条反馈`);
    this.name = "FeedbackLimitError";
  }
}

function normalizedStoredRecipe(value: unknown): {
  recipe: HostedRecipe;
  clamped: string[];
  warning?: string;
} {
  try {
    const normalized = normalizeRecipeWithReport(value);
    return {
      recipe: normalized.recipe,
      clamped: normalized.clamps,
      ...(normalized.clamps.length > 0
        ? { warning: `已按安全边界调整：${normalized.clamps.join("；")}` }
        : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "字段不完整";
    throw new Error(`配方结构有误：${detail.slice(0, 240)}`);
  }
}

async function ownedBeanExists(env: Env, owner: string, beanId: unknown): Promise<boolean> {
  if (typeof beanId !== "string" || !beanId.trim()) return true;
  return Boolean(await getItem(env, owner, "bean", beanId.trim()));
}

async function insertItemIfAbsent(
  env: Env,
  owner: string,
  kind: "recipe" | "bean",
  id: string,
  createdAt: string,
  value: unknown,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "INSERT INTO user_items(owner,kind,id,created_at,json) VALUES(?,?,?,?,?) ON CONFLICT(owner,kind,id) DO NOTHING",
  )
    .bind(owner, kind, id, createdAt, JSON.stringify(value))
    .run();
  return (result.meta.changes ?? 0) === 1;
}

async function getItem(
  env: Env,
  owner: string,
  kind: "recipe" | "bean",
  id: string,
): Promise<{ createdAt: string; value: Record<string, unknown> } | null> {
  const row = await env.DB.prepare(
    "SELECT created_at, json FROM user_items WHERE owner=? AND kind=? AND id=?",
  )
    .bind(owner, kind, id)
    .first<{ created_at: string; json: string }>();
  return row
    ? { createdAt: row.created_at, value: JSON.parse(row.json) as Record<string, unknown> }
    : null;
}

function compactText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, maxLength);
}

function recipeReviewFindings(value: unknown): Array<Record<string, string>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const findings = value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        ((item as Record<string, unknown>).level === "error" ||
          (item as Record<string, unknown>).level === "warn"),
    )
    .slice(0, 20)
    .map((item) => ({
      level: String(item.level),
      rule: compactText(item.rule, 60) ?? "unknown",
      message: compactText(item.message, 300) ?? "",
      suggestion: compactText(item.suggestion, 300) ?? "",
    }));
  return findings.length ? findings : undefined;
}

function recipeBrewRationale(value: unknown): Array<Record<string, string>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const rationale = value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .map((item) => ({
      param: compactText(item.param, 30) ?? "",
      choice: compactText(item.choice, 30) ?? "",
      basis: compactText(item.basis, 160) ?? "",
    }))
    .filter((item) => item.param && item.choice && item.basis)
    .slice(0, 8);
  return rationale.length ? rationale : undefined;
}

function savedRecipeValue(
  body: Record<string, unknown>,
  recipe: HostedRecipe,
  parent: { id: string; value: Record<string, unknown> } | null,
): Record<string, unknown> {
  const refUrls = Array.isArray(body.refUrls)
    ? body.refUrls
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => {
          if (!value || value.length > 2_048) return false;
          try {
            const url = new URL(value);
            return url.protocol === "http:" || url.protocol === "https:";
          } catch {
            return false;
          }
        })
        .slice(0, 20)
    : [];
  const reviewFindings = recipeReviewFindings(body.reviewFindings);
  const brewRationale = recipeBrewRationale(body.brewRationale);
  const sourceFeedbackId = parent ? compactText(body.sourceFeedbackId, 80) : undefined;
  const pairId =
    typeof body.pairId === "string" && /^[0-9a-f-]{36}$/i.test(body.pairId.trim())
      ? body.pairId.trim()
      : undefined;
  const cloudTableId =
    typeof body.cloudTableId === "string" && /^\d{1,20}$/.test(body.cloudTableId.trim())
      ? body.cloudTableId.trim()
      : undefined;
  const beanId = compactText(body.beanId, 80);
  const parentVersion =
    parent && typeof parent.value.version === "number" && Number.isInteger(parent.value.version)
      ? parent.value.version
      : 1;

  return {
    recipe,
    ...(parent ? { parentId: parent.id, version: parentVersion + 1 } : {}),
    ...(sourceFeedbackId ? { sourceFeedbackId } : {}),
    ...(compactText(body.changeNotes, 120)
      ? { changeNotes: compactText(body.changeNotes, 120) }
      : {}),
    ...(refUrls.length ? { refUrls } : {}),
    ...(compactText(body.beanSnapshot, 2_000)
      ? { beanSnapshot: compactText(body.beanSnapshot, 2_000) }
      : {}),
    ...(compactText(body.researchSummary, 6_000)
      ? { researchSummary: compactText(body.researchSummary, 6_000) }
      : {}),
    ...(reviewFindings ? { reviewFindings } : {}),
    ...(beanId ? { beanId } : {}),
    ...(compactText(body.roasterReference, 4_000)
      ? { roasterReference: compactText(body.roasterReference, 4_000) }
      : {}),
    ...(body.variant === "original" || body.variant === "improved"
      ? { variant: body.variant }
      : {}),
    ...(pairId ? { pairId } : {}),
    ...(brewRationale ? { brewRationale } : {}),
    ...(cloudTableId ? { cloudTableId } : {}),
  };
}

async function backfillRecipeFeedback(
  env: Env,
  owner: string,
  childId: string,
  child: Record<string, unknown>,
): Promise<void> {
  const parentId = compactText(child.parentId, 80);
  const feedbackId = compactText(child.sourceFeedbackId, 80);
  if (!parentId || !feedbackId) return;
  await mutateItem(env, owner, "recipe", parentId, (current) => ({
    ...current,
    feedbacks: Array.isArray(current.feedbacks)
      ? current.feedbacks.map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
          const feedback = entry as Record<string, unknown>;
          return feedback.id === feedbackId
            ? { ...feedback, resultingRecipeId: childId }
            : feedback;
        })
      : [],
  }));
}

const HOSTED_CANDIDATE_DIRECTIONS = [
  "稳健基线：均衡、甜感、复现性优先。",
  "清晰路线：在用户目标内突出干净度、层次和风味辨识度。",
  "圆润路线：在用户目标内突出甜感、质感和余韵完整度。",
] as const;

const HOSTED_MODEL_REQUEST_TIMEOUT_MS = 60_000;
const HOSTED_MAX_CANDIDATE_BUDGET_MS = 75_000;
const HOSTED_SINGLE_CANDIDATE_BUDGET_MS = 90_000;
const HOSTED_MAX_SCORE_TARGET = 90;
const HOSTED_DIVERSITY_RETRIES = 1;

function isTransientModelError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error).toLowerCase();
  return (
    /http (408|425|429|500|502|503|504|529)\b/.test(message) ||
    message.includes("fetch failed") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("connection")
  );
}

function isRecoverableRecipeFormatError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return /模型响应中没有配方 JSON|配方不是对象|配方缺少注水段|response missing content/i.test(
    message,
  );
}

export function publicHostedFailureReason(error: unknown): string {
  const message = String((error as Error)?.message ?? error).toLowerCase();
  const status = Number(message.match(/http\s+(\d{3})/)?.[1] ?? 0);
  if (status === 400) return "模型接口未接受本次请求参数";
  if (status === 401 || status === 403) return "模型接口认证未通过";
  if (status === 404) return "模型或接口路径不存在";
  if (status === 429) return "模型接口请求较多，自动重试后仍未完成";
  if ([408, 425, 500, 502, 503, 504, 529].includes(status))
    return "模型接口暂时繁忙，自动重试后仍未完成";
  if (message.includes("timeout") || message.includes("abort")) return "模型响应超时";
  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("connection")
  )
    return "网络连接波动，自动重试后仍未完成";
  if (
    message.includes("json") ||
    message.includes("unexpected token") ||
    message.includes("response missing content")
  )
    return "模型响应格式不完整";
  return "模型接口本次未返回可用配方";
}

export function publicApiError(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RequestBodyTooLargeError) return { status: 413, message };
  if (error instanceof QuotaExceededError) return { status: 429, message };
  if (error instanceof SyntaxError) return { status: 400, message: "请求体不是有效的 JSON" };
  if (/^请先登录|登录已过期/.test(message)) return { status: 401, message };
  if (/登录尝试较多|额度已用完|次数已到/.test(message)) {
    return { status: 429, message };
  }
  if (/APP_(?:SESSION_SECRET|PASSWORD_PEPPER|DATA_ENCRYPTION_KEY)|站点尚未配置/.test(message)) {
    return { status: 503, message: "站点配置尚未完成，请联系站点维护者" };
  }
  if (
    /^(?:请填写|请求体|请求格式|账号名|账号密码|密码需要|模型 API 地址|API Key|更换接口|备用模型|主模型|分享链接|配方结构有误|配方超出|豆档案格式有误|豆档案尚未|反馈格式有误|配方更新字段|反馈更新字段|关联的豆档案|单次用豆量|缺少)/.test(
      message,
    )
  ) {
    return { status: 400, message };
  }
  if (
    /模型接口|模型响应|接口已连接|xBloom 云端|xBloom 登录|fetch failed|network|timeout/i.test(
      message,
    )
  ) {
    if (/\b(?:401|403)\b/.test(message))
      return { status: 502, message: "模型接口鉴权未通过，请检查 API Key 与账号权限" };
    if (/\b404\b/.test(message))
      return { status: 502, message: "模型接口路径或模型 ID 不存在，请重新识别模型" };
    if (/\b429\b/.test(message))
      return { status: 502, message: "模型供应商当前请求较多，请稍后重试" };
    if (/响应过大/.test(message)) return { status: 502, message: "模型接口响应过大，请缩短输出" };
    if (/不是 JSON|返回网页|响应格式/i.test(message))
      return { status: 502, message: "模型接口响应格式有误，请检查 API 地址是否包含正确版本路径" };
    if (/xBloom/.test(message))
      return { status: 502, message: "xBloom 官方服务本次未完成请求，请稍后重试" };
    return { status: 502, message: "模型接口连接本次未完成，请检查网络、地址和模型配置" };
  }
  // D1、解析和运行时细节只留在平台诊断中，避免把 SQL/堆栈透给公网客户端。
  return { status: 500, message: "服务本次未完成请求，请稍后重试" };
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error("request aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function callModelOnce(
  connection: NonNullable<Awaited<ReturnType<typeof modelConnectionForUser>>>,
  model: string,
  description: string,
  context: Record<string, unknown>,
  candidateIndex: number,
  candidateTotal: number,
  seed: number,
  avoidRecipes: HostedRecipe[],
  requestSignal: AbortSignal,
): Promise<{ recipe: HostedRecipe; clamps: string[]; model: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("model request timeout")),
    HOSTED_MODEL_REQUEST_TIMEOUT_MS,
  );
  const abortFromRequest = (): void => controller.abort(requestSignal.reason ?? "request aborted");
  if (requestSignal.aborted) abortFromRequest();
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  try {
    const content = await generateModelText(
      {
        ...connection,
        model,
        apiKey:
          model !== connection.model && connection.fallbackApiKey
            ? connection.fallbackApiKey
            : connection.apiKey,
      },
      [
        {
          role: "system",
          content:
            "你是 xBloom 手冲配方设计师。只输出一个 JSON 对象。字段必须包含 name,cupType,doseGrams,grinderSize,rpm,grandWater,pours,bypassEnabled,bypassVolume,bypassTemp,isSetGrinderSize,theColor。pours 为 1-6 段，每段含 volume,temperature,flowRate(3.0-3.5),pattern(center/circular/spiral),pausing,vibBefore,vibAfter,theName。粉量 5-18g，研磨 40-120，水温 60-95℃，各段水量之和等于总水。",
        },
        {
          role: "user",
          content:
            `${description}\n上下文：${JSON.stringify({ ...context, seed }).slice(0, 12_000)}\n` +
            (candidateTotal > 1
              ? `【MAX 候选 ${candidateIndex + 1}/${candidateTotal}】${HOSTED_CANDIDATE_DIRECTIONS[candidateIndex]}`
              : "【单案生成】优先完整遵循用户目标并保持参数可复现。") +
            `该方向服从用户明确口味与硬约束；请在研磨、水温、分段、流速或停顿上形成真实可执行差异，避免只改名称。` +
            (avoidRecipes.length > 0
              ? `\n以下方案已存在，本次至少在两项核心参数上形成差异：${JSON.stringify(avoidRecipes).slice(0, 10_000)}`
              : ""),
        },
      ],
      {
        signal: controller.signal,
        timeoutMs: HOSTED_MODEL_REQUEST_TIMEOUT_MS,
        temperature: 0.3,
        maxTokens: 3000,
      },
    );
    return {
      ...normalizeRecipeWithReport(
        extractJsonObject(content),
        description.slice(0, 32) || "AI Brew",
      ),
      model,
    };
  } finally {
    clearTimeout(timeout);
    requestSignal.removeEventListener("abort", abortFromRequest);
  }
}

async function callModel(
  connection: NonNullable<Awaited<ReturnType<typeof modelConnectionForUser>>>,
  description: string,
  context: Record<string, unknown>,
  candidateIndex: number,
  candidateTotal: number,
  seed: number,
  avoidRecipes: HostedRecipe[],
  signal: AbortSignal,
): Promise<{ recipe: HostedRecipe; clamps: string[]; model: string }> {
  let lastError: unknown;
  const models = [connection.model, connection.fallbackModel, connection.thirdModel].filter(
    (model, index, all) => Boolean(model) && all.indexOf(model) === index,
  );
  for (const model of models) {
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      try {
        return await callModelOnce(
          connection,
          model,
          description,
          context,
          candidateIndex,
          candidateTotal,
          seed,
          avoidRecipes,
          signal,
        );
      } catch (error) {
        lastError = error;
        if (signal.aborted) throw error;
        if (
          attempt < 1 &&
          (isTransientModelError(error) || isRecoverableRecipeFormatError(error))
        ) {
          await wait(350, signal);
          continue;
        }
        break;
      }
    }
  }
  throw lastError;
}

async function parseHostedBeanInfo(
  env: Env,
  user: AuthUser | null,
  sourceText: string,
  signal: AbortSignal,
): Promise<BeanExtractionResult> {
  const connection = await modelConnectionForUser(env, user);
  if (!connection) throw new Error("请先登录并完成模型连接配置");
  const models = [connection.model, connection.fallbackModel, connection.thirdModel].filter(
    (model, index, all) => Boolean(model) && all.indexOf(model) === index,
  );
  let lastError: unknown = new Error("模型响应格式不完整");
  for (const model of models) {
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      try {
        const content = await generateModelText(
          {
            ...connection,
            model,
            apiKey:
              model !== connection.model && connection.fallbackApiKey
                ? connection.fallbackApiKey
                : connection.apiKey,
          },
          [
            { role: "system", content: BEAN_EXTRACTION_SYSTEM_PROMPT },
            { role: "user", content: beanExtractionUserPrompt(sourceText) },
          ],
          { signal, timeoutMs: 45_000, temperature: 0.1, maxTokens: 900 },
        );
        const extraction = parseBeanExtractionOutput(content, sourceText);
        if (!extraction) throw new Error("bean extraction response format incomplete");
        return extraction;
      } catch (error) {
        lastError = error;
        if (signal.aborted) throw error;
        const malformed = /bean extraction response format incomplete/i.test(
          String((error as Error)?.message ?? error),
        );
        if (attempt < 1 && (malformed || isTransientModelError(error))) {
          await wait(250, signal);
          continue;
        }
        break;
      }
    }
  }
  throw lastError;
}

export interface HostedCandidateOutcome {
  index: number;
  recipe?: HostedRecipe;
  clamps?: string[];
  model?: string;
  error?: string;
}

/** 生成与桌面前端一致的 candidates SSE 契约。 */
export function hostedCandidateSelection(outcomes: HostedCandidateOutcome[]) {
  const valid = outcomes.filter(
    (outcome): outcome is HostedCandidateOutcome & { recipe: HostedRecipe } =>
      Boolean(outcome.recipe),
  );
  const ranked = valid
    .map((outcome) => ({ ...outcome, scoreReport: scoreHostedRecipe(outcome.recipe) }))
    .sort(
      (left, right) =>
        right.scoreReport.rankScore - left.scoreReport.rankScore ||
        hostedRecipeFingerprint(left.recipe).localeCompare(hostedRecipeFingerprint(right.recipe)),
    );
  if (ranked.length === 0) throw new Error(outcomes[0]?.error || "候选配方生成失败");
  const reportByIndex = new Map(ranked.map((item) => [item.index, item.scoreReport]));

  const results = outcomes.map((outcome) =>
    outcome.recipe
      ? {
          index: outcome.index,
          status: "ok" as const,
          score: reportByIndex.get(outcome.index)!.score,
          vetoed: false,
          vetoReasons: [],
          warns: 0,
          clamps: outcome.clamps?.length ?? 0,
          deductions: reportByIndex.get(outcome.index)!.deductions,
          recipeSummary: hostedRecipeSummary(outcome.recipe),
          dimensions: reportByIndex.get(outcome.index)!.dimensions,
        }
      : {
          index: outcome.index,
          status: "failed" as const,
          failReason: outcome.error || "上游模型请求未完成",
        },
  );
  const winner = ranked[0];
  return {
    winner,
    ranked,
    results,
    scores: ranked.map((item) => ({
      index: item.index,
      score: item.scoreReport.score,
      vetoed: false,
      warns: 0,
      clamps: item.clamps?.length ?? 0,
    })),
  };
}

function hostedCandidateProgress(outcome: HostedCandidateOutcome) {
  if (!outcome.recipe) {
    return {
      index: outcome.index,
      status: "failed" as const,
      failReason: outcome.error || "上游模型请求未完成",
    };
  }
  return {
    index: outcome.index,
    status: "ok" as const,
    recipeSummary: hostedRecipeSummary(outcome.recipe),
  };
}

function candidateBudgetSignal(signal: AbortSignal, candidateTotal: number): AbortSignal {
  return AbortSignal.any([
    signal,
    AbortSignal.timeout(
      candidateTotal > 1 ? HOSTED_MAX_CANDIDATE_BUDGET_MS : HOSTED_SINGLE_CANDIDATE_BUDGET_MS,
    ),
  ]);
}

async function incrementQuota(env: Env, subject: string, bucket: string): Promise<number> {
  await env.DB.prepare(
    "INSERT INTO generation_usage(owner,hour_bucket,request_count) VALUES(?,?,1) ON CONFLICT(owner,hour_bucket) DO UPDATE SET request_count=request_count+1",
  )
    .bind(subject, bucket)
    .run();
  const row = await env.DB.prepare(
    "SELECT request_count FROM generation_usage WHERE owner=? AND hour_bucket=?",
  )
    .bind(subject, bucket)
    .first<{ request_count: number }>();
  return row?.request_count ?? 0;
}

function positiveHostedLimit(value: string | undefined, fallback: number, cap: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, cap) : fallback;
}

export function hostedItemQuotaPolicy(
  env: Pick<
    Env,
    | "HOSTED_ITEM_OWNER_HOURLY_LIMIT"
    | "HOSTED_ITEM_NETWORK_HOURLY_LIMIT"
    | "HOSTED_ITEM_GLOBAL_HOURLY_LIMIT"
    | "HOSTED_ITEM_OWNER_STORAGE_LIMIT"
  >,
) {
  return {
    ownerHourlyLimit: positiveHostedLimit(env.HOSTED_ITEM_OWNER_HOURLY_LIMIT, 240, 10_000),
    networkHourlyLimit: positiveHostedLimit(env.HOSTED_ITEM_NETWORK_HOURLY_LIMIT, 600, 50_000),
    globalHourlyLimit: positiveHostedLimit(env.HOSTED_ITEM_GLOBAL_HOURLY_LIMIT, 10_000, 1_000_000),
    ownerStorageLimit: positiveHostedLimit(env.HOSTED_ITEM_OWNER_STORAGE_LIMIT, 500, 10_000),
  };
}

export async function enforceItemWriteQuota(
  env: Env,
  request: Request,
  owner: string,
  kind: "recipe" | "bean",
  createsItem = false,
): Promise<void> {
  const policy = hostedItemQuotaPolicy(env);
  if (createsItem) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM user_items WHERE owner=? AND kind=?",
    )
      .bind(owner, kind)
      .first<{ count: number | string }>();
    if (Number(row?.count ?? 0) >= policy.ownerStorageLimit) {
      throw new QuotaExceededError("当前账户的本地档案数量已达到上限");
    }
  }

  const bucket = `items:${new Date().toISOString().slice(0, 13)}`;
  const subjects = await generationQuotaSubjects(request, env.APP_SESSION_SECRET);
  const [ownerCount, networkCount, globalCount] = await Promise.all([
    incrementQuota(env, `item-owner:${owner}`, bucket),
    incrementQuota(env, `item-${subjects.network}`, bucket),
    incrementQuota(env, `item-${subjects.global}`, bucket),
  ]);
  if (ownerCount > policy.ownerHourlyLimit) {
    throw new QuotaExceededError("当前账户的写入请求过多，请稍后再试");
  }
  if (networkCount > policy.networkHourlyLimit) {
    throw new QuotaExceededError("当前网络的写入请求过多，请稍后再试");
  }
  if (globalCount > policy.globalHourlyLimit) {
    throw new QuotaExceededError("站点写入配额已用完，请稍后再试");
  }
}

async function enforceGenerationQuota(env: Env, request: Request, owner: string): Promise<void> {
  const bucket = new Date().toISOString().slice(0, 13);
  const subjects = await generationQuotaSubjects(request, env.APP_SESSION_SECRET);
  const [browserCount, networkCount, globalCount] = await Promise.all([
    incrementQuota(env, `browser:${owner}`, bucket),
    incrementQuota(env, subjects.network, bucket),
    incrementQuota(env, subjects.global, bucket),
  ]);
  if (globalCount > 500) throw new QuotaExceededError("站点本小时生成额度已用完，请稍后继续");
  if (networkCount > 60)
    throw new QuotaExceededError("当前网络本小时生成次数已到 60 次，请稍后继续");
  if (browserCount > 20)
    throw new QuotaExceededError("本浏览器本小时生成次数已到 20 次，请稍后继续");
}

interface HostedResearchPacket {
  ok: boolean;
  sources: Array<{ title: string; url: string; snippet?: string }>;
  summaryText: string;
  message: string;
  filtered: number;
  distilled: boolean;
  xhsLoginExpired?: boolean;
}

export function hostedResearchPacket(value: unknown): HostedResearchPacket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const sources = Array.isArray(source.sources)
    ? source.sources.slice(0, 8).flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const item = entry as Record<string, unknown>;
        const title = typeof item.title === "string" ? item.title.trim().slice(0, 240) : "";
        const rawUrl = typeof item.url === "string" ? item.url.trim() : "";
        let url = "";
        try {
          const parsed = new URL(rawUrl);
          if (parsed.protocol === "https:" || parsed.protocol === "http:") url = parsed.toString();
        } catch {
          // 丢弃格式有误的公开来源地址。
        }
        if (!title || !url) return [];
        const snippet =
          typeof item.snippet === "string" && item.snippet.trim()
            ? item.snippet.trim().slice(0, 600)
            : undefined;
        return [{ title, url, ...(snippet ? { snippet } : {}) }];
      })
    : [];
  const summaryText =
    typeof source.summaryText === "string" ? source.summaryText.trim().slice(0, 16_000) : "";
  const message =
    typeof source.message === "string" && source.message.trim()
      ? source.message.trim().slice(0, 500)
      : sources.length
        ? "调研资料已整理"
        : "本次未取得可用的公开资料";
  return {
    ok: source.ok === true && Boolean(summaryText || sources.length),
    sources,
    summaryText,
    message,
    filtered: Math.max(0, Math.min(1_000, Number(source.filtered) || 0)),
    distilled: source.distilled === true,
    ...(source.xhsLoginExpired === true ? { xhsLoginExpired: true } : {}),
  };
}

type HostedConnection = NonNullable<Awaited<ReturnType<typeof modelConnectionForUser>>>;
type HostedSelection = ReturnType<typeof hostedCandidateSelection>;

function emitHostedResearch(
  send: SseSender,
  mode: "fast" | "pro" | "max",
  body: Record<string, unknown>,
  description: string,
  research: HostedResearchPacket | null,
  started = false,
): void {
  if (mode === "fast") return;
  const query =
    typeof body.beans === "string" && body.beans.trim()
      ? body.beans.trim().slice(0, 500)
      : description;
  if (!started) send({ type: "research", stage: "start", query });
  for (const source of research?.sources ?? [])
    send({ type: "research", stage: "source", ...source });
  send({
    type: "research",
    stage: "done",
    ok: research?.ok ?? false,
    message:
      research?.message ??
      "本次使用豆档案、口味目标与用户提供的参考资料生成；登录小红书后可加入站内辅助检索。",
    sources: research?.sources ?? [],
    filtered: research?.filtered ?? 0,
    distilled: research?.distilled ?? false,
    ...(research?.summaryText ? { summary: research.summaryText } : {}),
    ...(research?.xhsLoginExpired ? { xhsLoginExpired: true } : {}),
  });
}

interface HostedCandidateRun {
  send: SseSender;
  clientSignal: AbortSignal;
  generationSignal: AbortSignal;
  connection: HostedConnection;
  description: string;
  body: Record<string, unknown>;
  research: HostedResearchPacket | null;
  count: number;
}

async function generateHostedCandidates(
  input: HostedCandidateRun,
): Promise<HostedCandidateOutcome[]> {
  const { send, clientSignal, generationSignal, connection, description, body, research, count } =
    input;
  if (count > 1) send({ type: "candidates", stage: "start", n: count, round: 0 });
  let done = 0;
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      let outcome: HostedCandidateOutcome;
      try {
        const generated = await callModel(
          connection,
          description,
          {
            ...body,
            candidate: index + 1,
            ...(research?.summaryText ? { researchSummary: research.summaryText } : {}),
          },
          index,
          count,
          42 + index,
          [],
          candidateBudgetSignal(generationSignal, count),
        );
        outcome = { index, ...generated };
      } catch (error) {
        if (clientSignal.aborted) throw error;
        outcome = { index, error: publicHostedFailureReason(error) };
      }
      done += 1;
      if (count > 1 && !clientSignal.aborted) {
        send({
          type: "candidates",
          stage: "progress",
          done,
          total: count,
          round: 0,
          result: hostedCandidateProgress(outcome),
        });
      }
      return outcome;
    }),
  );
}

interface HostedCandidateFollowup {
  outcomes: HostedCandidateOutcome[];
  clientSignal: AbortSignal;
  generationSignal: AbortSignal;
  connection: HostedConnection;
  description: string;
  body: Record<string, unknown>;
}

async function deduplicateHostedCandidates(
  input: HostedCandidateFollowup,
): Promise<HostedCandidateOutcome[]> {
  const outcomes = input.outcomes.map((outcome) => ({ ...outcome }));
  const accepted: HostedRecipe[] = [];
  for (const outcome of outcomes.sort((left, right) => left.index - right.index)) {
    if (!outcome.recipe) continue;
    if (accepted.every((recipe) => hostedRecipesAreDistinct(recipe, outcome.recipe!))) {
      accepted.push(outcome.recipe);
      continue;
    }

    let replacement: { recipe: HostedRecipe; clamps: string[]; model: string } | undefined;
    let replacementError: string | undefined;
    for (
      let retry = 1;
      retry <= HOSTED_DIVERSITY_RETRIES && !input.generationSignal.aborted;
      retry += 1
    ) {
      try {
        const candidate = await callModel(
          input.connection,
          input.description,
          { ...input.body, candidate: outcome.index + 1, diversityRetry: retry },
          outcome.index,
          3,
          42 + outcome.index + retry * 1_000,
          accepted,
          candidateBudgetSignal(input.generationSignal, 3),
        );
        if (accepted.some((recipe) => !hostedRecipesAreDistinct(recipe, candidate.recipe))) {
          replacementError = "方案参数重复，补发后仍未形成有效差异";
          continue;
        }
        replacement = candidate;
        break;
      } catch (error) {
        if (input.clientSignal.aborted) throw error;
        replacementError = publicHostedFailureReason(error);
      }
    }
    outcome.recipe = replacement?.recipe;
    outcome.clamps = replacement?.clamps;
    outcome.model = replacement?.model;
    outcome.error = replacement
      ? undefined
      : replacementError || "方案参数重复，本轮采用其余有效候选";
    if (replacement) accepted.push(replacement.recipe);
  }
  return outcomes.sort((left, right) => left.index - right.index);
}

function emitHostedPicked(send: SseSender, selection: HostedSelection, round: number): void {
  send({
    type: "candidates",
    stage: "picked",
    round,
    winner: selection.winner.index,
    scores: selection.scores,
    results: selection.results,
  });
}

async function refineLowestHostedCandidate(
  input: HostedCandidateFollowup & { send: SseSender; selection: HostedSelection },
): Promise<{ outcomes: HostedCandidateOutcome[]; selection: HostedSelection }> {
  const failed = input.outcomes.find((outcome) => !outcome.recipe);
  const targetIndex = failed?.index ?? input.selection.ranked.at(-1)!.index;
  const existing = input.outcomes.flatMap((outcome) => (outcome.recipe ? [outcome.recipe] : []));
  input.send({ type: "candidates", stage: "start", n: 1, round: 1 });

  let replacement: HostedCandidateOutcome;
  try {
    const generated = await callModel(
      input.connection,
      input.description,
      {
        ...input.body,
        refinementRound: 1,
        scoreTarget: HOSTED_MAX_SCORE_TARGET,
        previousBest: input.selection.winner.recipe,
        deductions: input.selection.winner.scoreReport.deductions,
      },
      targetIndex,
      3,
      2_042 + targetIndex,
      existing,
      AbortSignal.any([input.generationSignal, AbortSignal.timeout(60_000)]),
    );
    replacement = existing.every((recipe) => hostedRecipesAreDistinct(recipe, generated.recipe))
      ? { index: targetIndex, ...generated }
      : { index: targetIndex, error: "补发方案与现有候选过于接近" };
  } catch (error) {
    if (input.clientSignal.aborted) throw error;
    replacement = { index: targetIndex, error: publicHostedFailureReason(error) };
  }

  input.send({
    type: "candidates",
    stage: "progress",
    done: 1,
    total: 1,
    round: 1,
    result: hostedCandidateProgress(replacement),
  });
  if (!replacement.recipe) return { outcomes: input.outcomes, selection: input.selection };

  const outcomes = input.outcomes.map((outcome) =>
    outcome.index === targetIndex ? replacement : outcome,
  );
  return { outcomes, selection: hostedCandidateSelection(outcomes) };
}

async function generate(
  request: Request,
  env: Env,
  owner: string,
  user: AuthUser | null,
): Promise<Response> {
  const body = await requestBody(request);
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description || description.length > 4_000)
    return json({ ok: false, message: "请填写 1-4000 字的冲煮需求" }, 400);
  const connection = await modelConnectionForUser(env, user);
  if (!connection) return json({ ok: false, message: "请先登录并完成模型连接配置" }, 409);
  // 只有通过语法、业务参数和模型配置校验的请求才占用生成额度。
  await enforceGenerationQuota(env, request, owner);
  const mode = body.mode === "max" ? "max" : body.mode === "pro" ? "pro" : "fast";
  const count = mode === "max" ? 3 : 1;
  let research = mode === "fast" ? null : hostedResearchPacket(body.researchPacket);
  return createSseResponse(
    async (send, clientSignal) => {
      const totalBudget = count === 3 ? HOSTED_MAX_TOTAL_BUDGET_MS : HOSTED_SINGLE_TOTAL_BUDGET_MS;
      const generationSignal = AbortSignal.any([clientSignal, AbortSignal.timeout(totalBudget)]);
      try {
        let researchStarted = false;
        if (mode !== "fast" && !research) {
          const keyword =
            typeof body.beans === "string" && body.beans.trim()
              ? body.beans.trim().slice(0, 80)
              : description.slice(0, 80);
          send({ type: "research", stage: "start", query: keyword });
          researchStarted = true;
          research = await researchXhsWithBrowser(env, owner, keyword, generationSignal);
        }
        emitHostedResearch(send, mode, body, description, research, researchStarted);
        let outcomes = await generateHostedCandidates({
          send,
          clientSignal,
          generationSignal,
          connection,
          description,
          body,
          research,
          count,
        });
        if (count === 3) {
          outcomes = await deduplicateHostedCandidates({
            outcomes,
            clientSignal,
            generationSignal,
            connection,
            description,
            body,
          });
        }

        let selection = hostedCandidateSelection(outcomes);
        let refinementAttempted = false;
        if (count === 3) {
          emitHostedPicked(send, selection, 0);
          if (
            selection.winner.scoreReport.score < HOSTED_MAX_SCORE_TARGET &&
            !generationSignal.aborted
          ) {
            refinementAttempted = true;
            const refined = await refineLowestHostedCandidate({
              send,
              outcomes,
              selection,
              clientSignal,
              generationSignal,
              connection,
              description,
              body,
            });
            outcomes = refined.outcomes;
            selection = refined.selection;
            emitHostedPicked(send, selection, 1);
          }
        }

        const belowTarget =
          count === 3 && selection.winner.scoreReport.score < HOSTED_MAX_SCORE_TARGET;
        send({
          type: "recipe",
          recipe: selection.winner.recipe,
          clamped: selection.winner.clamps ?? [],
          model: selection.winner.model ?? connection.model,
          ...(belowTarget
            ? {
                warning: refinementAttempted
                  ? "MAX 已完成限时补发，采用当前最高分方案"
                  : "MAX 已在本轮时间预算内采用当前最高分方案",
              }
            : {}),
          ...(count === 3
            ? {
                candidateScore: {
                  n: 3,
                  winner: selection.winner.index,
                  index: selection.winner.index,
                  score: selection.winner.scoreReport.score,
                  vetoed: false,
                  warns: 0,
                  clamps: selection.winner.clamps?.length ?? 0,
                  deductions: selection.winner.scoreReport.deductions,
                },
              }
            : {}),
        });
        send({ type: "done" });
      } catch (error) {
        if (clientSignal.aborted) return;
        send({ type: "error", message: publicHostedFailureReason(error) });
        send({ type: "done" });
      }
    },
    { clientSignal: request.signal },
  );
}

export async function parseHostedBeanRequest(
  request: Request,
  env: Env,
  owner: string,
  user: AuthUser | null,
): Promise<Response> {
  const body = await requestBody(request);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 8_000)
    return json({ ok: false, error: "请填写 1-8000 字的咖啡豆信息" }, 400);
  const connection = await modelConnectionForUser(env, user);
  if (!connection) return json({ ok: false, message: "请先登录并完成模型连接配置" }, 409);
  await enforceGenerationQuota(env, request, owner);
  try {
    // EdgeOne's relay has a 120 s function ceiling. The parser may try several
    // provider models, so one shared deadline must cover the complete fallback chain.
    const beanParseSignal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(HOSTED_BEAN_PARSE_TOTAL_BUDGET_MS),
    ]);
    const extraction = await parseHostedBeanInfo(env, user, text, beanParseSignal);
    return json({ ok: true, ...extraction });
  } catch (error) {
    const raw = String((error as Error)?.message ?? error);
    const reason = raw.startsWith("请先登录")
      ? raw
      : publicHostedFailureReason(error) === "模型接口本次未返回可用配方"
        ? "模型接口本次未返回可用豆信息"
        : publicHostedFailureReason(error);
    return json({ ok: false, error: `豆信息解析未完成：${reason}` });
  }
}

async function routeApi(request: Request, env: Env, identity: RequestIdentity): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/status")
    return json({
      ok: true,
      version: "hosted-0.2.1",
      deployment: "cloudflare",
      capabilities: {
        generate: true,
        cloud: true,
        ble: false,
        auth: true,
        personalModel: true,
        xhsBrowser: Boolean(env.BROWSER && env.APP_DATA_ENCRYPTION_KEY),
      },
    });
  if (request.method === "GET" && path === "/api/config") {
    const settings = await publicModelSettings(env, identity.user);
    return json({
      models: [settings.model, settings.fallbackModel, settings.thirdModel].filter(Boolean),
      defaultModel: settings.model,
      limits: {},
      cloudRegion: "cn",
      deployment: "cloudflare",
      authenticated: Boolean(identity.user),
      modelConfigured: settings.source === "user",
    });
  }
  if (request.method === "POST" && path === "/api/generate")
    return generate(request, env, identity.owner, identity.user);

  if (request.method === "GET" && path === "/api/recipes")
    return json({ ok: true, recipes: await listItems(env, identity.owner, "recipe") });
  if (request.method === "POST" && path === "/api/recipes") {
    const body = await requestBody(request);
    if (!body.recipe) return json({ ok: false, message: "缺少 recipe" }, 400);
    const clientRequestId = normalizeRecipeSaveRequestId(body.clientRequestId);
    if (body.clientRequestId !== undefined && !clientRequestId)
      return json({ ok: false, message: "clientRequestId 格式有误" }, 400);
    const id = clientRequestId ?? crypto.randomUUID();
    let recipeInput = body.recipe;
    if (
      typeof body.name === "string" &&
      body.name.trim() &&
      recipeInput &&
      typeof recipeInput === "object" &&
      !Array.isArray(recipeInput)
    ) {
      recipeInput = { ...(recipeInput as Record<string, unknown>), name: body.name.trim() };
    }
    const normalized = normalizedStoredRecipe(recipeInput);
    const existing = clientRequestId
      ? await getItem(env, identity.owner, "recipe", clientRequestId)
      : null;
    if (existing) {
      // A previous response may have been lost after the child row committed but before
      // its parent feedback was backfilled. Idempotent retries also repair that second write.
      await backfillRecipeFeedback(env, identity.owner, id, existing.value);
      return json({
        ok: true,
        id,
        ...(existing.value.recipe ? { recipe: existing.value.recipe } : {}),
        clamped: normalized.clamped,
        ...(typeof existing.value.version === "number" ? { version: existing.value.version } : {}),
        ...(normalized.warning ? { warning: normalized.warning } : {}),
      });
    }
    const createdAt = new Date().toISOString();
    if (!(await ownedBeanExists(env, identity.owner, body.beanId)))
      return json({ ok: false, message: "关联的豆档案不存在" }, 400);
    const parentId =
      body.parentId === undefined ? undefined : normalizeRecipeSaveRequestId(body.parentId);
    if (body.parentId !== undefined && !parentId)
      return json({ ok: false, message: "parentId 格式有误" }, 400);
    const sourceFeedbackId =
      body.sourceFeedbackId === undefined
        ? undefined
        : normalizeRecipeSaveRequestId(body.sourceFeedbackId);
    if (body.sourceFeedbackId !== undefined && !sourceFeedbackId)
      return json({ ok: false, message: "sourceFeedbackId 格式有误" }, 400);
    if (sourceFeedbackId && !parentId)
      return json({ ok: false, message: "sourceFeedbackId 需要同时提供 parentId" }, 400);
    if (parentId === id) return json({ ok: false, message: "配方不能引用自身作为父版本" }, 400);
    const parentItem = parentId ? await getItem(env, identity.owner, "recipe", parentId) : null;
    if (parentId && !parentItem) return json({ ok: false, message: "父配方不存在" }, 404);
    if (
      sourceFeedbackId &&
      !(
        Array.isArray(parentItem?.value.feedbacks) &&
        parentItem.value.feedbacks.some(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>).id === sourceFeedbackId,
        )
      )
    ) {
      return json({ ok: false, message: "父配方中不存在对应反馈" }, 400);
    }
    const parent = parentItem ? { id: parentId!, value: parentItem.value } : null;
    if (sourceFeedbackId) body.sourceFeedbackId = sourceFeedbackId;
    const value = savedRecipeValue(body, normalized.recipe, parent);
    await enforceItemWriteQuota(env, request, identity.owner, "recipe", true);
    // Atomic first-write-wins: concurrent retries share one row and later payloads never overwrite it.
    const inserted = await insertItemIfAbsent(env, identity.owner, "recipe", id, createdAt, value);
    if (!inserted) {
      const persisted = await getItem(env, identity.owner, "recipe", id);
      return json({
        ok: true,
        id,
        ...(persisted?.value.recipe ? { recipe: persisted.value.recipe } : {}),
        clamped: normalized.clamped,
        ...(typeof persisted?.value.version === "number"
          ? { version: persisted.value.version }
          : {}),
        ...(normalized.warning ? { warning: normalized.warning } : {}),
      });
    }
    await backfillRecipeFeedback(env, identity.owner, id, value);
    return json({
      ok: true,
      id,
      recipe: normalized.recipe,
      clamped: normalized.clamped,
      ...(typeof value.version === "number" ? { version: value.version } : {}),
      ...(normalized.warning ? { warning: normalized.warning } : {}),
    });
  }
  const recipeMatch = path.match(/^\/api\/recipes\/([0-9a-f-]+)$/i);
  if (recipeMatch && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM user_items WHERE owner=? AND kind='recipe' AND id=?")
      .bind(identity.owner, recipeMatch[1])
      .run();
    return json({ ok: true });
  }
  if (recipeMatch && request.method === "PATCH") {
    const patch = await requestBody(request);
    const hasBeanPatch = typeof patch.beanId === "string";
    const hasCloudPatch = typeof patch.cloudTableId === "string";
    const hasPairPatch = typeof patch.pairId === "string";
    if (Number(hasBeanPatch) + Number(hasCloudPatch) + Number(hasPairPatch) !== 1)
      return json({ ok: false, message: "请只提交 beanId、cloudTableId 或 pairId 其中一项" }, 400);

    let normalizedPatch: Record<string, unknown>;
    if (hasPairPatch) {
      const pairId = String(patch.pairId).trim();
      if (
        patch.variant !== "improved" ||
        !/^[0-9a-f-]{36}$/i.test(pairId) ||
        (patch.name !== undefined &&
          (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 120)) ||
        Object.keys(patch).some((key) => !["pairId", "variant", "name"].includes(key))
      ) {
        return json({ ok: false, message: "pairId、variant 或 name 格式有误" }, 400);
      }
      normalizedPatch = {
        pairId,
        variant: "improved",
        ...(typeof patch.name === "string" ? { name: patch.name.trim() } : {}),
      };
    } else if (hasCloudPatch) {
      const cloudTableId = String(patch.cloudTableId).trim();
      if (!/^\d{1,20}$/.test(cloudTableId) || Object.keys(patch).length !== 1)
        return json({ ok: false, message: "cloudTableId 格式有误" }, 400);
      normalizedPatch = { cloudTableId };
    } else {
      const beanId = String(patch.beanId).trim();
      if (Object.keys(patch).length !== 1)
        return json({ ok: false, message: "beanId 更新字段有误" }, 400);
      if (beanId && !(await ownedBeanExists(env, identity.owner, beanId)))
        return json({ ok: false, message: "关联的豆档案不存在" }, 400);
      normalizedPatch = { beanId };
    }

    if (!(await getItem(env, identity.owner, "recipe", recipeMatch[1])))
      return json({ ok: false, message: "配方不存在" }, 404);
    await enforceItemWriteQuota(env, request, identity.owner, "recipe");
    const updated = await mutateItem(env, identity.owner, "recipe", recipeMatch[1], (current) => {
      const nextValue = { ...current, ...normalizedPatch };
      if (hasBeanPatch && normalizedPatch.beanId === "") delete nextValue.beanId;
      if (typeof normalizedPatch.name === "string") {
        if (
          !current.recipe ||
          typeof current.recipe !== "object" ||
          Array.isArray(current.recipe)
        ) {
          throw new Error("配方结构有误：历史记录缺少 recipe");
        }
        nextValue.recipe = {
          ...(current.recipe as Record<string, unknown>),
          name: normalizedPatch.name,
        };
      }
      return nextValue;
    });
    if (!updated) return json({ ok: false, message: "配方不存在" }, 404);
    return json({ ok: true });
  }
  const feedbackMatch = path.match(/^\/api\/recipes\/([0-9a-f-]+)\/feedback$/i);
  if (feedbackMatch && request.method === "POST") {
    const parsed = FeedbackInputSchema.safeParse(await requestBody(request));
    if (!parsed.success)
      return json(
        { ok: false, message: `反馈格式有误：${parsed.error.issues[0]?.message ?? "字段不完整"}` },
        400,
      );
    if (!(await getItem(env, identity.owner, "recipe", feedbackMatch[1])))
      return json({ ok: false, message: "配方不存在" }, 404);
    const feedback = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...parsed.data,
    };
    await enforceItemWriteQuota(env, request, identity.owner, "recipe");
    let updated: Record<string, unknown> | null;
    try {
      updated = await mutateItem(env, identity.owner, "recipe", feedbackMatch[1], (current) => {
        const existing = Array.isArray(current.feedbacks) ? current.feedbacks : [];
        if (existing.length >= MAX_FEEDBACKS_PER_RECIPE) throw new FeedbackLimitError();
        return { ...current, feedbacks: [...existing, feedback] };
      });
    } catch (error) {
      if (error instanceof FeedbackLimitError) {
        return json({ ok: false, message: error.message }, 409);
      }
      throw error;
    }
    if (!updated) return json({ ok: false, message: "配方不存在" }, 404);
    return json({ ok: true, feedbackId: feedback.id });
  }
  const feedbackPatchMatch = path.match(/^\/api\/recipes\/([0-9a-f-]+)\/feedback\/([0-9a-f-]+)$/i);
  if (feedbackPatchMatch && request.method === "PATCH") {
    const patch = await requestBody(request);
    const resultingRecipeId = normalizeRecipeSaveRequestId(patch.resultingRecipeId);
    if (!resultingRecipeId || Object.keys(patch).length !== 1)
      return json({ ok: false, message: "反馈更新字段不受支持" }, 400);
    const resultingRecipe = await getItem(env, identity.owner, "recipe", resultingRecipeId);
    if (!resultingRecipe) return json({ ok: false, message: "结果配方不存在" }, 404);
    if (
      resultingRecipe.value.parentId !== feedbackPatchMatch[1] ||
      resultingRecipe.value.sourceFeedbackId !== feedbackPatchMatch[2]
    ) {
      return json({ ok: false, message: "结果配方与当前反馈的版本链不匹配" }, 400);
    }
    const parentRecipe = await getItem(env, identity.owner, "recipe", feedbackPatchMatch[1]);
    if (!parentRecipe) return json({ ok: false, message: "配方不存在" }, 404);
    const parentFeedbackExists =
      Array.isArray(parentRecipe.value.feedbacks) &&
      parentRecipe.value.feedbacks.some(
        (value) =>
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          (value as Record<string, unknown>).id === feedbackPatchMatch[2],
      );
    if (!parentFeedbackExists) return json({ ok: false, message: "反馈不存在" }, 404);
    await enforceItemWriteQuota(env, request, identity.owner, "recipe");
    let feedbackFound = false;
    const updated = await mutateItem(
      env,
      identity.owner,
      "recipe",
      feedbackPatchMatch[1],
      (current) => {
        feedbackFound = false;
        const feedbacks = Array.isArray(current.feedbacks)
          ? current.feedbacks.map((value) => {
              if (!value || typeof value !== "object" || Array.isArray(value)) return value;
              const feedback = value as Record<string, unknown>;
              if (feedback.id !== feedbackPatchMatch[2]) return feedback;
              feedbackFound = true;
              return { ...feedback, resultingRecipeId };
            })
          : [];
        return { ...current, feedbacks };
      },
    );
    if (!updated) return json({ ok: false, message: "配方不存在" }, 404);
    if (!feedbackFound) return json({ ok: false, message: "反馈不存在" }, 404);
    return json({ ok: true });
  }

  if (request.method === "GET" && path === "/api/beans")
    return json({ ok: true, beans: await listItems(env, identity.owner, "bean") });
  if (request.method === "POST" && path === "/api/beans") {
    const parsed = BeanInputSchema.safeParse(await requestBody(request));
    if (!parsed.success)
      return json(
        {
          ok: false,
          message: `豆档案格式有误：${parsed.error.issues[0]?.message ?? "字段不完整"}`,
        },
        400,
      );
    await enforceItemWriteQuota(env, request, identity.owner, "bean", true);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await putItem(env, identity.owner, "bean", id, createdAt, parsed.data);
    return json({ ok: true, id });
  }
  if (request.method === "GET" && path === "/api/beans/recommend") {
    const beans = (await listItems(env, identity.owner, "bean")) as Array<Record<string, unknown>>;
    const recommendations = beans.slice(0, 3).map((bean, index) => ({
      beanId: bean.id,
      beanName: bean.name,
      score: 1 - index * 0.1,
      reasons: ["来自当前豆仓", "优先使用已建档豆子"],
    }));
    return json({ ok: true, recommendations, fallback: true });
  }
  if (request.method === "POST" && path === "/api/beans/parse") {
    return parseHostedBeanRequest(request, env, identity.owner, identity.user);
  }
  const beanMatch = path.match(/^\/api\/beans\/([0-9a-f-]+)$/i);
  if (beanMatch && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM user_items WHERE owner=? AND kind='bean' AND id=?")
      .bind(identity.owner, beanMatch[1])
      .run();
    return json({ ok: true });
  }
  if (beanMatch && request.method === "PATCH") {
    const parsed = BeanPatchSchema.safeParse(await requestBody(request));
    if (!parsed.success)
      return json(
        {
          ok: false,
          message: `豆档案格式有误：${parsed.error.issues[0]?.message ?? "字段不完整"}`,
        },
        400,
      );
    if (!(await getItem(env, identity.owner, "bean", beanMatch[1])))
      return json({ ok: false, message: "豆档案不存在" }, 404);
    await enforceItemWriteQuota(env, request, identity.owner, "bean");
    const value = await mutateItem(env, identity.owner, "bean", beanMatch[1], (current) => {
      const next = { ...current };
      for (const [key, entry] of Object.entries(parsed.data)) {
        if (entry === null) delete next[key];
        else next[key] = entry;
      }
      return next;
    });
    if (!value) return json({ ok: false, message: "豆档案不存在" }, 404);
    return json({ ok: true, bean: { id: beanMatch[1], ...value } });
  }
  const consumeMatch = path.match(/^\/api\/beans\/([0-9a-f-]+)\/consume$/i);
  if (consumeMatch && request.method === "POST") {
    const body = await requestBody(request);
    const grams = Number(body.grams);
    if (!Number.isFinite(grams) || grams <= 0 || grams > 200)
      return json({ ok: false, message: "单次用豆量需在 0-200g 之间" }, 400);
    if (!(await getItem(env, identity.owner, "bean", consumeMatch[1])))
      return json({ ok: false, message: "豆档案不存在" }, 404);
    await enforceItemWriteQuota(env, request, identity.owner, "bean");
    let remainingGrams = 0;
    const value = await mutateItem(env, identity.owner, "bean", consumeMatch[1], (current) => {
      if (typeof current.stockGrams !== "number") throw new Error("豆档案尚未录入库存");
      remainingGrams = Math.max(0, current.stockGrams - grams);
      return { ...current, stockGrams: remainingGrams };
    });
    if (!value) return json({ ok: false, message: "豆档案不存在" }, 404);
    return json({
      ok: true,
      remainingGrams,
      brewsLeft: Math.floor(remainingGrams / Math.max(1, Number(body.doseGrams) || grams || 15)),
    });
  }

  if (request.method === "GET" && path === "/api/cloud/status")
    return json({ ok: true, loggedIn: false, region: "global" });
  if (request.method === "GET" && path === "/api/ble/status")
    return json({
      ok: true,
      available: false,
      connected: false,
      message: "设备实验室在 Windows 本地运行",
    });
  return json({ ok: false, message: "此操作由 Windows 本地完整版执行" }, 501);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/"))
      return securedResponse(await env.ASSETS.fetch(request), true);
    const throughEdgeProxy = trustedEdgeProxy(request, env);
    if (!sameOriginMutation(request) && !throughEdgeProxy)
      return json({ ok: false, message: "跨站写请求已拦截" }, 403);
    let routedRequest = request;
    if (throughEdgeProxy) {
      const headers = new Headers(request.headers);
      const clientIp = headers.get("x-xbloom-client-ip")?.trim();
      if (clientIp && clientIp.length <= 80) headers.set("CF-Connecting-IP", clientIp);
      headers.delete("x-xbloom-proxy-secret");
      headers.delete("x-xbloom-client-ip");
      routedRequest = new Request(request, { headers });
    }
    try {
      const identity = await resolveIdentity(routedRequest, env);
      const auth = await handleAuthRoute(routedRequest, env, identity);
      const settings = auth
        ? null
        : await handleModelSettingsRoute(routedRequest, env, identity.user);
      const xbloom =
        auth || settings ? null : await handleXbloomRoute(routedRequest, env, identity.user);
      const xhs =
        auth || settings || xbloom
          ? null
          : await handleXhsBrowserRoute(routedRequest, env, identity.owner);
      const response =
        auth?.response ??
        settings ??
        xbloom ??
        xhs ??
        (await routeApi(routedRequest, env, identity));
      const headers = new Headers(response.headers);
      for (const cookie of [...identity.cookies, ...(auth?.cookies ?? [])]) {
        headers.append("set-cookie", cookie);
      }
      return securedResponse(new Response(response.body, { status: response.status, headers }));
    } catch (error) {
      const failure = publicApiError(error);
      return json({ ok: false, message: failure.message }, failure.status);
    }
  },
} satisfies ExportedHandler<Env>;
