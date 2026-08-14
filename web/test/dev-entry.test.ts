import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("development service-worker cleanup uses an external module entry", () => {
  const html = readFileSync(path.join(WEB_ROOT, "index.html"), "utf8");
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const moduleScripts = scriptTags.filter((match) =>
    /(?:^|\s)type\s*=\s*(?:["']module["']|module)(?=\s|$)/i.test(match[1]),
  );
  const inlineModuleScripts = moduleScripts.filter((match) => !/(?:^|\s)src\s*=/.test(match[1]));

  assert.equal(
    inlineModuleScripts.length,
    0,
    "inline module scripts create Vite html-proxy entries that can become stale",
  );
  assert.ok(
    moduleScripts.some((match) =>
      /(?:^|\s)src\s*=\s*(?:["']\/src\/dev-sw-cleanup\.ts["']|\/src\/dev-sw-cleanup\.ts)(?=\s|$)/i.test(
        match[1],
      ),
    ),
    "the cleanup module must remain an explicit HTML entry",
  );

  const cleanupSource = readFileSync(path.join(WEB_ROOT, "src", "dev-sw-cleanup.ts"), "utf8");
  assert.match(cleanupSource, /import\.meta\.env\.DEV/);
  assert.match(cleanupSource, /registration\.unregister\(\)/);
});
