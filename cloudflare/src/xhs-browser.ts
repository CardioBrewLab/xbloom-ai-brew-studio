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
  XHS_BROWSER_PROFILE?: string;
  XHS_BROWSER_QR_DAILY_LIMIT?: string;
  XHS_BROWSER_SEARCH_DAILY_LIMIT?: string;
  XHS_BROWSER_QR_OWNER_DAILY_LIMIT?: string;
  XHS_BROWSER_SEARCH_OWNER_DAILY_LIMIT?: string;
  XHS_RESEARCH_CACHE_TTL_SECONDS?: string;
}

interface XhsSessionRow {
  encrypted_cookies: string;
  nickname: string;
  qr_session_id: string;
  qr_expires_at: number;
  encrypted_qr_payload: string;
  qr_lease_token: string;
  qr_lease_until: number;
}

export interface XhsResearchResult {
  ok: boolean;
  sources: Array<{ title: string; url: string; snippet?: string }>;
  summaryText: string;
  message: string;
  filtered: number;
  distilled: boolean;
  xhsLoginExpired?: boolean;
  cacheHit?: boolean;
}

const XHS_ORIGIN = "https://www.xiaohongshu.com";
const XHS_EXPLORE_URL = `${XHS_ORIGIN}/explore`;
const LOGIN_SELECTOR = ".main-container .user .link-wrapper .channel";
const QR_SELECTOR = ".login-container .qrcode-img";
const QR_CREATE_API = "/api/sns/web/v1/login/qrcode/create";
const XHS_LOGIN_DEEP_LINK_HOST = "rn";
const XHS_LOGIN_DEEP_LINK_PATH = "/app-settings/login/scan";
const QR_LIFETIME_MS = 210_000;
const BROWSER_KEEP_ALIVE_MS = 4 * 60_000;
const NAVIGATION_TIMEOUT_MS = 35_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

type BrowserBudgetKind = "qr" | "search";
type BrowserProfile = "free" | "scale";

export interface BrowserBudgetPolicy {
  profile: BrowserProfile;
  globalLimit: number;
  ownerLimit: number;
}

export interface BrowserBudgetClaim {
  bucket: string;
  ownerKey: string;
  ownerPath: string;
}

function positiveLimit(value: string | undefined, fallback: number, cap = 1_000_000): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, cap) : fallback;
}

