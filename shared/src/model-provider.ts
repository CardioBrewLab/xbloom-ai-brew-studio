/**
 * 多厂商模型连接适配层。
 *
 * 这里只处理公开 HTTP 协议，不保存任何密钥。桌面端与 Hosted 端分别负责
 * 本机 DPAPI / 云端 AES-GCM 持久化，再把解密后的瞬时连接交给这些函数。
 */

export type ModelProvider = "openai-compatible" | "anthropic" | "gemini";

export interface ModelProviderPreset {
  id: "openai" | "anthropic" | "kimi" | "deepseek" | "qwen" | "gemini" | "custom";
  label: string;
  provider: ModelProvider;
  baseUrl: string;
  domestic: boolean;
  hint: string;
}

export const MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    provider: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    domestic: true,
    hint: "DeepSeek 官方 OpenAI 兼容接口",
  },
  {
    id: "qwen",
    label: "通义千问",
    provider: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    domestic: true,
    hint: "阿里云百炼 OpenAI 兼容接口",
  },
  {
    id: "kimi",
    label: "Kimi",
    provider: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    domestic: true,
    hint: "Moonshot AI OpenAI 兼容接口",
  },
  {
    id: "openai",
    label: "OpenAI / GPT",
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    domestic: false,
    hint: "OpenAI Chat Completions 接口",
  },
  {
    id: "anthropic",
    label: "Anthropic / Claude",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    domestic: false,
    hint: "Anthropic Messages 接口",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    domestic: false,
    hint: "Google Generative Language 接口",
  },
  {
    id: "custom",
    label: "自定义兼容接口",
    provider: "openai-compatible",
    baseUrl: "https://YOUR_MODEL_HOST/v1",
    domestic: false,
    hint: "适用于 One API、New API、LiteLLM 等 OpenAI 兼容网关",
  },
] as const;

export interface ModelConnection {
  provider: ModelProvider;
  baseUrl: string;
  apiKey: string;
  model?: string;
}

export interface ModelDiscoveryResult {
  provider: ModelProvider;
  baseUrl: string;
  models: string[];
  latencyMs: number;
}

export interface ModelTestResult extends ModelDiscoveryResult {
  model: string;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type HostResolver = (hostname: string, signal?: AbortSignal) => Promise<string[]>;

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127(?:\.[0-9]{1,3}){3}$/,
  /^0(?:\.[0-9]{1,3}){3}$/,
  /^10(?:\.[0-9]{1,3}){3}$/,
  /^169\.254(?:\.[0-9]{1,3}){2}$/,
  /^192\.168(?:\.[0-9]{1,3}){2}$/,
  /^172\.(?:1[6-9]|2[0-9]|3[01])(?:\.[0-9]{1,3}){2}$/,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
] as const;

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function ipv4Parts(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : null;
}

function ipv6Words(value: string): number[] | null {
  const address = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (address.includes("%") || (address.match(/::/g)?.length ?? 0) > 1) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const segments = side.split(":");
    const words: number[] = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const embeddedV4 = ipv4Parts(segment);
      if (embeddedV4) {
        if (index !== segments.length - 1) return null;
        words.push((embeddedV4[0] << 8) | embeddedV4[1], (embeddedV4[2] << 8) | embeddedV4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
        words.push(Number.parseInt(segment, 16));
      }
    }
    return words;
  };
  const [headText, tailText = ""] = address.split("::");
  const head = parseSide(headText);
  const tail = parseSide(tailText);
  if (!head || !tail) return null;
  if (address.includes("::")) {
    const omitted = 8 - head.length - tail.length;
    if (omitted < 1) return null;
    return [...head, ...Array<number>(omitted).fill(0), ...tail];
  }
  return head.length === 8 ? head : null;
}

/** 公网出口只接受可路由地址；保留、文档、基准测试、组播及私网地址均拒绝。 */
export function isPublicInternetAddress(value: string): boolean {
  const address = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const dottedMappedV4 = /^(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)?.[1];
  const v4 = ipv4Parts(dottedMappedV4 ?? address);
  if (v4) {
    const [a, b, c] = v4;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  const words = ipv6Words(address);
  if (!words) return false;
  const mappedV4 =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
      ? [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff]
      : words.slice(0, 6).every((word) => word === 0)
        ? [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff]
        : null;
  if (mappedV4) return isPublicInternetAddress(mappedV4.join("."));
  const first = words[0];
  return !(
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && words[1] === 0x0db8) ||
    (first === 0x2001 && words[1] <= 0x002f)
  );
}

