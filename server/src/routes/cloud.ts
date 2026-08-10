/**
 * xBloom 云端 API 路由（default export Router，挂载于 /api/cloud）。
 *
 * 契约（前端原样依赖）：
 * - POST   /login   {email,password} → {ok:true, memberId, email} | {ok:false, message}
 * - POST   /logout                    → {ok:true}
 * - GET    /status                    → {reachable, loggedIn, proxyUsed, message, autoLogin, email?}
 *   会话缺失但 .env 配置了凭据时，status 也会静默自动登录（云端不可达时跳过，避免慢响应）
 * - POST   /publish {recipe, name?, theColor?} → {ok:true, shareUrl, tableId, adjustments, readback?} | {ok:false, message}
 * - POST   /publish-preview {recipe, name?} → {ok:true, adjustments, alignedGrandWater, cloudRatio, pours} | {ok:false, message}
 * - GET    /recipes                   → {ok:true, recipes:[{tableId, theName, dose, ...}]} | {ok:false, message}
 * - PUT    /recipes/:tableId {recipe, name?} → {ok:true, shareUrl, tableId, adjustments, readback?} | {ok:false, message}
 * - DELETE /recipes/:tableId          → {ok:true} | {ok:false, message}
 * - GET    /detail/:shareId           → {ok:true, recipe, raw} | {ok:false, message}
 *
 * 说明：index.ts 由另一位工程师挂载（动态 import + try/catch），本文件只负责导出 Router。
 */
import { Router, json, type NextFunction, type Request, type Response } from "express";
import { RecipeSchema, type Recipe } from "../lib/recipe-schema.js";
import { validateForTarget } from "../lib/safety.js";
import { writeBackAlignedRecipe } from "../lib/local-writeback.js";
import {
  checkReachable,
  clearSession,
  createRecipe,
  deleteRecipe,
  ensureSession,
  fetchSharedRecipe,
  hasAutoLoginCredentials,
  listMyRecipes,
  loadSession,
  login,
  maskEmail,
  prewarmSession,
  readBackCloudRecipe,
  toCloudPayload,
  updateRecipe,
  type CloudSession,
} from "../lib/xbloom-cloud.js";

// 启动自检：配置了凭据且无现成会话时后台异步预热登录；失败只记日志，不影响服务启动
void prewarmSession();

const router = Router();
// 兜底：即便宿主未提前挂 express.json()，本路由也能解析 JSON body
router.use(json({ limit: "1mb" }));
// JSON 解析错误统一转成 {ok:false}，不让 Express 默认错误页/崩溃接管
router.use((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
  if (err instanceof SyntaxError) {
    res.status(200).json({ ok: false, message: "请求体不是合法 JSON" });
    return;
  }
  next(err);
});

/** async 处理器统一兜底：任何异常都转成 {ok:false,message}，绝不让路由崩溃；
 *  异常同步写入后端日志，便于诊断"前端卡住/报错"类问题（任务#88） */
function safe(handler: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.warn(`[xbloom][cloud] ${req.method} ${req.path} 异常：${message}`);
      res.status(200).json({ ok: false, message });
    }
  };
}

// 对齐值回写本地配方库（任务#45 Stan 审查引入，任务#55 修正匹配语义）：
// 实现见 ../lib/local-writeback.js——整段 pours 规范化 JSON 参与匹配，
// 避免版本链条目（仅温度/流速不同）被误覆写；重复条目全部回写。

// --- POST /api/cloud/login ---------------------------------------------------
router.post(
  "/login",
  safe(async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password) {
      res.json({ ok: false, message: "缺少 email 或 password" });
      return;
    }
    const session = await login(email, password);
    res.json({ ok: true, memberId: session.memberId, email: maskEmail(session.email) });
  }),
);

// --- POST /api/cloud/logout --------------------------------------------------
router.post(
  "/logout",
  safe(async (_req, res) => {
    clearSession();
    res.json({ ok: true });
  }),
);

// --- GET /api/cloud/status ----------------------------------------------------
router.get(
  "/status",
  safe(async (_req, res) => {
    const probe = await checkReachable(); // 内部 5s 快速失败，不抛异常
    // 自动登录：有缓存会话直接用；否则云端可达时尝试 ensureSession（.env 凭据静默登录），
    // 失败（凭据未配置/登录失败）仅按未登录处理，不透异常
    let session: CloudSession | null = loadSession();
    if (!session && probe.reachable) {
      try {
        session = await ensureSession();
      } catch {
        session = null;
      }
    }
    const loggedIn = session !== null;
    res.json({
      reachable: probe.reachable,
      loggedIn,
      proxyUsed: probe.proxyUsed,
      autoLogin: hasAutoLoginCredentials(),
      // 状态接口只返回脱敏标识；完整邮箱和密码始终留在本机加密会话中。
      ...(loggedIn && session?.email ? { email: maskEmail(session.email) } : {}),
      message: loggedIn
        ? `${probe.message}；已登录 xBloom 云端（${session!.email ? maskEmail(session!.email) : "本机账号"}）`
        : probe.message,
    });
  }),
);