export function browserBudgetPolicy(
  env: Pick<
    XhsBrowserEnv,
    | "XHS_BROWSER_PROFILE"
    | "XHS_BROWSER_QR_DAILY_LIMIT"
    | "XHS_BROWSER_SEARCH_DAILY_LIMIT"
    | "XHS_BROWSER_QR_OWNER_DAILY_LIMIT"
    | "XHS_BROWSER_SEARCH_OWNER_DAILY_LIMIT"
  >,
  kind: BrowserBudgetKind,
): BrowserBudgetPolicy {
  const profile: BrowserProfile = env.XHS_BROWSER_PROFILE === "scale" ? "scale" : "free";
  const scale = profile === "scale";
  const globalDefault = kind === "qr" ? (scale ? 2_500 : 3) : scale ? 20_000 : 20;
  const ownerDefault = kind === "qr" ? (scale ? 8 : 3) : scale ? 100 : 10;
  const globalLimit = positiveLimit(
    kind === "qr" ? env.XHS_BROWSER_QR_DAILY_LIMIT : env.XHS_BROWSER_SEARCH_DAILY_LIMIT,
    globalDefault,
  );
  const ownerLimit = Math.min(
    globalLimit,
    positiveLimit(
      kind === "qr"
        ? env.XHS_BROWSER_QR_OWNER_DAILY_LIMIT
        : env.XHS_BROWSER_SEARCH_OWNER_DAILY_LIMIT,
      ownerDefault,
    ),
  );
  return { profile, globalLimit, ownerLimit };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 全站与 owner 配额在同一 D1 行、同一 SQL 中判定和递增，避免并发下只写入一半。 */
export async function claimBrowserBudget(
  env: XhsBrowserEnv,
  owner: string,
  kind: BrowserBudgetKind,
): Promise<BrowserBudgetClaim | null> {
  const { globalLimit, ownerLimit } = browserBudgetPolicy(env, kind);
  const bucket = `xhs-${kind}:${new Date().toISOString().slice(0, 10)}`;
  const ownerKey = await sha256Hex(owner);
  const ownerPath = `$."${ownerKey}"`;
  const row = await env.DB.prepare(
    `INSERT INTO xhs_browser_budget(bucket,global_count,owner_counts_json,updated_at)
     VALUES(?,1,json_object(?,1),?)
     ON CONFLICT(bucket) DO UPDATE SET
       global_count=xhs_browser_budget.global_count+1,
       owner_counts_json=json_set(
         xhs_browser_budget.owner_counts_json,
         ?,
         COALESCE(json_extract(xhs_browser_budget.owner_counts_json,?),0)+1
       ),
       updated_at=excluded.updated_at
     WHERE xhs_browser_budget.global_count < ?
       AND COALESCE(json_extract(xhs_browser_budget.owner_counts_json,?),0) < ?
     RETURNING global_count`,
  )
    .bind(
      bucket,
      ownerKey,
      new Date().toISOString(),
      ownerPath,
      ownerPath,
      globalLimit,
      ownerPath,
      ownerLimit,
    )
    .first<{ global_count: number }>();
  return row ? { bucket, ownerKey, ownerPath } : null;
}

export async function releaseBrowserBudget(
  env: XhsBrowserEnv,
  claim: BrowserBudgetClaim,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE xhs_browser_budget SET
       global_count=MAX(global_count-1,0),
       owner_counts_json=json_set(
         owner_counts_json,
         ?,
         MAX(COALESCE(json_extract(owner_counts_json,?),0)-1,0)
       ),
       updated_at=?
     WHERE bucket=?`,
  )
    .bind(claim.ownerPath, claim.ownerPath, new Date().toISOString(), claim.bucket)
    .run();
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
    `SELECT encrypted_cookies,nickname,qr_session_id,qr_expires_at,encrypted_qr_payload,
            qr_lease_token,qr_lease_until
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
  qrPayload: { qrcode: string; launchUrl?: string },
): Promise<void> {
  if (!env.APP_DATA_ENCRYPTION_KEY) throw new Error("站点尚未配置二维码加密密钥");
  const encryptedPayload = await encryptText(
    JSON.stringify(qrPayload),
    env.APP_DATA_ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `INSERT INTO xhs_browser_sessions(owner,qr_session_id,qr_expires_at,updated_at,encrypted_qr_payload)
     VALUES(?,?,?,?,?)
     ON CONFLICT(owner) DO UPDATE SET
       qr_session_id=excluded.qr_session_id,
       qr_expires_at=excluded.qr_expires_at,
       updated_at=excluded.updated_at,
       encrypted_qr_payload=excluded.encrypted_qr_payload`,
  )
    .bind(owner, sessionId, expiresAt, new Date().toISOString(), encryptedPayload)
    .run();
}

async function savedQrPayload(
  env: XhsBrowserEnv & { APP_DATA_ENCRYPTION_KEY: string },
  row: XhsSessionRow,
): Promise<{ qrcode: string; launchUrl?: string } | null> {
  if (!row.encrypted_qr_payload) return null;
  try {
    const parsed = JSON.parse(
      await decryptText(row.encrypted_qr_payload, env.APP_DATA_ENCRYPTION_KEY),
    ) as Record<string, unknown>;
    const qrcode = typeof parsed.qrcode === "string" ? parsed.qrcode : "";
    const launchUrl = normalizeXhsLoginLaunchUrl(parsed.launchUrl);
    if (!qrcode.startsWith("data:image/png;base64,") || qrcode.length > 1_500_000) return null;
    return { qrcode, ...(launchUrl ? { launchUrl } : {}) };
  } catch {
    return null;
  }
}

async function saveLoggedInSession(
  env: XhsBrowserEnv & { APP_DATA_ENCRYPTION_KEY: string },
  owner: string,
  cookies: CookieParam[],
  nickname: string,
): Promise<void> {
  const encrypted = await encryptText(JSON.stringify(cookies), env.APP_DATA_ENCRYPTION_KEY);
  await env.DB.prepare(
    `INSERT INTO xhs_browser_sessions(owner,encrypted_cookies,nickname,qr_session_id,qr_expires_at,updated_at,encrypted_qr_payload)
     VALUES(?,?,?,'',0,?,'')
     ON CONFLICT(owner) DO UPDATE SET
       encrypted_cookies=excluded.encrypted_cookies,
       nickname=excluded.nickname,
       qr_session_id='',
       qr_expires_at=0,
       encrypted_qr_payload='',
       updated_at=excluded.updated_at`,
  )
    .bind(owner, encrypted, nickname.slice(0, 100), new Date().toISOString())
    .run();
}

async function clearQrState(env: XhsBrowserEnv, owner: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE xhs_browser_sessions SET qr_session_id='',qr_expires_at=0,encrypted_qr_payload='',updated_at=? WHERE owner=?",
  )
    .bind(new Date().toISOString(), owner)
    .run();
}

