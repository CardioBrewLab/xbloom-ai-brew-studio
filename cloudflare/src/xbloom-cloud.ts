import { RecipeSchema, cloudToPattern, type Recipe } from "../../shared/src/recipe-schema.ts";
import { toCloudPayload } from "../../shared/dist/xbloom-cloud-payload.js";
import type { AuthUser } from "./auth.ts";
import { decryptText, encryptText } from "./crypto.ts";
import { parseSpkiRsaPublicKey, rsaPkcs1Encrypt } from "./rsa-pkcs1.ts";

export type XbloomRegion = "cn" | "global";

export interface XbloomEnv {
  DB: D1Database;
  APP_DATA_ENCRYPTION_KEY?: string;
}

interface XbloomSession {
  memberId: number;
  token: string;
  email: string;
}

interface StoredXbloomSession {
  region: XbloomRegion;
  email: string;
  password: string;
  session: XbloomSession;
}

interface ExternalSessionRow {
  region: XbloomRegion;
  account_hint: string;
  encrypted_payload: string;
}

const API_BASE: Record<XbloomRegion, string> = {
  cn: "https://clientcn-api.xbloomcoffee.cn",
  global: "https://client-api.xbloom.com",
};
const SHARE_BASE: Record<XbloomRegion, string> = {
  cn: "https://share-h5.xbloomcoffee.cn",
  global: "https://share-h5.xbloom.com",
};
const RSA_PUBLIC_KEY_B64 =
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC4LF40GZ72SdhMyl765K/i4nY5" +
  "CPcHz2Q1IKWKZ9S79xmK7G8pUhbVf4EZLvnNF1+9IvOFQUKV5Z7ZNNviqSpnql9" +
  "tAT+8+J/He0R7pcirvVSxgdr2i9V/C/gmqAEZ5qVTzRnd3uWdFoKzPdEBxP0Ipor" +
  "J1VBbCv90yBSOhVxO+QIDAQAB";
const RSA_KEY = parseSpkiRsaPublicKey(RSA_PUBLIC_KEY_B64);
const encoder = new TextEncoder();

function encryptionSecret(env: XbloomEnv): string {
  if (!env.APP_DATA_ENCRYPTION_KEY?.trim()) throw new Error("站点尚未配置数据加密密钥");
  return env.APP_DATA_ENCRYPTION_KEY;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function rsaEncryptXbloom(payload: Record<string, unknown>): string {
  return bytesToBase64(rsaPkcs1Encrypt(encoder.encode(JSON.stringify(payload)), RSA_KEY));
}

function detailOf(body: Record<string, unknown>): string {
  for (const key of [
    "msg",
    "message",
    "errorMsg",
    "errorMessage",
    "error",
    "reason",
    "tips",
    "info",
  ]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 240);
  }
  return "xBloom 云端未返回具体原因";
}

function isAuthFailure(body: Record<string, unknown>): boolean {
  if (body.result === "success") return false;
  const code = Number(body.code ?? body.status ?? body.resultCode);
  return code === 401 || code === 403 || /token|未登录|登录态|过期|失效/i.test(detailOf(body));
}

