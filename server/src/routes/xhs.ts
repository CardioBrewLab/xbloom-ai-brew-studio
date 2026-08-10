/**
 * 小红书账号登录路由（任务 #83）：失效自动提醒的应用内侧——
 * - GET  /api/xhs/status        探活 + 登录态检查（离线返回 online:false，前端显示「服务未启动」）
 * - POST /api/xhs/login/qrcode  获取登录二维码（base64 data URL + 过期时刻）
 * - GET  /api/xhs/login/poll    前端轮询（2-3s 间隔）确认是否已扫码
 * - POST /api/xhs/logout        删除 cookies 重置登录态（主动切换账号的前置步骤）
 * - POST /api/xhs/login/cookie-import  扫码被风控拦截时的兜底：粘贴浏览器 Cookie 导入登录
 *   （任务 #97；MCP 每次调用都会从 cookies.json 重建浏览器并注入 cookie，写入即生效无需重启）
 * 纪律：沿用 xhs-mcp.ts 的独立时间盒（探活 3s / 工具 ≤18s，均 ≤20s）；
 * 一切失败均返回 HTTP 200 + { ok:false, message } 结构化错误，绝不抛 500。
 */
import { Router } from "express";
import { config } from "../config.js";
import { importXhsBrowserCookies } from "../lib/xhs-cookie-import.js";
import {
  checkXhsLoginStatus,
  getXhsLoginQrcode,
  resetXhsCookies,
  xhsMcpHealthy,
} from "../lib/xhs-mcp.js";

export const xhsRouter = Router();

/** 统一错误文案：MCP 未配置/离线（与「掉登录」严格区分，避免误导用户） */
const MCP_OFFLINE_MSG = "小红书本地服务未启动（xiaohongshu-mcp），请确认常驻服务已运行后重试";

/** 兜底异常文案（不向前端泄漏堆栈细节，保留可读原因） */
function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/aborted|timeout|timed out/i.test(m)) return "小红书服务响应超时，请稍后重试";
  return m.length > 160 ? `${m.slice(0, 160)}…` : m;
}

type XhsFailureKind = "service_offline" | "browser_timeout" | "no_qrcode" | "unknown";

function failureKind(e: unknown): XhsFailureKind {
  const message = e instanceof Error ? e.message : String(e);
  return /aborted|timeout|timed out/i.test(message) ? "browser_timeout" : "unknown";
}

/**
 * GET /status：{ online, loggedIn, nickname?, checkFailed?, message? }
 * online:false = MCP 服务未启动（非掉登录）；checkFailed:true = 服务在线但
 * 登录态检查本身失败（浏览器异常等），前端展示「状态未知」。
 */
xhsRouter.get("/status", async (_req, res) => {
  if (!config.xhsMcpUrl || !(await xhsMcpHealthy())) {
    res.json({
      ok: true,
      online: false,
      loggedIn: false,
      failureKind: "service_offline",
      message: MCP_OFFLINE_MSG,
    });
    return;
  }
  try {
    const status = await checkXhsLoginStatus();
    res.json({
      ok: true,
      online: true,
      loggedIn: status.loggedIn,
      ...(status.nickname ? { nickname: status.nickname } : {}),
    });
  } catch (e) {
    res.json({
      ok: true,
      online: true,
      loggedIn: false,
      checkFailed: true,
      failureKind: failureKind(e),
      message: errMsg(e),
    });
  }
});

/**
 * POST /login/qrcode：{ qrcode(dataURL), expiresAt(ms), hint? } | { alreadyLoggedIn:true }
 * 已登录时 MCP 不下发二维码——切换账号请先调用 /logout 重置登录态。
 */
