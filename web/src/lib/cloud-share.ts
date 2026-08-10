interface CloudEntryRef {
  tableId: string;
  shareUrl?: unknown;
}

const OFFICIAL_SHARE_HOSTS = new Set(["share-h5.xbloom.com", "share-h5.xbloomcoffee.cn"]);

/**
 * 中国区分享 ID 由服务端签发，不能用 tableId 的 Base64 代替；全球区保留旧兼容路径。
 */
export function cloudDetailReference(entry: CloudEntryRef, region: "cn" | "global"): string {
  if (typeof entry.shareUrl === "string" && entry.shareUrl.trim()) {
    try {
      const url = new URL(entry.shareUrl);
      if (url.protocol === "https:" && OFFICIAL_SHARE_HOSTS.has(url.hostname))
        return url.toString();
    } catch {
      // 继续执行区域兜底。
    }
  }
  if (region === "global") return btoa(String(entry.tableId));
  throw new Error("云端列表暂未返回中国区分享链接，请刷新列表后重试");
}
