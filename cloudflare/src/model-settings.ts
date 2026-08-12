import {
  MODEL_PROVIDER_PRESETS,
  detectModelProvider,
  discoverModels,
  equivalentModelBaseUrls,
  normalizeModelBaseUrl,
  testModelConnection,
  type ModelConnection,
  type ModelProvider,
} from "../../shared/src/model-provider.ts";
import type { AuthUser } from "./auth.ts";
import { decryptText, encryptText } from "./crypto.ts";

export interface ModelSettingsEnv {
  DB: D1Database;
  APP_DATA_ENCRYPTION_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_API_KEY?: string;
}

interface ModelSettingsRow {
  provider: ModelProvider;
  base_url: string;
  model: string;
  fallback_model: string;
  third_model: string;
  encrypted_api_key: string;
  updated_at: string;
}

interface StoredApiKeys {
  primary: string;
  fallback: string;
}

export function modelValidationTargets(
  primaryModel: string,
  fallbackModel: string,
  thirdModel: string,
  primaryApiKey: string,
  fallbackApiKey: string,
): Array<{ model: string; apiKey: string }> {
  const targets = [
    { model: primaryModel, apiKey: primaryApiKey },
    ...(fallbackModel ? [{ model: fallbackModel, apiKey: fallbackApiKey }] : []),
    ...(thirdModel ? [{ model: thirdModel, apiKey: fallbackApiKey }] : []),
  ];
  const seen = new Set<string>();
  return targets.filter((target) => {
    const identity = `${target.model}\0${target.apiKey}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export interface PublicModelSettings {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  fallbackModel: string;
  thirdModel: string;
  apiKeyConfigured: boolean;
  fallbackApiKeyConfigured: boolean;
  source: "environment" | "user" | "unconfigured";
  localOverridePresent: boolean;
  localOverrideValid: boolean;
  updatedAt?: string;
}

function encryptionSecret(env: ModelSettingsEnv): string {
  if (!env.APP_DATA_ENCRYPTION_KEY?.trim()) {
    throw new Error("站点尚未配置 APP_DATA_ENCRYPTION_KEY");
  }
  return env.APP_DATA_ENCRYPTION_KEY;
}

function providerValue(value: unknown, baseUrl: string): ModelProvider {
  if (value === "openai-compatible" || value === "anthropic" || value === "gemini") return value;
  return detectModelProvider(baseUrl);
}

function stringField(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`请填写${name}`);
  const result = value.trim();
  if (result.length > maxLength || /[\r\n\0]/.test(result)) throw new Error(`${name}格式有误`);
  return result;
}

function optionalModel(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return stringField(value, "备用模型", 200);
}

function apiKeyValue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("API Key 格式有误");
  const result = value.trim();
  if (!result || result.length > 8192 || /[\r\n\0]/.test(result))
    throw new Error("API Key 格式有误");
  return result;
}

export function parseStoredApiKeys(value: string): StoredApiKeys {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.primary === "string" && parsed.primary) {
      return {
        primary: parsed.primary,
        fallback:
          typeof parsed.fallback === "string" && parsed.fallback ? parsed.fallback : parsed.primary,
      };
    }
  } catch {
    // 旧版载荷是单一 API Key 明文（外层仍由 AES-GCM 加密），按主/备用共用迁移。
  }
  return { primary: value, fallback: value };
}

async function decryptedApiKeys(
  env: ModelSettingsEnv,
  row: ModelSettingsRow,
): Promise<StoredApiKeys> {
  return parseStoredApiKeys(await decryptText(row.encrypted_api_key, encryptionSecret(env)));
}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 32_768) throw new Error("请求体过大");
  const parsed = JSON.parse(text || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("请求格式有误");
  return parsed as Record<string, unknown>;
}

async function settingsRow(
  env: ModelSettingsEnv,
  userId: string,
): Promise<ModelSettingsRow | null> {
  return env.DB.prepare(
    `SELECT provider,base_url,model,fallback_model,third_model,encrypted_api_key,updated_at
       FROM user_model_settings WHERE user_id=?`,
  )
    .bind(userId)
    .first<ModelSettingsRow>();
}

export async function publicModelSettings(
  env: ModelSettingsEnv,
  user: AuthUser | null,
): Promise<PublicModelSettings> {
  const row = user ? await settingsRow(env, user.id) : null;
  if (row) {
    const keys = await decryptedApiKeys(env, row);
    return {
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      fallbackModel: row.fallback_model,
      thirdModel: row.third_model,
      apiKeyConfigured: Boolean(row.encrypted_api_key),
      fallbackApiKeyConfigured: Boolean(keys.fallback),
      source: "user",
      localOverridePresent: true,
      localOverrideValid: true,
      updatedAt: row.updated_at,
    };
  }
  if (user) {
    return {
      provider: "openai-compatible",
      baseUrl: "",
      model: "",
      fallbackModel: "",
      thirdModel: "",
      apiKeyConfigured: false,
      fallbackApiKeyConfigured: false,
      source: "unconfigured",
      localOverridePresent: false,
      localOverrideValid: true,
    };
  }
  if (env.LLM_BASE_URL && env.LLM_MODEL && env.LLM_API_KEY) {
    return {
      provider: detectModelProvider(env.LLM_BASE_URL),
      baseUrl: env.LLM_BASE_URL,
      model: env.LLM_MODEL,
      fallbackModel: "",
      thirdModel: "",
      apiKeyConfigured: true,
      fallbackApiKeyConfigured: false,
      source: "environment",
      localOverridePresent: false,
      localOverrideValid: true,
    };
  }
  return {
    provider: "openai-compatible",
    baseUrl: "",
    model: "",
    fallbackModel: "",
    thirdModel: "",
    apiKeyConfigured: false,
    fallbackApiKeyConfigured: false,
    source: "unconfigured",
    localOverridePresent: false,
    localOverrideValid: true,
  };
}

export async function modelConnectionForUser(
  env: ModelSettingsEnv,
  user: AuthUser | null,
): Promise<
  | (ModelConnection & {
      model: string;
      fallbackModel: string;
      thirdModel: string;
      fallbackApiKey: string;
    })
  | null
> {
  const row = user ? await settingsRow(env, user.id) : null;
  if (row) {
    const keys = await decryptedApiKeys(env, row);
    return {
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      fallbackModel: row.fallback_model,
      thirdModel: row.third_model,
      apiKey: keys.primary,
      fallbackApiKey: keys.fallback,
    };
  }
  if (user) return null;
  if (env.LLM_BASE_URL && env.LLM_MODEL && env.LLM_API_KEY) {
    return {
      provider: detectModelProvider(env.LLM_BASE_URL),
      baseUrl: normalizeModelBaseUrl(env.LLM_BASE_URL),
      model: env.LLM_MODEL,
      fallbackModel: "",
      thirdModel: "",
      apiKey: env.LLM_API_KEY,
      fallbackApiKey: env.LLM_API_KEY,
    };
  }
  return null;
}

async function draftConnection(
  body: Record<string, unknown>,
  env: ModelSettingsEnv,
  user: AuthUser,
): Promise<ModelConnection & { model?: string }> {
  const existing = await settingsRow(env, user.id);
  const baseUrl = normalizeModelBaseUrl(stringField(body.baseUrl, "模型 API 地址", 2048));
  const provider = providerValue(body.provider, baseUrl);
  const suppliedKey = apiKeyValue(body.apiKey);
  const sameEndpoint = existing
    ? equivalentModelBaseUrls(existing.base_url, baseUrl) && existing.provider === provider
    : false;
  const apiKey =
    suppliedKey ??
    (sameEndpoint && existing ? (await decryptedApiKeys(env, existing)).primary : null);
  if (!apiKey) throw new Error("更换接口时请填写该接口的 API Key");
  return {
    provider,
    baseUrl,
    apiKey,
    ...(typeof body.model === "string" && body.model.trim() ? { model: body.model.trim() } : {}),
  };
}

const responseJson = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function handleModelSettingsRoute(
  request: Request,
  env: ModelSettingsEnv,
  user: AuthUser | null,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const matches = path === "/api/settings/llm" || path.startsWith("/api/settings/llm/");
  if (!matches) return null;
  if (request.method === "GET" && path === "/api/settings/llm") {
    return responseJson({ ok: true, settings: await publicModelSettings(env, user) });
  }
  if (request.method === "GET" && path === "/api/settings/llm/providers") {
    return responseJson({ ok: true, providers: MODEL_PROVIDER_PRESETS });
  }
  if (!user) return responseJson({ ok: false, message: "请先注册或登录，再保存个人模型配置" }, 401);
  if (request.method === "POST" && path === "/api/settings/llm/detect") {
    const connection = await draftConnection(await bodyObject(request), env, user);
    const discovered = await discoverModels(connection);
    return responseJson({ ok: true, ...discovered });
  }
  if (request.method === "POST" && path === "/api/settings/llm/test") {
    const body = await bodyObject(request);
    let connection: ModelConnection & { model: string };
    if (Object.keys(body).length > 0) {
      const draft = await draftConnection(body, env, user);
      connection = { ...draft, model: stringField(body.model, "模型", 200) };
    } else {
      const saved = await modelConnectionForUser(env, user);
      if (!saved) return responseJson({ ok: false, message: "请先填写模型配置" }, 400);
      connection = saved;
    }
    const tested = await testModelConnection(connection);
    return responseJson({ ok: true, ...tested });
  }
  if (request.method === "PUT" && path === "/api/settings/llm") {
    const body = await bodyObject(request);
    const connection = await draftConnection(body, env, user);
    const model = stringField(body.model, "主模型", 200);
    const fallbackModel = optionalModel(body.fallbackModel);
    const thirdModel = optionalModel(body.thirdModel);
    const existing = await settingsRow(env, user.id);
    const sameEndpoint = existing
      ? equivalentModelBaseUrls(existing.base_url, connection.baseUrl) &&
        existing.provider === connection.provider
      : false;
    const existingKeys = existing && sameEndpoint ? await decryptedApiKeys(env, existing) : null;
    const suppliedFallbackKey = apiKeyValue(body.fallbackApiKey);
    const fallbackApiKey = suppliedFallbackKey ?? existingKeys?.fallback ?? connection.apiKey;
    const validationTargets = modelValidationTargets(
      model,
      fallbackModel,
      thirdModel,
      connection.apiKey,
      fallbackApiKey,
    );
    let primaryTest: Awaited<ReturnType<typeof testModelConnection>> | null = null;
    for (const target of validationTargets) {
      const tested = await testModelConnection({ ...connection, ...target });
      if (target.model === model && target.apiKey === connection.apiKey) primaryTest = tested;
    }
    if (!primaryTest) throw new Error("主模型连接测试未完成");
    const encrypted = await encryptText(
      JSON.stringify({ primary: connection.apiKey, fallback: fallbackApiKey }),
      encryptionSecret(env),
    );
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO user_model_settings(user_id,provider,base_url,model,fallback_model,third_model,encrypted_api_key,updated_at)
       VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider,base_url=excluded.base_url,
       model=excluded.model,fallback_model=excluded.fallback_model,third_model=excluded.third_model,
       encrypted_api_key=excluded.encrypted_api_key,updated_at=excluded.updated_at`,
    )
      .bind(
        user.id,
        connection.provider,
        connection.baseUrl,
        model,
        fallbackModel,
        thirdModel,
        encrypted,
        now,
      )
      .run();
    return responseJson({
      ok: true,
      settings: await publicModelSettings(env, user),
      test: { model: primaryTest.model, latencyMs: primaryTest.latencyMs },
    });
  }
  if (request.method === "DELETE" && path === "/api/settings/llm") {
    await env.DB.prepare("DELETE FROM user_model_settings WHERE user_id=?").bind(user.id).run();
    return responseJson({ ok: true, settings: await publicModelSettings(env, user) });
  }
  return responseJson({ ok: false, message: "模型设置操作不存在" }, 404);
}
