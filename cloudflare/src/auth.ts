import {
  CLIENT_PASSWORD_ITERATIONS,
  CLIENT_PASSWORD_SCHEME,
  type ClientPasswordProof,
} from "../../shared/src/password-auth.ts";
import {
  fakePasswordSalt,
  hashPasswordProof,
  randomToken,
  sha256,
  verifyPasswordProof,
} from "./crypto.ts";
import { browserOwner, generationQuotaSubjects } from "./session.ts";

export interface AuthEnv {
  DB: D1Database;
  APP_SESSION_SECRET: string;
  APP_PASSWORD_PEPPER: string;
}

export interface AuthUser {
  id: string;
  loginName: string;
  displayName: string;
}

interface AuthUserRow {
  id: string;
  login_name: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  password_scheme: string;
}

export interface RequestIdentity {
  owner: string;
  anonymousOwner: string;
  user: AuthUser | null;
  cookies: string[];
}

const AUTH_COOKIE = "xbloom_auth";
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function cookieValue(request: Request, name: string): string | null {
  const prefix = `${name}=`;
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix))
      ?.slice(prefix.length) ?? null
  );
}

function userFromRow(row: AuthUserRow): AuthUser {
  return { id: row.id, loginName: row.login_name, displayName: row.display_name };
}

function authCookie(token: string, maxAge = SESSION_SECONDS): string {
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function resolveIdentity(request: Request, env: AuthEnv): Promise<RequestIdentity> {
  const anonymous = await browserOwner(request, env.APP_SESSION_SECRET);
  const cookies = anonymous.cookie ? [anonymous.cookie] : [];
  const token = cookieValue(request, AUTH_COOKIE);
  if (!token || token.length > 256) {
    return { owner: anonymous.owner, anonymousOwner: anonymous.owner, user: null, cookies };
  }
  const row = await env.DB.prepare(
    `SELECT u.id,u.login_name,u.display_name,u.password_hash,u.password_salt,u.password_iterations,u.password_scheme
       FROM auth_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>?`,
  )
    .bind(await sha256(token), new Date().toISOString())
    .first<AuthUserRow>();
  if (!row) {
    cookies.push(authCookie("", 0));
    return { owner: anonymous.owner, anonymousOwner: anonymous.owner, user: null, cookies };
  }
  const user = userFromRow(row);
  return { owner: `user:${user.id}`, anonymousOwner: anonymous.owner, user, cookies };
}

function validateLoginName(value: unknown): { loginName: string; displayName: string } {
  if (typeof value !== "string") throw new Error("请填写账号名");
  const displayName = value.trim();
  if (displayName.length < 2 || displayName.length > 64) throw new Error("账号名需要 2-64 个字符");
  if (!/^[\p{L}\p{N}_.@+\-]+$/u.test(displayName)) {
    throw new Error("账号名可使用中英文、数字及 . _ @ + -");
  }
  return { loginName: displayName.toLocaleLowerCase("en-US"), displayName };
}

function validatePasswordProof(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("账号密码凭据格式有误");
  }
  return value;
}

function clientPasswordProof(body: Record<string, unknown>): ClientPasswordProof {
  const credential = {
    scheme: body.passwordScheme,
    salt: body.passwordSalt,
    iterations: body.passwordIterations,
    proof: validatePasswordProof(body.passwordProof),
  };
  if (
    credential.scheme !== CLIENT_PASSWORD_SCHEME ||
    typeof credential.salt !== "string" ||
    credential.iterations !== CLIENT_PASSWORD_ITERATIONS
  ) {
    throw new Error("账号密码计算参数有误");
  }
  return credential as ClientPasswordProof;
}

async function incrementAuthAttempts(
  env: AuthEnv,
  request: Request,
  loginName: string,
): Promise<void> {
  const subjects = await generationQuotaSubjects(request, env.APP_SESSION_SECRET);
  const bucket = new Date().toISOString().slice(0, 13);
  for (const subject of [`auth:${subjects.network}`, `auth-account:${await sha256(loginName)}`]) {
    await env.DB.prepare(
      "INSERT INTO auth_attempts(subject,hour_bucket,request_count) VALUES(?,?,1) ON CONFLICT(subject,hour_bucket) DO UPDATE SET request_count=request_count+1",
    )
      .bind(subject, bucket)
      .run();
    const row = await env.DB.prepare(
      "SELECT request_count FROM auth_attempts WHERE subject=? AND hour_bucket=?",
    )
      .bind(subject, bucket)
      .first<{ request_count: number }>();
    if ((row?.request_count ?? 0) > 30) throw new Error("登录尝试较多，请稍后继续");
  }
}

async function createSession(env: AuthEnv, userId: string): Promise<string> {
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_SECONDS * 1000);
  await env.DB.prepare(
    "INSERT INTO auth_sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
  )
    .bind(await sha256(token), userId, now.toISOString(), expires.toISOString())
    .run();
  return token;
}

