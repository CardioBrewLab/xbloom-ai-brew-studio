const encoder = new TextEncoder();
const COOKIE = "xbloom_hosted_id";

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function generationQuotaSubjects(
  request: Request,
  secret: string,
): Promise<{ network: string; global: string }> {
  if (secret.length < 32) throw new Error("APP_SESSION_SECRET 至少需要 32 个字符");
  // CF-Connecting-IP 由 Cloudflare 边缘写入；只保存带 HMAC 的不可逆分组值，不落原始 IP。
  const connectingIp = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
  return {
    network: `network:${await sign(`network:${connectingIp}`, secret)}`,
    global: "global",
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

export async function browserOwner(
  request: Request,
  secret: string,
): Promise<{ owner: string; cookie?: string }> {
  if (secret.length < 32) throw new Error("APP_SESSION_SECRET 至少需要 32 个字符");
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (raw) {
    const [owner, signature] = raw.split(".", 2);
    if (
      /^[0-9a-f-]{36}$/i.test(owner) &&
      signature &&
      constantTimeEqual(signature, await sign(owner, secret))
    )
      return { owner };
  }
  const owner = crypto.randomUUID();
  const value = `${owner}.${await sign(owner, secret)}`;
  return {
    owner,
    cookie: `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
  };
}

export function sameOriginMutation(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
