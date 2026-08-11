import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextFunction, Request, Response } from "express";
import { atomicWriteJson } from "./data-io.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PAIRING_FILE = path.resolve(here, "../../../data/companion-pairing.json");
const TOKEN_HEADER = "x-xbloom-companion-token";
const MAX_PAIRED_ORIGINS = 32;
export const COMPANION_PAIRING_TTL_MS = 90 * 24 * 60 * 60 * 1000;

interface StoredOriginPairing {
  origin: string;
  issuedAt: number;
  expiresAt: number;
  tokenHash: string;
}

interface StoredPairingFile {
  version: 3;
  pairings: StoredOriginPairing[];
}

export interface CompanionAccessOptions {
  pairingFile?: string;
  now?: () => number;
}

export interface IssuedCompanionPairing {
  token: string;
  expiresAt: number;
}

function readPairings(file: string): StoredOriginPairing[] {
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredPairingFile>;
    if (stored.version !== 3 || !Array.isArray(stored.pairings)) return [];
    return stored.pairings.filter(
      (entry): entry is StoredOriginPairing =>
        Boolean(entry) &&
        trustedWebOrigin(entry.origin) &&
        Number.isFinite(entry.issuedAt) &&
        Number.isFinite(entry.expiresAt) &&
        entry.expiresAt > entry.issuedAt &&
        typeof entry.tokenHash === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(entry.tokenHash),
    );
  } catch {
    // 首次启动、旧版全局令牌或历史文件损坏都按尚未配对处理。
    return [];
  }
}

function writePairings(file: string, pairings: StoredOriginPairing[]): void {
  atomicWriteJson(file, { version: 3, pairings: pairings.slice(-MAX_PAIRED_ORIGINS) });
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenDigest(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("base64url");
}

export function loopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/** 仅接受浏览器可用的明文 HTTP 回环 Origin；协议与完整 Origin 都需精确匹配。 */
export function localWorkbenchOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.origin === origin && url.protocol === "http:" && loopbackOrigin(origin);
  } catch {
    return false;
  }
}

export function trustedWebOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.origin === origin && url.protocol === "https:") || localWorkbenchOrigin(origin);
  } catch {
    return false;
  }
}

export function issueCompanionPairing(
  origin: string,
  file = PAIRING_FILE,
  now = Date.now(),
): IssuedCompanionPairing {
  if (!trustedWebOrigin(origin)) throw new Error("配对目标地址格式有误");
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = now + COMPANION_PAIRING_TTL_MS;
  const pairings = readPairings(file).filter(
    (entry) => entry.origin !== origin && entry.expiresAt > now,
  );
  pairings.push({
    origin,
    issuedAt: now,
    expiresAt,
    tokenHash: tokenDigest(token),
  });
  writePairings(file, pairings);
  return { token, expiresAt };
}

export function validateCompanionPairing(
  origin: string,
  supplied: string,
  file = PAIRING_FILE,
  now = Date.now(),
): boolean {
  if (!trustedWebOrigin(origin) || !supplied) return false;
  const pairing = readPairings(file).find(
    (entry) => entry.origin === origin && entry.issuedAt <= now && entry.expiresAt > now,
  );
  if (!pairing) return false;
  return constantTimeEqual(tokenDigest(supplied), pairing.tokenHash);
}

export function revokeCompanionPairing(origin: string, file = PAIRING_FILE): void {
  if (!trustedWebOrigin(origin)) return;
  writePairings(
    file,
    readPairings(file).filter((entry) => entry.origin !== origin),
  );
}

function cors(res: Response, origin: string): void {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${TOKEN_HEADER}`);
  // 兼容仍发送 PNA 预检的浏览器；新版 Chrome 会另外弹出 Local Network Access 权限。
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

/**
 * 公网页面访问本机助手的边界：精确回显 HTTPS Origin + 与该 Origin 绑定的限期令牌。
 * 本地工作台同源请求保持原行为；本机文件只保存不可逆摘要，原令牌留在配对网页的 localStorage。
 */
export function createCompanionAccess(
  options: CompanionAccessOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const pairingFile = options.pairingFile ?? PAIRING_FILE;
  const now = options.now ?? Date.now;
  return (req, res, next) => {
    const protectedPath =
      req.path.startsWith("/api/xhs/") || req.path.startsWith("/api/companion/");
    if (!protectedPath || (req.path === "/api/companion/pair" && req.method === "GET")) {
      next();
      return;
    }
    const origin = req.get("origin");
    if (!origin || localWorkbenchOrigin(origin)) {
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
    if (!validateCompanionPairing(origin, supplied, pairingFile, now())) {
      res.status(401).json({ ok: false, message: "本地助手配对已失效，请重新连接" });
      return;
    }
    next();
  };
}

export const companionAccess = createCompanionAccess();

export function pairingPage(targetOrigin: string): string {
  if (!trustedWebOrigin(targetOrigin)) throw new Error("配对目标地址格式有误");
  const targetJson = JSON.stringify(targetOrigin).replace(/</g, "\\u003c");
  const targetHtml = targetOrigin.replace(/[<>&"]/g, "");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 xBloom 本地助手</title><style>body{margin:0;background:#f5f3ee;color:#201d19;font:14px system-ui}.card{max-width:420px;margin:10vh auto;padding:28px;border:1px solid #ddd7cd;border-radius:18px;background:#fff;box-shadow:0 16px 50px #4b3d2818}h1{font-size:20px;margin:0 0 12px}p{color:#6d665d;line-height:1.7;word-break:break-all}button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;background:#25211c;color:#fff;font-weight:600;cursor:pointer}button:disabled{opacity:.55;cursor:wait}</style></head><body><main class="card"><h1>连接本地小红书助手</h1><p>目标网站：<strong>${targetHtml}</strong></p><p>确认后，该网站可以调用这台电脑上的调研与小红书登录服务；Cookie 仍留在本机。本次配对仅对这个网站有效。</p><button id="pair">确认连接</button></main><script>const target=${targetJson};document.getElementById('pair').onclick=async(event)=>{const button=event.currentTarget;button.disabled=true;button.textContent='正在连接…';try{if(!window.opener)throw new Error('请从工作台打开此窗口');const response=await fetch('/api/companion/pair',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin:target})});const body=await response.json();if(!response.ok||!body.token)throw new Error(body.message||'连接未完成');window.opener.postMessage({type:'xbloom-companion-paired',baseUrl:location.origin,token:body.token,expiresAt:body.expiresAt},target);document.querySelector('main').innerHTML='<h1>连接完成</h1><p>可以关闭此窗口，回到工作台继续。</p>';setTimeout(()=>window.close(),900)}catch(error){alert(error.message||'连接未完成');button.disabled=false;button.textContent='确认连接'}};</script></body></html>`;
}