export function normalizeModelBaseUrl(value: string, allowLoopback = false): string {
  const trimmed = value.trim();
  const url = new URL(trimmed);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(
    url.hostname.toLowerCase().replace(/^\[|\]$/g, ""),
  );
  if (
    (!allowLoopback && url.protocol !== "https:") ||
    (allowLoopback && url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    throw new Error("模型 API 地址需要使用 HTTPS；本机回环地址可使用 HTTP");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("模型 API 地址不应包含账号、查询参数或锚点");
  }
  if (!allowLoopback && isPrivateHostname(url.hostname)) {
    throw new Error("Hosted 版模型地址需要使用公网 HTTPS 域名");
  }
  return url.toString().replace(/\/+$/, "");
}

/** OpenAI 兼容网关的站点根地址与自动识别出的 /v1 视为同一凭据边界。 */
export function equivalentModelBaseUrls(left: string, right: string): boolean {
  const identity = (value: string): string => {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname === "" || pathname === "/v1" ? "/v1" : pathname}`;
  };
  try {
    return identity(left) === identity(right);
  } catch {
    return false;
  }
}

export function detectModelProvider(baseUrl: string): ModelProvider {
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (host === "api.anthropic.com" || host.endsWith(".anthropic.com")) return "anthropic";
  if (host === "generativelanguage.googleapis.com" || host.endsWith(".googleapis.com")) {
    return "gemini";
  }
  return "openai-compatible";
}

function endpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

/**
 * OpenAI 的推理型 Chat Completions 模型使用 max_completion_tokens，并且部分
 * 型号拒绝 temperature。这里只按明确的模型族切换，避免把第三方普通兼容接口
 * 一并推到较新的参数契约上。
 */
export function usesReasoningChatParameters(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    /^(?:o1|o3|o4)(?:-|$)/.test(normalized) || /^gpt-(?:[5-9]|\d{2,})(?:[.\-]|$)/.test(normalized)
  );
}

function authHeaders(connection: ModelConnection): Record<string, string> {
  if (connection.provider === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": connection.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  if (connection.provider === "gemini") {
    return { "content-type": "application/json", "x-goog-api-key": connection.apiKey };
  }
  return { "content-type": "application/json", authorization: `Bearer ${connection.apiKey}` };
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function resolveHostnameWithDoh(hostname: string, signal?: AbortSignal): Promise<string[]> {
  const query = async (type: "A" | "AAAA"): Promise<string[]> => {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      redirect: "error",
      signal: combineSignal(signal, 5_000),
    });
    if (!response.ok) throw new Error(`DNS 校验服务返回 HTTP ${response.status}`);
    const body = (await response.json()) as {
      Status?: number;
      Answer?: Array<{ type?: number; data?: string }>;
    };
    if (body.Status !== 0 && body.Status !== undefined) return [];
    const wantedType = type === "A" ? 1 : 28;
    return (body.Answer ?? [])
      .filter((answer) => answer.type === wantedType && typeof answer.data === "string")
      .map((answer) => answer.data!.trim());
  };
  const [v4, v6] = await Promise.all([query("A"), query("AAAA")]);
  return [...new Set([...v4, ...v6])];
}

/**
 * Hosted 请求在出站前解析域名并拒绝任何非公网结果。后续 fetch 同时禁用重定向；
 * Worker 还强制启用 global_fetch_strictly_public，让 DNS 重绑定后的私网目标仍按公网路由隔离。
 */
export async function assertPublicModelHostname(
  baseUrl: string,
  resolver: HostResolver = resolveHostnameWithDoh,
  signal?: AbortSignal,
): Promise<void> {
  const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (ipv4Parts(hostname) || hostname.includes(":")) {
    if (!isPublicInternetAddress(hostname)) {
      throw new Error("Hosted 版模型地址解析到了非公网地址");
    }
    return;
  }
  const addresses = await resolver(hostname, signal);
  if (!addresses.length) throw new Error("模型 API 域名未解析到公网地址");
  if (addresses.some((address) => !isPublicInternetAddress(address))) {
    throw new Error("Hosted 版模型地址解析到了非公网地址");
  }
}

const MAX_SUCCESS_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

class ModelResponseSizeError extends Error {
  constructor(kind: "success" | "error") {
    super(
      kind === "success" ? "模型接口成功响应正文超过大小上限" : "模型接口错误响应正文超过大小上限",
    );
    this.name = "ModelResponseSizeError";
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 响应已经结束或被读取时，取消失败不应遮蔽原始错误。
  }
}

async function readResponseText(
  response: Response,
  maxBytes: number,
  kind: "success" | "error",
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > maxBytes) {
    await cancelResponseBody(response);
    throw new ModelResponseSizeError(kind);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkBytes = value?.byteLength ?? 0;
      totalBytes += chunkBytes;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // 读取器已被底层连接关闭时，继续返回稳定的大小错误类别。
        }
        throw new ModelResponseSizeError(kind);
      }
      if (value) text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function responseFailure(response: Response): Promise<Error> {
  let detail = "";
  try {
    const text = await readResponseText(response, MAX_ERROR_RESPONSE_BYTES, "error");
    const body = JSON.parse(text) as Record<string, unknown>;
    const nested = body.error && typeof body.error === "object" ? body.error : undefined;
    const nestedMessage = nested && (nested as Record<string, unknown>).message;
    const candidate = nestedMessage ?? body.message ?? body.error_description;
    if (typeof candidate === "string") detail = candidate.replace(/[\r\n]+/g, " ").slice(0, 240);
  } catch (error) {
    if (error instanceof ModelResponseSizeError) throw error;
    // 非 JSON 错误页只披露状态码，避免把网关 HTML 回传到界面。
  }
  return new Error(`模型接口 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
}

async function modelResponseJson(response: Response, action: string): Promise<unknown> {
  const text = await readResponseText(response, MAX_SUCCESS_RESPONSE_BYTES, "success");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `模型接口${action}响应不是 JSON；请检查 API 地址，OpenAI 兼容接口通常以 /v1 结尾`,
    );
  }
}

