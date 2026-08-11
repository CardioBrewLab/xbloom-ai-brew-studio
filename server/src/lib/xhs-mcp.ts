/**
 * 小红书 MCP 直连客户端（任务 #82）：
 * 本机常驻的 xiaohongshu-mcp（v2.4.3，Streamable HTTP 端点，默认
 * http://127.0.0.1:18060）提供 search_feeds / get_feed_detail 等工具，
 * 比免 key 搜索引擎的 site: 语法召回质量高得多（实测 10+ 条真实笔记）。
 *
 * 调用方式：原生 fetch 走 MCP Streamable HTTP JSON-RPC（initialize →
 * tools/call），不引入 @modelcontextprotocol/sdk 等重依赖。
 * 已知风险：search_feeds 首次调用偶发约 60s 超时——所有 MCP 请求都带
 * 独立时间盒（health 3s / search_feeds 25s（任务 #86 放宽，原 16s 实测偶发截断） /
 * 其余工具调用 16s / 正文深取 18s，由调研级 signal 合并兑底），超时即抛错，由调用方
 * （research.ts searchXiaohongshuDirected）静默降级到 site: 定向 + 域名过滤路径。
 *
 * 任务 #83：登录态检测与扫码续期已在本模块落地——
 * checkXhsLoginStatus（check_login_status）/ getXhsLoginQrcode（get_login_qrcode，
 * 返回 base64 二维码 图 + 过期时刻）/ resetXhsCookies（delete_cookies，主动切换账号
 * 前先重置登录态），均由 xhsMcpCallToolContents 走完整 JSON-RPC 流程；
 * isXhsLoginExpiredError 识别未登录/凭证失效类错误特征，供 research.ts 路径 0 标记降级。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

/** MCP 工具调用默认时间盒（实测首次 search_feeds 偶发 ~60s 挂死，宁超时降级） */
export const XHS_MCP_TOOL_TIMEOUT_MS = 16_000;
/**
 * search_feeds 专用时间盒（任务 #86：16s 实测偏紧——「阿朵斯 手冲」在 16s 被截断，
 * 而小红书 App 内搜同词有大量笔记，属调用侧超时而非平台无内容；放宽到 25s，
 * 调研总时间盒 40s 与外部 signal 仍兑底，超盒部分由深取/后续渠道降级吸收）
 */
export const XHS_MCP_SEARCH_TIMEOUT_MS = 25_000;
/** /health 探活时间盒（离线判定必须快，避免浪费调研时间预算） */
export const XHS_MCP_HEALTH_TIMEOUT_MS = 3_000;
/** 正文深取时间盒（仅对无摘要的 top 笔记做 1 条深取，超预算直接放弃） */
export const XHS_MCP_DETAIL_TIMEOUT_MS = 18_000;

/** 可测性钩子：所有超时都可经此参数缩短（单测用），缺省用上述常量 */
export interface XhsMcpOptions {
  /** 覆盖 MCP 基址（默认 config.xhsMcpUrl） */
  baseUrl?: string;
  /** 覆盖工具调用超时 */
  toolTimeoutMs?: number;
  /** 覆盖 /health 探活超时 */
  healthTimeoutMs?: number;
  /** 外部中止信号（调研总时间盒） */
  signal?: AbortSignal;
}

/** MCP content 单项（xiaohongshu-mcp 结果含 text/image 两类 content） */
export interface XhsMcpContentItem {
  type?: string;
  text?: string;
  /** image content 的 base64 数据（或偶发的本地临时图片路径） */
  data?: string;
  mimeType?: string;
}

/** 外部中止 + 请求级超时合并；signal 缺省时仅超时约束 */
function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** 基址规整：去末尾斜杠；未配置返回空串（调用方视为禁用） */
function mcpBaseUrl(options?: XhsMcpOptions): string {
  return (options?.baseUrl ?? config.xhsMcpUrl ?? "").replace(/\/+$/, "");
}

/**
 * GET /health 快速探活：返回 true 表示 MCP 在线。
 * 离线/超时/非 2xx 一律返回 false（调用方直接跳过 MCP 路径，不浪费等待）。
 */