const QR_LEASE_MS = 90_000;

async function acquireQrLease(env: XhsBrowserEnv, owner: string): Promise<string | null> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO xhs_browser_sessions(owner,updated_at,qr_lease_token,qr_lease_until)
     VALUES(?,?,?,?)
     ON CONFLICT(owner) DO UPDATE SET
       qr_lease_token=excluded.qr_lease_token,
       qr_lease_until=excluded.qr_lease_until,
       updated_at=excluded.updated_at
     WHERE xhs_browser_sessions.qr_lease_token=''
        OR xhs_browser_sessions.qr_lease_until<=?
     RETURNING qr_lease_token`,
  )
    .bind(owner, new Date().toISOString(), token, now + QR_LEASE_MS, now)
    .first<{ qr_lease_token: string }>();
  return row?.qr_lease_token === token ? token : null;
}

async function releaseQrLease(env: XhsBrowserEnv, owner: string, token: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE xhs_browser_sessions
        SET qr_lease_token='',qr_lease_until=0,updated_at=?
      WHERE owner=? AND qr_lease_token=?`,
  )
    .bind(new Date().toISOString(), owner, token)
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

async function browserSessionAvailable(
  env: XhsBrowserEnv & { BROWSER: BrowserWorker },
  sessionId: string,
): Promise<boolean> {
  if (!sessionId) return false;
  try {
    // sessions() 只读探测，不抢占当前连接；轮询请求与“重新取码”同时发生时也不会误删有效码。
    return (await puppeteer.sessions(env.BROWSER)).some(
      (session) => session.sessionId === sessionId,
    );
  } catch {
    return false;
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

/**
 * 小红书网页登录完成后至少会落下这三个会话 Cookie。只看头像 DOM 会受页面改版、
 * hydration 时序与 AB 实验影响，因此把 Cookie 作为独立的登录完成信号。
 */
export function hasXhsAuthenticatedCookies(
  cookies: ReadonlyArray<{ name: string; value: string }>,
): boolean {
  const names = new Set(
    cookies.filter((cookie) => cookie.value.trim()).map((cookie) => cookie.name.toLowerCase()),
  );
  return names.has("a1") && names.has("webid") && names.has("web_session");
}

/** 仅放行小红书登录接口自身返回的扫码 deeplink，避免把任意协议交给浏览器跳转。 */
export function normalizeXhsLoginLaunchUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096) return "";
  const candidate = value.trim();
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "xhsdiscover:" ||
      parsed.hostname !== XHS_LOGIN_DEEP_LINK_HOST ||
      parsed.pathname !== XHS_LOGIN_DEEP_LINK_PATH ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash
    ) {
      return "";
    }
    if (
      !parsed.searchParams.get("qrId") ||
      !parsed.searchParams.get("code") ||
      !parsed.searchParams.get("timestamp")
    ) {
      return "";
    }
    return candidate;
  } catch {
    return "";
  }
}

