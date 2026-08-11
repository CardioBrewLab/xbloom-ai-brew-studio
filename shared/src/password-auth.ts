const encoder = new TextEncoder();

export const CLIENT_PASSWORD_SCHEME = "client-pbkdf2-hmac-pepper-v2";
export const CLIENT_PASSWORD_ITERATIONS = 600_000;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export interface ClientPasswordParams {
  scheme: typeof CLIENT_PASSWORD_SCHEME;
  salt: string;
  iterations: number;
}

export interface ClientPasswordProof extends ClientPasswordParams {
  proof: string;
}

export function createClientPasswordParams(): ClientPasswordParams {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return {
    scheme: CLIENT_PASSWORD_SCHEME,
    salt: bytesToBase64Url(salt),
    iterations: CLIENT_PASSWORD_ITERATIONS,
  };
}

export function validateClientPasswordParams(value: ClientPasswordParams): void {
  if (value.scheme !== CLIENT_PASSWORD_SCHEME) throw new Error("账号密码协议版本有误");
  if (value.iterations !== CLIENT_PASSWORD_ITERATIONS) throw new Error("账号密码计算参数有误");
  let salt: Uint8Array;
  try {
    salt = base64UrlToBytes(value.salt);
  } catch {
    throw new Error("账号密码盐值格式有误");
  }
  if (salt.byteLength !== 16) throw new Error("账号密码盐值格式有误");
}

/**
 * The intentionally expensive PBKDF2 step runs in the user's browser. The
 * Worker stores only a separately peppered verifier, keeping Free-plan CPU
 * below its 10 ms request budget without sending the plaintext password.
 */
export async function deriveClientPasswordProof(
  password: string,
  params: ClientPasswordParams,
): Promise<ClientPasswordProof> {
  if (password.length < 10 || password.length > 128) throw new Error("密码需要 10-128 个字符");
  validateClientPasswordParams(params);
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64UrlToBytes(params.salt) as BufferSource,
      iterations: params.iterations,
    },
    key,
    256,
  );
  return { ...params, proof: bytesToBase64Url(new Uint8Array(bits)) };
}