export async function xhsMcpHealthy(options?: XhsMcpOptions): Promise<boolean> {
  const base = mcpBaseUrl(options);
  if (!base) return false;
  try {
    const res = await fetch(`${base}/health`, {
      signal: withTimeout(options?.healthTimeoutMs ?? XHS_MCP_HEALTH_TIMEOUT_MS, options?.signal),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** JSON-RPC id 自增计数器（会话内唯一即可，服务端无状态校验） */
let rpcSeq = 0;

/**
 * MCP 工具调用底层封装（initialize → tools/call 两轮 JSON-RPC），
 * 返回完整 content 数组（任务 #83：get_login_qrcode 的二维码图片在
 * image content 中，仅取首个 text 会丢失）。
 * 非 2xx / JSON-RPC error / 超时 / content 缺失都抛错，由调用方降级处理。
 */
export async function xhsMcpCallToolContents(
  name: string,
  args: Record<string, unknown>,
  options?: XhsMcpOptions,
): Promise<XhsMcpContentItem[]> {
  const base = mcpBaseUrl(options);
  if (!base) throw new Error("XHS_MCP_URL 未配置");
  const signal = withTimeout(options?.toolTimeoutMs ?? XHS_MCP_TOOL_TIMEOUT_MS, options?.signal);
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcSeq,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "xbloom-research", version: "1.0" },
      },
    }),
  });
  if (!res.ok) throw new Error(`MCP initialize 失败（HTTP ${res.status}）`);
  await res.json().catch(() => null); // initialize 响应体不用，消费掉连接即可
  const callRes = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcSeq,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!callRes.ok) throw new Error(`MCP tools/call 失败（HTTP ${callRes.status}）`);
  const json = (await callRes.json()) as {
    result?: { content?: XhsMcpContentItem[]; isError?: boolean };
    error?: { message?: string };
  };
  if (json.error) throw new Error(`MCP 错误：${json.error.message ?? "未知"}`);
  const content = json.result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error("MCP 响应缺少 content");
  }
  if (json.result?.isError) {
    const text = content.find((c) => c?.type === "text")?.text ?? "";
    throw new Error(`MCP 工具报错：${text.slice(0, 120)}`);
  }
  return content;
}

/**
 * MCP 工具调用（任务 #82 原签名保留）：返回 result.content 首个 text
 * （xiaohongshu-mcp 约定：工具结果序列化为 JSON 字符串放在首个 text content 中）；
 * 缺少 text 内容抛错，由调用方降级处理。
 */
export async function xhsMcpCallTool(
  name: string,
  args: Record<string, unknown>,
  options?: XhsMcpOptions,
): Promise<string> {
  const content = await xhsMcpCallToolContents(name, args, options);
  const text = content.find((c) => c?.type === "text")?.text;
  if (typeof text !== "string" || !text) throw new Error("MCP 响应缺少 text 内容");
  return text;
}

/** 安全 JSON.parse：失败返回 null */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** search_feeds 返回的笔记（仅保留调研所需字段） */
export interface XhsMcpNote {
  /** 笔记 id（feed_id） */
  id: string;
  /** 访问令牌（笔记详情 URL 必需参数，有时效） */
  xsecToken: string;
  /** 笔记标题（noteCard.displayTitle） */
  title: string;
  /** 笔记正文摘要（search_feeds 当前版本不带，字段保留以便后续协议升级） */
  desc: string;
  /** 点赞数（用于挑选深取目标：互动高 → 内容质量大概率更高） */
  likedCount: number;
}

/** 从 feeds 数组提取笔记；非法条目跳过（纯函数可测） */
export function parseXhsMcpFeeds(feeds: unknown): XhsMcpNote[] {
  const out: XhsMcpNote[] = [];
  if (!Array.isArray(feeds)) return out;
  for (const item of feeds) {
    if (!item || typeof item !== "object") continue;
    const f = item as {
      id?: unknown;
      xsecToken?: unknown;
      noteCard?: {
        displayTitle?: unknown;
        desc?: unknown;
        interactInfo?: { likedCount?: unknown };
      };
    };
    const id = typeof f.id === "string" ? f.id : "";
    const title =
      typeof f.noteCard?.displayTitle === "string" ? f.noteCard.displayTitle.trim() : "";
    if (!id || !title) continue;
    const likedRaw = f.noteCard?.interactInfo?.likedCount;
    out.push({
      id,
      xsecToken: typeof f.xsecToken === "string" ? f.xsecToken : "",
      title,
      desc: typeof f.noteCard?.desc === "string" ? f.noteCard.desc.trim() : "",
      likedCount: Number(likedRaw) || 0,
    });
  }
  return out;
}

