ALTER TABLE users ADD COLUMN password_scheme TEXT NOT NULL DEFAULT 'pbkdf2-sha256-v1';
