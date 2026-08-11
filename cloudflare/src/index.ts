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
import { handleAuthRoute, resolveIdentity, type AuthUser, type RequestIdentity } from "./auth.ts";
import {
  handleModelSettingsRoute,
  modelConnectionForUser,
  publicModelSettings,
  type ModelSettingsEnv,
} from "./model-settings.ts";
import { generationQuotaSubjects, sameOriginMutation } from "./session.ts";
import { handleXbloomRoute } from "./xbloom-cloud.ts";

export interface Env extends ModelSettingsEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_SESSION_SECRET: string;
  APP_PASSWORD_PEPPER: string;
  APP_DATA_ENCRYPTION_KEY?: string;
  EDGE_PROXY_SECRET?: string;
}

interface ItemRow {
  id: string;
  created_at: string;
  json: string;
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

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

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 262_144) throw new Error("请求体超过 256KB");
  const text = await request.text();
  if (text.length > 262_144) throw new Error("请求体超过 256KB");
  const parsed = JSON.parse(text || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("请求体必须是 JSON 对象");
  return parsed as Record<string, unknown>;
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

const HOSTED_CANDIDATE_DIRECTIONS = [
  "稳健基线：均衡、甜感、复现性优先。",
  "清晰路线：在用户目标内突出干净度、层次和风味辨识度。",
  "圆润路线：在用户目标内突出甜感、质感和余韵完整度。",
] as const;

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
  if (error instanceof SyntaxError) return { status: 400, message: "请求体不是有效的 JSON" };
  if (/登录尝试较多|额度已用完|次数已到/.test(message)) {
    return { status: 429, message };
  }
  if (/APP_(?:SESSION_SECRET|PASSWORD_PEPPER|DATA_ENCRYPTION_KEY)|站点尚未配置/.test(message)) {
    return { status: 503, message: "站点配置尚未完成，请联系站点维护者" };
  }
  if (
    /^(?:请填写|请求体|请求格式|账号名|账号密码|密码需要|模型 API 地址|API Key|更换接口|备用模型|主模型|分享链接|配方结构有误|缺少)/.test(
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
    return { status: 502, message: message.slice(0, 500) };
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
  const timeout = setTimeout(() => controller.abort("timeout"), 120_000);
  const abortFromRequest = (): void => controller.abort(requestSignal.reason ?? "request aborted");
  if (requestSignal.aborted) abortFromRequest();
  else requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  try {
    const content = await generateModelText(
      { ...connection, model },
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
      { signal: controller.signal, timeoutMs: 120_000, temperature: 0.3, maxTokens: 3000 },
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
        if (attempt < 1 && isTransientModelError(error)) {
          await wait(350, signal);
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

async function enforceGenerationQuota(env: Env, request: Request, owner: string): Promise<void> {
  const bucket = new Date().toISOString().slice(0, 13);
  const subjects = await generationQuotaSubjects(request, env.APP_SESSION_SECRET);
  const [browserCount, networkCount, globalCount] = await Promise.all([
    incrementQuota(env, `browser:${owner}`, bucket),
    incrementQuota(env, subjects.network, bucket),
    incrementQuota(env, subjects.global, bucket),
  ]);
  if (globalCount > 500) throw new Error("站点本小时生成额度已用完，请稍后继续");
  if (networkCount > 60) throw new Error("当前网络本小时生成次数已到 60 次，请稍后继续");
  if (browserCount > 20) throw new Error("本浏览器本小时生成次数已到 20 次，请稍后继续");
}

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
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

async function generate(
  request: Request,
  env: Env,
  owner: string,
  user: AuthUser | null,
): Promise<Response> {
  await enforceGenerationQuota(env, request, owner);
  const connection = await modelConnectionForUser(env, user);
  if (!connection) return json({ ok: false, message: "请先登录并完成模型连接配置" }, 409);
  const body = await requestBody(request);
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description || description.length > 4_000)
    return json({ ok: false, message: "请填写 1-4000 字的冲煮需求" }, 400);
  const mode = body.mode === "max" ? "max" : body.mode === "pro" ? "pro" : "fast";
  const count = mode === "max" ? 3 : 1;
  const events: unknown[] = [];
  const research = mode === "fast" ? null : hostedResearchPacket(body.researchPacket);
  if (mode !== "fast") {
    const query =
      typeof body.beans === "string" && body.beans.trim()
        ? body.beans.trim().slice(0, 500)
        : description;
    events.push({ type: "research", stage: "start", query });
    for (const source of research?.sources ?? []) {
      events.push({ type: "research", stage: "source", ...source });
    }
    events.push({
      type: "research",
      stage: "done",
      ok: research?.ok ?? false,
      message:
        research?.message ??
        "本次使用豆档案、口味目标与用户提供的参考资料生成；连接本地助手后还可加入小红书与网页调研。",
      sources: research?.sources ?? [],
      filtered: research?.filtered ?? 0,
      distilled: research?.distilled ?? false,
      ...(research?.summaryText ? { summary: research.summaryText } : {}),
      ...(research?.xhsLoginExpired ? { xhsLoginExpired: true } : {}),
    });
  }
  if (count === 3) events.push({ type: "candidates", stage: "start", n: 3, round: 0 });
  const outcomes: HostedCandidateOutcome[] = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
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
          request.signal,
        );
        return { index, ...generated };
      } catch (error) {
        if (request.signal.aborted) throw error;
        return { index, error: publicHostedFailureReason(error) };
      }
    }),
  );

  if (count === 3) {
    for (const outcome of outcomes) {
      if (!outcome.recipe) continue;
      const acceptedRecipes = outcomes
        .filter((entry) => entry.index < outcome.index && entry.recipe)
        .map((entry) => entry.recipe!);
      if (acceptedRecipes.every((recipe) => hostedRecipesAreDistinct(recipe, outcome.recipe!))) {
        continue;
      }
      let replacement: { recipe: HostedRecipe; clamps: string[]; model: string } | undefined;
      let replacementError: string | undefined;
      for (let retry = 1; retry <= 2; retry += 1) {
        try {
          const candidate = await callModel(
            connection,
            description,
            { ...body, candidate: outcome.index + 1 },
            outcome.index,
            count,
            42 + outcome.index + retry * 1_000,
            acceptedRecipes,
            request.signal,
          );
          if (
            acceptedRecipes.some(
              (existing) => !hostedRecipesAreDistinct(existing, candidate.recipe),
            )
          )
            continue;
          replacement = candidate;
          break;
        } catch (error) {
          if (request.signal.aborted) throw error;
          replacementError = publicHostedFailureReason(error);
          // 下一次定向补发继续使用新的 seed。
        }
      }
      outcome.recipe = replacement?.recipe;
      outcome.clamps = replacement?.clamps;
      outcome.error = replacement
        ? undefined
        : replacementError || "方案参数重复，定向补发后仍未形成有效差异";
    }
  }

  const selection = hostedCandidateSelection(outcomes);
  if (count === 3) {
    outcomes.forEach((outcome, index) =>
      events.push({
        type: "candidates",
        stage: "progress",
        done: index + 1,
        total: 3,
        round: 0,
        result: selection.results.find((result) => result.index === outcome.index),
      }),
    );
    events.push({
      type: "candidates",
      stage: "picked",
      round: 0,
      winner: selection.winner.index,
      scores: selection.scores,
      results: selection.results,
    });
  }
  events.push(
    {
      type: "recipe",
      recipe: selection.winner.recipe,
      clamped: selection.winner.clamps ?? [],
      model: selection.winner.model ?? connection.model,
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
    },
    { type: "done" },
  );
  return sse(events);
}