// --- POST /api/cloud/publish ---------------------------------------------------
router.post(
  "/publish",
  safe(async (req, res) => {
    const t0 = Date.now();
    console.log(`[xbloom][cloud] 收到发布请求 name=${JSON.stringify(req.body?.name ?? "")}`);
    // 1. 结构校验（RecipeSchema：枚举 + 各段之和 === grandWater）
    const parsed = RecipeSchema.safeParse(req.body?.recipe);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "recipe"}: ${i.message}`,
      );
      res.json({ ok: false, message: `配方结构不合法：${issues.join("；")}` });
      return;
    }
    const name =
      typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : undefined;
    // theColor 透传：body 显式指定的合法色值优先，其次配方自带 theColor
    let recipe: Recipe = parsed.data;
    const color = req.body?.theColor;
    if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
      recipe = { ...recipe, theColor: color };
    }
    // 2. 映射对齐：ratio 0.1 步进可达性对齐（不可达的总水量会被官方拒收），
    //    用对齐后的值重建配方，后续校验/发布/预览全部以实际上传值为准
    const preAligned = recipe;
    const mapped = toCloudPayload(recipe, name);
    if (mapped.adjustments.length > 0) {
      recipe = { ...recipe, grandWater: mapped.alignedGrandWater, pours: mapped.alignedPours };
    }
    // 3. 云端路径专属边界校验（对齐后的配方必然满足 ratio 可达性）
    const errors = validateForTarget(recipe, "cloud");
    if (errors.length) {
      res.json({ ok: false, message: `配方不满足云端下发边界：${errors.join("；")}` });
      return;
    }
    // 4. 登录态检查：无缓存会话则尝试 .env 凭证自动登录（ensureSession 内部处理）
    const session = await ensureSession();
    // 5. 发布并返回分享链接（adjustments：映射层为通过官方校验对总水/分段做过的对齐；
    //    readback：发布后回读云端存储值的 Σ分段==dose×ratio 等式验证报告，任务#45）
    const result = await createRecipe(recipe, { name, session });
    // 6. 对齐成功且有实际改写时，回写本地配方条目，避免本地/云端数值漂移（Stan 审查，任务#45）
    let localRecipeId: string | undefined;
    if (mapped.adjustments.length > 0) {
      localRecipeId = writeBackAlignedRecipe(
        preAligned,
        mapped.alignedGrandWater,
        mapped.alignedPours,
      );
    }
    res.json({
      ok: true,
      shareUrl: result.shareUrl,
      tableId: result.tableId,
      adjustments: mapped.adjustments,
      verification: result.verification,
      ...(result.readback ? { readback: result.readback } : {}),
      ...(localRecipeId ? { localRecipeId } : {}),
    });
    console.log(`[xbloom][cloud] 发布成功 tableId=${result.tableId}，耗时 ${Date.now() - t0}ms`);
  }),
);

// --- POST /api/cloud/publish-preview（发布前预览实际上传值）-------------------------
// 复用发布链路的同一套映射：返回对齐说明 adjustments 与对齐后的总水/分段水量，
// 供前端预览弹窗如实展示（官方要求 Σ 分段水量 = dose × ratio，不一致会被拒）。
router.post(
  "/publish-preview",
  safe(async (req, res) => {
    const parsed = RecipeSchema.safeParse(req.body?.recipe);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "recipe"}: ${i.message}`,
      );
      res.json({ ok: false, message: `配方结构不合法：${issues.join("；")}` });
      return;
    }
    const name =
      typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : undefined;
    let recipe: Recipe = parsed.data;
    const color = req.body?.theColor;
    if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
      recipe = { ...recipe, theColor: color };
    }
    const mapped = toCloudPayload(recipe, name);
    const payload = mapped.payload;
    // 与真实 publish 同一口径（Stan/Kim 审查必改）：预演也跑一遍云端边界校验，
    // 避免越界配方预演显示 ok 但实发被拒
    let aligned: Recipe = recipe;
    if (mapped.adjustments.length > 0) {
      aligned = { ...recipe, grandWater: mapped.alignedGrandWater, pours: mapped.alignedPours };
    }
    const errors = validateForTarget(aligned, "cloud");
    if (errors.length) {
      res.json({
        ok: false,
        message: `配方不满足云端下发边界：${errors.join("；")}`,
        adjustments: mapped.adjustments,
      });
      return;
    }
    const pours = JSON.parse(payload.pourDataJSONStr as string) as Array<Record<string, unknown>>;
    res.json({
      ok: true,
      adjustments: mapped.adjustments,
      alignedGrandWater: mapped.alignedGrandWater,
      cloudRatio: payload.grandWater,
      pours: pours.map((p) => ({ theName: p.theName, volume: p.volume })),
    });
  }),
);

