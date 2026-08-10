CREATE TABLE IF NOT EXISTS user_items (
  owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('recipe', 'bean')),
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (owner, kind, id)
);

CREATE INDEX IF NOT EXISTS idx_user_items_owner_kind_created
  ON user_items(owner, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS generation_usage (
  owner TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, hour_bucket)
);
