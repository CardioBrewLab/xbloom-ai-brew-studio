/**
 * 本地配方库 CRUD + 冲煮反馈闭环 + 版本链追溯。
 * 数据存仓库根目录 data/recipes.json：[{ id, createdAt, recipe, feedbacks?, parentId?, version?, sourceFeedbackId?, changeNotes? ]]
 *
 * GET    /api/recipes                          → { ok:true, recipes:[...] }
 * POST   /api/recipes                          → { ok:true, id, version? }
 *        body: { recipe, name?, parentId?, sourceFeedbackId?, changeNotes? }
 *        带 parentId 时服务端推导 version = parent.version + 1（parent 不存在则忽略 parentId）；
 *        带 sourceFeedbackId 时自动回填对应 feedback 的 resultingRecipeId。
 * DELETE /api/recipes/:id                      → { ok:true }
 * POST   /api/recipes/:id/feedback             → { ok:true, feedbackId } | { ok:false, error }
 *        body: { rating:1-5, taste:[味型标签], note? }
 * PATCH  /api/recipes/:id/feedback/:fid        → { ok:true }（回填 resultingRecipeId）
 */
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  FeedbackInputSchema,
  MAX_FEEDBACKS_PER_RECIPE,
  TASTE_TAGS,
} from "../../../shared/dist/data-schema.js";
import { atomicWriteJson, loadJsonArray } from "../lib/data-io.js";
import { clampRecipe, durationWarning } from "../lib/safety.js";
import { ROASTER_REFERENCE_MAX, sanitizeBrewRationale } from "./generate.js";
import { loadBeans } from "./beans.js";
import type { ReviewFinding } from "../lib/review.js";
import type { BrewRationaleItem, Recipe } from "../lib/recipe-schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/routes → 仓库根：../../..（dist/routes 同样适用）
export const RECIPES_FILE = path.resolve(here, "../../../data/recipes.json");

export function isValidPairPatch(pairId: unknown, variant: unknown): pairId is string {
  return (
    typeof pairId === "string" && variant === "improved" && /^[0-9a-f-]{36}$/i.test(pairId.trim())
  );
}

export function normalizeRecipeSaveRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    normalized,
  )
    ? normalized
    : undefined;
}

/** Build the normalized payload returned for an idempotent save retry. */
export function existingRecipeSaveResponse(existing: StoredRecipe, requestedRecipe: unknown) {
  const retriedNormalization = clampRecipe(requestedRecipe);
  const warning = durationWarning(existing.recipe);
  return {
    ok: true as const,
    id: existing.id,
    recipe: existing.recipe,
    clamped: retriedNormalization.clamped,
    ...(existing.version ? { version: existing.version } : {}),
    ...(warning ? { warning } : {}),
  };
}

/** 冲煮反馈味型枚举（generate 重生成调参分支的输入）：五味型 + 三枚风味维度标签 */
export { MAX_FEEDBACKS_PER_RECIPE, TASTE_TAGS };
export type TasteTag = (typeof TASTE_TAGS)[number];

export const FeedbackSchema = FeedbackInputSchema;
export type BrewFeedback = z.infer<typeof FeedbackSchema> & {
  /** feedback 条目唯一 id（版本链追溯用） */
  id?: string;
  createdAt: string;
  /** 该反馈驱动的调参新版本配方 id（回填） */
  resultingRecipeId?: string;
};