/**
 * 解析 MCP 工具响应文本（content[0].text 内的 JSON 字符串），提取 feeds 列表
 * （纯函数可测）：非法 JSON / 缺 feeds 字段返回空数组。
 */
export function parseXhsMcpSearchText(text: string): XhsMcpNote[] {
  const json = tryParseJson(text);
  if (!json || typeof json !== "object") return [];
  return parseXhsMcpFeeds((json as { feeds?: unknown }).feeds);
}

/**
 * search_feeds：按关键词搜索小红书笔记。
 * 时间盒用 search 专用 25s（任务 #86，见 XHS_MCP_SEARCH_TIMEOUT_MS）。
 * MCP 离线/超时/报错由 xhsMcpCallTool 抛错向上传播，调用方降级。
 */
export async function searchXhsMcp(
  keyword: string,
  options?: XhsMcpOptions,
): Promise<XhsMcpNote[]> {
  const text = await xhsMcpCallTool(
    "search_feeds",
    { keyword },
    { ...options, toolTimeoutMs: options?.toolTimeoutMs ?? XHS_MCP_SEARCH_TIMEOUT_MS },
  );
  return parseXhsMcpSearchText(text);
}

/**
 * 笔记真实链接（xiaohongshu.com 域名，天然享受 isXiaohongshu 加权与 kept=true）。
 * xsec_token 是笔记详情页必需参数，必须带上；纯函数可测。
 */
export function xhsNoteUrl(note: { id: string; xsecToken?: string }): string {
  const params = new URLSearchParams({ xsec_token: note.xsecToken ?? "" });
  return `https://www.xiaohongshu.com/explore/${note.id}?${params.toString()}`;
}

/**
 * 笔记 → 调研来源：标题 + 摘要（desc）作 snippet（纯函数可测）。
 * desc 缺省时 snippet 省略，由调用方决定是否深取正文补足。
 */
export function xhsNoteToSource(note: XhsMcpNote): {
  title: string;
  url: string;
  snippet?: string;
} {
  return {
    title: note.title.slice(0, 120),
    url: xhsNoteUrl(note),
    ...(note.desc ? { snippet: note.desc.slice(0, 500) } : {}),
  };
}

/** get_feed_detail 返回的笔记正文（仅保留调研所需字段） */
export interface XhsMcpNoteDetail {
  title: string;
  /** 笔记正文（desc 字段） */
  desc: string;
}

/**
 * 解析 get_feed_detail 响应文本（纯函数可测）：实测响应结构为
 * { feed_id, data: { note: { title, desc, ... } } }，desc 即笔记正文
 * （图文笔记为正文文字，视频笔记往往只有话题标签）；兼容顶层/noteCard 形态。
 * 取不到正文返回空字段，调用方保留标题级来源。
 */
export function parseXhsMcpDetailText(text: string): XhsMcpNoteDetail {
  const json = tryParseJson(text);
  if (!json || typeof json !== "object") return { title: "", desc: "" };
  const obj = json as {
    desc?: unknown;
    title?: unknown;
    data?: { note?: { desc?: unknown; title?: unknown } };
    noteCard?: { title?: unknown; desc?: unknown };
  };
  const pick = (...candidates: unknown[]): string => {
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c;
    }
    return "";
  };
  return {
    title: pick(obj.data?.note?.title, obj.title, obj.noteCard?.title).trim(),
    desc: pick(obj.data?.note?.desc, obj.desc, obj.noteCard?.desc).trim(),
  };
}

/**
 * get_feed_detail：深取单条笔记正文（标题 + desc 拼为可读文本）。
 * 仅对无摘要的 top 笔记使用（控制调用次数与时间盒），失败抛错由调用方降级。
 */
export async function getFeedDetailText(
  feedId: string,
  xsecToken: string,
  options?: XhsMcpOptions,
): Promise<string> {
  const text = await xhsMcpCallTool(
    "get_feed_detail",
    { feed_id: feedId, xsec_token: xsecToken },
    { ...options, toolTimeoutMs: options?.toolTimeoutMs ?? XHS_MCP_DETAIL_TIMEOUT_MS },
  );
  const detail = parseXhsMcpDetailText(text);
  const body = `${detail.title ? `${detail.title}\n` : ""}${detail.desc}`.trim();
  if (!body) throw new Error("笔记正文为空");
  return body.slice(0, 1500);
}

// ---------------------------------------------------------------------------
// 任务 #83：登录态检测 / 扫码续期 / 主动切换账号
// ---------------------------------------------------------------------------