async function routeApi(request: Request, env: Env, identity: RequestIdentity): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/status")
    return json({
      ok: true,
      version: "hosted-0.2.1",
      deployment: "cloudflare",
      capabilities: { generate: true, cloud: true, ble: false, auth: true, personalModel: true },
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
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    if (!body.recipe) return json({ ok: false, message: "缺少 recipe" }, 400);
    await putItem(env, identity.owner, "recipe", id, createdAt, body);
    return json({ ok: true, id, version: 1 });
  }
  const recipeMatch = path.match(/^\/api\/recipes\/([0-9a-f-]+)$/i);
  if (recipeMatch && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM user_items WHERE owner=? AND kind='recipe' AND id=?")
      .bind(identity.owner, recipeMatch[1])
      .run();
    return json({ ok: true });
  }
  if (recipeMatch && request.method === "PATCH") {
    const current = await getItem(env, identity.owner, "recipe", recipeMatch[1]);
    if (!current) return json({ ok: false, message: "配方不存在" }, 404);
    const patch = await requestBody(request);
    await putItem(env, identity.owner, "recipe", recipeMatch[1], current.createdAt, {
      ...current.value,
      ...patch,
    });
    return json({ ok: true });
  }
  const feedbackMatch = path.match(/^\/api\/recipes\/([0-9a-f-]+)\/feedback$/i);
  if (feedbackMatch && request.method === "POST") {
    const current = await getItem(env, identity.owner, "recipe", feedbackMatch[1]);
    if (!current) return json({ ok: false, message: "配方不存在" }, 404);
    const feedback = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...(await requestBody(request)),
    };
    const feedbacks = Array.isArray(current.value.feedbacks)
      ? [...current.value.feedbacks, feedback]
      : [feedback];
    await putItem(env, identity.owner, "recipe", feedbackMatch[1], current.createdAt, {
      ...current.value,
      feedbacks,
    });
    return json({ ok: true, feedbackId: feedback.id });
  }
  const feedbackPatchMatch = path.match(/^\/api\/recipes\/([0-9a-f-]+)\/feedback\/([0-9a-f-]+)$/i);
  if (feedbackPatchMatch && request.method === "PATCH") {
    const current = await getItem(env, identity.owner, "recipe", feedbackPatchMatch[1]);
    if (!current) return json({ ok: false, message: "配方不存在" }, 404);
    const patch = await requestBody(request);
    const feedbacks = Array.isArray(current.value.feedbacks)
      ? current.value.feedbacks.map((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return value;
          const feedback = value as Record<string, unknown>;
          return feedback.id === feedbackPatchMatch[2] ? { ...feedback, ...patch } : feedback;
        })
      : [];
    await putItem(env, identity.owner, "recipe", feedbackPatchMatch[1], current.createdAt, {
      ...current.value,
      feedbacks,
    });
    return json({ ok: true });
  }

  if (request.method === "GET" && path === "/api/beans")
    return json({ ok: true, beans: await listItems(env, identity.owner, "bean") });
  if (request.method === "POST" && path === "/api/beans") {
    const body = await requestBody(request);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await putItem(env, identity.owner, "bean", id, createdAt, body);
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
    const body = await requestBody(request);
    const text = typeof body.text === "string" ? body.text.slice(0, 8_000) : "";
    return json({
      ok: true,
      parsed: {
        name:
          text
            .split(/[\n，,]/)[0]
            ?.trim()
            .slice(0, 80) || null,
        roaster: null,
        origin: null,
        farm: null,
        process: null,
        varietal: null,
        roastLevel: null,
        tastingNotes: [],
        roastDate: null,
      },
    });
  }
  const beanMatch = path.match(/^\/api\/beans\/([0-9a-f-]+)$/i);
  if (beanMatch && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM user_items WHERE owner=? AND kind='bean' AND id=?")
      .bind(identity.owner, beanMatch[1])
      .run();
    return json({ ok: true });
  }
  if (beanMatch && request.method === "PATCH") {
    const current = await getItem(env, identity.owner, "bean", beanMatch[1]);
    if (!current) return json({ ok: false, message: "豆档案不存在" }, 404);
    const patch = await requestBody(request);
    const value = { ...current.value, ...patch };
    await putItem(env, identity.owner, "bean", beanMatch[1], current.createdAt, value);
    return json({ ok: true, bean: { id: beanMatch[1], ...value } });
  }
  const consumeMatch = path.match(/^\/api\/beans\/([0-9a-f-]+)\/consume$/i);
  if (consumeMatch && request.method === "POST") {
    const current = await getItem(env, identity.owner, "bean", consumeMatch[1]);
    if (!current) return json({ ok: false, message: "豆档案不存在" }, 404);
    const body = await requestBody(request);
    const grams = Math.max(0, Number(body.grams) || 0);
    const remainingGrams = Math.max(0, Number(current.value.stockGrams ?? 0) - grams);
    const value = { ...current.value, stockGrams: remainingGrams };
    await putItem(env, identity.owner, "bean", consumeMatch[1], current.createdAt, value);
    return json({
      ok: true,
      remainingGrams,
      brewsLeft: Math.floor(remainingGrams / Math.max(1, Number(body.doseGrams) || grams || 15)),
    });
  }

  if (request.method === "GET" && path === "/api/xhs/status")
    return json({
      ok: true,
      online: false,
      loggedIn: false,
      message: "小红书调研由本地完整版提供",
    });
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
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
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
      const response =
        auth?.response ?? settings ?? xbloom ?? (await routeApi(routedRequest, env, identity));
      const headers = new Headers(response.headers);
      for (const cookie of [...identity.cookies, ...(auth?.cookies ?? [])]) {
        headers.append("set-cookie", cookie);
      }
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "same-origin");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      const failure = publicApiError(error);
      return json({ ok: false, message: failure.message }, failure.status);
    }
  },
} satisfies ExportedHandler<Env>;