/** 兼容小红书接口常见的 data.url / response.data.url 包装。 */
export function extractXhsLoginLaunchUrl(payload: unknown, depth = 0): string {
  if (depth > 4 || !payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const record = payload as Record<string, unknown>;
  const direct = normalizeXhsLoginLaunchUrl(record.url);
  if (direct) return direct;
  for (const key of ["data", "response", "body", "result"] as const) {
    const nested = extractXhsLoginLaunchUrl(record[key], depth + 1);
    if (nested) return nested;
  }
  return "";
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

export function normalizeXhsResearchKeyword(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 80);
}

export async function xhsResearchCacheKey(
  env: XhsBrowserEnv,
  owner: string,
  keyword: string,
): Promise<string> {
  // owner 与应用密钥参与摘要：相同关键词仅在同一账号内复用，D1 中也不暴露原词。
  return sha256Hex(
    `${env.APP_DATA_ENCRYPTION_KEY ?? "unconfigured"}\0${owner}\0${normalizeXhsResearchKeyword(keyword)}`,
  );
}

function cachedSources(value: unknown): XhsResearchResult["sources"] {
  if (!Array.isArray(value)) return [];
  const sources: XhsResearchResult["sources"] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const title = stringField(source.title).slice(0, 240);
    const url = stringField(source.url);
    const snippet = stringField(source.snippet).slice(0, 500);
    if (!title || !url || seen.has(url)) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.hostname !== "www.xiaohongshu.com") continue;
    } catch {
      continue;
    }
    seen.add(url);
    sources.push({ title, url, ...(snippet ? { snippet } : {}) });
    if (sources.length >= 8) break;
  }
  return sources;
}

async function loadResearchCache(
  env: XhsBrowserEnv,
  owner: string,
  keyword: string,
): Promise<XhsResearchResult["sources"]> {
  const row = await env.DB.prepare(
    "SELECT sources_json,expires_at FROM xhs_research_cache WHERE cache_key=?",
  )
    .bind(await xhsResearchCacheKey(env, owner, keyword))
    .first<{ sources_json: string; expires_at: number }>();
  if (!row || row.expires_at <= Date.now()) return [];
  try {
    return cachedSources(JSON.parse(row.sources_json));
  } catch {
    return [];
  }
}

const RESEARCH_LEASE_MS = 90_000;

async function acquireResearchLease(env: XhsBrowserEnv, cacheKey: string): Promise<string | null> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO xhs_research_cache(
       cache_key,sources_json,expires_at,updated_at,lease_token,lease_until
     ) VALUES(?,'[]',0,?,?,?)
     ON CONFLICT(cache_key) DO UPDATE SET
       lease_token=excluded.lease_token,
       lease_until=excluded.lease_until,
       updated_at=excluded.updated_at
     WHERE xhs_research_cache.expires_at<=?
       AND xhs_research_cache.lease_until<=?
     RETURNING lease_token`,
  )
    .bind(cacheKey, new Date().toISOString(), token, now + RESEARCH_LEASE_MS, now, now)
    .first<{ lease_token: string }>();
  return row?.lease_token === token ? token : null;
}

async function releaseResearchLease(
  env: XhsBrowserEnv,
  cacheKey: string,
  token: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE xhs_research_cache
        SET lease_token='',lease_until=0,updated_at=?
      WHERE cache_key=? AND lease_token=?`,
  )
    .bind(new Date().toISOString(), cacheKey, token)
    .run();
}

