import { extractJsonObject, normalizeRecipe, scoreRecipe, type HostedRecipe } from "./recipe";
import { browserOwner, generationQuotaSubjects, sameOriginMutation } from "./session";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  LLM_API_KEY: string;
  APP_SESSION_SECRET: string;
}

interface ItemRow {
  id: string;
  created_at: string;
  json: string;
}

const json = (body: unknown, status = 200, headers: HeadersInit = {}): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

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

function llmEndpoint(env: Env): string {
  const base = new URL(env.LLM_BASE_URL);
  if (base.protocol !== "https:") throw new Error("Cloudflare 部署的模型地址必须使用 HTTPS");
  return new URL(`${base.pathname.replace(/\/$/, "")}/chat/completions`, base).toString();
}

async function callModel(
  env: Env,
  description: string,
  context: Record<string, unknown>,
): Promise<HostedRecipe> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), 120_000);
  try {
    const response = await fetch(llmEndpoint(env), {
      method: "POST",
      headers: { authorization: `Bearer ${env.LLM_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "你是 xBloom 手冲配方设计师。只输出一个 JSON 对象。字段必须包含 name,cupType,doseGrams,grinderSize,rpm,grandWater,pours,bypassEnabled,bypassVolume,bypassTemp,isSetGrinderSize,theColor。pours 为 1-6 段，每段含 volume,temperature,flowRate(3.0-3.5),pattern(center/circular/spiral),pausing,vibBefore,vibAfter,theName。粉量 5-18g，研磨 40-120，水温 60-95℃，各段水量之和等于总水。",
          },
          {
            role: "user",
            content: `${description}\n上下文：${JSON.stringify(context).slice(0, 12_000)}`,
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`模型接口 HTTP ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("模型没有返回配方正文");
    return normalizeRecipe(extractJsonObject(content), description.slice(0, 32) || "AI Brew");
  } finally {
    clearTimeout(timeout);
  }
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

async function generate(request: Request, env: Env, owner: string): Promise<Response> {
  await enforceGenerationQuota(env, request, owner);
  const body = await requestBody(request);
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description || description.length > 4_000)
    return json({ ok: false, message: "请填写 1-4000 字的冲煮需求" }, 400);
  const mode = body.mode === "max" ? "max" : body.mode === "pro" ? "pro" : "fast";
  const count = mode === "max" ? 3 : 1;
  const events: unknown[] = [];
  if (mode !== "fast")
    events.push(
      { type: "research", stage: "start", query: description },
      {
        type: "research",
        stage: "done",
        summary: "Hosted 版本轮使用模型上下文与用户提供的参考资料；实时网页来源需本地完整版。",
      },
    );
  if (count === 3) events.push({ type: "candidates", stage: "start", count: 3 });
  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_, index) =>
      callModel(env, description, { ...body, candidate: index + 1 }),
    ),
  );
  const recipes = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (recipes.length === 0)
    throw new Error(
      settled[0].status === "rejected" ? String(settled[0].reason) : "候选配方生成失败",
    );
  const ranked = recipes
    .map((recipe, index) => ({ recipe, index, score: scoreRecipe(recipe) }))
    .sort((a, b) => b.score - a.score);
  if (count === 3) {
    ranked.forEach((item, index) =>
      events.push({
        type: "candidates",
        stage: "progress",
        completed: index + 1,
        total: recipes.length,
        candidate: { index: item.index, score: item.score, recipe: item.recipe },
      }),
    );
    events.push({
      type: "candidates",
      stage: "picked",
      pickedIndex: ranked[0].index,
      candidates: ranked.map((item) => ({
        index: item.index,
        score: item.score,
        recipe: item.recipe,
      })),
    });
  }
  events.push(
    { type: "recipe", recipe: ranked[0].recipe, clamped: [], model: env.LLM_MODEL },
    { type: "done" },
  );
  return sse(events);
}