/** check_login_status 解析结果（纯函数可测） */
export interface XhsLoginStatus {
  loggedIn: boolean;
  /** 已登录时的昵称（MCP 返回文本中的用户名行） */
  nickname?: string;
}

/**
 * 解析 check_login_status 工具返回文本（纯函数可测）。实测格式：
 * 已登录："✅ 已登录\n用户名: xxx\n…"；未登录："❌ 未登录\n…"。
 * 无法识别时保守返回未登录（调用方结合探活区分服务离线）。
 */
export function parseXhsLoginStatusText(text: string): XhsLoginStatus {
  if (/✅|已登录/.test(text) && !/未登录/.test(text.split("\n")[0] ?? "")) {
    const m = text.match(/用户名[:：]\s*(.+)/);
    const nickname = m ? m[1].trim().split(/\s+/)[0] : "";
    return { loggedIn: true, ...(nickname ? { nickname } : {}) };
  }
  return { loggedIn: false };
}

/**
 * check_login_status：探活由调用方先行（离线时不必浪费工具调用预算）。
 * MCP 内部导航 explore 页检查登录元素，实测可达十几秒，独立时间盒 18s。
 * 报错（浏览器异常等）向上传播，由路由层转为结构化错误。
 */
export async function checkXhsLoginStatus(options?: XhsMcpOptions): Promise<XhsLoginStatus> {
  const text = await xhsMcpCallTool(
    "check_login_status",
    {},
    { ...options, toolTimeoutMs: options?.toolTimeoutMs ?? XHS_MCP_DETAIL_TIMEOUT_MS },
  );
  return parseXhsLoginStatusText(text);
}

/** get_login_qrcode 解析结果（纯函数可测） */
export interface XhsLoginQrcode {
  /** MCP 判定当前已登录（不下发二维码，调用方提示切换账号需先登出） */
  alreadyLoggedIn: boolean;
  /** 二维码 data URL（image/png base64） */
  qrcode?: string;
  /** 二维码失效时刻（毫秒时间戳；文本中未带截止时间时缺省，调用方兜底倒计时） */
  expiresAt?: number;
  /** MCP 原始提示文案（如「请用小红书 App 在 … 前扫码登录」） */
  hint?: string;
}

/** 二维码缺省有效时长（MCP 文本未带截止时间时的保守兜底，小红书码实测数分钟级） */
export const XHS_QRCODE_FALLBACK_TTL_MS = 150_000;

/** xiaohongshu-mcp 工作目录（tools/xhs-mcp；本文件位于 server/src/lib，向上三级，dev/dist 层级一致） */
export const XHS_MCP_WORK_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tools/xhs-mcp",
);

/**
 * 任务 #99：二维码 image.data 为本地路径时的读取白名单校验（防任意文件读取：
 * 路径完全由外部 MCP 进程决定，只允许系统临时目录或 tools/xhs-mcp 工作目录
 * 前缀下的文件）。Windows 盘符大小写归一化用 toLowerCase；末尾拼分隔符
 * 防「C:\tmp2 前缀匹配 C:\tmp」这类兄弟目录误中。非纯函数部分（tmpdir/
 * 常量）在模块加载时固定，单测可直接断言边界。
 */
export function isXhsAllowedLocalImagePath(raw: string): boolean {
  if (!raw || typeof raw !== "string") return false;
  let resolved: string;
  try {
    resolved = path.resolve(raw).toLowerCase() + path.sep;
  } catch {
    return false;
  }
  const allowedPrefixes = [os.tmpdir(), XHS_MCP_WORK_DIR].map(
    (d) => path.resolve(d).toLowerCase() + path.sep,
  );
  return allowedPrefixes.some((prefix) => resolved.startsWith(prefix));
}

const XHS_QRCODE_MAX_BYTES = 5 * 1024 * 1024;

