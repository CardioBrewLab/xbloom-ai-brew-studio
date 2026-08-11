PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS user_model_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openai-compatible', 'anthropic', 'gemini')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  fallback_model TEXT NOT NULL DEFAULT '',
  third_model TEXT NOT NULL DEFAULT '',
  encrypted_api_key TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_external_sessions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT NOT NULL CHECK (service IN ('xbloom')),
  region TEXT NOT NULL DEFAULT 'cn',
  account_hint TEXT NOT NULL DEFAULT '',
  encrypted_payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, service)
);

CREATE TABLE IF NOT EXISTS auth_attempts (
  subject TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, hour_bucket)
);
