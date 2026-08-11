import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextFunction, Request, Response } from "express";
import { atomicWriteJson } from "./data-io.js";
import { protectCurrentUserText, unprotectCurrentUserText } from "./windows-dpapi.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PAIRING_FILE = path.resolve(here, "../../../data/companion-pairing.json");
const ENTROPY = "xbloom-ai-brew-studio:companion-pairing:v1";
const TOKEN_HEADER = "x-xbloom-companion-token";

interface StoredPairing {
  version: 1;
  algorithm: "windows-dpapi";
  ciphertext: string;
}

function readOrCreateToken(): string {
  try {
    const stored = JSON.parse(fs.readFileSync(PAIRING_FILE, "utf8")) as StoredPairing;
    if (stored.version === 1 && stored.algorithm === "windows-dpapi" && stored.ciphertext) {
      return unprotectCurrentUserText(stored, ENTROPY);
    }
  } catch {
    // 首次启动或历史文件损坏时创建新的本机配对令牌。
  }
  const token = crypto.randomBytes(32).toString("base64url");
  atomicWriteJson(PAIRING_FILE, { version: 1, ...protectCurrentUserText(token, ENTROPY) });
  return token;
}

let cachedToken: string | null = null;
export function companionToken(): string {
  cachedToken ??= readOrCreateToken();
  return cachedToken;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function loopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

export function trustedWebOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.origin === origin && (url.protocol === "https:" || loopbackOrigin(origin));
  } catch {
    return false;
  }
}

function cors(res: Response, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${TOKEN_HEADER}`);
  // 兼容仍发送 PNA 预检的浏览器；新版 Chrome 会另外弹出 Local Network Access 权限。
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

/**
 * 公网页面访问本机助手的边界：精确回显 HTTPS Origin + 用户配对令牌。
 * 本地工作台同源请求保持原行为；令牌只保存在本机 DPAPI 文件和该网页的 localStorage。
 */
export function companionAccess(req: Request, res: Response, next: NextFunction): void {
  const protectedPath = req.path.startsWith("/api/xhs/") || req.path.startsWith("/api/companion/");
  if (!protectedPath || req.path === "/api/companion/pair") {
    next();
    return;
  }
  const origin = req.get("origin");
  if (!origin || loopbackOrigin(origin)) {
    next();
    return;
  }
  if (!trustedWebOrigin(origin)) {
    res.status(403).json({ ok: false, message: "本地助手只接受 HTTPS 工作台连接" });
    return;
  }
  cors(res, origin);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  const supplied = req.get(TOKEN_HEADER) ?? "";
  if (!constantTimeEqual(supplied, companionToken())) {
    res.status(401).json({ ok: false, message: "本地助手配对已失效，请重新连接" });
    return;
  }
  next();
}

export function pairingPage(targetOrigin: string): string {
  if (!trustedWebOrigin(targetOrigin)) throw new Error("配对目标地址格式有误");
  const targetJson = JSON.stringify(targetOrigin).replace(/</g, "\\u003c");
  const tokenJson = JSON.stringify(companionToken()).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 xBloom 本地助手</title><style>body{margin:0;background:#f5f3ee;color:#201d19;font:14px system-ui}.card{max-width:420px;margin:10vh auto;padding:28px;border:1px solid #ddd7cd;border-radius:18px;background:#fff;box-shadow:0 16px 50px #4b3d2818}h1{font-size:20px;margin:0 0 12px}p{color:#6d665d;line-height:1.7;word-break:break-all}button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;background:#25211c;color:#fff;font-weight:600;cursor:pointer}</style></head><body><main class="card"><h1>连接本地小红书助手</h1><p>目标网站：<strong>${targetOrigin.replace(/[<>&"]/g, "")}</strong></p><p>确认后，该网站可以调用这台电脑上的调研与小红书登录服务；Cookie 仍留在本机。</p><button id="pair">确认连接</button></main><script>document.getElementById('pair').onclick=()=>{if(!window.opener){alert('请从工作台打开此窗口');return}window.opener.postMessage({type:'xbloom-companion-paired',baseUrl:location.origin,token:${tokenJson}},${targetJson});document.querySelector('main').innerHTML='<h1>连接完成</h1><p>可以关闭此窗口，回到工作台继续。</p>';setTimeout(()=>window.close(),900)};</script></body></html>`;
}
