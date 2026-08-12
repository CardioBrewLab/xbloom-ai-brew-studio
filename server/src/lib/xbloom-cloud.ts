/**
 * xBloom 云端模块：登录、发布/更新/删除/列表配方、读取分享配方、连通性探测。
 *
 * 协议蓝本照抄开源逆向实现 denull0/xbloom-agent（MIT）：
 * xbloom-mcp-remote/supabase/functions/xbloom-mcp/index.ts
 *
 * 关键协议事实（均已对照源码确认）：
 * - API base: https://client-api.xbloom.com（全球区）
 * - 中国区（xbloomcoffee.cn，沪ICP备2023018281号，上海猎光者贸易）API base：
 *   https://clientcn-api.xbloomcoffee.cn —— 协议与全球区完全同构（tMemberLogin.thtml /
 *   tuRecipeAdd.tuhtml 等，2026-08-03 真实账号实测登录成功）。域名提取自官方中国区
 *   share-h5（share-h5.xbloomcoffee.cn）前端 bundle 的硬编码；同族的 client-api.xbloomcoffee.cn
 *   已宕机（持续 502）勿用。XBLOOM_REGION=cn 切换。
 * - 请求头必须带 Referer: https://share-h5.xbloom.com/ 与 iPhone UA
 * - 登录 POST /tMemberLogin.thtml（明文 JSON）→ result==="success" 时取 member.tableId + token
 * - 建配方 POST /tuRecipeAdd.tuhtml（payload 先 RSA 加密成 base64 字符串再 JSON.stringify）
 * - 列表 POST /tuMyTeaRecipeCreated.tuhtml（authBase + pageNumber/countPerPage/adaptedModel:1）→ resp.list
 * - 更新 POST /tuRecipeUpdate.tuhtml（authBase + tableId + 全量配方字段，同 tuRecipeAdd 字段集）
 * - 删除 POST /tuRecipeDelete.tuhtml（authBase + tableId）
 * - 免登录读取 POST /RecipeDetail.html {tableIdOfRSA, interfaceVersion:19700101, skey:"testskey"}
 * - 分享链接：全球区 = https://share-h5.xbloom.com/?id= + btoa(String(tableId))；
 *   中国区分享 ID 是服务端生成的 16 字节密文（无法本地推导），必须取列表接口
 *   返回的 shareRecipeLink 字段（2026-08-03 实测：base64(tableId) 形态在中国区读回失败）
 * - RSA-1024 公钥（PKCS1 padding），明文按 117 字节分块加密后拼接 base64
 * - 云端 cupType：xdripper→2（咖啡手冲），other→3；本产品已移除 xPod
 *
 * 云端语义差异（重要）：云端 payload 的 grandWater 字段语义是【粉水比 ratio】，
 * 不是总水量（ml）。总水量 = dose × ratio。内部模型 grandWater 是总水量 ml，
 * 来回转换集中在 toCloudPayload / parseRecipeVo 两处。
 *
 * 网络约束：本机直连 *.xbloom.com 会超时（DNS fake-IP 代理路由问题），
 * 所有出站请求统一走 undici fetch，配置了 HTTPS_PROXY/ALL_PROXY 时挂 ProxyAgent。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { constants, publicEncrypt } from "node:crypto";
import * as undici from "undici";
import type { Dispatcher, RequestInit as UndiciRequestInit } from "undici";
import { config } from "../config.js";
import {
  alignIntegerPours,
  toCloudPayload,
  type CloudPayloadResult,
} from "@xbloom/shared/xbloom-cloud-payload";
import { atomicWriteJson } from "./data-io.js";
import {
  protectCurrentUserText,
  unprotectCurrentUserText,
  type DpapiEnvelope,
} from "./windows-dpapi.js";
import {
  RecipeSchema,
  cloudToPattern,
  isReachableCloudTotal,
  nearestReachableCloudTotal,
  type CupType,
  type Recipe,
  type RecipeCore,
} from "./recipe-schema.js";

// ---------------------------------------------------------------------------
// 协议常量（照抄 xbloom-agent 源码）
// ---------------------------------------------------------------------------

export const API_BASE_GLOBAL = "https://client-api.xbloom.com";
export const API_BASE_CN = "https://clientcn-api.xbloomcoffee.cn";
export const SHARE_BASE_GLOBAL = "https://share-h5.xbloom.com";
export const SHARE_BASE_CN = "https://share-h5.xbloomcoffee.cn";

export type XbloomRegion = "cn" | "global";

export function defaultXbloomRegion(): XbloomRegion {
  return (process.env.XBLOOM_REGION || "").trim().toLowerCase() === "cn" ? "cn" : "global";
}

export function normalizeXbloomRegion(
  value: unknown,
  fallback: XbloomRegion = defaultXbloomRegion(),
): XbloomRegion {
  return value === "cn" || value === "global" ? value : fallback;
}

export function apiBaseForRegion(region: XbloomRegion): string {
  return region === "cn" ? API_BASE_CN : API_BASE_GLOBAL;
}

export function shareBaseForRegion(region: XbloomRegion): string {
  return region === "cn" ? SHARE_BASE_CN : SHARE_BASE_GLOBAL;
}

/** 是否使用中国区后端（.env 的 XBLOOM_REGION=cn） */
export function isCnRegion(region: XbloomRegion = defaultXbloomRegion()): boolean {
  return region === "cn";
}

export const API_BASE = apiBaseForRegion(defaultXbloomRegion());
export const SHARE_BASE = shareBaseForRegion(defaultXbloomRegion());
const r1 = (value: number): number => Math.round(value * 10) / 10;

/** xBloom 服务端 RSA-1024 公钥（DER/base64，照抄 xbloom-agent） */
const RSA_PUBLIC_KEY_B64 =
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC4LF40GZ72SdhMyl765K/i4nY5" +
  "CPcHz2Q1IKWKZ9S79xmK7G8pUhbVf4EZLvnNF1+9IvOFQUKV5Z7ZNNviqSpnql9" +
  "tAT+8+J/He0R7pcirvVSxgdr2i9V/C/gmqAEZ5qVTzRnd3uWdFoKzPdEBxP0Ipor" +
  "J1VBbCv90yBSOhVxO+QIDAQAB";