async function waitForResearchCache(
  env: XhsBrowserEnv,
  owner: string,
  keyword: string,
): Promise<XhsResearchResult["sources"]> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const cached = await loadResearchCache(env, owner, keyword);
    if (cached.length > 0) return cached;
  }
  return [];
}

async function saveResearchCache(
  env: XhsBrowserEnv,
  cacheKey: string,
  leaseToken: string,
  sources: XhsResearchResult["sources"],
): Promise<void> {
  const ttlSeconds = positiveLimit(env.XHS_RESEARCH_CACHE_TTL_SECONDS, 86_400, 604_800);
  const update = env.DB.prepare(
    `UPDATE xhs_research_cache SET
       sources_json=?,expires_at=?,updated_at=?,lease_token='',lease_until=0
     WHERE cache_key=? AND lease_token=?`,
  ).bind(
    JSON.stringify(sources),
    Date.now() + ttlSeconds * 1_000,
    new Date().toISOString(),
    cacheKey,
    leaseToken,
  );
  await env.DB.batch([
    env.DB.prepare("DELETE FROM xhs_research_cache WHERE expires_at<=? AND lease_until<=?").bind(
      Date.now(),
      Date.now(),
    ),
    update,
  ]);
}

function researchSummary(keyword: string, sources: XhsResearchResult["sources"]): string {
  return [
    `小红书检索词：${keyword}`,
    ...sources.map(
      (source, index) =>
        `${index + 1}. ${source.title}${source.snippet ? `：${source.snippet}` : ""}`,
    ),
  ].join("\n");
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

async function authenticatedInitialState(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = globalThis as unknown as {
      __INITIAL_STATE__?: { user?: { userInfo?: unknown } };
    };
    const raw = root.__INITIAL_STATE__?.user?.userInfo as
      { value?: unknown; _value?: unknown } | undefined;
    const info = (raw?.value ?? raw?._value ?? raw) as
      { guest?: unknown; userId?: unknown; user_id?: unknown; nickname?: unknown } | undefined;
    const present = (value: unknown) => typeof value === "string" && value.trim().length > 0;
    return Boolean(
      info &&
      info.guest !== true &&
      (present(info.userId) || present(info.user_id) || present(info.nickname)),
    );
  });
}

async function authenticatedCookies(page: Page): Promise<CookieParam[] | null> {
  const cookies = await page.cookies(XHS_ORIGIN);
  const selectorReady = Boolean(await page.$(LOGIN_SELECTOR));
  const stateReady = await authenticatedInitialState(page).catch(() => false);
  return selectorReady || stateReady || hasXhsAuthenticatedCookies(cookies) ? cookies : null;
}

async function waitForAuthenticatedCookies(page: Page): Promise<CookieParam[] | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cookies = await authenticatedCookies(page);
    if (cookies && hasXhsAuthenticatedCookies(cookies)) return cookies;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

async function requestObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 64_000) throw new Error("请求内容过长");
  const parsed = JSON.parse(text || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("请求格式有误");
  return parsed as Record<string, unknown>;
}

export function xhsBrowserFailureMessage(
  message: string,
  env: Pick<
    XhsBrowserEnv,
    | "XHS_BROWSER_PROFILE"
    | "XHS_BROWSER_QR_DAILY_LIMIT"
    | "XHS_BROWSER_SEARCH_DAILY_LIMIT"
    | "XHS_BROWSER_QR_OWNER_DAILY_LIMIT"
    | "XHS_BROWSER_SEARCH_OWNER_DAILY_LIMIT"
  >,
): string {
  if (
    /browser time limit exceeded|time limit exceeded for today|daily browser limit/i.test(message)
  ) {
    return "当前 Cloudflare Browser Run 套餐的当日平台容量已用完；站点其他功能照常，本次先跳过小红书";
  }
  if (/429|rate limit/i.test(message)) {
    return browserBudgetPolicy(env, "qr").profile === "scale"
      ? "云端浏览器当前请求较多，请稍后重试"
      : "云端浏览器已达到当前免费档容量；短期限频请稍后重试，日容量于次日恢复";
  }
  if (/timeout|timed out/i.test(message)) return "云端登录浏览器响应超时，请稍后重试";
  if (/session|connect/i.test(message)) return "登录二维码已失效，请重新取码";
  return "小红书云端浏览器本次执行异常，请稍后重试";
}

