import type { Recipe } from "./recipe-schema.js";
import type { CloudRegion } from "./api.js";
import { createRequestId } from "./request-id.js";

const STORAGE_KEY = "xbloom.cloud-publish-requests.v1";
const CHECKPOINT_STORAGE_KEY = "xbloom.cloud-publish-checkpoints.v1";
const MAX_ENTRIES = 32;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StoredPublishRequest {
  fingerprint: string;
  requestId: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CloudPublishRequestCheckpoint {
  sourceFingerprint: string;
  payloadFingerprint: string;
  requestId: string;
  accountKey: string;
  region: CloudRegion;
  recipe: Recipe;
  name?: string;
  tableId?: string;
  shareUrl?: string;
}

/** Deterministic non-cryptographic key; only the hash, never recipe text, is persisted. */
export function cloudPublishRecipeFingerprint(recipe: Recipe): string {
  const value = JSON.stringify(recipe);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

/** Same recipe keeps the same write ID across modal closes and page reloads. */
export function persistentCloudPublishRequestId(recipe: Recipe, storage: StorageLike): string {
  const fingerprint = cloudPublishRecipeFingerprint(recipe);
  let entries: StoredPublishRequest[] = [];
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      entries = parsed.filter(
        (entry): entry is StoredPublishRequest =>
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof (entry as StoredPublishRequest).fingerprint === "string" &&
          REQUEST_ID_PATTERN.test((entry as StoredPublishRequest).requestId),
      );
    }
  } catch {
    entries = [];
  }
  const existing = entries.find((entry) => entry.fingerprint === fingerprint);
  if (existing) return existing.requestId;

  const requestId = createRequestId();
  try {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ fingerprint, requestId }, ...entries].slice(0, MAX_ENTRIES)),
    );
  } catch {
    // Private browsing/storage quotas still keep the current in-memory request ID.
  }
  return requestId;
}

/** Retire the request ID once its cloud row has been verified and locally bound. */
export function clearPersistentCloudPublishRequestId(recipe: Recipe, storage: StorageLike): void {
  const fingerprint = cloudPublishRecipeFingerprint(recipe);
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    const entries = Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is StoredPublishRequest =>
            Boolean(entry) &&
            typeof entry === "object" &&
            typeof (entry as StoredPublishRequest).fingerprint === "string" &&
            REQUEST_ID_PATTERN.test((entry as StoredPublishRequest).requestId),
        )
      : [];
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify(entries.filter((entry) => entry.fingerprint !== fingerprint)),
    );
  } catch {
    // A fresh in-memory ID remains available if storage access is interrupted.
  }
}

function checkpointFingerprint(recipe: Recipe, name: string | undefined): string {
  return cloudPublishRecipeFingerprint({ ...recipe, name: name ?? recipe.name });
}

function readCheckpoints(storage: StorageLike): CloudPublishRequestCheckpoint[] {
  try {
    const parsed = JSON.parse(storage.getItem(CHECKPOINT_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is CloudPublishRequestCheckpoint => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as CloudPublishRequestCheckpoint;
      return (
        typeof item.sourceFingerprint === "string" &&
        typeof item.payloadFingerprint === "string" &&
        REQUEST_ID_PATTERN.test(item.requestId) &&
        typeof item.accountKey === "string" &&
        (item.region === "cn" || item.region === "global") &&
        Boolean(item.recipe) &&
        typeof item.recipe === "object" &&
        Array.isArray(item.recipe.pours)
      );
    });
  } catch {
    return [];
  }
}

function writeCheckpoints(storage: StorageLike, entries: CloudPublishRequestCheckpoint[]): void {
  try {
    storage.setItem(CHECKPOINT_STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // The caller still retains the checkpoint in component state for this page session.
  }
}

/** Restore the exact edited payload used by an unresolved create, scoped to one App account. */
export function loadCloudPublishRequestCheckpoint(
  sourceRecipe: Recipe,
  accountKey: string,
  storage: StorageLike,
): CloudPublishRequestCheckpoint | undefined {
  if (!accountKey) return undefined;
  const sourceFingerprint = cloudPublishRecipeFingerprint(sourceRecipe);
  return readCheckpoints(storage).find(
    (entry) => entry.sourceFingerprint === sourceFingerprint && entry.accountKey === accountKey,
  );
}

/** Persist the actual modal draft/name before the remote POST is issued. */
export function prepareCloudPublishRequest(
  sourceRecipe: Recipe,
  publishRecipe: Recipe,
  name: string | undefined,
  accountKey: string,
  region: CloudRegion,
  storage: StorageLike,
  preferredRequestId?: string,
  current?: CloudPublishRequestCheckpoint,
): CloudPublishRequestCheckpoint {
  const sourceFingerprint = cloudPublishRecipeFingerprint(sourceRecipe);
  const payloadFingerprint = checkpointFingerprint(publishRecipe, name);
  const entries = readCheckpoints(storage);
  if (current?.sourceFingerprint === sourceFingerprint && current.accountKey === accountKey) {
    // An in-flight request with an unknown outcome must first be replayed byte-for-byte.
    // Edits can be applied as an update after that row is recovered.
    return current;
  }
  const existing = entries.find(
    (entry) => entry.sourceFingerprint === sourceFingerprint && entry.accountKey === accountKey,
  );
  if (existing?.payloadFingerprint === payloadFingerprint) return existing;

  const checkpoint: CloudPublishRequestCheckpoint = {
    sourceFingerprint,
    payloadFingerprint,
    requestId:
      !existing && preferredRequestId && REQUEST_ID_PATTERN.test(preferredRequestId)
        ? preferredRequestId
        : createRequestId(),
    accountKey,
    region,
    recipe: JSON.parse(JSON.stringify(publishRecipe)) as Recipe,
    ...(name ? { name } : {}),
  };
  writeCheckpoints(storage, [
    checkpoint,
    ...entries.filter(
      (entry) => entry.sourceFingerprint !== sourceFingerprint || entry.accountKey !== accountKey,
    ),
  ]);
  return checkpoint;
}

/** Save the returned table ID before any separate local-history binding is attempted. */
export function markCloudPublishRequestCreated(
  checkpoint: CloudPublishRequestCheckpoint,
  tableId: string,
  shareUrl: string,
  storage: StorageLike,
): CloudPublishRequestCheckpoint {
  const completed = { ...checkpoint, tableId, shareUrl };
  const entries = readCheckpoints(storage);
  writeCheckpoints(storage, [
    completed,
    ...entries.filter(
      (entry) =>
        entry.sourceFingerprint !== checkpoint.sourceFingerprint ||
        entry.accountKey !== checkpoint.accountKey,
    ),
  ]);
  return completed;
}

export function clearCloudPublishRequestCheckpoint(
  checkpoint: CloudPublishRequestCheckpoint,
  storage: StorageLike,
): void {
  writeCheckpoints(
    storage,
    readCheckpoints(storage).filter(
      (entry) =>
        entry.sourceFingerprint !== checkpoint.sourceFingerprint ||
        entry.accountKey !== checkpoint.accountKey ||
        entry.requestId !== checkpoint.requestId,
    ),
  );
}