const pemBody = RSA_PUBLIC_KEY_B64.match(/.{1,64}/g)!.join("\n");
const RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----\n${pemBody}\n-----END PUBLIC KEY-----`;

/** RSA-1024 PKCS1：单块明文上限 128-11=117 字节，密文块固定 128 字节 */
const RSA_CHUNK_PLAIN = 117;
export const RSA_CHUNK_CIPHER = 128;

function apiHeaders(region: XbloomRegion): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Referer: `${shareBaseForRegion(region)}/`,
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
  };
}

/** 默认 HTTP 超时（ms） */
export const HTTP_TIMEOUT_MS = 15_000;
/** status 探测用的快速失败超时（ms） */
export const PROBE_TIMEOUT_MS = 5_000;
/** postJson 遭遇瞬时故障（HTTP 404/5xx）时的重试次数（2026-08-03 实测：同一 URL 首次请求返回 404，随后稳定 200）；任务 #98：仅限幂等调用使用 */
const TRANSIENT_RETRY_COUNT = 2;

export const XBLOOM_RECIPE_PAGE_SIZE = 100;
export const XBLOOM_MAX_RECIPE_PAGES = 20;

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(1, Math.floor(value!))) : fallback;
}

// ---------------------------------------------------------------------------
// 出站代理（本机直连 xbloom 会超时，必须支持代理）
// ---------------------------------------------------------------------------

/** 当前生效的出站代理地址（HTTPS_PROXY 优先，其次 ALL_PROXY），空串表示无代理 */
export function proxyUrl(): string {
  return process.env.HTTPS_PROXY || process.env.ALL_PROXY || config.httpsProxy || "";
}

let cachedDispatcher: Dispatcher | null | undefined;

/** 有代理配置时返回共享 ProxyAgent，否则 null（走默认连接池） */
export function getDispatcher(): Dispatcher | null {
  if (cachedDispatcher !== undefined) return cachedDispatcher;
  const url = proxyUrl();
  cachedDispatcher = url ? new undici.ProxyAgent(url) : null;
  return cachedDispatcher;
}

// ---------------------------------------------------------------------------
// HTTP 封装（undici fetch + ProxyAgent + AbortSignal 超时）
// ---------------------------------------------------------------------------

interface JsonRequestOptions {
  timeoutMs?: number;
  region?: XbloomRegion;
  /**
   * 任务 #98：调用是否幂等（默认 false）。仅 idempotent===true 时保留 404/5xx 有限重试
   * （登录/状态探测/列表查询等只读调用）；非幂等写操作（tuRecipeAdd 建配方等）
   * 绝不重试——实测存在「首次 404 但后端已落库」现象，重试会重复创建云端配方。
   */
  idempotent?: boolean;
}

/**
 * 统一 JSON POST。失败一律抛 Error（含 HTTP 状态/网络原因），由上层决定如何呈现。
 */
export async function postJson(
  endpoint: string,
  payload: unknown,
  opts: JsonRequestOptions = {},
): Promise<Record<string, unknown>> {
  const dispatcher = getDispatcher();
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
  const region = opts.region ?? defaultXbloomRegion();
  // undici fetch 的 RequestInit 额外支持 dispatcher；用 undici 自带类型避免与全局 RequestInit 冲突
  // 官方网关偶发对存在的端点返回 404（疑似 LB 后端实例不一致），仅幂等调用对 404/5xx 做有限次重试
  let resp: undici.Response | undefined;
  for (let attempt = 0; ; attempt++) {
    // 任务#88：每次尝试独立创建超时信号。旧实现三次尝试共用一个 AbortSignal.timeout，
    // 超时预算从首个请求开始累计，导致重试窗口被耗尽、提前误报超时失败
    const init: Record<string, unknown> = {
      method: "POST",
      headers: apiHeaders(region),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (dispatcher) init.dispatcher = dispatcher;
    resp = await undici.fetch(`${apiBaseForRegion(region)}/${endpoint}`, init as UndiciRequestInit);
    // 任务 #98：非幂等写操作不重试（首次 404/5xx 时后端可能已落库，重试会重复创建）
    const transient = opts.idempotent === true && (resp.status === 404 || resp.status >= 500);
    if (!transient || attempt >= TRANSIENT_RETRY_COUNT) break;
    console.warn(`[xbloom][cloud] ${endpoint} HTTP ${resp.status}，第 ${attempt + 1} 次重试`);
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  let body: Record<string, unknown>;
  try {
    body = (await resp.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`xBloom API ${endpoint} 返回了非 JSON 响应 (HTTP ${resp.status})`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// RSA 加密（hutool 风格分块，照抄 xbloom-agent）
// ---------------------------------------------------------------------------

/**
 * 把 payload 对象 JSON 化后按 117 字节分块做 RSA-1024 PKCS1 加密，
 * 拼接全部密文块后 base64 输出（与 hutool SecureUtil 行为一致）。
 */
export function rsaEncrypt(payload: Record<string, unknown>): string {
  const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");
  const chunks: Buffer[] = [];
  for (let i = 0; i < plaintext.length; i += RSA_CHUNK_PLAIN) {
    const chunk = plaintext.subarray(i, i + RSA_CHUNK_PLAIN);
    const encrypted = publicEncrypt(
      { key: RSA_PUBLIC_KEY_PEM, padding: constants.RSA_PKCS1_PADDING },
      chunk,
    );
    chunks.push(encrypted);
  }
  return Buffer.concat(chunks).toString("base64");
}

// ---------------------------------------------------------------------------
// 会话：登录态 + data/session.json 缓存
// ---------------------------------------------------------------------------

export interface CloudSession {
  memberId: number;
  token: string;
  email: string;
  region: XbloomRegion;
}

interface ProtectedCloudSession extends DpapiEnvelope {
  version: 2;
}

const CLOUD_SESSION_ENTROPY = "xbloom-ai-brew-studio:cloud-session:v2";

/** 进程内会话缓存（session.json 的读结果也回填到这里） */
let sessionCache: CloudSession | null = null;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SESSION_FILE = path.join(repoRoot, "data", "session.json");

export function getSessionFile(): string {
  return SESSION_FILE;
}

function parseCloudSession(value: unknown): CloudSession | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<CloudSession>;
  if (!parsed.token || typeof parsed.token !== "string" || typeof parsed.memberId !== "number")
    return null;
  return {
    memberId: parsed.memberId,
    token: parsed.token,
    email: typeof parsed.email === "string" ? parsed.email : "",
    region: normalizeXbloomRegion(parsed.region),
  };
}

function protectCloudSession(session: CloudSession): ProtectedCloudSession {
  return {
    version: 2,
    ...protectCurrentUserText(JSON.stringify(session), CLOUD_SESSION_ENTROPY),
  };
}

function writeProtectedSession(session: CloudSession): void {
  atomicWriteJson(SESSION_FILE, protectCloudSession(session));
}

/** 读取已缓存会话：先内存，后 data/session.json；均无返回 null */
export function loadSession(): CloudSession | null {
  if (sessionCache) return sessionCache;
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProtectedCloudSession & CloudSession>;
    if (
      parsed.version === 2 &&
      parsed.algorithm === "windows-dpapi" &&
      typeof parsed.ciphertext === "string"
    ) {
      sessionCache = parseCloudSession(
        JSON.parse(
          unprotectCurrentUserText(
            { algorithm: "windows-dpapi", ciphertext: parsed.ciphertext },
            CLOUD_SESSION_ENTROPY,
          ),
        ),
      );
      return sessionCache;
    }
    const legacy = parseCloudSession(parsed);
    if (legacy) {
      sessionCache = legacy;
      // v1 明文会话仅作兼容读取；成功读取后立即原位升级，登录态保持不变。
      try {
        writeProtectedSession(legacy);
      } catch {
        console.warn("[xbloom][cloud] 历史会话保护升级未完成；本次进程仍沿用内存登录态");
      }
      return sessionCache;
    }
  } catch {
    /* 文件不存在/损坏视为未登录 */
  }
  return null;
}

/** 保存会话到内存 + data/session.json（写临时文件 + rename 原子替换，目录不存在时自动创建） */
export function saveSession(session: CloudSession): void {
  writeProtectedSession(session);
  sessionCache = session;
}

/** 清除会话（内存 + 文件） */
export function clearSession(): void {
  sessionCache = null;
  try {
    fs.unlinkSync(SESSION_FILE);
  } catch {
    /* 文件本就不存在时无需处理 */
  }
}

// ---------------------------------------------------------------------------
// 登录 / 鉴权基础字段
// ---------------------------------------------------------------------------

/** 登录 xBloom 云端账号（明文 JSON，照抄 xbloom-agent 字段；登录幂等可重试，任务 #98） */
export async function login(
  email: string,
  password: string,
  region: XbloomRegion = defaultXbloomRegion(),
): Promise<CloudSession> {
  const resp = await postJson(
    "tMemberLogin.thtml",
    {
      interfaceVersion: 20240918,
      skey: "testskey",
      clientType: 2,
      phoneType: "Android",
      languageType: 3,
      email,
      password,
    },
    { idempotent: true, region },
  );
  if (resp.result !== "success") {
    const detail = pickFailureDetail(resp);
    throw new Error(detail ? `登录失败：${detail}` : "登录失败：请检查邮箱与密码");
  }
  const member = resp.member as Record<string, unknown> | undefined;
  const token = resp.token as string | undefined;
  if (!member || typeof member.tableId !== "number" || !token) {
    throw new Error("登录响应缺少预期字段（member.tableId / token），请重试");
  }
  const session: CloudSession = { memberId: member.tableId, token, email, region };
  saveSession(session);
  return session;
}

/** 已登录则直接返回；否则尝试 .env 的 XBLOOM_EMAIL/PASSWORD 自动登录 */
export async function ensureSession(): Promise<CloudSession> {
  const cached = loadSession();
  if (cached) return cached;
  if (!hasAutoLoginCredentials()) {
    throw new Error(
      "未登录 xBloom 云端，且 .env 未配置 XBLOOM_EMAIL/XBLOOM_PASSWORD，请在页面手动登录",
    );
  }
  return login(config.xbloom.email, config.xbloom.password, defaultXbloomRegion());
}

/** .env 是否配置了 xBloom 凭据（决定是否具备自动登录能力） */
export function hasAutoLoginCredentials(): boolean {
  return Boolean(config.xbloom.email && config.xbloom.password);
}

/** 邮箱脱敏（保留前 2 位与域名），用于日志与前端提示，密码绝不出现在任何日志/响应 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  // 账号状态只需要帮助用户区分账户，不需要暴露完整本地部分。
  // 单字符邮箱完全隐藏，其余仅保留首字符，避免短邮箱被“脱敏”后仍原样泄露。
  const visible = at > 1 ? email[0] : "";
  return `${visible}***${email.slice(at)}`;
}

/** 云端判定会话失效（token 过期/未授权）时抛出，用于触发自动重登重试 */
export class AuthExpiredError extends Error {
  constructor(detail?: string) {
    super(detail || "云端登录态已失效");
    this.name = "AuthExpiredError";
  }
}

/** 鉴权类失败文案的启发式特征（仅用于非登录端点的响应判定） */
const AUTH_FAILURE_PATTERN =
  /token|unauthor|expired|invalid.{0,24}(member|login|auth)|登录|未登录|未授权|已过期|失效|凭证/i;

/**
 * 判断云端失败响应是否属于"会话/token 失效"类：
 * - 业务码 401/403（部分网关以 code/status/resultCode 下发）
 * - 失败文案命中 token/未登录/过期 等特征
 * 命中后调用方抛 AuthExpiredError，由 withSessionRetry 静默重登并重试一次。
 */
export function isAuthFailureResponse(resp: Record<string, unknown>): boolean {
  if (resp.result === "success") return false;
  const code = Number(resp.code ?? resp.status ?? resp.resultCode);
  if (code === 401 || code === 403) return true;
  const texts = [
    resp.msg,
    resp.message,
    resp.errorMsg,
    resp.errorMessage,
    resp.error,
    resp.reason,
    resp.tips,
    resp.info,
  ].filter((v): v is string => typeof v === "string");
  return texts.some((t) => AUTH_FAILURE_PATTERN.test(t));
}

/**
 * 带自动重登的鉴权调用包装：
 * 1. 会话优先取调用方传入的 preferred，其次 ensureSession（缓存/文件 → .env 自动登录）
 * 2. op 抛 AuthExpiredError（token 失效）时：清会话，用 .env 凭据静默重登，重试一次
 * 3. 凭据未配置 → 抛明确提示引导手动登录；自动登录失败 → 透出云端官方错误信息
 */
export async function withSessionRetry<T>(
  op: (session: CloudSession) => Promise<T>,
  preferred?: CloudSession,
): Promise<T> {
  let session = preferred ?? (await ensureSession());
  try {
    return await op(session);
  } catch (e) {
    if (!(e instanceof AuthExpiredError)) throw e;
    if (!hasAutoLoginCredentials()) {
      throw new Error(
        "云端登录态已失效，且 .env 未配置 XBLOOM_EMAIL/XBLOOM_PASSWORD，请在页面手动重新登录",
      );
    }
    clearSession();
    session = await login(config.xbloom.email, config.xbloom.password, session.region);
    return await op(session);
  }
}

/**
 * 启动自检：配置了凭据且无现成会话时，后台异步预热登录。
 * 失败只记日志不抛错（后续请求经 ensureSession/withSessionRetry 仍会自动重试）。
 */
export async function prewarmSession(): Promise<void> {
  if (loadSession() || !hasAutoLoginCredentials()) return;
  try {
    const session = await login(config.xbloom.email, config.xbloom.password, defaultXbloomRegion());
    console.log(`[xbloom][cloud] 启动预热自动登录成功（${maskEmail(session.email)}）`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[xbloom][cloud] 启动预热自动登录失败（不影响服务，后续请求会自动重试）：${msg}`);
  }
}