function publicFailure(error: unknown, env: XhsBrowserEnv): string {
  return xhsBrowserFailureMessage(String((error as Error)?.message ?? error), env);
}

function logBrowserFailure(
  operation: "qrcode" | "poll" | "cookie-import" | "search",
  error: unknown,
): void {
  const value = error as { name?: unknown; message?: unknown };
  // 只记录错误类别与裁剪后的运行时消息，不写 owner、Cookie、二维码或请求参数。
  console.error("xhs-browser-operation-failed", {
    operation,
    errorName: typeof value?.name === "string" ? value.name.slice(0, 80) : "Error",
    errorMessage:
      typeof value?.message === "string"
        ? value.message.replace(/[\r\n]+/g, " ").slice(0, 500)
        : "",
  });
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
  if (!row?.encrypted_cookies && row?.qr_session_id && row.qr_expires_at > Date.now()) {
    // 手机从小红书 App 返回后即便网页被系统重载，也会从保留的 Browser Run 会话补做确认。
    return poll(env, owner);
  }
  if (row?.qr_session_id && row.qr_expires_at <= Date.now()) {
    await closeBrowserSession(env, row.qr_session_id);
    await clearQrState(env, owner);
  }
  return json({
    ok: true,
    online: true,
    loggedIn: Boolean(row?.encrypted_cookies),
    pendingLogin: false,
    ...(row?.nickname ? { nickname: row.nickname } : {}),
    message: row?.encrypted_cookies ? "云端登录态已保存" : "可直接扫码登录",
  });
}

async function qrcode(env: XhsBrowserEnv, owner: string): Promise<Response> {
  if (!configured(env)) return status(env, owner);
  const beforeLease = await sessionRow(env, owner);
  if (beforeLease?.encrypted_cookies) {
    return json({ ok: true, online: true, alreadyLoggedIn: true });
  }
  const leaseToken = await acquireQrLease(env, owner);
  if (!leaseToken) {
    return json(
      {
        ok: false,
        online: true,
        failureKind: "busy",
        message: "当前账号的登录码正在生成，请稍后再试",
      },
      409,
    );
  }

  let browser: Browser | null = null;
  let keepSession = false;
  let budgetClaim: BrowserBudgetClaim | null = null;
  try {
    const current = await sessionRow(env, owner);
    if (current?.encrypted_cookies) {
      return json({ ok: true, online: true, alreadyLoggedIn: true });
    }
    if (current?.qr_session_id && current.qr_expires_at > Date.now()) {
      const payload = await savedQrPayload(env, current);
      if (payload && (await browserSessionAvailable(env, current.qr_session_id))) {
        return json({
          ok: true,
          online: true,
          ...payload,
          expiresAt: current.qr_expires_at,
          reused: true,
          hint: "已复用当前账号仍在线的登录码",
        });
      }
    }
    await closeBrowserSession(env, current?.qr_session_id ?? "");
    await clearQrState(env, owner);

    budgetClaim = await claimBrowserBudget(env, owner, "qr");
    if (!budgetClaim) {
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
    browser = await launchBrowser(env);
    const page = await browser.newPage();
    await preparePage(page);
    const qrResponsePromise = page
      .waitForResponse(
        (response) =>
          response.url().includes(QR_CREATE_API) && response.request().method() === "POST",
        { timeout: 5_000 },
      )
      .catch(() => null);
    await page.goto(XHS_EXPLORE_URL, { waitUntil: "domcontentloaded" });
    const existingCookies = await waitForAuthenticatedCookies(page);
    if (existingCookies) {
      await saveLoggedInSession(env, owner, existingCookies, await currentNickname(page));
      return json({ ok: true, online: true, alreadyLoggedIn: true });
    }
    const element = await page.waitForSelector(QR_SELECTOR, { timeout: 20_000 });
    if (!element) throw new Error("qrcode selector missing");
    // deeplink 是手机端增强项；即使接口结构临时变化，也先把已经可见的二维码交给桌面端。
    const qrResponse = await Promise.race([
      qrResponsePromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_200)),
    ]);
    let launchUrl = "";
    if (qrResponse) {
      launchUrl = extractXhsLoginLaunchUrl(await qrResponse.json().catch(() => null));
    }
    const encoded = await element.screenshot({ encoding: "base64" });
    const qrcodeData = `data:image/png;base64,${encoded}`;
    const expiresAt = Date.now() + QR_LIFETIME_MS;
    await saveQrSession(env, owner, browser.sessionId(), expiresAt, {
      qrcode: qrcodeData,
      ...(launchUrl ? { launchUrl } : {}),
    });
    keepSession = true;
    return json({
      ok: true,
      online: true,
      qrcode: qrcodeData,
      expiresAt,
      ...(launchUrl ? { launchUrl } : {}),
      hint: "二维码和登录态只属于当前浏览器或账号",
    });
  } catch (error) {
    if (budgetClaim) await releaseBrowserBudget(env, budgetClaim).catch(() => {});
    logBrowserFailure("qrcode", error);
    return json(
      {
        ok: false,
        online: true,
        failureKind: "service_error",
        message: publicFailure(error, env),
      },
      502,
    );
  } finally {
    if (browser) {
      if (keepSession) await browser.disconnect();
      else await browser.close().catch(() => {});
    }
    await releaseQrLease(env, owner, leaseToken).catch(() => {});
  }
}

