/**
 * BLE 实验通道路由（任务 #5）。
 *
 * 契约（前端依赖）：
 *   GET  /api/ble/status  → {available:boolean, connected:boolean, reason?:string}
 *   POST /api/ble/connect → {ok:boolean, device?:string, message?:string}
 *   POST /api/ble/brew    {recipe, confirmSafety:boolean} → 只加载配方，机器端确认开始
 *   POST /api/ble/stop    → {ok:boolean}
 *
 * 说明：配方 grinderSize 为云端标尺 40-120（越小越细）；BLE 路径经
 * validateForTarget 按内部云端标尺 40-120 校验，下发设备前由
 * grinderCloudToBle 线性换算为设备标尺 1-80（见 encodeRecipeHex）。
 */
import { Router } from "express";
import { bleBridge } from "../lib/ble-bridge.js";
import { RecipeSchema } from "../lib/recipe-schema.js";
import { validateForTarget, bleReachabilityWarnings } from "../lib/safety.js";

const router = Router();

/** BLE 能力与连接状态 */
router.get("/status", (_req, res) => {
  res.json(bleBridge.status());
});

/** 扫描并连接 xBloom 设备 */
router.post("/connect", async (_req, res) => {
  try {
    const r = await bleBridge.connect();
    res.json(r);
  } catch (e) {
    res.json({ ok: false, message: `连接异常：${(e as Error).message}` });
  }
});

/** 加载配方到机器：必须显式确认设备准备状态；加载本身不包含远程启动帧。 */
router.post("/brew", async (req, res) => {
  try {
    if (req.body?.confirmSafety !== true) {
      res.json({
        ok: false,
        message: "请先确认手机 App 已断开且机器处于唤醒状态",
      });
      return;
    }

    const parsed = RecipeSchema.safeParse(req.body?.recipe);
    if (!parsed.success) {
      res.json({
        ok: false,
        message: `配方结构校验失败：${parsed.error.issues
          .map((i) => `${i.path.join(".") || "recipe"}: ${i.message}`)
          .join("；")}`,
      });
      return;
    }

    const errors = validateForTarget(parsed.data, "ble");
    if (errors.length > 0) {
      res.json({ ok: false, message: `BLE 边界校验失败：${errors.join("；")}` });
      return;
    }

    // 粉水比可达性只警告不拦截（任务#45，Stan 审查）：不可达组合机器可能拒载，让用户知情
    const warnings = bleReachabilityWarnings(parsed.data);
    if (warnings.length) console.warn(`[xbloom][ble] ${warnings.join("；")}`);
    const result = await bleBridge.brew(parsed.data);
    res.json({ ...result, warnings });
  } catch (e) {
    res.json({ ok: false, message: `冲煮请求异常：${(e as Error).message}` });
  }
});

/** 停止冲煮 */
router.post("/stop", async (_req, res) => {
  try {
    res.json(await bleBridge.stop());
  } catch {
    res.json({ ok: false });
  }
});

export default router;
