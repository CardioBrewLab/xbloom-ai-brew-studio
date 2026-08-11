import assert from "node:assert/strict";
import { it } from "node:test";
import {
  CLIENT_PASSWORD_ITERATIONS,
  CLIENT_PASSWORD_SCHEME,
  createClientPasswordParams,
  deriveClientPasswordProof,
} from "@xbloom/shared/password-auth";

it("账号密码在客户端完成 PBKDF2，输出固定长度凭据且不含明文", async () => {
  const password = "coffee-passphrase-2026";
  const params = createClientPasswordParams();
  const credential = await deriveClientPasswordProof(password, params);
  assert.equal(credential.scheme, CLIENT_PASSWORD_SCHEME);
  assert.equal(credential.iterations, CLIENT_PASSWORD_ITERATIONS);
  assert.match(credential.salt, /^[A-Za-z0-9_-]{22}$/);
  assert.match(credential.proof, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(credential).includes(password), false);
});