async function routeApi(request: Request, env: Env, owner: string): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/api/status")
    return json({
      ok: true,
      version: "hosted-0.1",
      deployment: "cloudflare",
      capabilities: { generate: true, cloud: false, ble: false },
    });
  if (request.method === "GET" && path === "/api/config")
    return json({
      models: [env.LLM_MODEL],
      defaultModel: env.LLM_MODEL,
      limits: {},
      cloudRegion: "global",
      deployment: "cloudflare",
    });
  if (request.method === "GET" && path === "/api/settings/llm")
    return json({
      ok: true,
      settings: {
        baseUrl: "由部署者配置",
        model: env.LLM_MODEL,
        fallbackModel: "",
        thirdModel: "",
        apiKeyConfigured: Boolean(env.LLM_API_KEY),
        fallbackApiKeyConfigured: false,
        source: "environment",
        localOverridePresent: false,
        localOverrideValid: true,
      },
    });
  if (["PUT", "DELETE"].includes(request.method) && path === "/api/settings/llm")
    return json({ ok: false, message: "Hosted 版模型接口由部署者的 Worker Secret 管理" }, 409);
  if (request.method === "POST" && path === "/api/generate") return generate(request, env, owner);

  if (request.method === "GET" && path === "/api/recipes")
    return json({ ok: true, recipes: await listItems(env, owner, "recipe") });
  if (request.method === "POST" && path === "/api/recipes") {
    const body = await requestBody(request);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    if (!body.recipe) return json({ ok: false, message: "缺少 recipe" }, 400);
    await putItem(env, owner, "recipe", id, createdAt, body);
    return json({ ok: true, id, version: 1 });
  }
  const recipeMatch = path.match(/^\/api\/recipes\/([0-9a-f-]+)$/i);
  if (recipeMatch && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM user_items WHERE owner=? AND kind='recipe' AND id=?")
      .bind(owner, recipeMatch[1])
      .run();
    return json({ ok: true });
  }
  if (recipeMatch && request.method === "PATCH") {
    const current = await getItem(env, owner, "recipe", recipeMatch[1]);
    if (!current) return json({ ok: false, message: "配方不存在" }, 404);
    const patch = await requestBody(request);
    await putItem(env, owner, "recipe", recipeMatch[1], current.createdAt, {
      ...current.value,
      ...patch,
    });
    return json({ ok: true });
  }
  const feedbackMatch = path.match(/^\/api\/recipes\/([0-9a-f-]+)\/feedback$/i);
  if (feedbackMatch && request.method === "POST") {
    const current = await getItem(env, owner, "recipe", feedbackMatch[1]);
    if (!current) return json({ ok: false, message: "配方不存在" }, 404);
    const feedback = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...(await requestBody(request)),
    };
    const feedbacks = Array.isArray(current.value.feedbacks)
      ? [...current.value.feedbacks, feedback]
      : [feedback];
    await putItem(env, owner, "recipe", feedbackMatch[1], current.createdAt, {
      ...current.value,
      feedbacks,
    });
    return json({ ok: true, feedbackId: feedback.id });
  }

  if (request.method === "GET" && path === "/api/beans")
    return json({ ok: true, beans: await listItems(env, owner, "bean") });
  if (request.method === "POST" && path === "/api/beans") {
    const body = await requestBody(request);
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await putItem(env, owner, "bean", id, createdAt, body);
    return json({ ok: true, id });
  }
  if (request.method === "GET" && path === "/api/beans/recommend") {
    const beans = (await listItems(env, owner, "bean")) as Array<Record<string, unknown>>;
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
      .bind(owner, beanMatch[1])
      .run();
    return json({ ok: true });
  }
  if (beanMatch && request.method === "PATCH") {
    const current = await getItem(env, owner, "bean", beanMatch[1]);
    if (!current) return json({ ok: false, message: "豆档案不存在" }, 404);
    const patch = await requestBody(request);
    const value = { ...current.value, ...patch };
    await putItem(env, owner, "bean", beanMatch[1], current.createdAt, value);
    return json({ ok: true, bean: { id: beanMatch[1], ...value } });
  }
  const consumeMatch = path.match(/^\/api\/beans\/([0-9a-f-]+)\/consume$/i);
  if (consumeMatch && request.method === "POST") {
    const current = await getItem(env, owner, "bean", consumeMatch[1]);
    if (!current) return json({ ok: false, message: "豆档案不存在" }, 404);
    const body = await requestBody(request);
    const grams = Math.max(0, Number(body.grams) || 0);
    const remainingGrams = Math.max(0, Number(current.value.stockGrams ?? 0) - grams);
    const value = { ...current.value, stockGrams: remainingGrams };
    await putItem(env, owner, "bean", consumeMatch[1], current.createdAt, value);
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
    if (!sameOriginMutation(request)) return json({ ok: false, message: "跨站写请求已拦截" }, 403);
    try {
      const identity = await browserOwner(request, env.APP_SESSION_SECRET);
      const response = await routeApi(request, env, identity.owner);
      const headers = new Headers(response.headers);
      if (identity.cookie) headers.append("set-cookie", identity.cookie);
      headers.set("x-content-type-options", "nosniff");
      headers.set("referrer-policy", "same-origin");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ ok: false, message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
