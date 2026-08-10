/**
 * 本机模型接口设置：在不改写 .env 的前提下，为当前单机工作台提供可持久化的
 * LLM 地址、模型链和密钥覆盖。密钥只在服务端读写，公共响应只披露是否已配置。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config, type AppConfig } from "../config.js";
import { atomicWriteJson } from "./data-io.js";
import { withFileLock } from "./store-mutex.js";

type MutableLlmConfig = AppConfig["llm"];

const here = path.dirname(fileURLToPath(import.meta.url));
// src/lib 与 dist/lib 到仓库根均为 ../../..
export const LLM_SETTINGS_FILE = path.resolve(here, "../../../data/llm-settings.json");
const DPAPI_ENTROPY = "xbloom-ai-brew-studio:llm-settings:v3";

/** v2 旧格式的相邻密钥路径；只用于保存成功或恢复设置时清理历史遗留。 */
function legacyLlmSettingsKeyFile(file: string = LLM_SETTINGS_FILE): string {
  return path.resolve(file) === path.resolve(LLM_SETTINGS_FILE)
    ? path.join(path.dirname(file), ".llm-settings.key")
    : `${file}.key`;
}

/** 进程启动时从 .env 得到的原始值；恢复设置时回到这一份，而不是硬编码默认值。 */
export const ENV_LLM_DEFAULTS: Readonly<MutableLlmConfig> = Object.freeze({ ...config.llm });

function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** 统一去掉尾部斜杠，避免调用端拼接出 //chat/completions。 */
export function normalizeLlmBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!isValidBaseUrl(trimmed)) {
    throw new Error(
      "模型 API 地址需使用 HTTPS；本机 localhost/127.0.0.1 可使用 HTTP，且地址不含账号、查询参数或锚点",
    );
  }
  return new URL(trimmed).toString().replace(/\/+$/, "");
}

const BaseUrlSchema = z
  .string()
  .trim()
  .min(1, "模型 API 地址不能为空")
  .max(2048, "模型 API 地址过长")
  .refine(
    isValidBaseUrl,
    "模型 API 地址需使用 HTTPS；本机地址可使用 HTTP，且不含账号、查询参数或锚点",
  )
  .transform(normalizeLlmBaseUrl);

const RequiredModelSchema = z
  .string()
  .trim()
  .min(1, "主模型不能为空")
  .max(160, "模型名称过长")
  .refine((value) => !/[\r\n\0]/.test(value), "模型名称含有非法字符");

const OptionalModelSchema = z
  .string()
  .trim()
  .max(160, "模型名称过长")
  .refine((value) => !/[\r\n\0]/.test(value), "模型名称含有非法字符");

const ApiKeySchema = z
  .string()
  .trim()
  .min(1, "API Key 不能为空")
  .max(8192, "API Key 过长")
  .refine((value) => !/[\r\n\0]/.test(value), "API Key 含有非法字符");

