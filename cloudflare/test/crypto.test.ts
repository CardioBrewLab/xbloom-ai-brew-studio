import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createClientPasswordParams,
  deriveClientPasswordProof,
} from "../../shared/src/password-auth.ts";
import {
  decryptText,
  encryptText,
  fakePasswordSalt,
  hashPasswordProof,
  randomToken,
  sha256,
  verifyPasswordProof,
} from "../src/crypto.ts";

const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const passwordPepper = "password-pepper-0123456789abcdef0123456789abcdef";

it("浏览器 PBKDF2 凭据使用随机盐，Worker 只保存加 pepper 的校验值", async () => {
  const leftProof = await deriveClientPasswordProof(
    "correct horse battery staple",
    createClientPasswordParams(),
  );
  const rightProof = await deriveClientPasswordProof(
    "correct horse battery staple",
    createClientPasswordParams(),
  );
  const left = await hashPasswordProof("coffee_user", leftProof, passwordPepper);
  const right = await hashPasswordProof("coffee_user", rightProof, passwordPepper);
  assert.notEqual(left.salt, right.salt);
  assert.notEqual(left.hash, right.hash);
  assert.equal(
    await verifyPasswordProof("coffee_user", leftProof.proof, left, passwordPepper),
    true,
  );
  assert.equal(
    await verifyPasswordProof("coffee_user", rightProof.proof, left, passwordPepper),
    false,
  );
  assert.equal(
    await fakePasswordSalt("missing_user", passwordPepper),
    await fakePasswordSalt("missing_user", passwordPepper),
  );
});

it("AES-GCM 信封随机化并拒绝篡改", async () => {
  const first = await encryptText("TOKEN", encryptionKey);
  const second = await encryptText("TOKEN", encryptionKey);
  assert.notEqual(first, second);
  assert.equal(await decryptText(first, encryptionKey), "TOKEN");
  await assert.rejects(() => decryptText(`${first}x`, encryptionKey), /校验/);
});

it("随机会话令牌与 SHA-256 标识不暴露原文", async () => {
  const token = randomToken();
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  const digest = await sha256(token);
  assert.notEqual(digest, token);
  assert.equal(digest.includes(token), false);
});
