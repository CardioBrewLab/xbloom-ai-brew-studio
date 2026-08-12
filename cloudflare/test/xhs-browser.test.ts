import assert from "node:assert/strict";
import { it } from "node:test";
import {
  browserBudgetPolicy,
  claimBrowserBudget,
  extractXhsLoginLaunchUrl,
  hasXhsAuthenticatedCookies,
  normalizeXhsLoginLaunchUrl,
  normalizeXhsResearchKeyword,
  parseCookieHeader,
  parseXhsSearchFeeds,
  releaseBrowserBudget,
  xhsResearchCacheKey,
} from "../src/xhs-browser.ts";

function budgetDb(): {
  db: D1Database;
  rows: Map<string, { global: number; owners: Map<string, number> }>;
} {
  const rows = new Map<string, { global: number; owners: Map<string, number> }>();
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T>() {
          assert.match(sql, /^INSERT INTO xhs_browser_budget/);
          assert.match(sql, /RETURNING global_count/);
          const bucket = String(values[0]);
          const ownerKey = String(values[1]);
          const globalLimit = Number(values[5]);
          const ownerLimit = Number(values[7]);
          const current = rows.get(bucket);
          if (!current) {
            rows.set(bucket, { global: 1, owners: new Map([[ownerKey, 1]]) });
            return { global_count: 1 } as T;
          }
          const ownerCount = current.owners.get(ownerKey) ?? 0;
          if (current.global >= globalLimit || ownerCount >= ownerLimit) return null;
          current.global += 1;
          current.owners.set(ownerKey, ownerCount + 1);
          return { global_count: current.global } as T;
        },
        async run() {
          assert.match(sql, /^UPDATE xhs_browser_budget/);
          const ownerKey = String(values[0]).match(/^\$\."([0-9a-f]+)"$/)?.[1] ?? "";
          const bucket = String(values[3]);
          const current = rows.get(bucket);
          if (current) {
            current.global = Math.max(current.global - 1, 0);
            current.owners.set(ownerKey, Math.max((current.owners.get(ownerKey) ?? 0) - 1, 0));
          }
          return {};
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { db, rows };
}

it("Cookie 文本只保留合法且唯一的键值", () => {
  const cookies = parseCookieHeader(
    "web_session=SESSION; a1=A; web_session=SHOULD_NOT_OVERRIDE; invalid name=x; empty=",
  );
  assert.deepEqual(
    cookies.map(({ name, value, domain, secure }) => ({ name, value, domain, secure })),
    [
      { name: "web_session", value: "SESSION", domain: ".xiaohongshu.com", secure: true },
      { name: "a1", value: "A", domain: ".xiaohongshu.com", secure: true },
    ],
  );
});

it("小红书搜索状态解析为真实笔记链接并去重", () => {
  const sources = parseXhsSearchFeeds([
    {
      id: "note-a",
      xsecToken: "token=1",
      noteCard: { displayTitle: "花魁手冲参数", desc: "92℃，三段注水" },
    },
    { id: "note-a", noteCard: { displayTitle: "重复项" } },
    { id: "note-b", noteCard: { title: "浅烘冲煮记录" } },
    { id: "missing-title", noteCard: {} },
  ]);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].title, "花魁手冲参数");
  assert.equal(sources[0].snippet, "92℃，三段注水");
  assert.match(sources[0].url, /^https:\/\/www\.xiaohongshu\.com\/explore\/note-a\?/);
  assert.match(sources[0].url, /xsec_token=token%3D1/);
});

it("单个 owner 超限后不再消耗全站 Browser Run 名额", async () => {
  const { db } = budgetDb();
  const env = { DB: db, XHS_BROWSER_QR_DAILY_LIMIT: "4" };
  assert.ok(await claimBrowserBudget(env, "owner-a", "qr"));
  assert.ok(await claimBrowserBudget(env, "owner-a", "qr"));
  assert.ok(await claimBrowserBudget(env, "owner-a", "qr"));
  assert.equal(await claimBrowserBudget(env, "owner-a", "qr"), null);
  assert.ok(await claimBrowserBudget(env, "owner-b", "qr"));
  assert.equal(await claimBrowserBudget(env, "owner-c", "qr"), null);
});

