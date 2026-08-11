/**
 * OpenAI 兼容流式客户端。
 *
 * POST {LLM_BASE_URL}/chat/completions（Bearer key，stream:true）。
 * 已实测（Claude thinking 与 GPT-5.5/5.6）：思考内容统一在 delta.reasoning_content，
 * 正文在 delta.content，SSE 以 [DONE] 结束。产出 async generator：
 * { type:"reasoning"|"content", delta }。
 *
 * 双 key 两级兜底（实测结论）：
 * - GPT 系模型默认请求不带思考流；请求体带 reasoning_effort（实测 "high" 生效）
 *   后思考内容才出现在 reasoning_content。故仅对模型名含 "gpt" 的请求下发该参数。
 * - 主模型失败（尚未产出任何内容前）依次降级：fallbackModel → thirdModel。
 * - key 选择：Claude 系模型（兜底）用 LLM_FALLBACK_API_KEY，其余（gpt-5.6-sol 等）
 *   用 LLM_API_KEY（缺省回退）。模型 ID 一律从配置读取，不硬编码。
 */
import { fetch } from "undici";
import { config } from "../config.js";

const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;

function boundedTimeout(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed)
    ? Math.min(600_000, Math.max(5_000, Math.trunc(parsed)))
    : fallback;
}

/** 单次模型 HTTP 请求上限；父 signal 用于客户端断开/整轮超时，二者任一触发即终止。 */
export function llmRequestSignal(
  parent?: AbortSignal,
  timeoutMs = boundedTimeout(process.env.LLM_REQUEST_TIMEOUT_MS, DEFAULT_LLM_REQUEST_TIMEOUT_MS),
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function timeoutError(
  model: string,
  timeoutSignal: AbortSignal,
  parent?: AbortSignal,
): Error | null {
  if (!timeoutSignal.aborted || parent?.aborted) return null;
  return new Error(`LLM 请求超时 [${model}]，请检查接口地址或稍后重试`);
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChunk {
  type: "reasoning" | "content";
  delta: string;
}

export interface StreamChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 用于提前中断流（如客户端断开） */
  signal?: AbortSignal;
}

/**
 * 采样层治理（任务 #106）——按模型分发采样参数（沿用 reasoning_effort 模式）：
 * - 模型名含 "gpt"：一律不下发 temperature（reasoning 模型固定 temperature）；
 * - 其他模型：下发 opts.temperature ?? config.llm.temperature ?? 0.3。
 * 供流式（runStream）与非流式（chatCompletion 候选生成）共用同一策略。
 */
export function samplingParams(
  model: string,
  opts: { temperature?: number },
): { temperature?: number } {
  if (model.toLowerCase().includes("gpt")) return {};
  return { temperature: opts.temperature ?? config.llm.temperature ?? 0.3 };
}

/**
 * seed 透传固定值（任务 #106）：仅对 gpt 系下发。
 * 注：OpenAI 的 seed 为 best-effort 不作保证——同 seed 同参数下网关会尽量
 * 确定性重放，但不承诺逐字节一致，且不同网关实现可能直接忽略。
 */
export const LLM_SEED_BEST_EFFORT = 42;

/** 携带 HTTP 状态码的 LLM 请求错误（429/529/503 用于多候选降 N 判定） */
export class LlmRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LlmRequestError";
    this.status = status;
  }
}

/**
 * 并发/限流类错误判定（任务 #106）：HTTP 429/529/503，或错误消息命中
 * 限流/过载关键词。多候选批次全体因此类错误失败时降 N（3→2→1）重试本次。
 */
export function isConcurrencyError(err: unknown): boolean {
  if (
    err instanceof LlmRequestError &&
    (err.status === 429 || err.status === 529 || err.status === 503)
  ) {
    return true;
  }
  const msg = String((err as Error)?.message ?? "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("too many concurrent") ||
    msg.includes("concurrency") ||
    msg.includes("overloaded")
  );
}

