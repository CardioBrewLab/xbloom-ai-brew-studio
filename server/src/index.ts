/**
 * xBloom AI 冲煮工作台 —— 后端入口。
 * 监听 127.0.0.1:8787。
 * - 任务 #2：LLM 流式配方生成（/api/generate）+ 本地配方库（/api/recipes）
 * - 任务 #3（云端）/ #5（BLE）：try/catch 动态 import，文件缺失时静默跳过
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { config } from "./config.js";
import { initializeLlmSettings } from "./lib/llm-settings.js";
import { SAFE_LIMITS } from "./lib/recipe-schema.js";
import generateRouter from "./routes/generate.js";
import recipesRouter from "./routes/recipes.js";
import beansRouter from "./routes/beans.js";
import settingsRouter from "./routes/settings.js";
import xhsRouter from "./routes/xhs.js";

export const VERSION = "0.1.1";

// 在挂载生成路由前应用本机模型覆盖；只改变 LLM 客户端运行参数，不改变监听地址或部署。
initializeLlmSettings();

// --- 进程级兜底（任务 #14）----------------------------------------------------
// BLE 原生层（noble）或其他异步源的异常绝不应无声杀死服务：
// 记录完整堆栈到日志后继续运行；exit/beforeExit 钩子记录退出原因，便于排查。
function describeError(e: unknown): string {
  if (e instanceof Error) return e.stack ?? `${e.name}: ${e.message}`;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
process.on("uncaughtException", (e) => {
  // 端口被占用绝不能被吞：立即报错退出，避免服务看似在跑实则未监听
  if ((e as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    console.error(
      `[xbloom][fatal] 端口 ${config.port} 已被占用（EADDRINUSE），服务无法监听，退出。请释放端口或修改 .env 的 PORT`,
    );
    process.exit(1);
  }
  console.error(
    `[xbloom][fatal-guard] uncaughtException（已拦截，服务继续运行）：\n${describeError(e)}`,
  );
});
process.on("unhandledRejection", (reason) => {
  console.error(
    `[xbloom][fatal-guard] unhandledRejection（已拦截，服务继续运行）：\n${describeError(reason)}`,
  );
});
process.on("beforeExit", (code) => {
  console.log(`[xbloom][exit] beforeExit code=${code}（事件循环已空）`);
});
process.on("exit", (code) => {
  console.log(`[xbloom][exit] process exit code=${code}`);
});

/** 动态挂载可选路由模块：其他工程师并行开发，文件可能尚不存在 */
async function tryImportRouter(modulePath: string): Promise<Router | null> {
  try {
    const mod = await import(modulePath);
    return (mod.default ?? mod.router ?? null) as Router | null;
  } catch {
    return null; // 模块未就绪 → 静默跳过
  }
}

const cloudRouter = await tryImportRouter("./routes/cloud.js"); // 任务 #3
const bleRouter = await tryImportRouter("./routes/ble.js"); // 任务 #5

const app = express();
app.use(express.json({ limit: "1mb" }));

/** 全局 JSON 解析错误中间件：非法请求体统一返回 {ok:false,message} */
app.use((err: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
  if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
    res.status(400).json({ ok: false, message: "请求体不是合法 JSON" });
    return;
  }
  next(err);
});

// --- 路由挂载 ---------------------------------------------------------------
app.use(generateRouter); // POST /api/generate（任务 #2）
app.use(recipesRouter); // /api/recipes CRUD + 冲煮反馈（任务 #2 / #11）
app.use(beansRouter); // /api/beans 豆库 CRUD（任务 #11）
app.use("/api/settings", settingsRouter); // /api/settings/llm 本机模型接口设置
app.use("/api/xhs", xhsRouter); // /api/xhs 小红书登录态/扫码续期（任务 #83）
if (cloudRouter) app.use("/api/cloud", cloudRouter);
if (bleRouter) app.use("/api/ble", bleRouter);

/** 能力表：按实际挂载结果计算 */
const capabilities = {
  generate: true, // 任务 #2 已接入
  cloud: cloudRouter !== null, // 任务 #3 就绪后置 true
  ble: bleRouter !== null, // 任务 #5 就绪后置 true
  beans: true, // 任务 #11 豆库
  feedback: true, // 任务 #11 冲煮反馈闭环
};

/** 健康检查与能力探测 */
app.get("/api/status", (_req, res) => {
  res.json({ ok: true, version: VERSION, capabilities });
});

/** 前端配置：可用模型列表（主/兜底链，从配置读取不硬编码）与安全边界 */
app.get("/api/config", (_req, res) => {
  const models = [config.llm.model, config.llm.fallbackModel, config.llm.thirdModel].filter(
    (m, i, arr) => m && arr.indexOf(m) === i,
  );
  res.json({
    models,
    defaultModel: config.llm.model,
    limits: SAFE_LIMITS,
    // 云端区域（与 xbloom-cloud.isCnRegion 同逻辑；不直接 import 以保持云端模块可选）
    cloudRegion: (process.env.XBLOOM_REGION || "").trim().toLowerCase() === "cn" ? "cn" : "global",
  });
});

// 静态托管前端构建产物（web/dist 存在时生效，便于单端口预览）
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(
    express.static(webDist, {
      // 文本类资源强制携带 charset=utf-8：
      // 缺失 charset 时浏览器（尤其 PWA/缓存场景）可能按本地编码（GBK）猜测解码，
      // 导致页面中文文案/标题乱码（任务 #40）。
      setHeaders(res, filePath) {
        const ct = String(res.getHeader("Content-Type") ?? "");
        if (filePath.endsWith(".webmanifest") && !ct.includes("manifest")) {
          res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
          return;
        }
        if (
          /^(text\/|application\/(javascript|json|manifest)|image\/svg)/.test(ct) &&
          !/charset=/i.test(ct)
        ) {
          res.setHeader("Content-Type", ct + "; charset=utf-8");
        }
      },
    }),
  );
}

const server = app.listen(config.port, config.host, () => {
  console.log(`[xbloom] server listening on http://${config.host}:${config.port}`);
  console.log(`[xbloom] capabilities: ${JSON.stringify(capabilities)}`);
});
// listen 错误（如 EADDRINUSE）走 server 的 error 事件：同样报错后立即退出，绝不被吞
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[xbloom][fatal] 端口 ${config.port} 已被占用（EADDRINUSE），服务无法监听，退出。请释放端口或修改 .env 的 PORT`,
    );
  } else {
    console.error(`[xbloom][fatal] HTTP server 错误：${describeError(err)}`);
  }
  process.exit(1);
});
