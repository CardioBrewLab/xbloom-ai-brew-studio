CREATE TABLE IF NOT EXISTS xbloom_write_operations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  before_ids_json TEXT NOT NULL DEFAULT '[]',
  response_json TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, member_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_xbloom_write_operations_updated
  ON xbloom_write_operations(updated_at);