/** 鉴权请求的公共字段（照抄 xbloom-agent authBase） */
function authBase(session: CloudSession): Record<string, unknown> {
  return {
    interfaceVersion: 20240918,
    skey: "testskey",
    phoneType: "Android",
    memberId: session.memberId,
    clientType: 2,
    languageType: 3,
    token: session.token,
  };
}

/** 从 xBloom 各类失败响应里挑一条可读原因（照抄 xbloom-agent xbloomFailure 的取值顺序） */
export function pickFailureDetail(resp: Record<string, unknown>): string | undefined {
  const candidates = [
    resp.msg,
    resp.message,
    resp.errorMsg,
    resp.errorMessage,
    resp.error,
    resp.reason,
    resp.tips,
    resp.info,
  ];
  const found = candidates.find((v) => typeof v === "string" && (v as string).trim());
  return typeof found === "string" ? found : undefined;
}

// ---------------------------------------------------------------------------
// 分享 ID 编解码
// ---------------------------------------------------------------------------

/** tableId → shareId：btoa(String(tableId))，与官方 APP 分享链接一致 */
export function tableIdToShareId(tableId: number | string): string {
  return Buffer.from(String(tableId), "utf-8").toString("base64");
}

/** shareId → tableId：base64 解码；非法输入抛错 */
export function shareIdToTableId(shareId: string): string {
  const decoded = Buffer.from(shareId, "base64").toString("utf-8");
  if (!decoded || !/^\d+$/.test(decoded)) {
    throw new Error(`非法的分享 ID（base64 解码结果不是数字）: ${shareId}`);
  }
  return decoded;
}

