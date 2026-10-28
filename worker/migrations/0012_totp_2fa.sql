-- Additive: TOTP two-factor authentication (RFC 6238). Secrets are AES-GCM encrypted with the Worker secret TOTP_ENC_KEY.
-- Backup codes, login challenges and trusted-device tokens are stored only as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS user_totp (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL, enabled_at INTEGER, last_step INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS totp_backup_codes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS totp_backup_user ON totp_backup_codes(user_id);
CREATE TABLE IF NOT EXISTS login_challenges (id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS login_challenges_user ON login_challenges(user_id);
CREATE TABLE IF NOT EXISTS trusted_devices (id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE INDEX IF NOT EXISTS trusted_devices_user ON trusted_devices(user_id);
