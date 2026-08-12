ALTER TABLE xhs_browser_sessions
  ADD COLUMN encrypted_qr_payload TEXT NOT NULL DEFAULT '';

ALTER TABLE xhs_browser_sessions
  ADD COLUMN qr_lease_token TEXT NOT NULL DEFAULT '';

ALTER TABLE xhs_browser_sessions
  ADD COLUMN qr_lease_until INTEGER NOT NULL DEFAULT 0;

-- 单行 JSON 同时保存全站和各 owner 计数，使一次 claim 成为单条原子写入。
CREATE TABLE IF NOT EXISTS xhs_browser_budget (
  bucket TEXT PRIMARY KEY,
  global_count INTEGER NOT NULL DEFAULT 0,
  owner_counts_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

-- 缓存按 owner + 关键词摘要隔离；租约用于合并同一账号的并发检索。
CREATE TABLE IF NOT EXISTS xhs_research_cache (
  cache_key TEXT PRIMARY KEY,
  sources_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_xhs_research_cache_expiry
  ON xhs_research_cache(expires_at);