export const LlmSettingsPatchSchema = z
  .object({
    baseUrl: BaseUrlSchema.optional(),
    model: RequiredModelSchema.optional(),
    fallbackModel: OptionalModelSchema.optional(),
    thirdModel: OptionalModelSchema.optional(),
    apiKey: ApiKeySchema.optional(),
    fallbackApiKey: ApiKeySchema.optional(),
    /** 地址跨 origin 且沿用已有 Key 时，由前端显式二次确认；仅用于本次请求，不落盘。 */
    confirmEndpointChange: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "至少提交一项模型设置");

export type LlmSettingsPatch = z.infer<typeof LlmSettingsPatchSchema>;

export class LlmEndpointConfirmationError extends Error {
  constructor() {
    super("模型地址已更换；沿用现有 API Key 前需要再次确认");
    this.name = "LlmEndpointConfirmationError";
  }
}

const EncryptedSecretSchema = z
  .object({
    algorithm: z.literal("windows-dpapi"),
    ciphertext: z.string().min(1),
  })
  .strict();

type EncryptedSecret = z.infer<typeof EncryptedSecretSchema>;

const StoredLlmSettingsFileSchema = z
  .object({
    version: z.literal(3),
    updatedAt: z.string(),
    baseUrl: BaseUrlSchema.optional(),
    model: RequiredModelSchema.optional(),
    fallbackModel: OptionalModelSchema.optional(),
    thirdModel: OptionalModelSchema.optional(),
    apiKeyEncrypted: EncryptedSecretSchema.optional(),
    fallbackApiKeyEncrypted: EncryptedSecretSchema.optional(),
  })
  .strict();

export interface StoredLlmSettings {
  version: 3;
  updatedAt: string;
  baseUrl?: string;
  model?: string;
  fallbackModel?: string;
  thirdModel?: string;
  apiKey?: string;
  fallbackApiKey?: string;
}

export interface PublicLlmSettings {
  baseUrl: string;
  model: string;
  fallbackModel: string;
  thirdModel: string;
  apiKeyConfigured: boolean;
  fallbackApiKeyConfigured: boolean;
  source: "environment" | "local";
  /** 文件是否存在；文件损坏时仍为 true，让界面保留恢复入口。 */
  localOverridePresent: boolean;
  /** false 表示文件存在但解析或系统解密失败。 */
  localOverrideValid: boolean;
  updatedAt?: string;
}

const DPAPI_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$request=[Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$bytes=[Convert]::FromBase64String([string]$request.data)",
  `$entropy=[Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
  "if ([string]$request.action -eq 'protect') {$output=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)} elseif ([string]$request.action -eq 'unprotect') {$output=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)} else {throw 'Unsupported DPAPI action'}",
  "[Console]::Out.Write([Convert]::ToBase64String($output))",
].join(";");

/**
 * 用 Windows DPAPI 将密钥绑定到当前 Windows 用户；磁盘上只留下系统保护后的密文，
 * 读取项目 data 目录本身不足以还原 API Key。敏感正文通过 stdin 传入，不进入命令行参数。
 */
function dpapiTransform(action: "protect" | "unprotect", input: Buffer): Buffer {
  if (process.platform !== "win32") {
    throw new Error("本机密钥保存需要 Windows 用户数据保护服务");
  }
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const output = execFileSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT],
    {
      input: JSON.stringify({ action, data: input.toString("base64") }),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 32 * 1024,
    },
  ).trim();
  const result = Buffer.from(output, "base64");
  if (result.length === 0) throw new Error("Windows 用户数据保护服务返回空结果");
  return result;
}

function encryptSecret(value: string): EncryptedSecret {
  return {
    algorithm: "windows-dpapi",
    ciphertext: dpapiTransform("protect", Buffer.from(value, "utf8")).toString("base64"),
  };
}

function decryptSecret(value: EncryptedSecret): string {
  return dpapiTransform("unprotect", Buffer.from(value.ciphertext, "base64")).toString("utf8");
}

export function readStoredLlmSettings(file: string = LLM_SETTINGS_FILE): StoredLlmSettings | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const stored = StoredLlmSettingsFileSchema.parse(JSON.parse(raw) as unknown);
  return {
    version: 3,
    updatedAt: stored.updatedAt,
    ...(stored.baseUrl !== undefined ? { baseUrl: stored.baseUrl } : {}),
    ...(stored.model !== undefined ? { model: stored.model } : {}),
    ...(stored.fallbackModel !== undefined ? { fallbackModel: stored.fallbackModel } : {}),
    ...(stored.thirdModel !== undefined ? { thirdModel: stored.thirdModel } : {}),
    ...(stored.apiKeyEncrypted
      ? { apiKey: ApiKeySchema.parse(decryptSecret(stored.apiKeyEncrypted)) }
      : {}),
    ...(stored.fallbackApiKeyEncrypted
      ? { fallbackApiKey: ApiKeySchema.parse(decryptSecret(stored.fallbackApiKeyEncrypted)) }
      : {}),
  };
}

/** 先恢复环境默认值再覆盖本机设置，确保删除/重置字段不会残留在内存。 */
export function applyStoredLlmSettings(
  stored: StoredLlmSettings | null,
  target: MutableLlmConfig = config.llm,
  defaults: Readonly<MutableLlmConfig> = ENV_LLM_DEFAULTS,
): void {
  Object.assign(target, defaults);
  if (!stored) return;
  for (const key of [
    "baseUrl",
    "apiKey",
    "fallbackApiKey",
    "model",
    "fallbackModel",
    "thirdModel",
  ] as const) {
    const value = stored[key];
    if (value !== undefined) target[key] = value;
  }
}

export function publicLlmSettings(
  target: MutableLlmConfig = config.llm,
  stored: StoredLlmSettings | null = null,
  localOverridePresent: boolean = stored !== null,
  localOverrideValid = true,
): PublicLlmSettings {
  return {
    baseUrl: target.baseUrl,
    model: target.model,
    fallbackModel: target.fallbackModel,
    thirdModel: target.thirdModel,
    apiKeyConfigured: target.apiKey.trim().length > 0,
    fallbackApiKeyConfigured: target.fallbackApiKey.trim().length > 0,
    source: stored ? "local" : "environment",
    localOverridePresent,
    localOverrideValid,
    ...(stored?.updatedAt ? { updatedAt: stored.updatedAt } : {}),
  };
}

/** 启动时应用本机覆盖；配置文件异常时保留 .env，并且日志不包含任何密钥值。 */
export function initializeLlmSettings(
  file: string = LLM_SETTINGS_FILE,
  target: MutableLlmConfig = config.llm,
  defaults: Readonly<MutableLlmConfig> = ENV_LLM_DEFAULTS,
): PublicLlmSettings {
  try {
    const stored = readStoredLlmSettings(file);
    applyStoredLlmSettings(stored, target, defaults);
    return publicLlmSettings(target, stored);
  } catch (error) {
    Object.assign(target, defaults);
    console.warn(`[llm-settings] 本机模型设置读取失败，已继续使用 .env：${(error as Error).name}`);
    return publicLlmSettings(target, null, fs.existsSync(file), false);
  }
}

/**
 * 运行期只读快照：与写入共用文件锁，但不重复改写全局 config，避免 GET 与 PUT
 * 交错时让旧磁盘快照覆盖刚刚生效的新设置。
 */
export function currentLlmSettings(
  file: string = LLM_SETTINGS_FILE,
  target: MutableLlmConfig = config.llm,
): Promise<PublicLlmSettings> {
  return withFileLock(file, () => {
    try {
      return publicLlmSettings(target, readStoredLlmSettings(file));
    } catch (error) {
      console.warn(`[llm-settings] 本机模型设置状态读取失败：${(error as Error).name}`);
      return publicLlmSettings(target, null, fs.existsSync(file), false);
    }
  });
}

function writeStoredLlmSettings(file: string, settings: StoredLlmSettings): void {
  atomicWriteJson(file, {
    version: 3,
    updatedAt: settings.updatedAt,
    ...(settings.baseUrl !== undefined ? { baseUrl: settings.baseUrl } : {}),
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(settings.fallbackModel !== undefined ? { fallbackModel: settings.fallbackModel } : {}),
    ...(settings.thirdModel !== undefined ? { thirdModel: settings.thirdModel } : {}),
    ...(settings.apiKey ? { apiKeyEncrypted: encryptSecret(settings.apiKey) } : {}),
    ...(settings.fallbackApiKey
      ? { fallbackApiKeyEncrypted: encryptSecret(settings.fallbackApiKey) }
      : {}),
  });
  // Windows 会按 ACL 处理；类 Unix 环境下收紧为仅当前用户可读写。
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 文件已成功写入，权限能力由当前平台决定。
  }
  // v2 曾使用相邻主密钥文件；v3 写入成功后清理该旧格式遗留。
  try {
    fs.unlinkSync(legacyLlmSettingsKeyFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function updateLlmSettings(
  input: unknown,
  file: string = LLM_SETTINGS_FILE,
  target: MutableLlmConfig = config.llm,
  defaults: Readonly<MutableLlmConfig> = ENV_LLM_DEFAULTS,
): Promise<PublicLlmSettings> {
  const parsedPatch = LlmSettingsPatchSchema.parse(input);
  const { confirmEndpointChange, ...patch } = parsedPatch;
  return withFileLock(file, () => {
    let current: StoredLlmSettings | null = null;
    try {
      current = readStoredLlmSettings(file);
    } catch {
      // 用户主动保存时用本次合法输入修复损坏的本机设置文件。
      current = null;
    }
    const activeBaseUrl = current?.baseUrl ?? defaults.baseUrl;
    const nextBaseUrl = patch.baseUrl ?? activeBaseUrl;
    const endpointChanged = new URL(activeBaseUrl).origin !== new URL(nextBaseUrl).origin;
    const wouldReuseSecret = Boolean(current?.apiKey ?? defaults.apiKey) && !patch.apiKey;
    if (endpointChanged && wouldReuseSecret && !confirmEndpointChange) {
      throw new LlmEndpointConfirmationError();
    }

    const next: StoredLlmSettings = {
      version: 3,
      ...(current ?? {}),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    writeStoredLlmSettings(file, next);
    applyStoredLlmSettings(next, target, defaults);
    return publicLlmSettings(target, next);
  });
}

export async function resetLlmSettings(
  file: string = LLM_SETTINGS_FILE,
  target: MutableLlmConfig = config.llm,
  defaults: Readonly<MutableLlmConfig> = ENV_LLM_DEFAULTS,
): Promise<PublicLlmSettings> {
  return withFileLock(file, () => {
    for (const targetFile of [file, legacyLlmSettingsKeyFile(file)]) {
      try {
        fs.unlinkSync(targetFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    applyStoredLlmSettings(null, target, defaults);
    return publicLlmSettings(target, null);
  });
}
