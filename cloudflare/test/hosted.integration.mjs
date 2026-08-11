import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cloudflareDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = path.join(cloudflareDir, "node_modules", "wrangler", "bin", "wrangler.js");
const config = path.join(cloudflareDir, "wrangler.template.jsonc");
const persistTo = await mkdtemp(path.join(tmpdir(), "xbloom-hosted-integration-"));
const port = 18800 + Math.floor(Math.random() * 700);
const origin = `http://127.0.0.1:${port}`;
const sessionSecret = "integration-session-secret-" + "s".repeat(40);
const passwordPepper = "integration-password-pepper-" + "p".repeat(40);
const dataSecret = "integration-data-secret-" + "d".repeat(40);
const proxySecret = "integration-edge-secret-" + "e".repeat(40);
let worker;
let workerOutput = "";

const passwordScheme = "client-pbkdf2-hmac-pepper-v2";
const passwordIterations = 600_000;
const encoder = new TextEncoder();

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function passwordCredential(password, params) {
  const salt = params?.salt ?? base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const iterations = params?.iterations ?? passwordIterations;
  const scheme = params?.scheme ?? passwordScheme;
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const proof = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: Buffer.from(salt, "base64url"),
      iterations,
    },
    key,
    256,
  );
  return {
    passwordProof: base64Url(proof),
    passwordSalt: salt,
    passwordIterations: iterations,
    passwordScheme: scheme,
  };
}

async function loginCredential(loginName, password, jar) {
  const params = await request("/api/auth/password-params", {
    jar,
    method: "POST",
    body: { loginName },
  });
  assert.equal(params.response.status, 200);
  return passwordCredential(password, params.payload);
}

class CookieJar {
  #values = new Map();

  absorb(response) {
    const values =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : (response.headers.get("set-cookie") ?? "")
            .split(/,(?=\s*[^;,=]+=[^;,]*)/)
            .filter(Boolean);
    for (const value of values) {
      const [pair] = value.split(";", 1);
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      if (!cookieValue || /max-age=0/i.test(value)) this.#values.delete(name);
      else this.#values.set(name, cookieValue);
    }
  }

