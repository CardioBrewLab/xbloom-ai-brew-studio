import assert from "node:assert/strict";
import test from "node:test";
import puppeteer from "@cloudflare/puppeteer";
import {
  enforceItemWriteQuota,
  parseHostedBeanRequest,
  publicApiError,
  requestBody,
  type Env,
} from "../src/index.ts";
import { encryptText } from "../src/crypto.ts";
import {
  acquireQrLeaseWithBudget,
  handleXhsBrowserRoute,
  researchXhsWithBrowser,
} from "../src/xhs-browser.ts";

const APP_SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
const DATA_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

function usageDb(forcedCount = 0): D1Database {
  const counts = new Map<string, number>();
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T>() {
          if (sql.startsWith("SELECT COUNT(*)")) return { count: 0 } as T;
          if (sql.startsWith("SELECT request_count")) {
            const key = `${String(values[0])}|${String(values[1])}`;
            return { request_count: Math.max(forcedCount, counts.get(key) ?? 0) } as T;
          }
          return null;
        },
        async run() {
          if (sql.startsWith("INSERT INTO generation_usage")) {
            const key = `${String(values[0])}|${String(values[1])}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function itemQuotaEnv(db: D1Database): Env {
  return {
    DB: db,
    APP_SESSION_SECRET,
    APP_PASSWORD_PEPPER: "test-pepper",
    ASSETS: {} as Fetcher,
    HOSTED_ITEM_OWNER_HOURLY_LIMIT: "10",
    HOSTED_ITEM_NETWORK_HOURLY_LIMIT: "2",
    HOSTED_ITEM_GLOBAL_HOURLY_LIMIT: "100",
    HOSTED_ITEM_OWNER_STORAGE_LIMIT: "100",
  } as Env;
}

test("item write quota survives anonymous owner-cookie rotation", async () => {
  const env = itemQuotaEnv(usageDb());
  const request = new Request("https://brew.example/api/beans", {
    method: "POST",
    headers: { "CF-Connecting-IP": "198.51.100.10" },
  });
  await enforceItemWriteQuota(env, request, crypto.randomUUID(), "bean");
  await enforceItemWriteQuota(env, request, crypto.randomUUID(), "bean");
  await assert.rejects(
    enforceItemWriteQuota(env, request, crypto.randomUUID(), "bean"),
    (error: unknown) => publicApiError(error).status === 429,
  );
});

test("bean parse is rejected by the shared generation quota before model work", async () => {
  const env = {
    ...itemQuotaEnv(usageDb(21)),
    LLM_BASE_URL: "https://api.example.com/v1",
    LLM_MODEL: "MODEL",
    LLM_API_KEY: "TOKEN",
  } as Env;
  const request = new Request("https://brew.example/api/beans/parse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "washed coffee" }),
  });
  await assert.rejects(
    parseHostedBeanRequest(request, env, "owner", null),
    (error: unknown) => publicApiError(error).status === 429,
  );
});

function browserDb(cookieSet: Array<{ name: string; value: string }>) {
  let releaseCount = 0;
  let saveCount = 0;
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T>() {
          if (sql.startsWith("INSERT INTO xhs_browser_budget")) return { global_count: 1 } as T;
          return null;
        },
        async run() {
          if (sql.startsWith("UPDATE xhs_browser_budget")) releaseCount += 1;
          if (sql.startsWith("INSERT INTO xhs_browser_sessions")) saveCount += 1;
          return { meta: { changes: 1 } };
        },
      };
      void values;
      return statement;
    },
  } as unknown as D1Database;
  return {
    db,
    get releaseCount() {
      return releaseCount;
    },
    get saveCount() {
      return saveCount;
    },
  };
}

async function runCookieImport(cookie: string) {
  const page = {
    setDefaultNavigationTimeout() {},
    async setViewport() {},
    async setUserAgent() {},
    async setCookie() {},
    async goto() {},
    async cookies() {
      return cookie
        .split(";")
        .filter(Boolean)
        .map((part) => {
          const [name, value] = part.split("=", 2);
          return { name, value };
        });
    },
    async $() {
      return null;
    },
    async evaluate() {
      return "";
    },
  };
  let closeCount = 0;
  const browser = {
    async newPage() {
      return page;
    },
    async close() {
      closeCount += 1;
    },
  };
  const originalLimits = puppeteer.limits;
  const originalLaunch = puppeteer.launch;
  const database = browserDb(
    cookie.split(";").map((part) => {
      const [name, value] = part.split("=", 2);
      return { name, value };
    }),
  );
  try {
    puppeteer.limits = async () => ({
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
      activeSessions: [],
      maxConcurrentSessions: 1,
    });
    puppeteer.launch = async () => browser as never;
    const response = await handleXhsBrowserRoute(
      new Request("https://brew.example/api/xhs/login/cookie-import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cookie }),
      }),
      { DB: database.db, BROWSER: {} as never, APP_DATA_ENCRYPTION_KEY: DATA_KEY },
      "owner",
    );
    assert.ok(response);
    return {
      status: response.status,
      closeCount,
      releaseCount: database.releaseCount,
      saveCount: database.saveCount,
    };
  } finally {
    puppeteer.limits = originalLimits;
    puppeteer.launch = originalLaunch;
  }
}

test("cookie import keeps the Browser Run claim after a started verification fails", async () => {
  const result = await runCookieImport("a1=INVALID");
  assert.equal(result.status, 401);
  assert.equal(result.closeCount, 1);
  assert.equal(result.releaseCount, 0);
});

test("cookie-only XHS authentication signals do not accept synthetic sessions", async () => {
  const result = await runCookieImport("a1=FAKE_A1;webid=FAKE_WEBID;web_session=FAKE_SESSION");
  assert.equal(result.status, 401);
  assert.equal(result.saveCount, 0);
  assert.equal(result.releaseCount, 0);
});

test("QR lease acquisition checks budget before inserting the session row", async () => {
  const calls: string[] = [];
  const db = {
    prepare(sql: string) {
      calls.push(sql.trimStart().split(/[\s(]/, 1)[0]);
      const statement = {
        bind() {
          return statement;
        },
        async first<T>() {
          if (sql.startsWith("INSERT INTO xhs_browser_budget")) return null;
          throw new Error("lease SQL must not run after budget rejection");
        },
        async run() {
          throw new Error("release SQL must not run without a claim");
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  const result = await acquireQrLeaseWithBudget(
    { DB: db, XHS_BROWSER_QR_DAILY_LIMIT: "1" },
    "owner",
  );
  assert.deepEqual(result, { kind: "budget-exhausted" });
  assert.equal(
    calls.some((value) => value === "INSERT"),
    true,
  );
  assert.equal(calls.length, 1);
});

test("aborting XHS research closes the Browser Run and releases its research lease", async () => {
  const encryptedCookies = await encryptText(
    JSON.stringify([{ name: "a1", value: "SESSION" }]),
    DATA_KEY,
  );
  let releaseLeaseCount = 0;
  let closeCount = 0;
  let resolveLaunch!: () => void;
  const launchStarted = new Promise<void>((resolve) => {
    resolveLaunch = resolve;
  });
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T>() {
          if (sql.startsWith("SELECT encrypted_cookies")) {
            return {
              encrypted_cookies: encryptedCookies,
              nickname: "",
              qr_session_id: "",
              qr_expires_at: 0,
              encrypted_qr_payload: "",
              qr_lease_token: "",
              qr_lease_until: 0,
            } as T;
          }
          if (sql.startsWith("SELECT sources_json")) return null;
          if (sql.startsWith("INSERT INTO xhs_research_cache"))
            return { lease_token: values[2] } as T;
          if (sql.startsWith("INSERT INTO xhs_browser_budget")) return { global_count: 1 } as T;
          throw new Error(`unexpected first query: ${sql}`);
        },
        async run() {
          if (sql.startsWith("UPDATE xhs_research_cache")) releaseLeaseCount += 1;
          return { meta: { changes: 1 } };
        },
        async batch() {
          return [];
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  } as unknown as D1Database;
  const page = {
    setDefaultNavigationTimeout() {},
    async setViewport() {},
    async setUserAgent() {},
    async setCookie() {},
    async goto() {
      await new Promise<void>(() => {});
    },
  };
  const browser = {
    async newPage() {
      return page;
    },
    async close() {
      closeCount += 1;
    },
  };
  const originalLimits = puppeteer.limits;
  const originalLaunch = puppeteer.launch;
  try {
    puppeteer.limits = async () => ({
      allowedBrowserAcquisitions: 1,
      timeUntilNextAllowedBrowserAcquisition: 0,
      activeSessions: [],
      maxConcurrentSessions: 1,
    });
    puppeteer.launch = async () => {
      resolveLaunch();
      return browser as never;
    };
    const controller = new AbortController();
    const pending = researchXhsWithBrowser(
      {
        DB: db,
        BROWSER: {} as never,
        APP_DATA_ENCRYPTION_KEY: DATA_KEY,
        XHS_BROWSER_SEARCH_DAILY_LIMIT: "1",
      },
      "owner",
      "coffee",
      controller.signal,
    );
    await Promise.race([
      launchStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("launch timeout")), 1_000)),
    ]);
    controller.abort(new Error("test abort"));
    await assert.rejects(pending, /test abort/);
    assert.equal(closeCount, 1);
    assert.equal(releaseLeaseCount, 1);
  } finally {
    puppeteer.limits = originalLimits;
    puppeteer.launch = originalLaunch;
  }
});

test("request body limits stop reading chunked bodies after the configured byte bound", async () => {
  const chunk = new Uint8Array(64 * 1024);
  let bytesRead = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      bytesRead += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const request = new Request("https://brew.example/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as unknown as RequestInit);
  await assert.rejects(requestBody(request), /请求体超过 256KB/);
  assert.ok(bytesRead <= 327_680);
});