it("超限点击不写入半份计数；失败释放使用原 claim 日期桶", async () => {
  const { db, rows } = budgetDb();
  const env = { DB: db, XHS_BROWSER_QR_DAILY_LIMIT: "1" };
  const claim = await claimBrowserBudget(env, "owner-a", "qr");
  assert.ok(claim);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(await claimBrowserBudget(env, "owner-b", "qr"), null);
  }
  assert.equal(rows.get(claim.bucket)?.global, 1);
  await releaseBrowserBudget(env, claim);
  assert.equal(rows.get(claim.bucket)?.global, 0);
  assert.ok(await claimBrowserBudget(env, "owner-b", "qr"));
});

it("千用户档提供独立的全站与单用户保护阈值", () => {
  assert.deepEqual(browserBudgetPolicy({ XHS_BROWSER_PROFILE: "scale" }, "qr"), {
    profile: "scale",
    globalLimit: 2500,
    ownerLimit: 8,
  });
  assert.deepEqual(browserBudgetPolicy({ XHS_BROWSER_PROFILE: "scale" }, "search"), {
    profile: "scale",
    globalLimit: 20000,
    ownerLimit: 100,
  });
  assert.equal(
    browserBudgetPolicy(
      {
        XHS_BROWSER_PROFILE: "scale",
        XHS_BROWSER_QR_DAILY_LIMIT: "1200",
        XHS_BROWSER_QR_OWNER_DAILY_LIMIT: "5",
      },
      "qr",
    ).ownerLimit,
    5,
  );
});

it("检索关键词做 Unicode 与空白归一，缓存按 owner 隔离", async () => {
  assert.equal(normalizeXhsResearchKeyword("  花魁　手冲  参数 "), "花魁 手冲 参数");
  assert.equal(normalizeXhsResearchKeyword("ＫＥＮＹＡ  V60"), "kenya v60");
  const env = { DB: {} as D1Database, APP_DATA_ENCRYPTION_KEY: "test-key" };
  assert.equal(
    await xhsResearchCacheKey(env, "owner-a", "花魁　手冲 参数"),
    await xhsResearchCacheKey(env, "owner-a", "花魁 手冲  参数"),
  );
  assert.notEqual(
    await xhsResearchCacheKey(env, "owner-a", "花魁 手冲 参数"),
    await xhsResearchCacheKey(env, "owner-b", "花魁 手冲 参数"),
  );
});

it("使用完整会话 Cookie 判定扫码已经确认", () => {
  assert.equal(
    hasXhsAuthenticatedCookies([
      { name: "a1", value: "A" },
      { name: "webId", value: "W" },
      { name: "web_session", value: "S" },
    ]),
    true,
  );
  assert.equal(
    hasXhsAuthenticatedCookies([
      { name: "a1", value: "A" },
      { name: "webId", value: "W" },
    ]),
    false,
  );
});

it("提取并严格校验小红书登录 deeplink", () => {
  const link =
    "xhsdiscover://rn/app-settings/login/scan?qrId=qr-1&ruleId=4&code=code-1&timestamp=1700000000";
  assert.equal(extractXhsLoginLaunchUrl({ data: { url: link } }), link);
  assert.equal(extractXhsLoginLaunchUrl({ response: { data: { url: link } } }), link);
  assert.equal(normalizeXhsLoginLaunchUrl("xhsdiscover://scan"), "");
  assert.equal(
    normalizeXhsLoginLaunchUrl(
      "xhsdiscover://rn:443/app-settings/login/scan?qrId=qr-1&code=code-1&timestamp=1700000000",
    ),
    "",
  );
  assert.equal(extractXhsLoginLaunchUrl({ data: { url: "https://attacker.example/" } }), "");
});
