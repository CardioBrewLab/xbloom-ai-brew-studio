import { createAbortScope } from "./abort.js";

const STORAGE_KEY = "xbloom-companion-v3";
const LEGACY_STORAGE_KEYS = ["xbloom-companion-v2", "xbloom-companion-v1"] as const;

export interface CompanionConfig {
  baseUrl: string;
  token: string;
  expiresAt: number;
}

export interface CompanionResearch {
  ok: boolean;
  sources: Array<{ title: string; url: string; snippet?: string }>;
  summaryText: string;
  message: string;
  filtered: number;
  distilled: boolean;
  xhsLoginExpired?: boolean;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function isHostedHostname(hostname: string): boolean {
  return !LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

export function hostedPage(): boolean {
  return isHostedHostname(location.hostname);
}

export function backendConnectionErrorMessage(hostname: string): string {
  return isHostedHostname(hostname)
    ? "云端服务暂时未连通，请稍后重试"
    : "无法连接后端服务，请确认 server 已启动（npm run dev）";
}

export function companionConfig(
  storage: Pick<Storage, "getItem" | "removeItem"> = localStorage,
  now = Date.now(),
): CompanionConfig | null {
  // v3 服务端只接受摘要型配对记录；清掉历史令牌，让升级后的页面直接展示重新连接入口。
  for (const key of LEGACY_STORAGE_KEYS) storage.removeItem(key);
  try {
    return parseCompanionConfig(storage.getItem(STORAGE_KEY), now);
  } catch {
    // 损坏配置按未配对处理。
  }
  return null;
}

export function parseCompanionConfig(raw: string | null, now: number): CompanionConfig | null {
  try {
    const parsed = JSON.parse(raw ?? "null") as CompanionConfig | null;
    return parsed &&
      /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(parsed.baseUrl) &&
      /^[A-Za-z0-9_-]{40,}$/.test(parsed.token) &&
      Number.isFinite(parsed.expiresAt) &&
      parsed.expiresAt > now
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function clearCompanion(storage: Pick<Storage, "removeItem"> = localStorage): void {
  storage.removeItem(STORAGE_KEY);
  for (const key of LEGACY_STORAGE_KEYS) storage.removeItem(key);
}

export async function pairCompanion(): Promise<CompanionConfig> {
  const baseUrl = "http://127.0.0.1:8787";
  const popup = window.open(
    `${baseUrl}/api/companion/pair?origin=${encodeURIComponent(location.origin)}`,
    "xbloom-companion-pair",
    "popup,width=520,height=520",
  );
  if (!popup) throw new Error("浏览器拦截了配对窗口，请允许弹窗后再试");
  return new Promise<CompanionConfig>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("本地助手配对等待超时，请确认本机版正在运行"));
    }, 90_000);
    const poll = window.setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new Error("配对窗口已关闭"));
      }
    }, 700);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== baseUrl || event.source !== popup) return;
      const data = event.data as Partial<CompanionConfig> & { type?: string };
      if (
        data.type !== "xbloom-companion-paired" ||
        data.baseUrl !== baseUrl ||
        typeof data.token !== "string" ||
        typeof data.expiresAt !== "number" ||
        data.expiresAt <= Date.now()
      ) {
        return;
      }
      const config = { baseUrl, token: data.token, expiresAt: data.expiresAt };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
      cleanup();
      resolve(config);
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.clearInterval(poll);
      window.removeEventListener("message", onMessage);
    };
    window.addEventListener("message", onMessage);
  });
}

export async function companionFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const config = companionConfig();
  if (!config) throw new Error("请先连接这台电脑上的本地助手");
  const target = `${config.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  // targetAddressSpace 告知新版 Chrome 这是用户明确发起的本地网络请求；旧版浏览器会忽略该字段。
  return fetch(target, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-xbloom-companion-token": config.token,
      ...(init.headers ?? {}),
    },
    targetAddressSpace: "local",
  } as RequestInit & { targetAddressSpace: "local" });
}

export async function companionResearch(
  input: Record<string, unknown>,
): Promise<CompanionResearch> {
  const abortScope = createAbortScope([], 50_000);
  let response: Response;
  try {
    response = await companionFetch("/api/companion/research", {
      method: "POST",
      body: JSON.stringify(input),
      signal: abortScope.signal,
    });
  } finally {
    abortScope.cleanup();
  }
  const body = (await response.json()) as {
    ok?: boolean;
    research?: CompanionResearch;
    message?: string;
  };
  if (!response.ok || !body.ok || !body.research) {
    if (response.status === 401) clearCompanion();
    throw new Error(body.message ?? `本地助手请求失败（HTTP ${response.status}）`);
  }
  return body.research;
}