/** 生成手机 APP 可导入的分享链接 */
export function buildShareUrl(
  tableId: number | string,
  region: XbloomRegion = defaultXbloomRegion(),
): string {
  if (isCnRegion(region)) return "";
  return `${shareBaseForRegion(region)}/?id=${encodeURIComponent(tableIdToShareId(tableId))}`;
}

// ---------------------------------------------------------------------------
// cupType 映射
// ---------------------------------------------------------------------------

/**
 * 内部 cupType → 云端编码。
 * 对照源码确认：2 = 咖啡（手冲/xDripper，源码咖啡配方固定 cupType:2）；
 * 3 = 其他器具；4 = 茶。本产品纯手冲语境，other 一律映射 3。
 */
/** 云端 cupType → 内部 cupType；2 = xdripper，其余（含历史遗留编码）保守归为 "other"（读取路径不抛错） */
export function cloudToCupType(code: unknown): CupType {
  if (code === 2) return "xdripper";
  return "other";
}

// ---------------------------------------------------------------------------
// 内部配方 → 云端 payload（集中转换，字段映射见注释）
// ---------------------------------------------------------------------------
// Shared xBloom cloud payload mapping
// ---------------------------------------------------------------------------

/** Desktop and hosted editions share one ratio/integer-pour implementation. */
export { alignIntegerPours, toCloudPayload };
export type { CloudPayloadResult };
export const isReachableTotal = isReachableCloudTotal;
export const nearestReachableTotal = nearestReachableCloudTotal;

// ---------------------------------------------------------------------------

export interface PublishResult {
  tableId: number;
  shareUrl: string;
  /** 映射层为通过官方校验而做的实际上传值调整说明（可能为空） */
  adjustments: string[];
  /** 发布后回读云端存储值的等式验证报告（任务#45；回读失败时为 undefined） */
  readback?: CloudIntegrityReport;
  /** 写入与回读是两个阶段；只有 verified 才代表手机 App 将读取到已核对的数据。 */
  verification: CloudWriteVerification;
}

export interface CloudWriteVerification {
  state: "verified" | "mismatch" | "unverified";
  message: string;
}

function cloudPourList(value: unknown): Array<Record<string, unknown>> | null {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}

