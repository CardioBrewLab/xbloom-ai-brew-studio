PRAGMA foreign_keys = ON;

-- Hosted 小红书登录按站内身份隔离；owner 同时支持匿名浏览器与已注册账号。
CREATE TABLE IF NOT EXISTS xhs_browser_sessions (
  owner TEXT PRIMARY KEY,
  encrypted_cookies TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  qr_session_id TEXT NOT NULL DEFAULT '',
  qr_expires_at INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_xhs_browser_qr_expiry
  ON xhs_browser_sessions(qr_expires_at);
