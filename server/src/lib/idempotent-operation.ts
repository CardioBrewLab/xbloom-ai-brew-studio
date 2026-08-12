import { createHash } from "node:crypto";
import { atomicWriteJson, loadJsonArray } from "./data-io.js";

interface OperationEntry<T> {
  fingerprint: string;
  promise?: Promise<T>;
  value?: T;
  checkpoint?: unknown;
  completedAt?: number;
}

interface PersistedOperationEntry<T> {
  key: string;
  fingerprint: string;
  status?: "pending" | "complete";
  value?: T;
  checkpoint?: unknown;
  completedAt?: number;
}

export interface RecoverableOperation<T, Checkpoint> {
  /** Capture remote IDs before issuing the non-idempotent create. */
  prepare(): Promise<Checkpoint>;
  /** Perform the create against that exact pre-write snapshot. */
  execute(checkpoint: Checkpoint): Promise<T>;
  /** Return the recovered result, or null only after a successful read proves no match. */
  recover(checkpoint: Checkpoint): Promise<T | null>;
}

function payloadFingerprint(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Coalesces retries of externally visible writes. Completed responses and recoverable
 * pre-write checkpoints can be persisted, so a restart does not repeat a remote create
 * whose response was lost.
 */
export class IdempotentOperationRegistry<T> {
  private readonly entries = new Map<string, OperationEntry<T>>();

  constructor(
    private readonly maxEntries = 50_000,
    private readonly persistenceFile?: string,
  ) {
    if (!persistenceFile) return;
    for (const stored of loadJsonArray<PersistedOperationEntry<T>>(persistenceFile)) {
      if (!stored || typeof stored.key !== "string" || typeof stored.fingerprint !== "string") {
        continue;
      }
      if (typeof stored.completedAt === "number" && stored.value !== undefined) {
        this.entries.set(stored.key, {
          fingerprint: stored.fingerprint,
          promise: Promise.resolve(stored.value),
          value: stored.value,
          completedAt: stored.completedAt,
        });
      } else if (stored.status === "pending" && stored.checkpoint !== undefined) {
        this.entries.set(stored.key, {
          fingerprint: stored.fingerprint,
          checkpoint: stored.checkpoint,
        });
      }
    }
    this.pruneCompletedEntries();
  }

  private pruneCompletedEntries(): void {
    if (this.entries.size <= this.maxEntries) return;
    const completed = [...this.entries.entries()]
      .filter((entry): entry is [string, OperationEntry<T> & { completedAt: number }] =>
        Number.isFinite(entry[1].completedAt),
      )
      .sort((left, right) => left[1].completedAt - right[1].completedAt);
    for (const [key] of completed) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(key);
    }
  }

  private persistEntries(): void {
    if (!this.persistenceFile) return;
    const rows: PersistedOperationEntry<T>[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.completedAt !== undefined && entry.value !== undefined) {
        rows.push({
          key,
          fingerprint: entry.fingerprint,
          status: "complete",
          value: entry.value,
          completedAt: entry.completedAt,
        });
      } else if (entry.checkpoint !== undefined) {
        rows.push({
          key,
          fingerprint: entry.fingerprint,
          status: "pending",
          checkpoint: entry.checkpoint,
        });
      }
    }
    atomicWriteJson(this.persistenceFile, rows);
  }

  private completeEntry(key: string, entry: OperationEntry<T>, value: T): T {
    entry.value = value;
    entry.checkpoint = undefined;
    entry.completedAt = Date.now();
    entry.promise = Promise.resolve(value);
    this.entries.set(key, entry);
    this.pruneCompletedEntries();
    try {
      this.persistEntries();
    } catch (error) {
      // The remote write already succeeded. Keep the response in memory; reporting
      // persistence trouble is better than turning success into a duplicate retry.
      console.warn(`[xbloom][cloud] 幂等记录写入失败：${String(error)}`);
    }
    return value;
  }

  run(scope: string, requestId: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
    const key = `${scope}:${requestId}`;
    const fingerprint = payloadFingerprint(payload);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new Error("同一发布请求号对应了不同配方，请重新打开发布预览"));
      }
      if (existing.promise) return existing.promise;
      return Promise.reject(new Error("该发布请求正在等待云端恢复确认，请通过原发布入口重试"));
    }

    this.pruneCompletedEntries();
    let entry: OperationEntry<T>;
    const promise = operation().then(
      (value) => this.completeEntry(key, entry, value),
      (error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      },
    );
    entry = { fingerprint, promise };
    this.entries.set(key, entry);
    return promise;
  }

  /**
   * Persist a pre-write snapshot around a non-idempotent create. An uncertain failure
   * keeps the checkpoint. The next retry, including after a process restart, searches
   * from that snapshot before deciding whether a fresh create is safe.
   */
  runRecoverable<Checkpoint>(
    scope: string,
    requestId: string,
    payload: unknown,
    operation: RecoverableOperation<T, Checkpoint>,
  ): Promise<T> {
    const key = `${scope}:${requestId}`;
    const fingerprint = payloadFingerprint(payload);
    let entry = this.entries.get(key);
    if (entry?.fingerprint !== undefined && entry.fingerprint !== fingerprint) {
      return Promise.reject(new Error("同一发布请求号对应了不同配方，请重新打开发布预览"));
    }
    if (entry?.completedAt !== undefined && entry.value !== undefined) {
      return Promise.resolve(entry.value);
    }
    if (entry?.promise) return entry.promise;

    this.pruneCompletedEntries();
    entry ??= { fingerprint };
    this.entries.set(key, entry);
    const activeEntry = entry;
    const promise = (async () => {
      let checkpoint = activeEntry.checkpoint as Checkpoint | undefined;
      if (checkpoint !== undefined) {
        try {
          const recovered = await operation.recover(checkpoint);
          if (recovered !== null) return this.completeEntry(key, activeEntry, recovered);
          // The list call completed and found no post-snapshot match. A new baseline
          // and create are now safe.
          activeEntry.checkpoint = undefined;
          this.persistEntries();
        } catch (error) {
          activeEntry.promise = undefined;
          this.persistEntries();
          throw error;
        }
      }

      try {
        checkpoint = await operation.prepare();
      } catch (error) {
        if (this.entries.get(key) === activeEntry) this.entries.delete(key);
        this.persistEntries();
        throw error;
      }
      activeEntry.checkpoint = checkpoint;
      this.persistEntries();
      try {
        const value = await operation.execute(checkpoint);
        return this.completeEntry(key, activeEntry, value);
      } catch (error) {
        // The remote POST may have committed even though its response or immediate
        // recovery read failed. Keep the snapshot for the next retry.
        activeEntry.promise = undefined;
        this.persistEntries();
        throw error;
      }
    })();
    activeEntry.promise = promise;
    return promise;
  }
}
