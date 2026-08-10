/** 本机设置接口：仅管理 LLM 连接，不涉及服务部署、xBloom 云端或小红书会话。 */
import { Router } from "express";
import { fetch } from "undici";
import { ZodError } from "zod";
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
    const host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return isLoopbackHostname(host);
  } catch {
    return false;
  }
}

router.use((req, res, next) => {
  const changesSettings =
    req.method === "PUT" ||
    req.method === "DELETE" ||
    (req.method === "POST" && req.path === "/llm/test");
  if (changesSettings && !isTrustedSettingsOrigin(req.get("origin"))) {
    res.status(403).json({ ok: false, message: "模型设置只接受本机工作台发起的修改" });
    return;
  }
  next();
});

router.post("/llm/test", async (_req, res) => {
  const startedAt = Date.now();
  try {
    const endpoint = new URL(config.llm.baseUrl);
    const secureEndpoint =
      endpoint.protocol === "https:" ||
      (endpoint.protocol === "http:" && isLoopbackHostname(endpoint.hostname));
    if (!secureEndpoint) {
      res.status(400).json({ ok: false, message: "模型接口需使用 HTTPS；本机回环地址可使用 HTTP" });
      return;
    }
    if (!config.llm.apiKey.trim() || !config.llm.model.trim()) {
      res.status(400).json({ ok: false, message: "请先填写主模型与 API Key" });
      return;
    }
    const url = new URL(`${endpoint.pathname.replace(/\/$/, "")}/chat/completions`, endpoint);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        model: config.llm.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 32,
        stream: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      res.status(400).json({ ok: false, message: `模型接口返回 HTTP ${response.status}` });
      return;
    }
    await response.body?.cancel().catch(() => undefined);
    res.json({ ok: true, model: config.llm.model, latencyMs: Date.now() - startedAt });
  } catch (error) {
    const timedOut = (error as Error)?.name === "TimeoutError";
    res
      .status(timedOut ? 504 : 400)
      .json({ ok: false, message: timedOut ? "模型连接测试超过 20 秒" : "模型接口连接失败" });
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
