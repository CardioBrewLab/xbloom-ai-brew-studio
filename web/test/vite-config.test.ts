import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveApiProxyTarget } from "../vite.config";

describe("Vite API proxy target", () => {
  test("uses the default backend when no override is supplied", () => {
    assert.equal(resolveApiProxyTarget(undefined), "http://127.0.0.1:8787");
    assert.equal(resolveApiProxyTarget(""), "http://127.0.0.1:8787");
  });

  test("normalizes a configured HTTP(S) target", () => {
    assert.equal(resolveApiProxyTarget("http://127.0.0.1:18787/"), "http://127.0.0.1:18787");
    assert.equal(
      resolveApiProxyTarget("https://backend.example.test/"),
      "https://backend.example.test",
    );
  });

  test("rejects unsafe or malformed targets before Vite starts", () => {
    for (const value of [
      "not-a-url",
      "ftp://127.0.0.1:8787",
      "https://user:pass@backend.example/",
      "https://backend.example.test/api/",
      "http://127.0.0.1:8787/api?token=secret",
      "http://127.0.0.1:0",
    ]) {
      assert.throws(() => resolveApiProxyTarget(value), /VITE_API_PROXY_TARGET/);
    }
  });
});