/**
 * 可安全重试的上游瞬时故障：连接中断、连接/响应超时，以及常见临时 5xx。
 * 认证、参数校验等确定性 4xx 会返回 false，避免重复消耗请求。
 */
export function isTransientTransportError(err: unknown): boolean {
  if (err instanceof LlmRequestError && [408, 425, 500, 502, 503, 504, 529].includes(err.status)) {
    return true;
  }

  const messages: string[] = [];
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const record = current as { message?: unknown; code?: unknown; cause?: unknown };
    if (typeof record.message === "string") messages.push(record.message.toLowerCase());
    if (typeof record.code === "string") codes.push(record.code.toUpperCase());
    current = record.cause;
  }

  const message = messages.join(" ");
  const code = codes.join(" ");
  return (
    message.includes("fetch failed") ||
    message.includes("request timeout") ||
    message.includes("请求超时") ||
    message.includes("connection reset") ||
    message.includes("socket hang up") ||
    message.includes("other side closed") ||
    code.includes("UND_ERR_CONNECT_TIMEOUT") ||
    code.includes("UND_ERR_HEADERS_TIMEOUT") ||
    code.includes("UND_ERR_SOCKET") ||
    code.includes("ECONNRESET") ||
    code.includes("ECONNREFUSED") ||
    code.includes("ETIMEDOUT") ||
    code.includes("EPIPE")
  );
}

/** 按模型选 key：Claude 系模型走兜底渠道 key，其余（GPT 系）走主 key */
export function keyForModel(model: string): string {
  const { apiKey, fallbackApiKey } = config.llm;
  if (model.toLowerCase().startsWith("claude") && fallbackApiKey) return fallbackApiKey;
  return apiKey;
}

/** 候选模型链（去重、去空）：主 → 第二兜底 → 第三兜底 */
export function modelChain(primary: string): string[] {
  const { fallbackModel, thirdModel } = config.llm;
  const chain = [primary];
  for (const m of [fallbackModel, thirdModel]) {
    if (m && !chain.includes(m)) chain.push(m);
  }
  return chain;
}

/** 逐行解析 SSE body，产出 delta 块 */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processLine = (line: string): StreamChunk | null | "done" => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload) return null;
    if (payload === "[DONE]") return "done";
    try {
      const json = JSON.parse(payload);
      const delta = json?.choices?.[0]?.delta;
      if (!delta) return null;
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        return { type: "reasoning", delta: delta.reasoning_content };
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        return { type: "content", delta: delta.content };
      }
      return null;
    } catch {
      return null; // 忽略无法解析的行
    }
  };

  try {
    while (true) {
      if (signal?.aborted) throw new Error("LLM 流已被中断");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const chunk = processLine(line);
        if (chunk === "done") return;
        if (chunk) yield chunk;
      }
    }
    // 冲刷剩余缓冲
    if (buffer.trim()) {
      const chunk = processLine(buffer);
      if (chunk !== "done" && chunk) yield chunk;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

/** 单个模型的一次流式请求；HTTP 非 2xx 或网络错误直接抛错 */
async function* streamSingle(
  model: string,
  messages: ChatMessage[],
  opts: StreamChatOptions,
): AsyncGenerator<StreamChunk> {
  const url = `${config.llm.baseUrl.replace(/\/$/, "")}/chat/completions`;
  // GPT 系需显式开启 reasoning_effort 才会输出思考流（实测确认）
  const reasoningEffort =
    config.llm.reasoningEffort && model.toLowerCase().includes("gpt")
      ? { reasoning_effort: config.llm.reasoningEffort }
      : {};
  // 采样层治理（任务 #106）：gpt 系不下发 temperature；其他模型下发温度（缺省 0.3）
  const sampling = samplingParams(model, opts);
  const seed = model.toLowerCase().includes("gpt") ? { seed: LLM_SEED_BEST_EFFORT } : {};
  const requestSignal = llmRequestSignal(opts.signal);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keyForModel(model)}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...reasoningEffort,
        ...sampling,
        ...seed,
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: requestSignal,
    });
  } catch (error) {
    throw timeoutError(model, requestSignal, opts.signal) ?? error;
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new LlmRequestError(
      `LLM 请求失败 [${model}] HTTP ${res.status}: ${text.slice(0, 500)}`,
      res.status,
    );
  }

  yield* parseSse(res.body as unknown as ReadableStream<Uint8Array>, requestSignal);
}