async function poll(env: XhsBrowserEnv, owner: string): Promise<Response> {
  if (!configured(env)) return status(env, owner);
  const row = await sessionRow(env, owner);
  if (row?.encrypted_cookies) {
    return json({ ok: true, online: true, loggedIn: true, nickname: row.nickname || undefined });
  }
  if (!row?.qr_session_id || row.qr_expires_at <= Date.now()) {
    await closeBrowserSession(env, row?.qr_session_id ?? "");
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
    const cookies = await waitForAuthenticatedCookies(page);
    if (!cookies) {
      await browser.disconnect();
      browser = null;
      return json({
        ok: true,
        online: true,
        loggedIn: false,
        pendingLogin: true,
        expiresAt: row.qr_expires_at,
      });
    }
    const nickname = await currentNickname(page);
    await saveLoggedInSession(env, owner, cookies, nickname);
    await browser.close();
    browser = null;
    return json({ ok: true, online: true, loggedIn: true, nickname: nickname || undefined });
  } catch (error) {
    logBrowserFailure("poll", error);
    return json({
      ok: true,
      online: true,
      loggedIn: false,
      pendingLogin: true,
      expiresAt: row.qr_expires_at,
      checkFailed: true,
      message: publicFailure(error, env),
    });
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
  const budgetClaim = await claimBrowserBudget(env, owner, "qr");
  if (!budgetClaim) {
    return json({ ok: false, message: "今日云端登录校验预算已用完，请明日再试" }, 429);
  }
  let browser: Browser | null = null;
  let completed = false;
  try {
    browser = await launchBrowser(env);
    const page = await browser.newPage();
    await preparePage(page);
    await page.setCookie(...cookies);
    await page.goto(XHS_EXPLORE_URL, { waitUntil: "domcontentloaded" });
    const verified = await waitForAuthenticatedCookies(page);
    if (!verified) return json({ ok: false, message: "Cookie 未通过登录校验" }, 401);
    const nickname = await currentNickname(page);
    await saveLoggedInSession(env, owner, verified, nickname);
    completed = true;
    return json({ ok: true, online: true, loggedIn: true, nickname: nickname || undefined });
  } catch (error) {
    logBrowserFailure("cookie-import", error);
    return json({ ok: false, message: publicFailure(error, env) }, 502);
  } finally {
    await browser?.close().catch(() => {});
    if (!completed) await releaseBrowserBudget(env, budgetClaim).catch(() => {});
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
  const normalizedKeyword = normalizeXhsResearchKeyword(keyword);
  if (!normalizedKeyword) return empty("本次没有可用于小红书检索的关键词");
  const row = await sessionRow(env, owner);
  if (!row?.encrypted_cookies) return empty("小红书尚未登录，本次继续使用豆档案与模型知识生成");
  const cached = await loadResearchCache(env, owner, normalizedKeyword).catch(() => []);
  if (cached.length > 0) {
    return {
      ok: true,
      sources: cached,
      summaryText: researchSummary(normalizedKeyword, cached),
      message: `已复用近期小红书公开笔记结果，共 ${cached.length} 条`,
      filtered: 0,
      distilled: false,
      cacheHit: true,
    };
  }
  const cookies = await decryptCookies(env, row.encrypted_cookies);
  if (cookies.length === 0) return empty("小红书登录态需要更新", true);
  const cacheKey = await xhsResearchCacheKey(env, owner, normalizedKeyword);
  const leaseToken = await acquireResearchLease(env, cacheKey);
  if (!leaseToken) {
    const merged = await waitForResearchCache(env, owner, normalizedKeyword).catch(() => []);
    if (merged.length > 0) {
      return {
        ok: true,
        sources: merged,
        summaryText: researchSummary(normalizedKeyword, merged),
        message: `已复用刚完成的小红书公开笔记结果，共 ${merged.length} 条`,
        filtered: 0,
        distilled: false,
        cacheHit: true,
      };
    }
    return empty("相同账号的同一检索正在执行，本次继续使用豆档案与模型知识生成");
  }
  let browser: Browser | null = null;
  let budgetClaim: BrowserBudgetClaim | null = null;
  let refundBudget = false;
  try {
    budgetClaim = await claimBrowserBudget(env, owner, "search");
    if (!budgetClaim) {
      return empty("今日云端小红书检索预算已用完，本次继续使用豆档案与模型知识生成");
    }
    browser = await launchBrowser(env);
    const page = await browser.newPage();
    await preparePage(page);
    await page.setCookie(...cookies);
    const url = new URL(`${XHS_ORIGIN}/search_result`);
    url.searchParams.set("keyword", normalizedKeyword);
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
    const stillLoggedIn = Boolean(await waitForAuthenticatedCookies(page));
    if (!stillLoggedIn && sources.length === 0) {
      await env.DB.prepare(
        "UPDATE xhs_browser_sessions SET encrypted_cookies='',nickname='',updated_at=? WHERE owner=?",
      )
        .bind(new Date().toISOString(), owner)
        .run();
      return empty("小红书登录已过期，本次继续完成生成", true);
    }
    if (sources.length === 0) return empty("小红书已登录，本次关键词未检索到相关笔记");
    await saveResearchCache(env, cacheKey, leaseToken, sources).catch(() => {});
    return {
      ok: true,
      sources,
      summaryText: researchSummary(normalizedKeyword, sources),
      message: `已从当前用户的小红书账号检索到 ${sources.length} 条相关笔记`,
      filtered: 0,
      distilled: false,
    };
  } catch (error) {
    refundBudget = true;
    logBrowserFailure("search", error);
    return empty(publicFailure(error, env));
  } finally {
    await browser?.close().catch(() => {});
    if (refundBudget && budgetClaim) await releaseBrowserBudget(env, budgetClaim).catch(() => {});
    await releaseResearchLease(env, cacheKey, leaseToken).catch(() => {});
  }
}