/** Full executable-field comparison used only to recover a create whose HTTP response was lost. */
export function cloudRecipeMatchesPayload(
  row: CloudRecipeSummary,
  payload: Record<string, unknown>,
): boolean {
  const scalarFields: Array<keyof CloudRecipeSummary> = [
    "theName",
    "dose",
    "grandWater",
    "grinderSize",
    "rpm",
    "cupType",
    "theColor",
    "isEnableBypassWater",
    "bypassTemp",
    "bypassVolume",
    "isSetGrinderSize",
  ];
  if (
    scalarFields.some((field) =>
      typeof row[field] === "number"
        ? Math.abs(Number(row[field]) - Number(payload[field])) > 1e-9
        : row[field] !== payload[field],
    )
  ) {
    return false;
  }
  const expectedPours = cloudPourList(payload.pourDataJSONStr);
  const actualPours = cloudPourList(row.raw.pourList ?? row.raw.pourDataJSONStr);
  if (!expectedPours || !actualPours || expectedPours.length !== actualPours.length) return false;
  const fields = [
    "theName",
    "volume",
    "temperature",
    "flowRate",
    "pattern",
    "pausing",
    "isEnableVibrationBefore",
    "isEnableVibrationAfter",
  ];
  return expectedPours.every((expected, index) =>
    fields.every((field) => {
      const actual = actualPours[index]?.[field];
      return field === "theName"
        ? actual === expected[field]
        : Math.abs(Number(actual) - Number(expected[field])) <= 1e-9;
    }),
  );
}

export function newestCloudRecipeId(
  rows: ReadonlyArray<Pick<CloudRecipeSummary, "tableId">>,
): number | null {
  return rows.length > 0 ? Math.max(...rows.map((row) => row.tableId)) : null;
}

/** 发布后回读验证报告：云端实际存储的分段与 dose×ratio 等式是否成立（任务#45） */
export interface CloudIntegrityReport {
  tableId: number;
  /** Σ存储分段 == dose×ratio 精确成立 且 各段为整数毫升 */
  ok: boolean;
  dose: number;
  /** 云端存储的粉水比（一位小数） */
  ratio: number;
  /** dose×ratio（保留一位小数） */
  expectedTotal: number;
  /** 云端存储的各段水量 */
  storedPours: number[];
  storedSum: number;
  allInteger: boolean;
  message: string;
}

/**
 * 发布后回读验证（任务#45）：从云端读回实际存储的分段水量与 dose/ratio，
 * 断言 Σ分段 == dose×ratio 精确成立且各段为整数毫升。
 * 读取路径：列表接口找到配方 → 优先解析列表记录的 pourList，
 * 没有则走官方分享链接的 RecipeDetail（App 加载的同一数据源）。
 */
export async function readBackCloudRecipe(
  tableId: number,
  options: { session?: CloudSession } = {},
): Promise<CloudIntegrityReport> {
  const found = (await listMyRecipes(options)).find((r) => r.tableId === tableId);
  if (!found) throw new Error(`回读验证失败：云端列表中找不到配方 ${tableId}`);
  let pourListRaw: unknown = found.raw.pourList;
  if (pourListRaw === undefined || pourListRaw === null) {
    if (!found.shareUrl) throw new Error(`回读验证失败：配方 ${tableId} 无 pourList 且无分享链接`);
    const { raw } = await fetchSharedRecipe(found.shareUrl, options.session?.region);
    const vo = raw.recipeVo as CloudRecipeVo | undefined;
    pourListRaw = vo?.pourList;
  }
  const items: unknown[] =
    typeof pourListRaw === "string"
      ? (JSON.parse(pourListRaw) as unknown[])
      : Array.isArray(pourListRaw)
        ? pourListRaw
        : [];
  const storedPours = items.map((it) => toNum((it as CloudPourVo)?.volume, NaN));
  if (!storedPours.length || storedPours.some((v) => !Number.isFinite(v))) {
    throw new Error(`回读验证失败：配方 ${tableId} 的 pourList 缺少可读的 volume`);
  }
  const storedSum = r1(storedPours.reduce((s, v) => s + v, 0));
  const dose = found.dose;
  const ratio = r1(found.grandWater);
  const expectedTotal = r1(dose * ratio);
  const allInteger = storedPours.every((v) => Number.isInteger(v));
  const ok = Math.abs(storedSum - expectedTotal) < 1e-9 && allInteger;
  const message = ok
    ? `✓ Σ分段=${storedSum}ml == ${dose}g×${ratio} = ${expectedTotal}ml，各段均为整数毫升（[${storedPours.join(", ")}]）`
    : `✗ Σ分段=${storedSum}ml ≠ ${dose}g×${ratio} = ${expectedTotal}ml，或存在非整数段（[${storedPours.join(", ")}]，allInteger=${allInteger}）`;
  return { tableId, ok, dose, ratio, expectedTotal, storedPours, storedSum, allInteger, message };
}

const CREATE_RECOVERY_DELAYS_MS = [0, 250, 750, 1_500] as const;

async function recoverCreatedTableId(
  session: CloudSession,
  mapped: CloudPayloadResult,
  beforeIds: ReadonlySet<number>,
): Promise<number | null> {
  let lastError: unknown;
  for (const delayMs of CREATE_RECOVERY_DELAYS_MS) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const matches = (await listMyRecipes({ session })).filter(
        (row) => !beforeIds.has(row.tableId) && cloudRecipeMatchesPayload(row, mapped.payload),
      );
      // Identical creates from another client may race this one. Any matching row
      // absent from the pre-write snapshot proves that creating again is unsafe;
      // select a stable newest ID rather than manufacturing an additional duplicate.
      const recoveredId = newestCloudRecipeId(matches);
      if (recoveredId !== null) return recoveredId;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError !== undefined) throw lastError;
  return null;
}

async function completedCreateResult(
  tableId: number,
  session: CloudSession,
  mapped: CloudPayloadResult,
): Promise<PublishResult> {
  let shareUrl = buildShareUrl(tableId, session.region);
  if (isCnRegion(session.region)) {
    try {
      const found = (await listMyRecipes({ session })).find((row) => row.tableId === tableId);
      if (found?.shareUrl) shareUrl = found.shareUrl;
    } catch {
      // The row is already created. Missing CN share metadata does not invalidate it.
    }
  }
  const verified = await readBackBestEffort(tableId, session);
  return {
    tableId,
    shareUrl,
    adjustments: mapped.adjustments,
    verification: verified.verification,
    ...(verified.readback ? { readback: verified.readback } : {}),
  };
}

