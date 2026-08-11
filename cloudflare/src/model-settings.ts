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
    return {
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      fallbackModel: row.fallback_model,
      thirdModel: row.third_model,
      apiKeyConfigured: Boolean(row.encrypted_api_key),
      fallbackApiKeyConfigured: false,
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
  (ModelConnection & { model: string; fallbackModel: string; thirdModel: string }) | null
> {
  const row = user ? await settingsRow(env, user.id) : null;
  if (row) {
    return {
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      fallbackModel: row.fallback_model,
      thirdModel: row.third_model,
      apiKey: await decryptText(row.encrypted_api_key, encryptionSecret(env)),
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
    (sameEndpoint && existing
      ? await decryptText(existing.encrypted_api_key, encryptionSecret(env))
      : null);
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
    const test = await testModelConnection({ ...connection, model });
    const encrypted = await encryptText(connection.apiKey, encryptionSecret(env));
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
      test: { model: test.model, latencyMs: test.latencyMs },
    });
  }
  if (request.method === "DELETE" && path === "/api/settings/llm") {
    await env.DB.prepare("DELETE FROM user_model_settings WHERE user_id=?").bind(user.id).run();
    return responseJson({ ok: true, settings: await publicModelSettings(env, user) });
  }
  return responseJson({ ok: false, message: "模型设置操作不存在" }, 404);
}