export interface StoredRecipe {
  id: string;
  createdAt: string;
  recipe: Recipe;
  feedbacks?: BrewFeedback[];
  /** 版本链：上一版配方 id */
  parentId?: string;
  /** 版本号（服务端按 parent 推导 = parent.version + 1） */
  version?: number;
  /** 触发本版本的 feedback 条目 id（落在 parent.feedbacks 中） */
  sourceFeedbackId?: string;
  /** 本轮调整理由（≤60 字，LLM changeNotes） */
  changeNotes?: string;
  /** 生成阶段联网调研的来源 URL 列表（任务 #35，旧条目无此字段属正常） */
  refUrls?: string[];
  /** 生成时用户输入的豆信息自由文本原文（任务 #35） */
  beanSnapshot?: string;
  /** 联网调研提炼后的摘要文本（任务 #35） */
  researchSummary?: string;
  /** 生成后自动审查的遗留 findings（任务 #36；修正后仍存在或未经修正的问题，旧条目无此字段属正常） */
  reviewFindings?: ReviewFinding[];
  /** 关联豆档案 id（任务 #50 豆仓库存；旧条目无此字段属正常，不校验豆存在性） */
  beanId?: string;
  /** 用户粘贴的烘焙商参考冲泡方案原文（任务 #57；旧条目无此字段属正常） */
  roasterReference?: string;
  /** 双方案对比（任务 #61）：original=烘焙商复刻原版，improved=AI 改进版；旧条目无此字段属正常 */
  variant?: "original" | "improved";
  /** 双方案配对 id（任务 #61）：同一次生成的原版与改进版共享同一 pairId，不校验存在性 */
  pairId?: string;
  /** 方案解读（任务 #72）：关键参数 param/choice/basis 结构化解读；旧条目无此字段属正常 */
  brewRationale?: BrewRationaleItem[];
  /** 已通过云端回读确认的 xBloom 配方记录；用于历史载入后继续更新原记录。 */
  cloudTableId?: string;
}

/** 版本号推导：无 parent → undefined（首版）；有 parent → parent.version + 1（未标注的 parent 视为 v1） */
export function deriveVersion(parent?: Pick<StoredRecipe, "version"> | null): number | undefined {
  if (!parent) return undefined;
  return (parent.version ?? 1) + 1;
}