/**
 * 发布内部配方到云端账号，返回 tableId 与分享链接。
 * 需要有效会话（先 loadSession，否则传 undefined 走 ensureSession 自动登录）。
 */
export async function createRecipe(
  recipe: RecipeCore,
  options: { name?: string; session?: CloudSession; beforeIds?: readonly number[] } = {},
): Promise<PublishResult> {
  return withSessionRetry(async (session) => {
    const mapped = toCloudPayload(recipe, options.name);
    const payload = { ...authBase(session), ...mapped.payload };
    const encrypted = rsaEncrypt(payload);
    const beforeIds = options.beforeIds
      ? new Set(options.beforeIds)
      : new Set((await listMyRecipes({ session })).map((row) => row.tableId));
    const recover = () => recoverCreatedTableId(session, mapped, beforeIds);
    // 注意：加密结果本身是 base64 字符串，body 还要再 JSON.stringify 一层（带引号），照抄源码
    // 任务 #98：创建配方是非幂等写操作——保持不重试（默认 idempotent:false），
    // 防「首次 404 但后端已落库」时重试重复创建云端配方
    let resp: Record<string, unknown>;
    try {
      resp = await postJson("tuRecipeAdd.tuhtml", encrypted, { region: session.region });
    } catch (error) {
      const recoveredId = await recover();
      if (recoveredId === null) throw error;
      resp = { result: "success", tableId: recoveredId };
    }
    if (resp.result !== "success") {
      if (isAuthFailureResponse(resp)) throw new AuthExpiredError(pickFailureDetail(resp));
      const recoveredId = await recover();
      if (recoveredId !== null) resp = { result: "success", tableId: recoveredId };
    }
    if (resp.result !== "success") {
      const detail = pickFailureDetail(resp);
      throw new Error(detail ? `发布配方失败：${detail}` : "发布配方失败（云端未返回原因）");
    }
    const responseTableId = typeof resp.tableId === "number" ? resp.tableId : await recover();
    if (responseTableId === null) throw new Error("发布成功但响应缺少 tableId");
    return completedCreateResult(responseTableId, session, mapped);
  }, options.session);
}

/** Recover a create from its persisted pre-write snapshot without issuing another POST. */
export async function recoverCreatedRecipe(
  recipe: RecipeCore,
  beforeIds: readonly number[],
  options: { name?: string; session?: CloudSession } = {},
): Promise<PublishResult | null> {
  return withSessionRetry(async (session) => {
    const mapped = toCloudPayload(recipe, options.name);
    const tableId = await recoverCreatedTableId(session, mapped, new Set(beforeIds));
    return tableId === null ? null : completedCreateResult(tableId, session, mapped);
  }, options.session);
}

