import type { CloudWriteVerification } from "./api.js";

/** 只有云端回读与预期完全一致时，才把 tableId 绑定到本地历史。 */
export function shouldBindCloudRecord(verification: CloudWriteVerification): boolean {
  return verification.state === "verified";
}