/** 生成带 id 的 feedback 条目 */
export function buildFeedbackEntry(data: z.infer<typeof FeedbackSchema>): BrewFeedback {
  return { ...data, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
}

/** 把新生成的配方 id 回填到 parent.feedbacks 中匹配 sourceFeedbackId 的条目；命中返回 true */
export function backfillResulting(
  list: StoredRecipe[],
  parentId: string,
  sourceFeedbackId: string,
  resultingRecipeId: string,
): boolean {
  const parent = list.find((r) => r.id === parentId);
  const fb = parent?.feedbacks?.find((f) => f.id === sourceFeedbackId);
  if (!fb) return false;
  fb.resultingRecipeId = resultingRecipeId;
  return true;
}

export function loadAll(file: string = RECIPES_FILE): StoredRecipe[] {
  // ENOENT → 空库；JSON 损坏 → 警告并备份 *.corrupt-<ts> 后按空库处理
  return loadJsonArray<StoredRecipe>(file);
}

export function saveAll(list: StoredRecipe[], file: string = RECIPES_FILE): void {
  // 写临时文件 + rename 原子替换，避免崩溃时留下半截文件
  atomicWriteJson(file, list);
}

/** 审查 findings 入库前清洗：只保留合法形状的条目，字段截断，至多 20 条（任务 #36） */
export function sanitizeReviewFindings(input: unknown): ReviewFinding[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const cleaned = input
    .filter(
      (f): f is Record<string, unknown> =>
        !!f && typeof f === "object" && (f.level === "error" || f.level === "warn"),
    )
    .slice(0, 20)
    .map((f) => ({
      // filter 已保证 level ∈ {"error","warn"}，此处断言收窄 unknown
      level: f.level as "error" | "warn",
      rule: typeof f.rule === "string" ? f.rule.slice(0, 60) : "unknown",
      message: typeof f.message === "string" ? f.message.slice(0, 300) : "",
      suggestion: typeof f.suggestion === "string" ? f.suggestion.slice(0, 300) : "",
    }));
  return cleaned.length > 0 ? cleaned : undefined;
}

/** roasterReference 入库前清洗（任务 #57）：非字符串/空白返回 undefined；否则 trim 并按 ROASTER_REFERENCE_MAX 截断 */
export function sanitizeRoasterReference(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  return text.slice(0, ROASTER_REFERENCE_MAX);
}

export const recipesRouter = Router();

recipesRouter.get("/api/recipes", (_req: Request, res: Response) => {
  res.json({ ok: true, recipes: loadAll() });
});

recipesRouter.post("/api/recipes", (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    recipe?: unknown;
    name?: string;
    parentId?: string;
    sourceFeedbackId?: string;
    changeNotes?: string;
    refUrls?: unknown;
    beanSnapshot?: unknown;
    researchSummary?: unknown;
    /** 生成后自动审查的遗留 findings（任务 #36） */
    reviewFindings?: unknown;
    /** 关联豆档案 id（任务 #50） */
    beanId?: unknown;
    /** 烘焙商参考方案原文（任务 #57） */
    roasterReference?: unknown;
    /** 双方案对比标识（任务 #61）：original | improved */
    variant?: unknown;
    /** 双方案配对 id（任务 #61） */
    pairId?: unknown;
    /** 方案解读（任务 #72） */
    brewRationale?: unknown;
    cloudTableId?: unknown;
    clientRequestId?: unknown;
  };
  if (!body.recipe || typeof body.recipe !== "object") {
    res.status(400).json({ ok: false, error: "recipe 不能为空" });
    return;
  }
  try {
    const clientRequestId = normalizeRecipeSaveRequestId(body.clientRequestId);
    if (body.clientRequestId !== undefined && !clientRequestId) {
      res.status(400).json({ ok: false, error: "clientRequestId 格式有误" });
      return;
    }
    const list = loadAll();
    const existing = clientRequestId
      ? list.find((entry) => entry.id === clientRequestId)
      : undefined;
    if (existing) {
      if (
        existing.parentId &&
        existing.sourceFeedbackId &&
        backfillResulting(list, existing.parentId, existing.sourceFeedbackId, existing.id)
      ) {
        saveAll(list);
      }
      res.json(existingRecipeSaveResponse(existing, body.recipe));
      return;
    }
    // 入库前统一钳位到 SAFE_LIMITS，保证库中配方永远合法
    const { recipe, clamped } = clampRecipe(body.recipe);
    if (body.name && typeof body.name === "string" && body.name.trim()) {
      recipe.name = body.name.trim();
    }
    const linkedBeanId = typeof body.beanId === "string" ? body.beanId.trim() : "";
    if (linkedBeanId && !loadBeans().some((bean) => bean.id === linkedBeanId)) {
      res.status(400).json({ ok: false, error: `豆档案 ${linkedBeanId} 不存在` });
      return;
    }
    const parentId =
      body.parentId === undefined ? undefined : normalizeRecipeSaveRequestId(body.parentId);
    if (body.parentId !== undefined && !parentId) {
      res.status(400).json({ ok: false, error: "parentId 格式有误" });
      return;
    }
    const sourceFeedbackId =
      body.sourceFeedbackId === undefined
        ? undefined
        : normalizeRecipeSaveRequestId(body.sourceFeedbackId);
    if (body.sourceFeedbackId !== undefined && !sourceFeedbackId) {
      res.status(400).json({ ok: false, error: "sourceFeedbackId 格式有误" });
      return;
    }
    if (sourceFeedbackId && !parentId) {
      res.status(400).json({ ok: false, error: "sourceFeedbackId 需要同时提供 parentId" });
      return;
    }
    const entryId = clientRequestId ?? crypto.randomUUID();
    if (parentId === entryId) {
      res.status(400).json({ ok: false, error: "配方不能引用自身作为父版本" });
      return;
    }
    const parent = parentId ? list.find((recipeEntry) => recipeEntry.id === parentId) : undefined;
    if (parentId && !parent) {
      res.status(404).json({ ok: false, error: "父配方不存在" });
      return;
    }
    if (
      sourceFeedbackId &&
      !parent?.feedbacks?.some((feedback) => feedback.id === sourceFeedbackId)
    ) {
      res.status(400).json({ ok: false, error: "父配方中不存在对应反馈" });
      return;
    }
    const entry: StoredRecipe = {
      id: entryId,
      createdAt: new Date().toISOString(),
      recipe,
      ...(parent ? { parentId: parent.id, version: deriveVersion(parent) } : {}),
      ...(parent && sourceFeedbackId ? { sourceFeedbackId } : {}),
      ...(typeof body.changeNotes === "string" && body.changeNotes.trim()
        ? { changeNotes: body.changeNotes.trim().slice(0, 120) }
        : {}),
      // 调研/豆信息快照持久化（任务 #35）：只在非空时落字段，保证旧客户端向后兼容
      ...(Array.isArray(body.refUrls) && body.refUrls.some((u) => typeof u === "string" && u.trim())
        ? {
            refUrls: body.refUrls
              .filter((u): u is string => typeof u === "string" && u.trim() !== "")
              .map((u) => u.trim())
              .slice(0, 20),
          }
        : {}),
      ...(typeof body.beanSnapshot === "string" && body.beanSnapshot.trim()
        ? { beanSnapshot: body.beanSnapshot.trim().slice(0, 2000) }
        : {}),
      ...(typeof body.researchSummary === "string" && body.researchSummary.trim()
        ? { researchSummary: body.researchSummary.trim().slice(0, 6000) }
        : {}),
      // 自动审查遗留 findings 透传落库（任务 #36）：清洗后非空才落字段
      ...(() => {
        const findings = sanitizeReviewFindings(body.reviewFindings);
        return findings ? { reviewFindings: findings } : {};
      })(),
      ...(typeof body.cloudTableId === "string" && /^\d{1,20}$/.test(body.cloudTableId)
        ? { cloudTableId: body.cloudTableId }
        : {}),
      // 关联豆档案 id 仅在当前豆库真实存在时落库，防止生成历史形成悬空引用。
      ...(linkedBeanId ? { beanId: linkedBeanId } : {}),
      // 烘焙商参考方案原文透传落库（任务 #57）：非空才落字段，超长截断
      ...(() => {
        const roasterReference = sanitizeRoasterReference(body.roasterReference);
        return roasterReference ? { roasterReference } : {};
      })(),
      // 双方案对比标识透传落库（任务 #61）：仅接受白名单枚举值；pairId 非空才落，不校验存在性
      ...(body.variant === "original" || body.variant === "improved"
        ? { variant: body.variant }
        : {}),
      ...(typeof body.pairId === "string" && body.pairId.trim()
        ? { pairId: body.pairId.trim() }
        : {}),
      // 方案解读透传落库（任务 #72）：清洗后非空才落字段，非法整体丢弃不阻塞
      ...(() => {
        const brewRationale = sanitizeBrewRationale(body.brewRationale);
        return brewRationale ? { brewRationale } : {};
      })(),
    };
    // 追溯回填：新配方由某条 feedback 驱动时，自动写回 resultingRecipeId
    if (parent && entry.sourceFeedbackId) {
      backfillResulting(list, parent.id, entry.sourceFeedbackId, entry.id);
    }
    list.push(entry);
    saveAll(list);
    // 总时长估算警告（任务 #35）：>180s 仅警告不拦截，随响应返回
    const warning = durationWarning(recipe);
    res.json({
      ok: true,
      id: entry.id,
      recipe,
      clamped,
      ...(entry.version ? { version: entry.version } : {}),
      ...(warning ? { warning } : {}),
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * PATCH /api/recipes/:id：更新配方的 beanId 关联或已验证云端绑定。
 * body: { beanId: string } 或 { cloudTableId: string }，两类字段互不覆盖。
 */
recipesRouter.patch("/api/recipes/:id", (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const body = (req.body ?? {}) as {
    beanId?: unknown;
    cloudTableId?: unknown;
    pairId?: unknown;
    variant?: unknown;
    name?: unknown;
  };
  const hasBeanPatch = typeof body.beanId === "string";
  const hasCloudPatch = typeof body.cloudTableId === "string";
  const hasPairPatch = typeof body.pairId === "string";
  if (Number(hasBeanPatch) + Number(hasCloudPatch) + Number(hasPairPatch) !== 1) {
    res.status(400).json({
      ok: false,
      error: "请只提交 beanId、cloudTableId 或 pairId 其中一项",
    });
    return;
  }
  const list = loadAll();
  const entry = list.find((r) => r.id === id);
  if (!entry) {
    res.status(404).json({ ok: false, error: `配方 ${id} 不存在` });
    return;
  }
  if (hasPairPatch) {
    const pairId = (body.pairId as string).trim();
    if (!isValidPairPatch(pairId, body.variant)) {
      res.status(400).json({ ok: false, error: "pairId 或 variant 格式有误" });
      return;
    }
    entry.pairId = pairId;
    entry.variant = "improved";
    if (typeof body.name === "string" && body.name.trim()) {
      entry.recipe.name = body.name.trim().slice(0, 120);
    }
  } else if (hasCloudPatch) {
    const cloudTableId = (body.cloudTableId as string).trim();
    if (!/^\d{1,20}$/.test(cloudTableId)) {
      res.status(400).json({ ok: false, error: "cloudTableId 格式有误" });
      return;
    }
    entry.cloudTableId = cloudTableId;
  } else {
    const newBeanId = (body.beanId as string).trim();
    if (newBeanId === "") {
      // 空串 = 解除关联
      delete entry.beanId;
    } else {
      // 非空 = 关联（校验豆存在性）
      const beanExists = loadBeans().some((b) => b.id === newBeanId);
      if (!beanExists) {
        res.status(400).json({ ok: false, error: `豆档案 ${newBeanId} 不存在` });
        return;
      }
      entry.beanId = newBeanId;
    }
  }
  saveAll(list);
  res.json({ ok: true });
});

recipesRouter.delete("/api/recipes/:id", (req: Request, res: Response) => {
  const list = loadAll();
  const next = list.filter((r) => r.id !== req.params.id);
  saveAll(next);
  res.json({ ok: true });
});

/** 冲煮反馈：追加到对应配方记录的 feedbacks 数组；配方不存在时 404 */
recipesRouter.post("/api/recipes/:id/feedback", (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = FeedbackSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；"),
    });
    return;
  }
  const list = loadAll();
  const entry = list.find((r) => r.id === id);
  if (!entry) {
    res.status(404).json({ ok: false, error: `配方 ${id} 不存在` });
    return;
  }
  entry.feedbacks = entry.feedbacks ?? [];
  if (entry.feedbacks.length >= MAX_FEEDBACKS_PER_RECIPE) {
    res.status(409).json({
      ok: false,
      error: `每个配方最多保留 ${MAX_FEEDBACKS_PER_RECIPE} 条反馈`,
    });
    return;
  }
  const fb = buildFeedbackEntry(parsed.data);
  entry.feedbacks.push(fb);
  saveAll(list);
  res.json({ ok: true, feedbackId: fb.id });
});

/** 追溯回填：把某 feedback 驱动的调参结果配方 id 写回该条目 */
recipesRouter.patch("/api/recipes/:id/feedback/:fid", (req: Request, res: Response) => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const fid = Array.isArray(req.params.fid) ? req.params.fid[0] : req.params.fid;
  const body = (req.body ?? {}) as { resultingRecipeId?: string };
  const resultingRecipeId = normalizeRecipeSaveRequestId(body.resultingRecipeId);
  if (!resultingRecipeId || Object.keys(req.body ?? {}).length !== 1) {
    res.status(400).json({ ok: false, error: "resultingRecipeId 不能为空" });
    return;
  }
  const list = loadAll();
  const entry = list.find((r) => r.id === id);
  const fb = entry?.feedbacks?.find((f) => f.id === fid);
  if (!entry || !fb) {
    res.status(404).json({ ok: false, error: `配方 ${id} 的反馈 ${fid} 不存在` });
    return;
  }
  const resultingRecipe = list.find((recipe) => recipe.id === resultingRecipeId);
  if (!resultingRecipe) {
    res.status(404).json({ ok: false, error: "结果配方不存在" });
    return;
  }
  if (resultingRecipe.parentId !== id || resultingRecipe.sourceFeedbackId !== fid) {
    res.status(400).json({ ok: false, error: "结果配方与当前反馈的版本链不匹配" });
    return;
  }
  fb.resultingRecipeId = resultingRecipeId;
  saveAll(list);
  res.json({ ok: true });
});

export default recipesRouter;