async function migrateAnonymousItems(
  env: AuthEnv,
  anonymousOwner: string,
  userId: string,
): Promise<void> {
  const target = `user:${userId}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO user_items(owner,kind,id,created_at,json)
       SELECT ?,kind,id,created_at,json FROM user_items WHERE owner=?`,
    ).bind(target, anonymousOwner),
    env.DB.prepare("DELETE FROM user_items WHERE owner=?").bind(anonymousOwner),
  ]);
}

export interface AuthRouteResult {
  response: Response;
  cookies?: string[];
}

const responseJson = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 32_768) throw new Error("请求体过大");
  const parsed = JSON.parse(text || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("请求格式有误");
  return parsed as Record<string, unknown>;
}

export async function handleAuthRoute(
  request: Request,
  env: AuthEnv,
  identity: RequestIdentity,
): Promise<AuthRouteResult | null> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/api/auth/session") {
    return {
      response: responseJson({
        ok: true,
        authenticated: Boolean(identity.user),
        user: identity.user,
      }),
    };
  }
  if (request.method === "POST" && path === "/api/auth/password-params") {
    const body = await bodyObject(request);
    const { loginName } = validateLoginName(body.loginName);
    const row = await env.DB.prepare(
      "SELECT password_salt,password_iterations,password_scheme FROM users WHERE login_name=?",
    )
      .bind(loginName)
      .first<Pick<AuthUserRow, "password_salt" | "password_iterations" | "password_scheme">>();
    const compatible = row?.password_scheme === CLIENT_PASSWORD_SCHEME;
    return {
      response: responseJson({
        ok: true,
        scheme: CLIENT_PASSWORD_SCHEME,
        salt: compatible
          ? row.password_salt
          : await fakePasswordSalt(loginName, env.APP_PASSWORD_PEPPER),
        iterations: CLIENT_PASSWORD_ITERATIONS,
      }),
    };
  }
  if (request.method === "POST" && path === "/api/auth/register") {
    if (identity.user) return { response: responseJson({ ok: true, user: identity.user }) };
    const body = await bodyObject(request);
    const { loginName, displayName } = validateLoginName(body.loginName);
    const clientProof = clientPasswordProof(body);
    await incrementAuthAttempts(env, request, loginName);
    const existing = await env.DB.prepare("SELECT id FROM users WHERE login_name=?")
      .bind(loginName)
      .first<{ id: string }>();
    if (existing)
      return { response: responseJson({ ok: false, message: "这个账号名已被使用" }, 409) };
    const digest = await hashPasswordProof(loginName, clientProof, env.APP_PASSWORD_PEPPER);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      await env.DB.prepare(
        `INSERT INTO users(id,login_name,display_name,password_hash,password_salt,password_iterations,password_scheme,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          id,
          loginName,
          displayName,
          digest.hash,
          digest.salt,
          digest.iterations,
          digest.scheme,
          now,
          now,
        )
        .run();
    } catch (error) {
      if (/unique/i.test(String((error as Error).message))) {
        return { response: responseJson({ ok: false, message: "这个账号名已被使用" }, 409) };
      }
      throw error;
    }
    await migrateAnonymousItems(env, identity.anonymousOwner, id);
    const token = await createSession(env, id);
    const user = { id, loginName, displayName };
    return {
      response: responseJson({ ok: true, authenticated: true, user }),
      cookies: [authCookie(token)],
    };
  }
  if (request.method === "POST" && path === "/api/auth/login") {
    const body = await bodyObject(request);
    const { loginName } = validateLoginName(body.loginName);
    const passwordProof = validatePasswordProof(body.passwordProof);
    await incrementAuthAttempts(env, request, loginName);
    const row = await env.DB.prepare(
      "SELECT id,login_name,display_name,password_hash,password_salt,password_iterations,password_scheme FROM users WHERE login_name=?",
    )
      .bind(loginName)
      .first<AuthUserRow>();
    const digest = row
      ? {
          hash: row.password_hash,
          salt: row.password_salt,
          iterations: row.password_iterations,
          scheme: row.password_scheme,
        }
      : {
          hash: "A".repeat(43),
          salt: await fakePasswordSalt(loginName, env.APP_PASSWORD_PEPPER),
          iterations: CLIENT_PASSWORD_ITERATIONS,
          scheme: CLIENT_PASSWORD_SCHEME,
        };
    const valid = await verifyPasswordProof(
      loginName,
      passwordProof,
      digest,
      env.APP_PASSWORD_PEPPER,
    );
    if (!row || !valid) {
      return { response: responseJson({ ok: false, message: "账号名或密码不匹配" }, 401) };
    }
    await migrateAnonymousItems(env, identity.anonymousOwner, row.id);
    const token = await createSession(env, row.id);
    return {
      response: responseJson({ ok: true, authenticated: true, user: userFromRow(row) }),
      cookies: [authCookie(token)],
    };
  }
  if (request.method === "POST" && path === "/api/auth/logout") {
    const token = cookieValue(request, AUTH_COOKIE);
    if (token)
      await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash=?")
        .bind(await sha256(token))
        .run();
    return {
      response: responseJson({ ok: true, authenticated: false, user: null }),
      cookies: [authCookie("", 0)],
    };
  }
  return null;
}