  header() {
    return [...this.#values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function request(
  pathname,
  { jar, method = "GET", body, headers = {}, requestOrigin = origin } = {},
) {
  const requestHeaders = new Headers(headers);
  if (requestOrigin) requestHeaders.set("origin", requestOrigin);
  if (jar?.header()) requestHeaders.set("cookie", jar.header());
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  jar?.absorb(response);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { response, payload };
}

async function waitUntilReady() {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // workerd is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`本地 Worker 启动超时\n${workerOutput.slice(-4_000)}`);
}

function stopWorker() {
  if (!worker || worker.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    worker.kill("SIGTERM");
  }
}

const validRecipe = {
  name: "Integration Brew",
  cupType: "xdripper",
  doseGrams: 15,
  grinderSize: 70,
  rpm: 80,
  grandWater: 225,
  pours: [
    {
      volume: 45,
      temperature: 93,
      flowRate: 3,
      pattern: "center",
      pausing: 30,
      vibBefore: false,
      vibAfter: false,
      theName: "Bloom",
    },
    {
      volume: 180,
      temperature: 93,
      flowRate: 3.2,
      pattern: "spiral",
      pausing: 0,
      vibBefore: false,
      vibAfter: false,
      theName: "Pour 1",
    },
  ],
  bypassEnabled: false,
  bypassVolume: 5,
  bypassTemp: 85,
  isSetGrinderSize: 1,
  theColor: "#C9D5B8",
};

try {
  const migration = spawnSync(
    process.execPath,
    [
      wrangler,
      "d1",
      "migrations",
      "apply",
      "xbloom-ai-brew-studio-db",
      "--local",
      "--config",
      config,
      "--persist-to",
      persistTo,
    ],
    { cwd: cloudflareDir, encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(
    migration.status,
    0,
    `D1 migration failed\n${migration.stdout ?? ""}\n${migration.stderr ?? ""}`,
  );

  worker = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--local",
      "--config",
      config,
      "--persist-to",
      persistTo,
      "--port",
      String(port),
      "--show-interactive-dev-session=false",
      "--var",
      `APP_SESSION_SECRET:${sessionSecret}`,
      "--var",
      `APP_PASSWORD_PEPPER:${passwordPepper}`,
      "--var",
      `APP_DATA_ENCRYPTION_KEY:${dataSecret}`,
      "--var",
      `EDGE_PROXY_SECRET:${proxySecret}`,
    ],
    { cwd: cloudflareDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  worker.stdout.on("data", (chunk) => (workerOutput += chunk));
  worker.stderr.on("data", (chunk) => (workerOutput += chunk));
  await waitUntilReady();

  const status = await request("/api/status", { requestOrigin: null });
  assert.equal(status.response.status, 200);
  assert.equal(status.payload.version, "hosted-0.2.1");
  assert.equal(status.payload.capabilities.auth, true);

  const crossSite = await request("/api/beans", {
    method: "POST",
    body: { name: "cross-site" },
    requestOrigin: "https://attacker.example",
  });
  assert.equal(crossSite.response.status, 403);

  const trustedProxy = await request("/api/beans", {
    method: "POST",
    body: { name: "trusted-edge" },
    requestOrigin: "https://brew.example.cn",
    headers: {
      "x-xbloom-proxy-secret": proxySecret,
      "x-xbloom-client-ip": "198.51.100.9",
      "x-forwarded-host": "brew.example.cn",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(trustedProxy.response.status, 200);

  const forgedTrustedProxy = await request("/api/beans", {
    method: "POST",
    body: { name: "forged-trusted-edge" },
    requestOrigin: "https://attacker.example",
    headers: {
      "x-xbloom-proxy-secret": proxySecret,
      "x-xbloom-client-ip": "198.51.100.9",
      "x-forwarded-host": "brew.example.cn",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(forgedTrustedProxy.response.status, 403);

  const guestSettings = await request("/api/settings/llm", { requestOrigin: null });
  assert.equal(guestSettings.payload.settings.source, "unconfigured");
  const guestSave = await request("/api/settings/llm", { method: "PUT", body: {} });
  assert.equal(guestSave.response.status, 401);

  const guestCloudStatus = await request("/api/cloud/status", { requestOrigin: null });
  assert.equal(guestCloudStatus.response.status, 200);
  assert.equal(guestCloudStatus.payload.loggedIn, false);
  assert.equal(guestCloudStatus.payload.workspaceLoginRequired, true);

  const user1 = new CookieJar();
  const password1 = "correct-horse-1";
  const registered1 = await request("/api/auth/register", {
    jar: user1,
    method: "POST",
    body: {
      loginName: "integration_user_1",
      ...(await passwordCredential(password1)),
    },
  });
  assert.equal(registered1.response.status, 200);
  assert.equal(registered1.payload.authenticated, true);
  assert.match(user1.header(), /xbloom_auth=/);

  const config1 = await request("/api/config", { jar: user1, requestOrigin: null });
  assert.equal(config1.payload.authenticated, true);
  assert.equal(config1.payload.modelConfigured, false);
  assert.deepEqual(config1.payload.models, []);

  const providers = await request("/api/settings/llm/providers", {
    jar: user1,
    requestOrigin: null,
  });
  assert.equal(providers.response.status, 200);
  assert.ok(providers.payload.providers.length >= 7);

  const bean1 = await request("/api/beans", {
    jar: user1,
    method: "POST",
    body: { name: "User One Bean", stockGrams: 100 },
  });
  assert.equal(bean1.response.status, 200);

  const recipe1 = await request("/api/recipes", {
    jar: user1,
    method: "POST",
    body: { recipe: validRecipe, model: "integration-model" },
  });
  assert.equal(recipe1.response.status, 200);

  const preview = await request("/api/cloud/publish-preview", {
    jar: user1,
    method: "POST",
    body: { recipe: validRecipe },
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.payload.ok, true);
  assert.equal(
    preview.payload.pours.reduce((sum, pour) => sum + pour.volume, 0),
    225,
  );

  const cloudStatus1 = await request("/api/cloud/status", { jar: user1, requestOrigin: null });
  assert.equal(cloudStatus1.response.status, 200);
  assert.equal(cloudStatus1.payload.loggedIn, false);

  const user2 = new CookieJar();
  const password2 = "correct-horse-2";
  const registered2 = await request("/api/auth/register", {
    jar: user2,
    method: "POST",
    body: {
      loginName: "integration_user_2",
      ...(await passwordCredential(password2)),
    },
  });
  assert.equal(registered2.response.status, 200);

  const user2BeansBefore = await request("/api/beans", { jar: user2, requestOrigin: null });
  const user2RecipesBefore = await request("/api/recipes", { jar: user2, requestOrigin: null });
  assert.deepEqual(user2BeansBefore.payload.beans, []);
  assert.deepEqual(user2RecipesBefore.payload.recipes, []);

  await request("/api/beans", {
    jar: user2,
    method: "POST",
    body: { name: "User Two Bean", stockGrams: 80 },
  });
  const user1Beans = await request("/api/beans", { jar: user1, requestOrigin: null });
  const user2Beans = await request("/api/beans", { jar: user2, requestOrigin: null });
  assert.deepEqual(
    user1Beans.payload.beans.map((bean) => bean.name),
    ["User One Bean"],
  );
  assert.deepEqual(
    user2Beans.payload.beans.map((bean) => bean.name),
    ["User Two Bean"],
  );

  const logout1 = await request("/api/auth/logout", { jar: user1, method: "POST", body: {} });
  assert.equal(logout1.response.status, 200);
  const afterLogout = await request("/api/auth/session", { jar: user1, requestOrigin: null });
  assert.equal(afterLogout.payload.authenticated, false);

  const login1 = await request("/api/auth/login", {
    jar: user1,
    method: "POST",
    body: {
      loginName: "integration_user_1",
      ...(await loginCredential("integration_user_1", password1, user1)),
    },
  });
  assert.equal(login1.response.status, 200);
  const persistedBeans = await request("/api/beans", { jar: user1, requestOrigin: null });
  assert.deepEqual(
    persistedBeans.payload.beans.map((bean) => bean.name),
    ["User One Bean"],
  );

  const wrongPassword = await request("/api/auth/login", {
    jar: new CookieJar(),
    method: "POST",
    body: {
      loginName: "integration_user_1",
      ...(await loginCredential("integration_user_1", "wrong-password-1", new CookieJar())),
    },
  });
  assert.equal(wrongPassword.response.status, 401);
  assert.doesNotMatch(JSON.stringify(wrongPassword.payload), /hash|salt|iteration/i);

  console.log(
    "[hosted-integration] PASS: auth, sessions, CSRF/proxy, per-user data isolation, provider onboarding and xBloom preview",
  );
} catch (error) {
  console.error(workerOutput.slice(-8_000));
  throw error;
} finally {
  stopWorker();
  await rm(persistTo, { recursive: true, force: true });
}