/**
 * 流式对话：主模型失败（尚未产出任何内容前）自动按 modelChain 逐级降级重试。
 * 已产出任何 chunk 后发生的错误直接抛出（降级重播会造成重复输出）；
 * signal 被中止时同样直接抛出，不再降级。
 */
export async function* streamChat(
  messages: ChatMessage[],
  opts: StreamChatOptions = {},
): AsyncGenerator<StreamChunk> {
  const chain = modelChain(opts.model ?? config.llm.model);
  let lastError: unknown = null;
  /** 是否已向调用方产出过任何 chunk：一旦产出过，失败绝不再降级重试 */
  let emitted = false;
  for (const model of chain) {
    try {
      for await (const chunk of streamSingle(model, messages, opts)) {
        emitted = true;
        yield chunk;
      }
      return;
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted) throw err;
      if (emitted) throw err; // 已产出内容 → 直接抛错，避免降级后重复输出
      const next = chain[chain.indexOf(model) + 1];
      if (next) {
        console.warn(`[llm] 模型 ${model} 失败，降级 ${next} 重试：`, (err as Error).message);
      }
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// 非流式一次性请求（任务 #106 多候选生成专用）
// ---------------------------------------------------------------------------

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 非流式候选的 best-effort seed；缺省保持历史固定值。 */
  seed?: number;
}

/** 单个模型的一次非流式请求；HTTP 非 2xx 抛 LlmRequestError（带状态码） */
async function completionSingle(
  model: string,
  messages: ChatMessage[],
  opts: CompletionOptions,
): Promise<string> {
  const url = `${config.llm.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const reasoningEffort =
    config.llm.reasoningEffort && model.toLowerCase().includes("gpt")
      ? { reasoning_effort: config.llm.reasoningEffort }
      : {};
  const sampling = samplingParams(model, opts);
  const seed = model.toLowerCase().includes("gpt")
    ? { seed: Number.isFinite(opts.seed) ? Math.trunc(opts.seed!) : LLM_SEED_BEST_EFFORT }
    : {};
  const requestSignal = llmRequestSignal(opts.signal);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${keyForModel(model)}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...reasoningEffort,
        ...sampling,
        ...seed,
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: requestSignal,
    });
  } catch (error) {
    throw timeoutError(model, requestSignal, opts.signal) ?? error;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmRequestError(
      `LLM 请求失败 [${model}] HTTP ${res.status}: ${text.slice(0, 500)}`,
      res.status,
    );
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new LlmRequestError(`LLM 响应缺少 content [${model}]`, 502);
  }
  return content;
}

/**
 * 非流式对话：主模型失败自动按 modelChain 逐级降级重试（与 streamChat 一致）。
 * 返回 choices[0].message.content 全文；signal 中止时直接抛错不降级。
 */
export async function chatCompletion(
  messages: ChatMessage[],
  opts: CompletionOptions = {},
): Promise<string> {
  const chain = modelChain(opts.model ?? config.llm.model);
  let lastError: unknown = null;
  for (const model of chain) {
    try {
      return await completionSingle(model, messages, opts);
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted) throw err;
      const next = chain[chain.indexOf(model) + 1];
      if (next) {
        console.warn(`[llm] 模型 ${model} 失败，降级 ${next} 重试：`, (err as Error).message);
      }
    }
  }
  throw lastError;
}
