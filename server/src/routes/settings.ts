/** 本机设置接口：仅管理 LLM 连接，不涉及服务部署、xBloom 云端或小红书会话。 */
import { Router } from "express";
import { fetch } from "undici";
import { ZodError } from "zod";
import {
  MODEL_PROVIDER_PRESETS,
  detectModelProvider,
  discoverModels,
  equivalentModelBaseUrls,
  normalizeModelBaseUrl,
  testModelConnection,
  type FetchLike,
  type ModelConnection,
} from "../../../shared/dist/model-provider.js";
import { config } from "../config.js";
import {
  currentLlmSettings,
  LlmEndpointConfirmationError,
  resetLlmSettings,
  updateLlmSettings,
} from "../lib/llm-settings.js";

const router = Router();

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isTrustedSettingsOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // 本机脚本/CLI 没有浏览器 Origin
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return url.origin === origin && url.protocol === "http:" && isLoopbackHostname(host);
  } catch {
    return false;
  }
}

router.use((req, res, next) => {
  const changesSettings =
    req.method === "PUT" ||
    req.method === "DELETE" ||
    (req.method === "POST" && ["/llm/test", "/llm/detect"].includes(req.path));
  if (changesSettings && !isTrustedSettingsOrigin(req.get("origin"))) {
    res.status(403).json({ ok: false, message: "模型设置只接受本机工作台发起的修改" });
    return;
  }
  next();
});

export function requestConnection(body: unknown): ModelConnection & { model: string } {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const baseUrl =
    typeof input.baseUrl === "string" && input.baseUrl.trim()
      ? normalizeModelBaseUrl(input.baseUrl, true)
      : config.llm.baseUrl;
  const provider =
    input.provider === "anthropic" ||
    input.provider === "gemini" ||
    input.provider === "openai-compatible"
      ? input.provider
      : equivalentModelBaseUrls(baseUrl, config.llm.baseUrl)
        ? config.llm.provider
        : detectModelProvider(baseUrl);
  const sameConnection =
    equivalentModelBaseUrls(baseUrl, config.llm.baseUrl) && provider === config.llm.provider;
  const apiKey =
    typeof input.apiKey === "string" && input.apiKey.trim()
      ? input.apiKey.trim()
      : sameConnection
        ? config.llm.apiKey
        : "";
  const model =
    typeof input.model === "string" && input.model.trim() ? input.model.trim() : config.llm.model;
  return { provider, baseUrl, apiKey, model };
}

router.get("/llm/providers", (_req, res) => {
  res.json({ ok: true, providers: MODEL_PROVIDER_PRESETS });
});

router.post("/llm/detect", async (req, res) => {
  try {
    const connection = requestConnection(req.body);
    const result = await discoverModels(connection, {
      fetcher: fetch as unknown as FetchLike,
      allowLoopback: true,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, message: (error as Error).message || "模型识别失败" });
  }
});

router.post("/llm/test", async (req, res) => {
  const startedAt = Date.now();
  try {
    const connection = requestConnection(req.body);
    const endpoint = new URL(connection.baseUrl);
    const secureEndpoint =
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" && isLoopbackHostname(endpoint.hostname));
    if (!secureEndpoint) {
      res.status(400).json({ ok: false, message: "模型接口需使用 HTTPS；本机回环地址可使用 HTTP" });
      return;
    }
    if (!connection.apiKey.trim() || !connection.model.trim()) {
      res.status(400).json({ ok: false, message: "请先填写主模型与 API Key" });
      return;
    }
    const tested = await testModelConnection(connection, {
      fetcher: fetch as unknown as FetchLike,
      allowLoopback: true,
    });
    res.json({
      ok: true,
      provider: tested.provider,
      model: tested.model,
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    const timedOut = (error as Error)?.name === "TimeoutError";
    const upstreamStatus = (error as Error)?.message.match(/HTTP\s+(\d{3})/i)?.[1];
    res.status(timedOut ? 504 : 400).json({
      ok: false,
      message: timedOut
        ? "模型连接测试超过 20 秒"
        : upstreamStatus
          ? `模型接口返回 HTTP ${upstreamStatus}`
          : "模型接口连接失败",
    });
  }
});

router.get("/llm", async (_req, res) => {
  const settings = await currentLlmSettings();
  res.json({ ok: true, settings });
});

router.put("/llm", async (req, res) => {
  try {
    const settings = await updateLlmSettings(req.body);
    res.json({ ok: true, settings });
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        ok: false,
        message: error.issues[0]?.message ?? "模型设置格式有误",
      });
      return;
    }
    if (error instanceof LlmEndpointConfirmationError) {
      res
        .status(409)
        .json({ ok: false, message: error.message, failureKind: "endpoint_confirmation_required" });
      return;
    }
    console.error(`[llm-settings] 保存失败：${(error as Error).name}`);
    res.status(500).json({ ok: false, message: "模型接口设置保存失败" });
  }
});

router.delete("/llm", async (_req, res) => {
  try {
    const settings = await resetLlmSettings();
    res.json({ ok: true, settings });
  } catch (error) {
    console.error(`[llm-settings] 恢复失败：${(error as Error).name}`);
    res.status(500).json({ ok: false, message: "模型接口设置恢复失败" });
  }
});

export default router;
