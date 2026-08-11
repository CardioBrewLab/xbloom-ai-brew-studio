import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { it } from "node:test";
import { rsaPkcs1EncryptChunk } from "../src/rsa-pkcs1.ts";

function base64UrlBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64url"));
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

it("纯 WebCrypto 环境用的 PKCS#1 v1.5 公钥加密可被标准 RSA 私钥解密", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const jwk = publicKey.export({ format: "jwk" });
  assert.ok(jwk.n && jwk.e);
  const modulusBytes = base64UrlBytes(jwk.n);
  const plaintext = new TextEncoder().encode("xbloom-payload");
  const ciphertext = rsaPkcs1EncryptChunk(
    plaintext,
    bytesToBigInt(modulusBytes),
    bytesToBigInt(base64UrlBytes(jwk.e)),
    modulusBytes.length,
  );
  const decrypted = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(ciphertext),
  );
  assert.equal(Buffer.from(decrypted).toString("utf8"), "xbloom-payload");
});