function normalizeModelIds(values: unknown[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const model = value.replace(/^models\//, "").trim();
    if (model && model.length <= 200 && !/[\r\n\0]/.test(model)) unique.add(model);
  }
  // 兼容聚合网关的大模型池，同时给异常响应保留明确上界。
  return [...unique].sort((left, right) => left.localeCompare(right)).slice(0, 2_000);
}

interface ModelDiscoveryPage {
  values: unknown[];
  nextPageToken: string;
  nextAfterId: string;
  hasMore: boolean;
}

function modelListValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["data", "models", "items", "results"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

/**
 * OpenAI-compatible gateways do not all mirror the official `{ data: [{ id }] }`
 * envelope.  Keep the accepted shapes deliberately small, but include the common
 * nested/list variants used by One API, New API and model aggregators.
 */
function parseModelDiscoveryPage(body: unknown): ModelDiscoveryPage {
  if (Array.isArray(body)) {
    return {
      values: body.map((value) => {
        if (typeof value === "string") return value;
        if (!value || typeof value !== "object") return undefined;
        const model = value as Record<string, unknown>;
        return model.id ?? model.model ?? model.model_id ?? model.slug ?? model.name;
      }),
      nextPageToken: "",
      nextAfterId: "",
      hasMore: false,
    };
  }
  if (!body || typeof body !== "object") {
    return { values: [], nextPageToken: "", nextAfterId: "", hasMore: false };
  }
  const record = body as Record<string, unknown>;
  const values = [
    ...modelListValues(record.data),
    ...modelListValues(record.models),
    ...modelListValues(record.result),
  ];
  if (values.length === 0) values.push(...modelListValues(body));
  return {
    values: values.map((value) => {
      if (typeof value === "string") return value;
      if (!value || typeof value !== "object") return undefined;
      const model = value as Record<string, unknown>;
      return model.id ?? model.model ?? model.model_id ?? model.slug ?? model.name;
    }),
    nextPageToken:
      typeof record.nextPageToken === "string"
        ? record.nextPageToken
        : typeof record.next_page_token === "string"
          ? record.next_page_token
          : "",
    nextAfterId:
      typeof record.last_id === "string"
        ? record.last_id
        : typeof record.lastId === "string"
          ? record.lastId
          : "",
    hasMore: record.has_more === true || record.hasMore === true,
  };
}

function discoveryPageUrl(
  baseUrl: string,
  provider: ModelProvider,
  pageToken: string,
  afterId: string,
): string {
  const url = new URL(endpoint(baseUrl, "models"));
  if (provider === "gemini") {
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
  } else if (afterId) {
    // Anthropic 官方接口以及部分 OpenAI-compatible 聚合网关都使用该游标。
    url.searchParams.set("after_id", afterId);
  }
  return url.toString();
}

export async function discoverModels(
  input: ModelConnection,
  options: {
    fetcher?: FetchLike;
    signal?: AbortSignal;
    allowLoopback?: boolean;
    resolveHostname?: HostResolver;
  } = {},
): Promise<ModelDiscoveryResult> {
  const started = Date.now();
  const provider = input.provider || detectModelProvider(input.baseUrl);
  const connection = {
    ...input,
    provider,
    baseUrl: normalizeModelBaseUrl(input.baseUrl, options.allowLoopback),
    apiKey: input.apiKey.trim(),
  };
  if (!connection.apiKey) throw new Error("请填写 API Key");
  if (!options.allowLoopback) {
    await assertPublicModelHostname(connection.baseUrl, options.resolveHostname, options.signal);
  }
  const fetcher = options.fetcher ?? fetch;
  const candidates = [connection.baseUrl];
  const parsedBaseUrl = new URL(connection.baseUrl);
  if (provider === "openai-compatible" && parsedBaseUrl.pathname === "/") {
    candidates.push(`${parsedBaseUrl.origin}/v1`);
  }
  // 一个识别动作共用 20 秒总预算；根地址探测最多占 5 秒，把余量留给常见的 /v1。
  const discoverySignal = combineSignal(options.signal, 20_000);
  let bestResult: ModelDiscoveryResult | null = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidateBaseUrl = candidates[index];
    const mayTryV1 = index === 0 && candidates.length > 1;
    const values: unknown[] = [];
    const seenTokens = new Set<string>();
    let pageToken = "";
    let afterId = "";
    let failedCandidate = false;
    for (let page = 0; page < 20 && values.length < 2_000; page += 1) {
      let response: Response;
      try {
        response = await fetcher(discoveryPageUrl(candidateBaseUrl, provider, pageToken, afterId), {
          method: "GET",
          headers: authHeaders(connection),
          redirect: "error",
          signal: mayTryV1 ? combineSignal(discoverySignal, 5_000) : discoverySignal,
        });
      } catch (error) {
        if (mayTryV1 && !discoverySignal.aborted) {
          failedCandidate = true;
          break;
        }
        if (bestResult) return bestResult;
        throw error;
      }
      if (!response.ok) {
        if (mayTryV1) {
          await response.body?.cancel().catch(() => {});
          failedCandidate = true;
          break;
        }
        if (bestResult) {
          await response.body?.cancel().catch(() => {});
          return bestResult;
        }
        throw await responseFailure(response);
      }

      let parsed: ModelDiscoveryPage;
      try {
        parsed = parseModelDiscoveryPage(await modelResponseJson(response, "模型列表"));
      } catch (error) {
        if (mayTryV1) {
          failedCandidate = true;
          break;
        }
        if (bestResult) return bestResult;
        throw error;
      }
      values.push(...parsed.values);
      const nextToken = parsed.nextPageToken || (parsed.hasMore ? parsed.nextAfterId : "");
      if (!nextToken || seenTokens.has(nextToken)) break;
      seenTokens.add(nextToken);
      pageToken = parsed.nextPageToken;
      afterId = parsed.nextAfterId;
    }
    if (failedCandidate) continue;
    const models = normalizeModelIds(values);
    if (models.length > 0) {
      const candidateResult = {
        provider,
        baseUrl: candidateBaseUrl,
        models,
        latencyMs: Date.now() - started,
      };
      if (!bestResult || candidateResult.models.length > bestResult.models.length) {
        bestResult = candidateResult;
      }
      if (index < candidates.length - 1) continue;
      return bestResult;
    }
    if (!mayTryV1) {
      if (bestResult) return bestResult;
      throw new Error("接口已连接，但模型列表为空；可手动填写模型 ID");
    }
  }

  if (bestResult) return bestResult;
  throw new Error("接口已连接，但模型列表为空；可手动填写模型 ID");
}

function extractText(provider: ModelProvider, body: unknown): string {
  const value = body as Record<string, unknown>;
  if (provider === "anthropic") {
    const content = Array.isArray(value.content) ? value.content : [];
    return content
      .map((item) =>
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).text === "string"
          ? ((item as Record<string, unknown>).text as string)
          : "",
      )
      .join("")
      .trim();
  }
  if (provider === "gemini") {
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    const first = candidates[0] as Record<string, unknown> | undefined;
    const content = first?.content as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    return parts
      .map((part) =>
        part &&
        typeof part === "object" &&
        typeof (part as Record<string, unknown>).text === "string"
          ? ((part as Record<string, unknown>).text as string)
          : "",
      )
      .join("")
      .trim();
  }
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  return typeof message?.content === "string" ? message.content.trim() : "";
}

