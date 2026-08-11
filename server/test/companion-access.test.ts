import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import {
  COMPANION_PAIRING_TTL_MS,
  createCompanionAccess,
  localWorkbenchOrigin,
  loopbackOrigin,
  trustedWebOrigin,
} from "../src/lib/companion-access.js";
import { createCompanionRouter } from "../src/routes/companion.js";
import { shutdownHttpServer } from "./helpers/http-server.js";

describe("公网页面与本地助手的 Origin 边界", () => {
  it("接受 HTTPS 站点与明确回环地址", () => {
    assert.equal(trustedWebOrigin("https://brew.example"), true);
    assert.equal(trustedWebOrigin("http://127.0.0.1:5180"), true);
    assert.equal(trustedWebOrigin("http://localhost:5180"), true);
    assert.equal(loopbackOrigin("http://[::1]:8787"), true);
    assert.equal(localWorkbenchOrigin("http://[::1]:8787"), true);
  });

  it("拒绝公网明文、带路径和 URL 解析混淆", () => {
    assert.equal(trustedWebOrigin("http://brew.example"), false);
    assert.equal(trustedWebOrigin("ftp://localhost"), false);
    assert.equal(localWorkbenchOrigin("ftp://localhost"), false);
    assert.equal(trustedWebOrigin("https://brew.example/path"), false);
    assert.equal(trustedWebOrigin("https://brew.example@attacker.test/path"), false);
    assert.equal(trustedWebOrigin("not-a-url"), false);
  });
});

describe("本地助手配对安全链路", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xbloom-companion-test-"));
  const pairingFile = path.join(tempDir, "pairing.json");
  const targetOrigin = "https://brew-a.example";
  const otherOrigin = "https://brew-b.example";
  let now = Date.UTC(2026, 7, 12);
  let server: http.Server;
  let baseUrl = "";

  before(async () => {
    const options = { pairingFile, now: () => now };
    const app = express();
    app.use(express.json());
    app.use(createCompanionAccess(options));
    app.use("/api/companion", createCompanionRouter(options));
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await shutdownHttpServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function pair(origin: string): Promise<{ token: string; expiresAt: number }> {
    const response = await fetch(`${baseUrl}/api/companion/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ origin }),
    });
    assert.equal(response.status, 200);
    return (await response.json()) as { token: string; expiresAt: number };
  }

  async function status(origin: string, token?: string): Promise<Response> {
    return fetch(`${baseUrl}/api/companion/status`, {
      headers: {
        origin,
        ...(token ? { "x-xbloom-companion-token": token } : {}),
      },
    });
  }

  it("配对页不内嵌令牌，并把消息固定发送给目标 Origin", async () => {
    const response = await fetch(
      `${baseUrl}/api/companion/pair?origin=${encodeURIComponent(targetOrigin)}`,
    );
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.ok(html.includes(`const target=${JSON.stringify(targetOrigin)}`));
    assert.match(html, /postMessage\([\s\S]*,target\)/);
    assert.doesNotMatch(html, /token:\s*["'][A-Za-z0-9_-]{40,}["']/);
  });

  it("令牌绑定单一 Origin，预检精确回显且本机同源保持兼容", async () => {
    const pairing = await pair(targetOrigin);
    assert.equal(pairing.expiresAt, now + COMPANION_PAIRING_TTL_MS);
    const storedPairing = fs.readFileSync(pairingFile, "utf8");
    assert.equal(storedPairing.includes(pairing.token), false, "磁盘文件不得保存原始令牌");
    assert.match(storedPairing, /"tokenHash"/);
    assert.doesNotMatch(storedPairing, /ciphertext/);

    const preflight = await fetch(`${baseUrl}/api/companion/status`, {
      method: "OPTIONS",
      headers: {
        origin: targetOrigin,
        "access-control-request-method": "GET",
        "access-control-request-private-network": "true",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), targetOrigin);
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");

    assert.equal((await status(targetOrigin, pairing.token)).status, 200);
    assert.equal((await status(otherOrigin, pairing.token)).status, 401, "跨 Origin 重放被拒绝");
    assert.equal((await status("ftp://localhost")).status, 403, "非 HTTP(S) 回环 Origin 被拒绝");
    assert.equal((await fetch(`${baseUrl}/api/companion/status`)).status, 200, "本机调用无需配对");
  });

  it("重新配对会撤销旧令牌，显式撤销与到期后都要求重新连接", async () => {
    const first = await pair(targetOrigin);
    const second = await pair(targetOrigin);
    assert.notEqual(first.token, second.token);
    assert.equal((await status(targetOrigin, first.token)).status, 401);
    assert.equal((await status(targetOrigin, second.token)).status, 200);

    const revoked = await fetch(`${baseUrl}/api/companion/pair`, {
      method: "DELETE",
      headers: { origin: targetOrigin, "x-xbloom-companion-token": second.token },
    });
    assert.equal(revoked.status, 200);
    assert.equal((await status(targetOrigin, second.token)).status, 401);

    const expiring = await pair(targetOrigin);
    now = expiring.expiresAt;
    assert.equal((await status(targetOrigin, expiring.token)).status, 401);
  });
});
