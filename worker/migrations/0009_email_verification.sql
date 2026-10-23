-- Additive: email verification. Every account that exists when this runs (incl. admin + shared test account) is marked verified; no emails are sent.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verified_at INTEGER;
UPDATE users SET email_verified = 1, verified_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
CREATE TABLE IF NOT EXISTS email_tokens (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, purpose TEXT NOT NULL DEFAULT 'verify', expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id);
