import puppeteer, {
  type Browser,
  type BrowserWorker,
  type CookieParam,
  type Page,
} from "@cloudflare/puppeteer";
import { decryptText, encryptText } from "./crypto.ts";

export interface XhsBrowserEnv {
  DB: D1Database;
  BROWSER?: BrowserWorker;
  APP_DATA_ENCRYPTION_KEY?: string;
  XHS_BROWSER_QR_DAILY_LIMIT?: string;
  XHS_BROWSER_SEARCH_DAILY_LIMIT?: string;
}

interface XhsSessionRow {
  encrypted_cookies: string;
  nickname: string;
  qr_session_id: string;
  qr_expires_at: number;
}

export interface XhsResearchResult {
  ok: boolean;
  sources: Array<{ title: string; url: string; snippet?: string }>;
  summaryText: string;
  message: string;
  filtered: number;
  distilled: boolean;
  xhsLoginExpired?: boolean;
}

const XHS_ORIGIN = "https://www.xiaohongshu.com";
const XHS_EXPLORE_URL = `${XHS_ORIGIN}/explore`;
const LOGIN_SELECTOR = ".main-container .user .link-wrapper .channel";
const QR_SELECTOR = ".login-container .qrcode-img";
const QR_LIFETIME_MS = 3 * 60_000;
const BROWSER_KEEP_ALIVE_MS = 4 * 60_000;
const NAVIGATION_TIMEOUT_MS = 35_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

type BrowserBudgetKind = "qr" | "search";

function positiveLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : fallback;
}