/** 回读验证 best-effort 包装：失败只记日志不阻断发布链路 */
async function readBackBestEffort(
  tableId: number,
  session: CloudSession,
): Promise<{ verification: CloudWriteVerification; readback?: CloudIntegrityReport }> {
  try {
    const report = await readBackCloudRecipe(tableId, { session });
    console.log(`[xbloom][cloud] 发布回读验证 tableId=${tableId}: ${report.message}`);
    return {
      readback: report,
      verification: {
        state: report.ok ? "verified" : "mismatch",
        message: report.message,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[xbloom][cloud] 发布已写入但回读待确认 tableId=${tableId}: ${msg}`);
    return {
      verification: {
        state: "unverified",
        message: `云端已写入；回读暂未完成：${msg}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// 我的配方列表 / 更新 / 删除（照 xbloom-agent listRecipes/editRecipe/deleteRecipe）
// ---------------------------------------------------------------------------

/** 云端配方列表项（tuMyTeaRecipeCreated.tuhtml 返回的 list 元素，字段容错） */
export interface CloudRecipeSummary {
  tableId: number;
  theName: string;
  /** 粉量（g） */
  dose: number;
  /** 云端语义：粉水比 ratio（不是总水量） */
  grandWater: number;
  grinderSize: number;
  rpm: number;
  cupType: number;
  theColor: string;
  isEnableBypassWater: number;
  bypassTemp: number;
  bypassVolume: number;
  isSetGrinderSize: number;
  shareUrl: string;
  /** 原始记录（含 pourList/shareRecipeLink 等未结构化字段） */
  raw: Record<string, unknown>;
}

export async function paginateRecipePages(
  fetchPage: (pageNumber: number, countPerPage: number) => Promise<Record<string, unknown>[]>,
  options: {
    pageNumber?: number;
    countPerPage?: number;
    maxPages?: number;
  } = {},
): Promise<Record<string, unknown>[]> {
  const pageNumber = boundedPositiveInteger(options.pageNumber, 1, Number.MAX_SAFE_INTEGER);
  const countPerPage = boundedPositiveInteger(
    options.countPerPage,
    XBLOOM_RECIPE_PAGE_SIZE,
    XBLOOM_RECIPE_PAGE_SIZE,
  );
  const maxPages = boundedPositiveInteger(
    options.maxPages,
    XBLOOM_MAX_RECIPE_PAGES,
    XBLOOM_MAX_RECIPE_PAGES,
  );
  const rows: Record<string, unknown>[] = [];
  const seenRows = new Set<string>();
  const seenPages = new Set<string>();

  for (let offset = 0; offset < maxPages; offset += 1) {
    const page = await fetchPage(pageNumber + offset, countPerPage);
    const pageSignature = JSON.stringify(
      page.map((row) => String(row.tableId ?? JSON.stringify(row))),
    );
    if (seenPages.has(pageSignature)) break;
    seenPages.add(pageSignature);
    for (const row of page) {
      const key = String(row.tableId ?? JSON.stringify(row));
      if (!seenRows.has(key)) {
        seenRows.add(key);
        rows.push(row);
      }
    }
    if (page.length < countPerPage) break;
  }
  return rows;
}

/**
 * 拉取当前账号创建的配方列表。
 * 照源码字段：authBase + { pageNumber, countPerPage, adaptedModel: 1 }。
 */
export async function listMyRecipes(
  options: { session?: CloudSession; pageNumber?: number; countPerPage?: number } = {},
): Promise<CloudRecipeSummary[]> {
  return withSessionRetry(async (session) => {
    const list = await paginateRecipePages(
      async (pageNumber, countPerPage) => {
        const payload = {
          ...authBase(session),
          pageNumber,
          countPerPage,
          adaptedModel: 1,
        };
        const resp = await postJson("tuMyTeaRecipeCreated.tuhtml", rsaEncrypt(payload), {
          idempotent: true,
          region: session.region,
        });
        if (resp.result !== "success") {
          if (isAuthFailureResponse(resp)) throw new AuthExpiredError(pickFailureDetail(resp));
          const detail = pickFailureDetail(resp);
          throw new Error(
            detail ? `拉取配方列表失败：${detail}` : "拉取配方列表失败（云端未返回原因）",
          );
        }
        return Array.isArray(resp.list) ? (resp.list as Record<string, unknown>[]) : [];
      },
      {
        pageNumber: options.pageNumber,
        countPerPage: options.countPerPage,
        maxPages: options.pageNumber === undefined ? XBLOOM_MAX_RECIPE_PAGES : 1,
      },
    );
    return list.map((r) => {
      const tableId = toNum(r.tableId, 0);
      return {
        tableId,
        theName: typeof r.theName === "string" ? r.theName : "",
        dose: toNum(r.dose, 0),
        grandWater: toNum(r.grandWater, 0),
        grinderSize: toNum(r.grinderSize, 0),
        rpm: toNum(r.rpm, 0),
        cupType: toNum(r.cupType, 2),
        theColor: typeof r.theColor === "string" ? r.theColor : "#C9D5B8",
        isEnableBypassWater: toNum(r.isEnableBypassWater, 2),
        bypassTemp: toNum(r.bypassTemp, 85),
        bypassVolume: toNum(r.bypassVolume, 5),
        isSetGrinderSize: toNum(r.isSetGrinderSize, 1),
        // 中国区优先用官方 shareRecipeLink（分享 ID 为服务端密文）
        shareUrl:
          typeof r.shareRecipeLink === "string" && (r.shareRecipeLink as string).startsWith("http")
            ? (r.shareRecipeLink as string)
            : tableId
              ? buildShareUrl(tableId, session.region)
              : "",
        raw: r,
      };
    });
  }, options.session);
}

/**
 * 更新云端配方（tuRecipeUpdate.tuhtml）：authBase + tableId + 全量配方字段。
 * 字段集与 tuRecipeAdd 一致（照 xbloom-agent editRecipe 的 payload 结构）。
 */
export async function updateRecipe(
  tableId: number,
  recipe: RecipeCore,
  options: { name?: string; session?: CloudSession } = {},
): Promise<PublishResult> {
  return withSessionRetry(async (session) => {
    const mapped = toCloudPayload(recipe, options.name);
    const payload = {
      ...authBase(session),
      tableId,
      ...mapped.payload,
    };
    // 任务 #98：更新配方是写操作——保持不重试（重复下发虽为覆盖写，
    // 但与其他写操作保持一致的保守语义，失败由用户显式重试）
    const resp = await postJson("tuRecipeUpdate.tuhtml", rsaEncrypt(payload), {
      region: session.region,
    });
    if (resp.result !== "success") {
      if (isAuthFailureResponse(resp)) throw new AuthExpiredError(pickFailureDetail(resp));
      const detail = pickFailureDetail(resp);
      throw new Error(detail ? `更新配方失败：${detail}` : "更新配方失败（云端未返回原因）");
    }
    let shareUrl = buildShareUrl(tableId, session.region);
    if (isCnRegion(session.region)) {
      try {
        const found = (await listMyRecipes({ session })).find((r) => r.tableId === tableId);
        if (found?.shareUrl) shareUrl = found.shareUrl;
      } catch {
        /* 官方链接暂未返回时保持空分享链接。 */
      }
    }
    const verified = await readBackBestEffort(tableId, session);
    return {
      tableId,
      shareUrl,
      adjustments: mapped.adjustments,
      verification: verified.verification,
      ...(verified.readback ? { readback: verified.readback } : {}),
    };
  }, options.session);
}

/** 删除云端配方（tuRecipeDelete.tuhtml）：authBase + tableId */
export async function deleteRecipe(
  tableId: number,
  options: { session?: CloudSession } = {},
): Promise<void> {
  return withSessionRetry(async (session) => {
    // 任务 #98：删除是写操作——保持不重试（首次失败时可能已删除，重试会报「不存在」干扰判定）
    const resp = await postJson(
      "tuRecipeDelete.tuhtml",
      rsaEncrypt({ ...authBase(session), tableId }),
      { region: session.region },
    );
    if (resp.result !== "success") {
      if (isAuthFailureResponse(resp)) throw new AuthExpiredError(pickFailureDetail(resp));
      const detail = pickFailureDetail(resp);
      throw new Error(detail ? `删除配方失败：${detail}` : "删除配方失败（云端未返回原因）");
    }
  }, options.session);
}

// ---------------------------------------------------------------------------
// 分享配方读取（免登录）与解析
// ---------------------------------------------------------------------------

/** 云端 recipeVo 的单段注水（容错解析，字段名以 RecipeDetail 返回为准） */
interface CloudPourVo {
  theName?: unknown;
  volume?: unknown;
  temperature?: unknown;
  flowRate?: unknown;
  pattern?: unknown;
  pausing?: unknown;
  isEnableVibrationBefore?: unknown;
  isEnableVibrationAfter?: unknown;
}

/** 云端 recipeVo（RecipeDetail.html 返回的 recipe 对象，字段容错） */
export interface CloudRecipeVo {
  theName?: unknown;
  dose?: unknown;
  grandWater?: unknown; // 云端语义 = 粉水比 ratio
  grinderSize?: unknown;
  rpm?: unknown;
  cupType?: unknown;
  isEnableBypassWater?: unknown; // 1 开 / 2 关
  bypassTemp?: unknown;
  bypassVolume?: unknown;
  isSetGrinderSize?: unknown; // 1 本机磨豆 / 2 预磨粉
  theColor?: unknown;
  pourList?: unknown; // 数组或 JSON 字符串都兼容
}

function toNum(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 把云端 recipeVo 解析为内部配方模型。
 * 云端 grandWater 是粉水比：内部总水量 = dose × ratio（保留一位小数）。
 * pattern 走 cloudToPattern（center=1, spiral=2, circular=3）。
 * 新增官方字段反向映射：isEnableBypassWater / isEnableVibration 系列值为 1 → true，
 * isSetGrinderSize 非法值回退 1，theColor 非法回退默认色。
 */
export function parseRecipeVo(vo: CloudRecipeVo): Recipe {
  const dose = toNum(vo.dose, 15);
  const ratio = toNum(vo.grandWater, 15);
  const rawPours: unknown[] =
    typeof vo.pourList === "string"
      ? (JSON.parse(vo.pourList) as unknown[])
      : Array.isArray(vo.pourList)
        ? vo.pourList
        : [];
  const pours = rawPours.map((item) => {
    const p = (item ?? {}) as CloudPourVo;
    const theName =
      typeof p.theName === "string" && p.theName.trim() ? p.theName.trim() : undefined;
    return {
      volume: toNum(p.volume, 30),
      temperature: toNum(p.temperature, 93),
      flowRate: toNum(p.flowRate, 3.0),
      pattern: cloudToPattern(toNum(p.pattern, 2)),
      pausing: toNum(p.pausing, 0),
      vibBefore: toNum(p.isEnableVibrationBefore, 2) === 1,
      vibAfter: toNum(p.isEnableVibrationAfter, 2) === 1,
      ...(theName ? { theName } : {}),
    };
  });
  if (!pours.length) {
    throw new Error("云端配方缺少 pourList，无法解析");
  }
  const grandWater = Math.round(dose * ratio * 10) / 10;
  const grinderModeRaw = toNum(vo.isSetGrinderSize, 1);
  const theColor =
    typeof vo.theColor === "string" && /^#[0-9a-fA-F]{6}$/.test(vo.theColor)
      ? vo.theColor
      : undefined;
  return RecipeSchema.parse({
    name: typeof vo.theName === "string" && vo.theName.trim() ? vo.theName : "导入配方",
    cupType: cloudToCupType(vo.cupType),
    doseGrams: dose,
    grinderSize: toNum(vo.grinderSize, 70),
    rpm: toNum(vo.rpm, 80),
    grandWater,
    pours,
    bypassEnabled: toNum(vo.isEnableBypassWater, 2) === 1,
    bypassVolume: Math.round(toNum(vo.bypassVolume, 5)),
    bypassTemp: toNum(vo.bypassTemp, 85),
    isSetGrinderSize: grinderModeRaw === 2 ? 2 : 1,
    ...(theColor ? { theColor } : {}),
  });
}

/**
 * 免登录读取分享配方：shareId → RecipeDetail → 内部配方。
 * shareId 也可直接传完整分享链接（自动提取 id 参数）。
 */
export async function fetchSharedRecipe(
  shareId: string,
  requestedRegion: XbloomRegion = defaultXbloomRegion(),
): Promise<{ recipe: Recipe; raw: Record<string, unknown> }> {
  let id = shareId.trim();
  let region = requestedRegion;
  if (id.includes("share-h5.xbloom.com") || id.includes("share-h5.xbloomcoffee.cn")) {
    const url = new URL(id);
    region = url.hostname === new URL(SHARE_BASE_CN).hostname ? "cn" : "global";
    const param = url.searchParams.get("id");
    if (!param) throw new Error(`分享链接缺少 id 参数: ${shareId}`);
    id = param;
  }
  const resp = await postJson(
    "RecipeDetail.html",
    {
      tableIdOfRSA: id,
      interfaceVersion: 19700101,
      skey: "testskey",
    },
    { idempotent: true, region }, // 任务 #98：免登录只读查询，幂等可重试
  );
  if (resp.result !== "success") {
    const detail = pickFailureDetail(resp);
    throw new Error(
      detail ? `读取分享配方失败：${detail}` : "读取分享配方失败（链接无效或配方已删除）",
    );
  }
  const vo = resp.recipeVo as CloudRecipeVo | undefined;
  if (!vo || typeof vo !== "object") {
    throw new Error("读取分享配方成功但响应缺少 recipeVo");
  }
  return { recipe: parseRecipeVo(vo), raw: resp };
}

// ---------------------------------------------------------------------------
// 连通性探测
// ---------------------------------------------------------------------------

export interface ReachabilityReport {
  reachable: boolean;
  proxyUsed: boolean;
  message: string;
}

/**
 * 快速探测云端可达性（默认 5s 快速失败）：
 * 直接 GET 分享 H5 首页，任何 HTTP 响应都算可达；只有网络层错误/超时算不可达。
 */
export async function checkReachable(
  timeoutMs: number = PROBE_TIMEOUT_MS,
  region: XbloomRegion = defaultXbloomRegion(),
): Promise<ReachabilityReport> {
  const used = proxyUrl();
  const dispatcher = getDispatcher();
  const init: Record<string, unknown> = {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (dispatcher) init.dispatcher = dispatcher;
  try {
    const resp = await undici.fetch(shareBaseForRegion(region), init as UndiciRequestInit);
    return {
      reachable: true,
      proxyUsed: Boolean(used),
      message: `云端可达（HTTP ${resp.status}${used ? "，经已配置代理" : "，直连"}）`,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      reachable: false,
      proxyUsed: Boolean(used),
      message: used
        ? `云端不可达（已尝试已配置代理）：${reason}`
        : `云端不可达（直连，未配置 HTTPS_PROXY/ALL_PROXY）：${reason}`,
    };
  }
}