xhsRouter.post("/login/qrcode", async (_req, res) => {
  if (!config.xhsMcpUrl || !(await xhsMcpHealthy())) {
    res.json({
      ok: false,
      online: false,
      failureKind: "service_offline",
      message: MCP_OFFLINE_MSG,
    });
    return;
  }
  try {
    const qr = await getXhsLoginQrcode();
    if (qr.alreadyLoggedIn) {
      res.json({
        ok: true,
        online: true,
        alreadyLoggedIn: true,
        message: "当前账号已登录；如需切换账号，请先登出再重新扫码",
      });
      return;
    }
    if (!qr.qrcode) {
      res.json({
        ok: false,
        online: true,
        failureKind: "no_qrcode",
        message: qr.hint || "未能获取登录二维码，请重试",
      });
      return;
    }
    res.json({
      ok: true,
      online: true,
      qrcode: qr.qrcode,
      expiresAt: qr.expiresAt,
      ...(qr.hint ? { hint: qr.hint } : {}),
    });
  } catch (e) {
    res.json({ ok: false, online: true, failureKind: failureKind(e), message: errMsg(e) });
  }
});

/**
 * GET /login/poll：前端扫码期间 2-3s 轮询一次；{ loggedIn, nickname? }。
 * 单次失败返回 ok:false（前端忽略并继续轮询，直至二维码过期自动停止）。
 */
xhsRouter.get("/login/poll", async (_req, res) => {
  if (!config.xhsMcpUrl || !(await xhsMcpHealthy())) {
    res.json({
      ok: false,
      online: false,
      loggedIn: false,
      failureKind: "service_offline",
      message: MCP_OFFLINE_MSG,
    });
    return;
  }
  try {
    const status = await checkXhsLoginStatus();
    res.json({
      ok: true,
      online: true,
      loggedIn: status.loggedIn,
      ...(status.nickname ? { nickname: status.nickname } : {}),
    });
  } catch (e) {
    res.json({
      ok: false,
      online: true,
      loggedIn: false,
      failureKind: failureKind(e),
      message: errMsg(e),
    });
  }
});

/**
 * POST /login/cookie-import（任务 #97 扫码风控兜底）：
 * body { cookie: string }（浏览器复制的 Cookie 字符串）。
 * 流程：探活 → 解析校验并写入 cookies.json（保留指纹 seed）→ check_login_status
 * 验证导入的凭证是否被小红书接受。
 * 返回：{ ok, online, loggedIn?, nickname?, message }（全部 HTTP 200 结构化）。
 */
xhsRouter.post("/login/cookie-import", async (req, res) => {
  if (!config.xhsMcpUrl || !(await xhsMcpHealthy())) {
    res.json({ ok: false, online: false, message: MCP_OFFLINE_MSG });
    return;
  }
  const raw = typeof req.body?.cookie === "string" ? req.body.cookie : "";
  try {
    const result = importXhsBrowserCookies(raw);
    // 写入后立即验证：MCP 下一次工具调用就会用新 cookie 重建浏览器
    const status = await checkXhsLoginStatus();
    if (!status.loggedIn) {
      res.json({
        ok: false,
        online: true,
        loggedIn: false,
        message: `Cookie 已写入（${result.count} 条）但验证未通过：Cookie 可能已过期或复制不完整，请在已登录页面重新复制后再试`,
      });
      return;
    }
    res.json({
      ok: true,
      online: true,
      loggedIn: true,
      ...(status.nickname ? { nickname: status.nickname } : {}),
      message: "Cookie 导入成功，登录已恢复",
    });
  } catch (e) {
    res.json({ ok: false, online: true, loggedIn: false, message: errMsg(e) });
  }
});

/**
 * POST /logout：删除 cookies 重置登录态（主动切换账号前置）。
 * 成功后前端再取二维码即为「换号扫码」。
 */
xhsRouter.post("/logout", async (_req, res) => {
  if (!config.xhsMcpUrl || !(await xhsMcpHealthy())) {
    res.json({ ok: false, online: false, message: MCP_OFFLINE_MSG });
    return;
  }
  try {
    await resetXhsCookies();
    res.json({ ok: true, online: true, message: "已登出，请重新扫码登录" });
  } catch (e) {
    res.json({ ok: false, online: true, message: errMsg(e) });
  }
});

export default xhsRouter;
