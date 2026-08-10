/**
 * 小红书 Cookie 导入兜底登录（任务 #97）：
 * 扫码登录被风控拦截（手机端反复 failed to login）时的替代通道——
 * 用户在 PC 浏览器登录 xiaohongshu.com 后复制 Cookie 字符串粘贴导入。
 *
 * 可行性依据（xiaohongshu-mcp 2.4.3 源码）：
 * - browser/browser.go：每次工具调用都 newBrowser()，从 cookies.json 读 cookie
 *   数组经 headless_browser.WithCookies 注入（proto.NetworkCookie / CDP 格式）；
 * - cookies/cookies.go：v2 会话文件 { version, seed, saved_at, cookies }，
 *   cookies 为 RawMessage 原样透传；seed 为指纹种子，需保留。
 * 因此：把浏览器 Cookie 解析成 CDP 格式写入 cookies.json，下一次 MCP 调用即生效，
 * 无需重启 MCP 进程。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** CDP / proto.NetworkCookie 关键字段（与 MCP 扫码成功后落盘的 cookies.json 同构） */
export interface XhsCdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** 过期时间（秒级 Unix 时间戳；小数允许） */
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  priority: string;
  sameParty: boolean;
  sourceScheme: string;
  sourcePort: number;
}

/** MCP v2 会话文件结构（cookies/cookies.go sessionFile 的 TS 镜像） */
export interface XhsSessionFile {
  version: number;
  seed: number;
  saved_at: string;
  cookies: XhsCdpCookie[];
}

/** 导入 Cookie 的默认有效期（天）：浏览器会话本身更长，这里保守续期 */
export const XHS_COOKIE_IMPORT_TTL_DAYS = 30;

/** 登录态关键凭证：缺失时导入无意义，直接拒绝并指引重新复制 */
export const XHS_REQUIRED_COOKIE = "web_session";

/** 仓库根（本文件位于 server/src/lib/，向上三级；dev 与 dist 目录层级一致） */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

/**
 * cookies.json 落盘路径：env XHS_COOKIES_PATH 优先（测试/自定义部署），
 * 缺省为 MCP 私有运行目录 tools/xhs-mcp/runtime/cookies.json；
 * start-xhs-mcp.ps1 同时把 COOKIES_PATH 指向该绝对路径。
 */
export function xhsCookiesFilePath(): string {
  const fromEnv = process.env.XHS_COOKIES_PATH?.trim();
  if (fromEnv) return fromEnv;
  return path.join(repoRoot, "tools", "xhs-mcp", "runtime", "cookies.json");
}

/**
 * 解析浏览器复制的 Cookie 字符串（document.cookie / DevTools 整串均可）：
 * "a1=xxx; web_session=yyy; webId=zzz" → [{name,value}, ...]。
 * 规则：按 ";" 分段，首个 "=" 前为名、后为值（值可含 "="）；
 * 段首尾空白容忍；无名/空段跳过；重名保留最后一个（与浏览器同域覆盖语义一致）。
 * 纯函数可测；空输入返回空数组（校验交给调用方，便于分层报错）。
 */
export function parseBrowserCookieString(raw: string): { name: string; value: string }[] {
  const map = new Map<string, string>();
  for (const segment of String(raw).split(";")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const name = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (!name) continue;
    map.set(name, value);
  }
  return [...map.entries()].map(([name, value]) => ({ name, value }));
}

/**
 * 名值对 → CDP 格式 cookie 数组（纯函数可测）：
 * 域统一 .xiaohongshu.com（MCP 只访问小红书域；CDP 允许带前导点的父域），
 * secure:true（小红书全站 HTTPS，同既有落盘格式）。
 */
export function buildXhsCdpCookies(
  pairs: { name: string; value: string }[],
  nowMs: number = Date.now(),
): XhsCdpCookie[] {
  const expires = nowMs / 1000 + XHS_COOKIE_IMPORT_TTL_DAYS * 24 * 3600;
  return pairs.map(({ name, value }) => ({
    name,
    value,
    domain: ".xiaohongshu.com",
    path: "/",
    expires,
    size: name.length + value.length,
    httpOnly: false,
    secure: true,
    session: false,
    priority: "Medium",
    sameParty: false,
    sourceScheme: "Secure",
    sourcePort: 443,
  }));
}

/**
 * 读既有会话文件的指纹 seed（纯 IO 薄封装）：文件不存在/损坏/旧格式返回 0
 * （与 cookies.go LoadSeed 行为一致；MCP 侧 ResolveFingerprintSeed 会生成并回写新 seed）。
 */
export function readXhsSessionSeed(filePath: string): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as { seed?: unknown };
    return typeof parsed.seed === "number" && Number.isFinite(parsed.seed) ? parsed.seed : 0;
  } catch {
    return 0;
  }
}

/** 组装 v2 会话文件对象（纯函数可测） */
export function buildXhsSessionFile(
  cookies: XhsCdpCookie[],
  seed: number,
  savedAt: string = new Date().toISOString(),
): XhsSessionFile {
  return { version: 2, seed, saved_at: savedAt, cookies };
}

export interface XhsCookieImportResult {
  /** 写入的 cookie 条数 */
  count: number;
  /** 是否含关键凭证 web_session（调用方应在 false 时拒绝导入） */
  hasWebSession: boolean;
  /** 落盘路径（便于排障提示） */
  filePath: string;
}

/**
 * 导入执行：解析 → 校验 → 保留 seed 落盘。
 * 校验失败抛带中文指引的 Error（路由层转结构化 ok:false）。
 */
export function importXhsBrowserCookies(
  rawCookieString: string,
  options?: { cookiesPath?: string; nowMs?: number },
): XhsCookieImportResult {
  const filePath = options?.cookiesPath ?? xhsCookiesFilePath();
  const pairs = parseBrowserCookieString(rawCookieString);
  if (pairs.length === 0) {
    throw new Error(
      "未解析到任何 Cookie：请粘贴从浏览器复制的完整 Cookie 字符串（形如 a1=xxx; web_session=yyy）",
    );
  }
  const hasWebSession = pairs.some((p) => p.name === XHS_REQUIRED_COOKIE && p.value.length > 0);
  if (!hasWebSession) {
    throw new Error(
      "缺少关键登录凭证 web_session：请确认已在 PC 浏览器登录 xiaohongshu.com，再重新复制完整 Cookie",
    );
  }
  const cookies = buildXhsCdpCookies(pairs, options?.nowMs ?? Date.now());
  const sessionFile = buildXhsSessionFile(cookies, readXhsSessionSeed(filePath));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(sessionFile, null, 2), "utf8");
  return { count: cookies.length, hasWebSession, filePath };
}
