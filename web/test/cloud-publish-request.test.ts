import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cloudPublishRecipeFingerprint,
  clearCloudPublishRequestCheckpoint,
  clearPersistentCloudPublishRequestId,
  loadCloudPublishRequestCheckpoint,
  markCloudPublishRequestCreated,
  persistentCloudPublishRequestId,
  prepareCloudPublishRequest,
} from "../src/lib/cloud-publish-request.js";
import type { Recipe } from "../src/lib/recipe-schema.js";

const recipe: Recipe = {
  name: "Test Brew",
  cupType: "xdripper",
  doseGrams: 15,
  grinderSize: 60,
  rpm: 80,
  grandWater: 225,
  pours: [
    {
      volume: 225,
      temperature: 93,
      flowRate: 5,
      pattern: "center",
      pausing: 0,
      vibBefore: false,
      vibAfter: false,
    },
  ],
  bypassEnabled: false,
  bypassVolume: 5,
  bypassTemp: 85,
  isSetGrinderSize: 1,
  theColor: "#111111",
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    values,
  };
}

describe("persistent cloud publish request IDs", () => {
  it("reuses the same request ID after a page-style state rebuild", () => {
    const storage = memoryStorage();
    const first = persistentCloudPublishRequestId(recipe, storage);
    const afterReload = persistentCloudPublishRequestId(
      JSON.parse(JSON.stringify(recipe)),
      storage,
    );
    assert.equal(afterReload, first);
    assert.match(first, /^[0-9a-f-]{36}$/i);
    assert.doesNotMatch([...storage.values.values()].join(""), /Test Brew/);
  });

  it("editing executable recipe data rotates the request ID", () => {
    const storage = memoryStorage();
    const first = persistentCloudPublishRequestId(recipe, storage);
    const edited = persistentCloudPublishRequestId({ ...recipe, grinderSize: 61 }, storage);
    assert.notEqual(edited, first);
    assert.notEqual(
      cloudPublishRecipeFingerprint(recipe),
      cloudPublishRecipeFingerprint({ ...recipe, grinderSize: 61 }),
    );
  });

  it("retires a completed request ID so a later identical create is fresh", () => {
    const storage = memoryStorage();
    const first = persistentCloudPublishRequestId(recipe, storage);
    clearPersistentCloudPublishRequestId(recipe, storage);
    const laterCreate = persistentCloudPublishRequestId(recipe, storage);
    assert.notEqual(laterCreate, first);
  });

  it("restores the exact edited draft and name after a response-loss reload", () => {
    const storage = memoryStorage();
    const edited = { ...recipe, grinderSize: 64, theColor: "#AABBCC" };
    const first = prepareCloudPublishRequest(
      recipe,
      edited,
      "Customer Name",
      "cn:member-1",
      "cn",
      storage,
    );
    const restored = loadCloudPublishRequestCheckpoint(recipe, "cn:member-1", storage);
    assert.deepEqual(restored?.recipe, edited);
    assert.equal(restored?.name, "Customer Name");
    assert.equal(restored?.requestId, first.requestId);

    const samePayload = prepareCloudPublishRequest(
      recipe,
      edited,
      "Customer Name",
      "cn:member-1",
      "cn",
      storage,
    );
    assert.equal(samePayload.requestId, first.requestId);

    const editedWhileUncertain = prepareCloudPublishRequest(
      recipe,
      { ...edited, grinderSize: 66 },
      "Changed Too Early",
      "cn:member-1",
      "cn",
      storage,
      undefined,
      first,
    );
    assert.deepEqual(editedWhileUncertain.recipe, edited);
    assert.equal(editedWhileUncertain.name, "Customer Name");
    assert.equal(editedWhileUncertain.requestId, first.requestId);

    const changedPayload = prepareCloudPublishRequest(
      recipe,
      { ...edited, grinderSize: 65 },
      "Customer Name",
      "cn:member-1",
      "cn",
      storage,
    );
    assert.notEqual(changedPayload.requestId, first.requestId);
  });

  it("scopes checkpoints by account and retains the returned table until binding", () => {
    const storage = memoryStorage();
    const checkpoint = prepareCloudPublishRequest(
      recipe,
      recipe,
      undefined,
      "global:member-1",
      "global",
      storage,
    );
    const created = markCloudPublishRequestCreated(checkpoint, "42", "https://share/42", storage);
    assert.equal(
      loadCloudPublishRequestCheckpoint(recipe, "global:member-1", storage)?.tableId,
      "42",
    );
    assert.equal(loadCloudPublishRequestCheckpoint(recipe, "global:member-2", storage), undefined);
    clearCloudPublishRequestCheckpoint(created, storage);
    assert.equal(loadCloudPublishRequestCheckpoint(recipe, "global:member-1", storage), undefined);
  });
});
