import {
  CLIENT_PASSWORD_ITERATIONS,
  CLIENT_PASSWORD_SCHEME,
  validateClientPasswordParams,
  type ClientPasswordProof,
} from "../../shared/src/password-auth.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

export async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return bytesToBase64Url(digest);
}

export interface PasswordDigest {
  hash: string;
  salt: string;
  iterations: number;
  scheme: string;
}

function passwordProofBytes(value: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToBytes(value);
  } catch {
    throw new Error("账号密码凭据格式有误");
  }
  if (bytes.byteLength !== 32) throw new Error("账号密码凭据格式有误");
  return bytes;
}

async function passwordPepperKey(pepper: string): Promise<CryptoKey> {
  if (pepper.length < 32) throw new Error("APP_PASSWORD_PEPPER 至少需要 32 个字符");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function pepperedProofHash(
  loginName: string,
  proof: string,
  pepper: string,
): Promise<Uint8Array> {
  passwordProofBytes(proof);
  const payload = encoder.encode(`${CLIENT_PASSWORD_SCHEME}\u0000${loginName}\u0000${proof}`);
  return new Uint8Array(await crypto.subtle.sign("HMAC", await passwordPepperKey(pepper), payload));
}

export async function hashPasswordProof(
  loginName: string,
  client: ClientPasswordProof,
  pepper: string,
): Promise<PasswordDigest> {
  validateClientPasswordParams(client);
  return {
    hash: bytesToBase64Url(await pepperedProofHash(loginName, client.proof, pepper)),
    salt: client.salt,
    iterations: client.iterations,
    scheme: client.scheme,
  };
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verifyPasswordProof(
  loginName: string,
  proof: string,
  digest: PasswordDigest,
  pepper: string,
): Promise<boolean> {
  if (digest.scheme !== CLIENT_PASSWORD_SCHEME || digest.iterations !== CLIENT_PASSWORD_ITERATIONS)
    return false;
  try {
    const expected = base64UrlToBytes(digest.hash);
    const actual = await pepperedProofHash(loginName, proof, pepper);
    return constantTimeBytesEqual(expected, actual);
  } catch {
    return false;
  }
}

export async function fakePasswordSalt(loginName: string, pepper: string): Promise<string> {
  const payload = encoder.encode(`fake-password-salt\u0000${loginName}`);
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", await passwordPepperKey(pepper), payload),
  );
  return bytesToBase64Url(digest.slice(0, 16));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const trimmed = secret.trim();
  let raw: Uint8Array;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    raw = Uint8Array.from(trimmed.match(/.{2}/g)!, (pair) => Number.parseInt(pair, 16));
  } else {
    try {
      raw = base64UrlToBytes(trimmed);
    } catch {
      throw new Error("APP_DATA_ENCRYPTION_KEY 格式有误");
    }
  }
  if (raw.byteLength !== 32) throw new Error("APP_DATA_ENCRYPTION_KEY 需要 32 字节随机值");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** v1.<iv>.<ciphertext+tag>；D1 只保存此密文信封。 */
export async function encryptText(value: string, secret: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await encryptionKey(secret),
      encoder.encode(value),
    ),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(encrypted)}`;
}

export async function decryptText(envelope: string, secret: string): Promise<string> {
  const [version, ivValue, encryptedValue] = envelope.split(".");
  if (version !== "v1" || !ivValue || !encryptedValue) throw new Error("加密配置格式有误");
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(ivValue) },
      await encryptionKey(secret),
      base64UrlToBytes(encryptedValue),
    );
    return decoder.decode(decrypted);
  } catch {
    throw new Error("加密配置校验未通过");
  }
}