async function postJson(
  region: XbloomRegion,
  endpoint: string,
  payload: unknown,
  options: { idempotent?: boolean; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  let last: Response | null = null;
  const attempts = options.idempotent ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await fetch(`${API_BASE[region]}/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        referer: `${SHARE_BASE[region]}/`,
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    if (!(last.status === 404 || last.status >= 500) || attempt === attempts - 1) break;
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  if (!last) throw new Error("xBloom 云端请求未发出");
  try {
    return (await last.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`xBloom 云端返回了非 JSON 内容（HTTP ${last.status}）`);
  }
}

function authBase(session: XbloomSession): Record<string, unknown> {
  return {
    interfaceVersion: 20240918,
    skey: "testskey",
    phoneType: "Android",
    memberId: session.memberId,
    clientType: 2,
    languageType: 3,
    token: session.token,
  };
}

function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : "***";
}

async function loginRemote(
  region: XbloomRegion,
  email: string,
  password: string,
): Promise<XbloomSession> {
  const response = await postJson(
    region,
    "tMemberLogin.thtml",
    {
      interfaceVersion: 20240918,
      skey: "testskey",
      clientType: 2,
      phoneType: "Android",
      languageType: 3,
      email,
      password,
    },
    { idempotent: true },
  );
  if (response.result !== "success") throw new Error(`xBloom 登录未通过：${detailOf(response)}`);
  const member = response.member as Record<string, unknown> | undefined;
  const token = response.token;
  if (!member || typeof member.tableId !== "number" || typeof token !== "string") {
    throw new Error("xBloom 登录响应字段不完整");
  }
  return { memberId: member.tableId, token, email };
}

async function saveStored(
  env: XbloomEnv,
  user: AuthUser,
  stored: StoredXbloomSession,
): Promise<void> {
  const encrypted = await encryptText(JSON.stringify(stored), encryptionSecret(env));
  await env.DB.prepare(
    `INSERT INTO user_external_sessions(user_id,service,region,account_hint,encrypted_payload,updated_at)
     VALUES(?,'xbloom',?,?,?,?)
     ON CONFLICT(user_id,service) DO UPDATE SET region=excluded.region,account_hint=excluded.account_hint,
     encrypted_payload=excluded.encrypted_payload,updated_at=excluded.updated_at`,
  )
    .bind(user.id, stored.region, maskEmail(stored.email), encrypted, new Date().toISOString())
    .run();
}

async function loadStored(env: XbloomEnv, user: AuthUser): Promise<StoredXbloomSession | null> {
  const row = await env.DB.prepare(
    "SELECT region,account_hint,encrypted_payload FROM user_external_sessions WHERE user_id=? AND service='xbloom'",
  )
    .bind(user.id)
    .first<ExternalSessionRow>();
  if (!row) return null;
  const parsed = JSON.parse(
    await decryptText(row.encrypted_payload, encryptionSecret(env)),
  ) as StoredXbloomSession;
  if (
    !parsed ||
    !["cn", "global"].includes(parsed.region) ||
    !parsed.email ||
    !parsed.password ||
    typeof parsed.session?.memberId !== "number" ||
    !parsed.session.token
  ) {
    throw new Error("已保存的 xBloom 会话格式有误，请重新登录");
  }
  return parsed;
}

class XbloomAuthError extends Error {}

async function withStoredSession<T>(
  env: XbloomEnv,
  user: AuthUser,
  operation: (stored: StoredXbloomSession) => Promise<T>,
): Promise<T> {
  const stored = await loadStored(env, user);
  if (!stored) throw new Error("请先登录 xBloom 账号");
  try {
    return await operation(stored);
  } catch (error) {
    if (!(error instanceof XbloomAuthError)) throw error;
    const session = await loginRemote(stored.region, stored.email, stored.password);
    const refreshed = { ...stored, session };
    await saveStored(env, user, refreshed);
    return operation(refreshed);
  }
}

async function listRemote(stored: StoredXbloomSession): Promise<Record<string, unknown>[]> {
  const response = await postJson(
    stored.region,
    "tuMyTeaRecipeCreated.tuhtml",
    rsaEncryptXbloom({
      ...authBase(stored.session),
      pageNumber: 1,
      countPerPage: 100,
      adaptedModel: 1,
    }),
    { idempotent: true },
  );
  if (response.result !== "success") {
    if (isAuthFailure(response)) throw new XbloomAuthError(detailOf(response));
    throw new Error(`读取 xBloom 配方未完成：${detailOf(response)}`);
  }
  return Array.isArray(response.list) ? (response.list as Record<string, unknown>[]) : [];
}

function shareUrl(region: XbloomRegion, row: Record<string, unknown>): string {
  if (typeof row.shareRecipeLink === "string" && row.shareRecipeLink.startsWith("http")) {
    return row.shareRecipeLink;
  }
  const tableId = Number(row.tableId);
  return tableId > 0
    ? `${SHARE_BASE[region]}/?id=${encodeURIComponent(btoa(String(tableId)))}`
    : "";
}

function listPublic(region: XbloomRegion, rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    ...row,
    tableId: String(Number(row.tableId) || ""),
    theName: typeof row.theName === "string" ? row.theName : "",
    shareUrl: shareUrl(region, row),
  }));
}

function numberValue(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseRecipeVo(value: Record<string, unknown>): Recipe {
  const dose = numberValue(value.dose, 15);
  const ratio = numberValue(value.grandWater, 15);
  const rawPours =
    typeof value.pourList === "string"
      ? (JSON.parse(value.pourList) as unknown[])
      : Array.isArray(value.pourList)
        ? value.pourList
        : [];
  if (!rawPours.length) throw new Error("xBloom 分享配方缺少注水段");
  return RecipeSchema.parse({
    name: typeof value.theName === "string" && value.theName.trim() ? value.theName : "导入配方",
    cupType: value.cupType === 2 ? "xdripper" : "other",
    doseGrams: dose,
    grinderSize: numberValue(value.grinderSize, 70),
    rpm: numberValue(value.rpm, 80),
    grandWater: Math.round(dose * ratio * 10) / 10,
    pours: rawPours.map((item, index) => {
      const pour = (item ?? {}) as Record<string, unknown>;
      return {
        volume: numberValue(pour.volume, 30),
        temperature: numberValue(pour.temperature, 93),
        flowRate: numberValue(pour.flowRate, 3),
        pattern: cloudToPattern(numberValue(pour.pattern, 2)),
        pausing: numberValue(pour.pausing, 0),
        vibBefore: numberValue(pour.isEnableVibrationBefore, 2) === 1,
        vibAfter: numberValue(pour.isEnableVibrationAfter, 2) === 1,
        theName:
          typeof pour.theName === "string" && pour.theName.trim()
            ? pour.theName.trim()
            : index === 0
              ? "Bloom"
              : `Pour ${index}`,
      };
    }),
    bypassEnabled: numberValue(value.isEnableBypassWater, 2) === 1,
    bypassVolume: numberValue(value.bypassVolume, 5),
    bypassTemp: numberValue(value.bypassTemp, 85),
    isSetGrinderSize: numberValue(value.isSetGrinderSize, 1) === 2 ? 2 : 1,
    theColor:
      typeof value.theColor === "string" && /^#[0-9a-f]{6}$/i.test(value.theColor)
        ? value.theColor
        : "#C9D5B8",
  });
}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 262_144) throw new Error("请求体过大");
  const parsed = JSON.parse(text || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("请求格式有误");
  return parsed as Record<string, unknown>;
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

function validatedRecipe(body: Record<string, unknown>): Recipe {
  const result = RecipeSchema.safeParse(body.recipe);
  if (!result.success)
    throw new Error(`配方结构有误：${result.error.issues[0]?.message ?? "字段不完整"}`);
  return result.data;
}

async function writeRecipe(
  stored: StoredXbloomSession,
  recipe: Recipe,
  name: string | undefined,
  tableId?: number,
) {
  const mapped = toCloudPayload(recipe, name);
  const endpoint = tableId ? "tuRecipeUpdate.tuhtml" : "tuRecipeAdd.tuhtml";
  const response = await postJson(
    stored.region,
    endpoint,
    rsaEncryptXbloom({
      ...authBase(stored.session),
      ...(tableId ? { tableId } : {}),
      ...mapped.payload,
    }),
  );
  if (response.result !== "success") {
    if (isAuthFailure(response)) throw new XbloomAuthError(detailOf(response));
    throw new Error(`${tableId ? "更新" : "上传"}配方未完成：${detailOf(response)}`);
  }
  const resultTableId = tableId ?? numberValue(response.tableId, 0);
  if (!resultTableId) throw new Error("xBloom 响应缺少配方 ID");
  const rows = await listRemote(stored).catch(() => []);
  const row = rows.find((item) => Number(item.tableId) === resultTableId) ?? {
    tableId: resultTableId,
  };
  return {
    ok: true,
    tableId: String(resultTableId),
    shareUrl: shareUrl(stored.region, row),
    adjustments: mapped.adjustments,
    verification: {
      state: rows.length ? "verified" : "unverified",
      message: rows.length
        ? "已写入 xBloom 云端并在账号配方列表中确认"
        : "已写入 xBloom 云端，列表回读稍后可再确认",
    },
  };
}

export async function handleXbloomRoute(
  request: Request,
  env: XbloomEnv,
  user: AuthUser | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/cloud/")) return null;
  if (request.method === "GET" && path.startsWith("/api/cloud/detail/")) {
    let id = decodeURIComponent(path.slice("/api/cloud/detail/".length));
    let region: XbloomRegion = id.includes("xbloom.com") ? "global" : "cn";
    if (id.startsWith("http")) id = new URL(id).searchParams.get("id") ?? "";
    if (!id) return json({ ok: false, message: "分享链接缺少 id" }, 400);
    let response = await postJson(
      region,
      "RecipeDetail.html",
      { tableIdOfRSA: id, interfaceVersion: 19700101, skey: "testskey" },
      { idempotent: true },
    );
    if (response.result !== "success") {
      region = region === "cn" ? "global" : "cn";
      response = await postJson(
        region,
        "RecipeDetail.html",
        { tableIdOfRSA: id, interfaceVersion: 19700101, skey: "testskey" },
        { idempotent: true },
      );
    }
    const vo = response.recipeVo as Record<string, unknown> | undefined;
    if (response.result !== "success" || !vo)
      return json({ ok: false, message: detailOf(response) }, 404);
    return json({ ok: true, recipe: parseRecipeVo(vo), raw: response });
  }
  if (!user) return json({ ok: false, message: "请先登录工作台账号" }, 401);
  if (request.method === "GET" && path === "/api/cloud/status") {
    const stored = await loadStored(env, user);
    return json({
      reachable: true,
      loggedIn: Boolean(stored),
      proxyUsed: false,
      autoLogin: Boolean(stored),
      ...(stored ? { email: maskEmail(stored.email) } : {}),
      ...(stored ? { region: stored.region } : {}),
      message: stored ? `已保存 xBloom 登录（${maskEmail(stored.email)}）` : "xBloom 云端待登录",
    });
  }
  if (request.method === "POST" && path === "/api/cloud/login") {
    const body = await bodyObject(request);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const region: XbloomRegion = body.region === "global" ? "global" : "cn";
    if (!email || email.length > 254 || !password || password.length > 256) {
      return json({ ok: false, message: "请填写 xBloom 邮箱和密码" }, 400);
    }
    const session = await loginRemote(region, email, password);
    await saveStored(env, user, { region, email, password, session });
    return json({ ok: true, memberId: String(session.memberId), email: maskEmail(email) });
  }
  if (request.method === "POST" && path === "/api/cloud/logout") {
    await env.DB.prepare("DELETE FROM user_external_sessions WHERE user_id=? AND service='xbloom'")
      .bind(user.id)
      .run();
    return json({ ok: true });
  }
  if (request.method === "POST" && path === "/api/cloud/publish-preview") {
    const body = await bodyObject(request);
    const recipe = validatedRecipe(body);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
    const mapped = toCloudPayload(recipe, name);
    const pours = JSON.parse(String(mapped.payload.pourDataJSONStr)) as Array<
      Record<string, unknown>
    >;
    return json({
      ok: true,
      adjustments: mapped.adjustments,
      alignedGrandWater: mapped.alignedGrandWater,
      cloudRatio: mapped.payload.grandWater,
      pours: pours.map((pour) => ({ theName: pour.theName, volume: pour.volume })),
    });
  }
  if (request.method === "POST" && path === "/api/cloud/publish") {
    const body = await bodyObject(request);
    const recipe = validatedRecipe(body);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
    return json(await withStoredSession(env, user, (stored) => writeRecipe(stored, recipe, name)));
  }
  if (request.method === "GET" && path === "/api/cloud/recipes") {
    const result = await withStoredSession(env, user, async (stored) => ({
      region: stored.region,
      rows: await listRemote(stored),
    }));
    return json({ ok: true, recipes: listPublic(result.region, result.rows) });
  }
  const recipeMatch = path.match(/^\/api\/cloud\/recipes\/(\d+)$/);
  if (recipeMatch && request.method === "PUT") {
    const body = await bodyObject(request);
    const recipe = validatedRecipe(body);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
    return json(
      await withStoredSession(env, user, (stored) =>
        writeRecipe(stored, recipe, name, Number(recipeMatch[1])),
      ),
    );
  }
  if (recipeMatch && request.method === "DELETE") {
    await withStoredSession(env, user, async (stored) => {
      const response = await postJson(
        stored.region,
        "tuRecipeDelete.tuhtml",
        rsaEncryptXbloom({ ...authBase(stored.session), tableId: Number(recipeMatch[1]) }),
      );
      if (response.result !== "success") {
        if (isAuthFailure(response)) throw new XbloomAuthError(detailOf(response));
        throw new Error(`删除配方未完成：${detailOf(response)}`);
      }
    });
    return json({ ok: true });
  }
  const verifyMatch = path.match(/^\/api\/cloud\/verify\/(\d+)$/);
  if (verifyMatch && request.method === "POST") {
    const tableId = Number(verifyMatch[1]);
    const found = await withStoredSession(env, user, async (stored) =>
      (await listRemote(stored)).find((row) => Number(row.tableId) === tableId),
    );
    const ok = Boolean(found);
    return json({
      ok: true,
      readback: { ok, message: ok ? "账号配方列表已确认这条记录" : "账号配方列表暂未返回这条记录" },
      verification: {
        state: ok ? "verified" : "unverified",
        message: ok ? "账号配方列表已确认这条记录" : "账号配方列表暂未返回这条记录",
      },
    });
  }
  return json({ ok: false, message: "xBloom 云端操作不存在" }, 404);
}
