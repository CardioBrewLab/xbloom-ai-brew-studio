import type { CloudWriteVerification } from "./api.js";
import type { CloudRegion } from "./api.js";

/** 只有云端回读与预期完全一致时，才把 tableId 绑定到本地历史。 */
export function shouldBindCloudRecord(verification: CloudWriteVerification): boolean {
  return verification.state === "verified";
}

export interface PendingCloudPublish {
  tableId: string;
  shareUrl: string;
  region: CloudRegion;
  accountKey: string;
  recipeKey: string;
}

export function cloudAccountKey(
  cloud: { memberId?: string; email?: string; region?: CloudRegion } | null | undefined,
  fallbackRegion: CloudRegion,
): string {
  const accountId = cloud?.memberId ?? cloud?.email;
  return accountId ? `${cloud?.region ?? fallbackRegion}:${accountId}` : "";
}

export function pendingPublishForAccount(
  pending: PendingCloudPublish | undefined,
  accountKey: string,
): PendingCloudPublish | undefined {
  return accountKey && pending?.accountKey === accountKey ? pending : undefined;
}

/** Reopen/retry a pending write against its existing cloud row instead of creating a second row. */
export function cloudPublishTarget(
  cloudTableId?: string,
  pending?: PendingCloudPublish,
): { mode: "create" | "update"; tableId?: string } {
  if (cloudTableId) return { mode: "update", tableId: cloudTableId };
  if (pending?.tableId) return { mode: "update", tableId: pending.tableId };
  return { mode: "create" };
}
