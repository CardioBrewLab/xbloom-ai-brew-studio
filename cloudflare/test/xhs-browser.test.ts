import assert from "node:assert/strict";
import { it } from "node:test";
import { claimBrowserBudget, parseCookieHeader, parseXhsSearchFeeds } from "../src/xhs-browser.ts";

function budgetDb(): D1Database {
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
          assert.match(sql, /^INSERT INTO generation_usage/);
          assert.match(sql, /RETURNING request_count/);
          const key = `${values[0]}|${values[1]}`;
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return { request_count: count } as T;
        },
      };
      return statement;
    },
  } as unknown as D1Database;
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
  const env = { DB: budgetDb(), XHS_BROWSER_QR_DAILY_LIMIT: "4" };
  assert.equal(await claimBrowserBudget(env, "owner-a", "qr"), true);
  assert.equal(await claimBrowserBudget(env, "owner-a", "qr"), true);
  assert.equal(await claimBrowserBudget(env, "owner-a", "qr"), true);
  assert.equal(await claimBrowserBudget(env, "owner-a", "qr"), false);
  assert.equal(await claimBrowserBudget(env, "owner-b", "qr"), true);
  assert.equal(await claimBrowserBudget(env, "owner-c", "qr"), false);
});
