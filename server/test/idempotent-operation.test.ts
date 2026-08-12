import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { IdempotentOperationRegistry } from "../src/lib/idempotent-operation.js";

describe("IdempotentOperationRegistry", () => {
  test("coalesces concurrent and completed retries", async () => {
    const registry = new IdempotentOperationRegistry<number>();
    let calls = 0;
    const operation = async () => ++calls;
    const first = registry.run("account", "request", { recipe: 1 }, operation);
    const retry = registry.run("account", "request", { recipe: 1 }, operation);
    assert.equal(first, retry);
    assert.deepEqual(await Promise.all([first, retry]), [1, 1]);
    assert.equal(await registry.run("account", "request", { recipe: 1 }, operation), 1);
    assert.equal(calls, 1);
  });

  test("rejects request-id reuse with a different payload", async () => {
    const registry = new IdempotentOperationRegistry<number>();
    await registry.run("account", "request", { recipe: 1 }, async () => 1);
    await assert.rejects(
      registry.run("account", "request", { recipe: 2 }, async () => 2),
      /不同配方/,
    );
  });

  test("releases failed operations for a later retry", async () => {
    const registry = new IdempotentOperationRegistry<number>();
    await assert.rejects(
      registry.run("account", "request", { recipe: 1 }, async () => {
        throw new Error("transient");
      }),
      /transient/,
    );
    assert.equal(await registry.run("account", "request", { recipe: 1 }, async () => 7), 7);
  });

  test("restores completed writes after a service restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xbloom-idempotency-"));
    const persistenceFile = path.join(directory, "operations.json");
    try {
      const firstProcess = new IdempotentOperationRegistry<number>(50_000, persistenceFile);
      assert.equal(await firstProcess.run("account", "request", { recipe: 1 }, async () => 17), 17);

      let repeatedCalls = 0;
      const restartedProcess = new IdempotentOperationRegistry<number>(50_000, persistenceFile);
      assert.equal(
        await restartedProcess.run("account", "request", { recipe: 1 }, async () => {
          repeatedCalls += 1;
          return 99;
        }),
        17,
      );
      assert.equal(repeatedCalls, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("persists an uncertain create checkpoint and recovers it after restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "xbloom-idempotency-pending-"));
    const persistenceFile = path.join(directory, "operations.json");
    try {
      const firstProcess = new IdempotentOperationRegistry<number>(50_000, persistenceFile);
      let createCalls = 0;
      await assert.rejects(
        firstProcess.runRecoverable(
          "account",
          "request",
          { recipe: 1 },
          {
            prepare: async () => [10, 11],
            execute: async () => {
              createCalls += 1;
              throw new Error("response lost and list unavailable");
            },
            recover: async () => null,
          },
        ),
        /response lost/,
      );

      const restartedProcess = new IdempotentOperationRegistry<number>(50_000, persistenceFile);
      const recovered = await restartedProcess.runRecoverable(
        "account",
        "request",
        { recipe: 1 },
        {
          prepare: async () => {
            throw new Error("a recovered write must not capture a new baseline");
          },
          execute: async () => {
            createCalls += 1;
            return 99;
          },
          recover: async (beforeIds) => {
            assert.deepEqual(beforeIds, [10, 11]);
            return 42;
          },
        },
      );
      assert.equal(recovered, 42);
      assert.equal(createCalls, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("default capacity keeps more than the former 256 completed writes", async () => {
    const registry = new IdempotentOperationRegistry<number>();
    for (let index = 0; index < 300; index += 1) {
      await registry.run("account", `request-${index}`, { index }, async () => index);
    }
    let repeatedCalls = 0;
    assert.equal(
      await registry.run("account", "request-0", { index: 0 }, async () => {
        repeatedCalls += 1;
        return 999;
      }),
      0,
    );
    assert.equal(repeatedCalls, 0);
  });
});