function imageMime(bytes: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (bytes.length >= 6 && /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}

function inlineVerifiedImage(bytes: Buffer): string | null {
  if (bytes.length === 0 || bytes.length > XHS_QRCODE_MAX_BYTES) return null;
  const mime = imageMime(bytes);
  return mime ? `data:${mime};base64,${bytes.toString("base64")}` : null;
}

/**
 * 解析 get_login_qrcode 的 content 数组（纯函数可测）。实测形态：
 * [{type:"text",text:"请用小红书 App 在 2026-08-07 15:04:05 前扫码登录 👇"},
 *  {type:"image",mimeType:"image/png",data:"<base64>"}]；
 * 已登录时仅返回文本「你当前已处于登录状态」。
 * image.data 兼容三种形态：data: URL / 裸 base64 / 本地临时图片路径（读成 base64）。
 * now 参数可注入便于单测；时间按 MCP 服务所在机器本地时区（同机部署，一致）。
 */
export function parseXhsQrcodeContents(
  contents: XhsMcpContentItem[],
  now: number = Date.now(),
): XhsLoginQrcode {
  const text = contents.find((c) => c?.type === "text")?.text?.trim() ?? "";
  const image = contents.find((c) => c?.type === "image" && c.data);
  if (!image) {
    // 无图片：已登录短路提示，或异常形态（调用方展示 hint）
    return { alreadyLoggedIn: /已处于登录状态|已登录/.test(text), ...(text ? { hint: text } : {}) };
  }
  const raw = image.data as string;
  let dataUrl: string | null = null;
  const dataUrlMatch = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (dataUrlMatch) {
    dataUrl = inlineVerifiedImage(Buffer.from(dataUrlMatch[2].replace(/\s/g, ""), "base64"));
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.replace(/\s/g, "").length > 64) {
    dataUrl = inlineVerifiedImage(Buffer.from(raw.replace(/\s/g, ""), "base64"));
  } else if (isXhsAllowedLocalImagePath(raw) && fs.existsSync(raw)) {
    // 偶发返回本地临时图片路径：读成 base64 内联，前端无需再访问 MCP 机器文件。
    // 任务 #99：先过目录白名单（仅临时目录/tools\xhs-mcp），防 MCP 返回任意路径被无差别读取
    const size = fs.statSync(raw).size;
    if (size > 0 && size <= XHS_QRCODE_MAX_BYTES)
      dataUrl = inlineVerifiedImage(fs.readFileSync(raw));
  }
  if (!dataUrl) {
    return { alreadyLoggedIn: false, ...(text ? { hint: text } : {}) };
  }
  const m = text.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  const expiresAt = m ? new Date(`${m[1]}T${m[2]}`).getTime() : NaN;
  return {
    alreadyLoggedIn: false,
    qrcode: dataUrl,
    ...(Number.isFinite(expiresAt) && expiresAt > now
      ? { expiresAt }
      : { expiresAt: now + XHS_QRCODE_FALLBACK_TTL_MS }),
    ...(text ? { hint: text } : {}),
  };
}

/**
 * get_login_qrcode：获取登录二维码（时间盒 18s：需唤起浏览器弹窗渲染二维码，
 * 比普通工具调用慢）。已登录时 MCP 不下发二维码（alreadyLoggedIn=true），
 * 主动切换账号需先 resetXhsCookies 再取码。
 */
export async function getXhsLoginQrcode(options?: XhsMcpOptions): Promise<XhsLoginQrcode> {
  const contents = await xhsMcpCallToolContents(
    "get_login_qrcode",
    {},
    { ...options, toolTimeoutMs: options?.toolTimeoutMs ?? XHS_MCP_DETAIL_TIMEOUT_MS },
  );
  return parseXhsQrcodeContents(contents);
}

/**
 * delete_cookies：重置登录态（主动切换账号的前置步骤）。
 * 成功无返回值；失败抛错由路由层转结构化错误。
 */
export async function resetXhsCookies(options?: XhsMcpOptions): Promise<void> {
  await xhsMcpCallTool("delete_cookies", {}, options);
}

/**
 * 未登录/凭证失效类错误特征识别（纯函数可测）：仅匹配明确的登录态失效信号，
 * 超时/网络/浏览器崩溃等泛化错误不算（避免误报，泛化错误走静默降级即可）。
 * 实测 xiaohongshu-mcp 的错误文案来自 rod 层与 MCP 包装前缀（「MCP 工具报错：搜索Feeds失败: …」）。
 */
export function isXhsLoginExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // 中止/超时类：绝不判定为登录失效
  if (/aborted|timeout|timed out|ECONNRE|fetch failed/i.test(msg)) return false;
  return (
    /未登录|尚未登录|登录已过期|登录失效|登录过期|重新登录|扫码登录|请先登录/i.test(msg) ||
    /cookie.*(过期|失效|无效|invalid|expired)/i.test(msg) ||
    /(not (logged ?in|login)|please (re)?login|log ?in (required|expired|invalid)|session (expired|invalid))/i.test(
      msg,
    )
  );
}