// --- POST /api/cloud/verify/:tableId（对已写入记录重新回读确认）-------------------
router.post(
  "/verify/:tableId",
  safe(async (req, res) => {
    const param = Array.isArray(req.params.tableId) ? req.params.tableId[0] : req.params.tableId;
    const tableId = Number(param);
    if (!param || !Number.isSafeInteger(tableId) || tableId <= 0) {
      res.json({ ok: false, message: "缺少合法的 tableId" });
      return;
    }
    const session = await ensureSession();
    const readback = await readBackCloudRecipe(tableId, { session });
    res.json({
      ok: true,
      readback,
      verification: {
        state: readback.ok ? "verified" : "mismatch",
        message: readback.message,
      },
    });
  }),
);

// --- GET /api/cloud/recipes（我的配方列表）--------------------------------------
router.get(
  "/recipes",
  safe(async (_req, res) => {
    const session = await ensureSession();
    const recipes = await listMyRecipes({ session });
    res.json({ ok: true, recipes });
  }),
);

// --- PUT /api/cloud/recipes/:tableId（更新配方）-----------------------------------
router.put(
  "/recipes/:tableId",
  safe(async (req, res) => {
    const param = req.params.tableId;
    const tableIdStr = Array.isArray(param) ? param[0] : param;
    const tableId = Number(tableIdStr);
    if (!tableIdStr || !Number.isFinite(tableId) || tableId <= 0) {
      res.json({ ok: false, message: "缺少合法的 tableId" });
      return;
    }
    const parsed = RecipeSchema.safeParse(req.body?.recipe);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "recipe"}: ${i.message}`,
      );
      res.json({ ok: false, message: `配方结构不合法：${issues.join("；")}` });
      return;
    }
    const name =
      typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : undefined;
    // 同 /publish：先做 ratio 可达性对齐，再拿对齐后的配方过边界校验
    const preAligned = parsed.data;
    const mapped = toCloudPayload(parsed.data, name);
    let recipe: Recipe = parsed.data;
    if (mapped.adjustments.length > 0) {
      recipe = { ...recipe, grandWater: mapped.alignedGrandWater, pours: mapped.alignedPours };
    }
    const errors = validateForTarget(recipe, "cloud");
    if (errors.length) {
      res.json({ ok: false, message: `配方不满足云端下发边界：${errors.join("；")}` });
      return;
    }
    const session = await ensureSession();
    const result = await updateRecipe(tableId, recipe, { name, session });
    let localRecipeId: string | undefined;
    if (mapped.adjustments.length > 0) {
      localRecipeId = writeBackAlignedRecipe(
        preAligned,
        mapped.alignedGrandWater,
        mapped.alignedPours,
      );
    }
    res.json({
      ok: true,
      shareUrl: result.shareUrl,
      tableId: result.tableId,
      adjustments: mapped.adjustments,
      verification: result.verification,
      ...(result.readback ? { readback: result.readback } : {}),
      ...(localRecipeId ? { localRecipeId } : {}),
    });
  }),
);

// --- DELETE /api/cloud/recipes/:tableId（删除配方）---------------------------------
router.delete(
  "/recipes/:tableId",
  safe(async (req, res) => {
    const param = req.params.tableId;
    const tableIdStr = Array.isArray(param) ? param[0] : param;
    const tableId = Number(tableIdStr);
    if (!tableIdStr || !Number.isFinite(tableId) || tableId <= 0) {
      res.json({ ok: false, message: "缺少合法的 tableId" });
      return;
    }
    const session = await ensureSession();
    await deleteRecipe(tableId, { session });
    res.json({ ok: true });
  }),
);

// --- GET /api/cloud/detail/:shareId ---------------------------------------------
router.get(
  "/detail/:shareId",
  safe(async (req, res) => {
    // Express 5 下 params 类型可能带 string[]，统一取首个字符串
    const param = req.params.shareId;
    const shareId = Array.isArray(param) ? param[0] : param;
    if (!shareId) {
      res.json({ ok: false, message: "缺少分享 ID" });
      return;
    }
    const { recipe, raw } = await fetchSharedRecipe(shareId);
    res.json({ ok: true, recipe, raw });
  }),
);

export default router;