export async function generateModelText(
  input: ModelConnection & { model: string },
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: {
    fetcher?: FetchLike;
    signal?: AbortSignal;
    timeoutMs?: number;
    allowLoopback?: boolean;
    resolveHostname?: HostResolver;
    temperature?: number;
    maxTokens?: number;
  } = {},
): Promise<string> {
  const connection = {
    ...input,
    baseUrl: normalizeModelBaseUrl(input.baseUrl, options.allowLoopback),
    apiKey: input.apiKey.trim(),
    model: input.model.trim(),
  };
  if (!connection.apiKey || !connection.model) throw new Error("请填写 API Key 并选择模型");
  if (!options.allowLoopback) {
    await assertPublicModelHostname(connection.baseUrl, options.resolveHostname, options.signal);
  }
  const fetcher = options.fetcher ?? fetch;
  let url: string;
  let body: unknown;
  if (connection.provider === "anthropic") {
    url = endpoint(connection.baseUrl, "messages");
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    body = {
      model: connection.model,
      max_tokens: options.maxTokens ?? 2048,
      ...(system ? { system } : {}),
      messages: messages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role, content: message.content })),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    };
  } else if (connection.provider === "gemini") {
    url = endpoint(
      connection.baseUrl,
      `models/${encodeURIComponent(connection.model.replace(/^models\//, ""))}:generateContent`,
    );
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    body = {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: message.content }],
        })),
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? 2048,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      },
    };
  } else {
    url = endpoint(connection.baseUrl, "chat/completions");
    const reasoningParameters = usesReasoningChatParameters(connection.model);
    const maxTokens = options.maxTokens ?? 2048;
    body = {
      model: connection.model,
      messages,
      stream: false,
      ...(reasoningParameters ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      ...(reasoningParameters || options.temperature === undefined
        ? {}
        : { temperature: options.temperature }),
    };
  }
  const response = await fetcher(url, {
    method: "POST",
    headers: authHeaders(connection),
    body: JSON.stringify(body),
    redirect: "error",
    signal: combineSignal(options.signal, options.timeoutMs ?? 120_000),
  });
  if (!response.ok) throw await responseFailure(response);
  const content = extractText(connection.provider, await modelResponseJson(response, "生成"));
  if (!content) throw new Error("模型接口已响应，但正文为空");
  return content;
}

export async function testModelConnection(
  input: ModelConnection & { model: string },
  options: {
    fetcher?: FetchLike;
    signal?: AbortSignal;
    allowLoopback?: boolean;
    resolveHostname?: HostResolver;
  } = {},
): Promise<ModelTestResult> {
  const started = Date.now();
  const reasoningModel =
    input.provider === "openai-compatible" && usesReasoningChatParameters(input.model);
  const content = await generateModelText(input, [{ role: "user", content: "Reply with OK." }], {
    ...options,
    timeoutMs: 25_000,
    // 推理 token 与可见正文共用此上限；过小会让连接正常却只产生推理、正文为空。
    maxTokens: reasoningModel ? 512 : 16,
    temperature: 0,
  });
  if (!content.trim()) throw new Error("模型连接测试未返回正文");
  return {
    provider: input.provider,
    baseUrl: normalizeModelBaseUrl(input.baseUrl, options.allowLoopback),
    model: input.model,
    models: [input.model],
    latencyMs: Date.now() - started,
  };
}
