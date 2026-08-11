import assert from "node:assert/strict";
import test from "node:test";
import { createSseResponse } from "../src/sse.ts";

test("SSE response flushes the first event before producer completion", async () => {
  const response = createSseResponse(async (send) => {
    send({ type: "candidates", stage: "start", n: 3 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    send({ type: "done" });
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(decoder.decode(first.value), /"stage":"start"/);
  const rest = await reader.read();
  assert.match(decoder.decode(rest.value), /"type":"done"/);
  await reader.cancel();
});

test("cancelling the response aborts the producer signal", async () => {
  let observedAbort = false;
  const response = createSseResponse(async (send, signal) => {
    send({ type: "start" });
    await new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          observedAbort = true;
          resolve();
        },
        { once: true },
      );
    });
  });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel("test complete");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(observedAbort, true);
});