/** Browser Run 按使用时长计费；默认预算避免被单个访客迅速耗尽。 */
export async function claimBrowserBudget(
  env: XhsBrowserEnv,
  owner: string,
  kind: BrowserBudgetKind,
): Promise<boolean> {
  const globalLimit = positiveLimit(
    kind === "qr" ? env.XHS_BROWSER_QR_DAILY_LIMIT : env.XHS_BROWSER_SEARCH_DAILY_LIMIT,
    kind === "qr" ? 6 : 20,
  );
  const ownerLimit = Math.min(globalLimit, kind === "qr" ? 3 : 10);
  const bucket = `xhs-${kind}:${new Date().toISOString().slice(0, 10)}`;
  const ownerSubject = `xhs-${kind}:owner:${owner}`;
  const globalSubject = `xhs-${kind}:global`;
  const ownerRow = await env.DB.prepare(
    `INSERT INTO generation_usage(owner,hour_bucket,request_count) VALUES(?,?,1)
     ON CONFLICT(owner,hour_bucket) DO UPDATE SET request_count=request_count+1
     RETURNING request_count`,
  )
    .bind(ownerSubject, bucket)
    .first<{ request_count: number }>();
  // 先挡住 owner，再占用全站名额；超限访客反复点击不会拖累其他用户。
  if ((ownerRow?.request_count ?? ownerLimit + 1) > ownerLimit) return false;

  const globalRow = await env.DB.prepare(
    `INSERT INTO generation_usage(owner,hour_bucket,request_count) VALUES(?,?,1)
     ON CONFLICT(owner,hour_bucket) DO UPDATE SET request_count=request_count+1
     RETURNING request_count`,
  )
    .bind(globalSubject, bucket)
    .first<{ request_count: number }>();
  return (globalRow?.request_count ?? globalLimit + 1) <= globalLimit;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function configured(env: XhsBrowserEnv): env is XhsBrowserEnv & {
  BROWSER: BrowserWorker;
  APP_DATA_ENCRYPTION_KEY: string;
} {
  return Boolean(env.BROWSER && env.APP_DATA_ENCRYPTION_KEY?.trim());
}

async function sessionRow(env: XhsBrowserEnv, owner: string): Promise<XhsSessionRow | null> {
  return env.DB.prepare(
    `SELECT encrypted_cookies,nickname,qr_session_id,qr_expires_at
       FROM xhs_browser_sessions WHERE owner=?`,
  )
    .bind(owner)
    .first<XhsSessionRow>();
}

async function saveQrSession(
  env: XhsBrowserEnv,
  owner: string,
  sessionId: string,
  expiresAt: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO xhs_browser_sessions(owner,qr_session_id,qr_expires_at,updated_at)
     VALUES(?,?,?,?)
     ON CONFLICT(owner) DO UPDATE SET
       qr_session_id=excluded.qr_session_id,
       qr_expires_at=excluded.qr_expires_at,
       updated_at=excluded.updated_at`,
  )
    .bind(owner, sessionId, expiresAt, new Date().toISOString())
    .run();
}

async function saveLoggedInSession(
  env: XhsBrowserEnv & { APP_DATA_ENCRYPTION_KEY: string },
  owner: string,
  cookies: CookieParam[],
  nickname: string,
): Promise<void> {
  const encrypted = await encryptText(JSON.stringify(cookies), env.APP_DATA_ENCRYPTION_KEY);
  await env.DB.prepare(
    `INSERT INTO xhs_browser_sessions(owner,encrypted_cookies,nickname,qr_session_id,qr_expires_at,updated_at)
     VALUES(?,?,?,'',0,?)
     ON CONFLICT(owner) DO UPDATE SET
       encrypted_cookies=excluded.encrypted_cookies,
       nickname=excluded.nickname,
       qr_session_id='',
       qr_expires_at=0,
       updated_at=excluded.updated_at`,
  )
    .bind(owner, encrypted, nickname.slice(0, 100), new Date().toISOString())
    .run();
}

async function clearQrState(env: XhsBrowserEnv, owner: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE xhs_browser_sessions SET qr_session_id='',qr_expires_at=0,updated_at=? WHERE owner=?",
  )
    .bind(new Date().toISOString(), owner)
    .run();
}

async function preparePage(page: Page): Promise<void> {
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.setUserAgent(USER_AGENT);
}

async function launchBrowser(env: XhsBrowserEnv & { BROWSER: BrowserWorker }): Promise<Browser> {
  const waitForAcquisition = async (fallbackMs: number): Promise<void> => {
    let waitMs = fallbackMs;
    try {
      const limits = await puppeteer.limits(env.BROWSER);
      if (limits.allowedBrowserAcquisitions > 0) return;
      waitMs = Math.max(waitMs, limits.timeUntilNextAllowedBrowserAcquisition + 250);
    } catch {
      // limits 端点自身异常时仍保留一次普通 launch，避免探测失败阻断功能。
    }
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 20_000)));
    }
  };

  await waitForAcquisition(0);
  try {
    return await puppeteer.launch(env.BROWSER, { keep_alive: BROWSER_KEEP_ALIVE_MS });
  } catch (error) {
    // 官方 limits 返回下一次允许 acquisition 的等待时间；按该窗口补一次。
    await waitForAcquisition(2_000);
    try {
      return await puppeteer.launch(env.BROWSER, { keep_alive: BROWSER_KEEP_ALIVE_MS });
    } catch {
      throw error;
    }
  }
}

async function closeBrowserSession(
  env: XhsBrowserEnv & { BROWSER: BrowserWorker },
  sessionId: string,
): Promise<void> {
  if (!sessionId) return;
  try {
    const browser = await puppeteer.connect(env.BROWSER, sessionId, {
      keep_alive: BROWSER_KEEP_ALIVE_MS,
    });
    await browser.close();
  } catch {
    // 已自然失效的二维码浏览器无需再次清理。
  }
}

async function decryptCookies(
  env: XhsBrowserEnv & { APP_DATA_ENCRYPTION_KEY: string },
  encrypted: string,
): Promise<CookieParam[]> {
  if (!encrypted) return [];
  const parsed = JSON.parse(await decryptText(encrypted, env.APP_DATA_ENCRYPTION_KEY));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (cookie): cookie is CookieParam =>
      Boolean(cookie) &&
      typeof cookie === "object" &&
      typeof (cookie as CookieParam).name === "string" &&
      typeof (cookie as CookieParam).value === "string",
  );
}

export function parseCookieHeader(value: string): CookieParam[] {
  const cookies: CookieParam[] = [];
  const names = new Set<string>();
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || !cookieValue || names.has(name)) continue;
    names.add(name);
    cookies.push({
      name,
      value: cookieValue,
      domain: ".xiaohongshu.com",
      path: "/",
      secure: true,
    });
  }
  return cookies.slice(0, 120);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseXhsSearchFeeds(value: unknown): XhsResearchResult["sources"] {
  if (!Array.isArray(value)) return [];
  const sources: XhsResearchResult["sources"] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const feed = entry as Record<string, unknown>;
    const noteCard =
      feed.noteCard && typeof feed.noteCard === "object" && !Array.isArray(feed.noteCard)
        ? (feed.noteCard as Record<string, unknown>)
        : {};
    const id = stringField(feed.id ?? feed.noteId ?? feed.note_id);
    const title = stringField(noteCard.displayTitle ?? noteCard.title ?? feed.title).slice(0, 240);
    const token = stringField(feed.xsecToken ?? feed.xsec_token);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const params = new URLSearchParams({ xsec_source: "pc_search" });
    if (token) params.set("xsec_token", token);
    const desc = stringField(noteCard.desc ?? noteCard.description ?? feed.desc).slice(0, 500);
    sources.push({
      title,
      url: `${XHS_ORIGIN}/explore/${encodeURIComponent(id)}?${params.toString()}`,
      ...(desc ? { snippet: desc } : {}),
    });
    if (sources.length >= 8) break;
  }
  return sources;
}

async function currentNickname(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = globalThis as unknown as {
      __INITIAL_STATE__?: { user?: { userInfo?: unknown } };
    };
    const raw = root.__INITIAL_STATE__?.user?.userInfo as
      { value?: unknown; _value?: unknown } | undefined;
    const info = (raw?.value ?? raw?._value ?? raw) as
      { nickname?: unknown; guest?: unknown } | undefined;
    return info && info.guest !== true && typeof info.nickname === "string" ? info.nickname : "";
  });
}

async function loggedIn(page: Page): Promise<boolean> {
  return Boolean(await page.$(LOGIN_SELECTOR));
}

async function requestObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 64_000) throw new Error("请求内容过长");
  const parsed = JSON.parse(text || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("请求格式有误");
  return parsed as Record<string, unknown>;
}

function publicFailure(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  if (/timeout|timed out/i.test(message)) return "云端登录浏览器响应超时，请稍后重试";
  if (/session|connect/i.test(message)) return "登录二维码已失效，请重新取码";
  return "小红书云端浏览器本次执行异常，请稍后重试";
}

async function status(env: XhsBrowserEnv, owner: string): Promise<Response> {
  if (!configured(env)) {
    return json({
      ok: true,
      online: false,
      loggedIn: false,
      message: "站点尚未启用云端小红书浏览器",
    });
  }
  const row = await sessionRow(env, owner);
  return json({
    ok: true,
    online: true,
    loggedIn: Boolean(row?.encrypted_cookies),
    ...(row?.nickname ? { nickname: row.nickname } : {}),
    message: row?.encrypted_cookies ? "云端登录态已保存" : "可直接扫码登录",
  });
}

async function qrcode(env: XhsBrowserEnv, owner: string): Promise<Response> {
  if (!configured(env)) return status(env, owner);
  const current = await sessionRow(env, owner);
  if (current?.encrypted_cookies) {
    return json({ ok: true, online: true, alreadyLoggedIn: true });
  }
  if (!(await claimBrowserBudget(env, owner, "qr"))) {
    return json(
      {
        ok: false,
        online: true,
        failureKind: "service_error",
        message: "今日云端扫码预算已用完，请明日再取码或由部署者提高 Browser Run 预算",
      },
      429,
    );
  }
  await closeBrowserSession(env, current?.qr_session_id ?? "");
  let browser: Browser | null = null;
  let keepSession = false;
  try {
    browser = await launchBrowser(env);
    const page = await browser.newPage();
    await preparePage(page);
    await page.goto(XHS_EXPLORE_URL, { waitUntil: "domcontentloaded" });
    if (await loggedIn(page)) {
      await saveLoggedInSession(
        env,
        owner,
        await page.cookies(XHS_ORIGIN),
        await currentNickname(page),
      );
      return json({ ok: true, online: true, alreadyLoggedIn: true });
    }
    const element = await page.waitForSelector(QR_SELECTOR, { timeout: 20_000 });
    if (!element) throw new Error("qrcode selector missing");
    const encoded = await element.screenshot({ encoding: "base64" });
    const expiresAt = Date.now() + QR_LIFETIME_MS;
    await saveQrSession(env, owner, browser.sessionId(), expiresAt);
    keepSession = true;
    return json({
      ok: true,
      online: true,
      qrcode: `data:image/png;base64,${encoded}`,
      expiresAt,
      hint: "二维码和登录态只属于当前浏览器或账号",
    });
  } catch (error) {
    return json(
      { ok: false, online: true, failureKind: "service_error", message: publicFailure(error) },
      502,
    );
  } finally {
    if (browser) {
      if (keepSession) await browser.disconnect();
      else await browser.close().catch(() => {});
    }
  }
}

async function poll(env: XhsBrowserEnv, owner: string): Promise<Response> {
  if (!configured(env)) return status(env, owner);
  const row = await sessionRow(env, owner);
  if (row?.encrypted_cookies) {
    return json({ ok: true, online: true, loggedIn: true, nickname: row.nickname || undefined });
  }
  if (!row?.qr_session_id || row.qr_expires_at <= Date.now()) {
    await clearQrState(env, owner);
    return json({ ok: true, online: true, loggedIn: false, message: "二维码已失效" });
  }
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.connect(env.BROWSER, row.qr_session_id, {
      keep_alive: BROWSER_KEEP_ALIVE_MS,
    });
    const pages = await browser.pages();
    const page = pages.at(-1);
    if (!page) throw new Error("browser session page missing");
    if (!(await loggedIn(page))) {
      await browser.disconnect();
      browser = null;
      return json({ ok: true, online: true, loggedIn: false });
    }
    const nickname = await currentNickname(page);
    await saveLoggedInSession(env, owner, await page.cookies(XHS_ORIGIN), nickname);
    await browser.close();
    browser = null;
    return json({ ok: true, online: true, loggedIn: true, nickname: nickname || undefined });
  } catch (error) {
    await clearQrState(env, owner);
    return json({ ok: true, online: true, loggedIn: false, message: publicFailure(error) });
  } finally {
    if (browser) await browser.disconnect().catch(() => {});
  }
}

async function cookieImport(
  env: XhsBrowserEnv,
  owner: string,
  request: Request,
): Promise<Response> {
  if (!configured(env)) return status(env, owner);
  const body = await requestObject(request);
  const cookies = parseCookieHeader(typeof body.cookie === "string" ? body.cookie : "");
  if (cookies.length === 0) return json({ ok: false, message: "Cookie 内容格式有误" }, 400);
  if (!(await claimBrowserBudget(env, owner, "qr"))) {
    return json({ ok: false, message: "今日云端登录校验预算已用完，请明日再试" }, 429);
  }
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(env);
    const page = await browser.newPage();
    await preparePage(page);
    await page.setCookie(...cookies);
    await page.goto(XHS_EXPLORE_URL, { waitUntil: "domcontentloaded" });
    if (!(await loggedIn(page))) return json({ ok: false, message: "Cookie 未通过登录校验" }, 401);
    const nickname = await currentNickname(page);
    const verified = await page.cookies(XHS_ORIGIN);
    await saveLoggedInSession(env, owner, verified, nickname);
    return json({ ok: true, online: true, loggedIn: true, nickname: nickname || undefined });
  } catch (error) {
    return json({ ok: false, message: publicFailure(error) }, 502);
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function logout(env: XhsBrowserEnv, owner: string): Promise<Response> {
  const row = await sessionRow(env, owner);
  if (configured(env)) await closeBrowserSession(env, row?.qr_session_id ?? "");
  await env.DB.prepare("DELETE FROM xhs_browser_sessions WHERE owner=?").bind(owner).run();
  return json({ ok: true, message: "已清除当前用户的小红书登录态" });
}

export async function handleXhsBrowserRoute(
  request: Request,
  env: XhsBrowserEnv,
  owner: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/xhs/")) return null;
  if (request.method === "GET" && path === "/api/xhs/status") return status(env, owner);
  if (request.method === "POST" && path === "/api/xhs/login/qrcode") return qrcode(env, owner);
  if (request.method === "GET" && path === "/api/xhs/login/poll") return poll(env, owner);
  if (request.method === "POST" && path === "/api/xhs/login/cookie-import")
    return cookieImport(env, owner, request);
  if (request.method === "POST" && path === "/api/xhs/logout") return logout(env, owner);
  return json({ ok: false, message: "小红书接口路径不存在" }, 404);
}

export async function researchXhsWithBrowser(
  env: XhsBrowserEnv,
  owner: string,
  keyword: string,
): Promise<XhsResearchResult> {
  const empty = (message: string, expired = false): XhsResearchResult => ({
    ok: false,
    sources: [],
    summaryText: "",
    message,
    filtered: 0,
    distilled: false,
    ...(expired ? { xhsLoginExpired: true } : {}),
  });
  if (!configured(env)) return empty("云端小红书调研服务尚未启用");
  const row = await sessionRow(env, owner);
  if (!row?.encrypted_cookies) return empty("小红书尚未登录，本次继续使用豆档案与模型知识生成");
  const cookies = await decryptCookies(env, row.encrypted_cookies);
  if (cookies.length === 0) return empty("小红书登录态需要更新", true);
  if (!(await claimBrowserBudget(env, owner, "search"))) {
    return empty("今日云端小红书检索预算已用完，本次继续使用豆档案与模型知识生成");
  }
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(env);
    const page = await browser.newPage();
    await preparePage(page);
    await page.setCookie(...cookies);
    const url = new URL(`${XHS_ORIGIN}/search_result`);
    url.searchParams.set("keyword", keyword.trim().slice(0, 80));
    url.searchParams.set("source", "web_explore_feed");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await page.waitForFunction("globalThis.__INITIAL_STATE__ !== undefined", { timeout: 25_000 });
    const feedValue = await page.evaluate(() => {
      const root = globalThis as unknown as {
        __INITIAL_STATE__?: { search?: { feeds?: unknown } };
      };
      const raw = root.__INITIAL_STATE__?.search?.feeds as
        { value?: unknown; _value?: unknown } | undefined;
      return raw?.value ?? raw?._value ?? raw ?? [];
    });
    const sources = parseXhsSearchFeeds(feedValue);
    const stillLoggedIn = await loggedIn(page);
    if (!stillLoggedIn && sources.length === 0) {
      await env.DB.prepare(
        "UPDATE xhs_browser_sessions SET encrypted_cookies='',nickname='',updated_at=? WHERE owner=?",
      )
        .bind(new Date().toISOString(), owner)
        .run();
      return empty("小红书登录已过期，本次继续完成生成", true);
    }
    if (sources.length === 0) return empty("小红书已登录，本次关键词未检索到相关笔记");
    const summaryText = [
      `小红书检索词：${keyword.trim().slice(0, 80)}`,
      ...sources.map(
        (source, index) =>
          `${index + 1}. ${source.title}${source.snippet ? `：${source.snippet}` : ""}`,
      ),
    ].join("\n");
    return {
      ok: true,
      sources,
      summaryText,
      message: `已从当前用户的小红书账号检索到 ${sources.length} 条相关笔记`,
      filtered: 0,
      distilled: false,
    };
  } catch (error) {
    return empty(publicFailure(error));
  } finally {
    await browser?.close().catch(() => {});
  }
}
