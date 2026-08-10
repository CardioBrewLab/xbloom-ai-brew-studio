import assert from "node:assert/strict";
import { it } from "node:test";
import { generationQuotaSubjects } from "../src/session.ts";

const secret = "unit-test-secret-with-at-least-32-characters";

it("Cloudflare 生成配额按 HMAC 网络标识聚合，不保存原始 IP", async () => {
  const request = new Request("https://brew.example/api/generate", {
    headers: { "CF-Connecting-IP": "203.0.113.10" },
  });
  const first = await generationQuotaSubjects(request, secret);
  const second = await generationQuotaSubjects(request, secret);
  assert.deepEqual(first, second);
  assert.equal(first.global, "global");
  assert.match(first.network, /^network:[0-9a-f]{64}$/);
  assert.equal(first.network.includes("203.0.113.10"), false);
});

it("不同网络得到不同配额分组，去掉浏览器 Cookie也不重置网络额度", async () => {
  const left = await generationQuotaSubjects(
    new Request("https://brew.example/api/generate", {
      headers: { "CF-Connecting-IP": "203.0.113.10" },
    }),
    secret,
  );
  const right = await generationQuotaSubjects(
    new Request("https://brew.example/api/generate", {
      headers: { "CF-Connecting-IP": "203.0.113.11" },
    }),
    secret,
  );
  assert.notEqual(left.network, right.network);
});
