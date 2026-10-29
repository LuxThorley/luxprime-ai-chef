-- Sessions are now stored as SHA-256(cookie value). Existing plain-text session rows can never match again,
-- so they are removed: every member signs in once more (accepted by Oliver, 29 Oct 2026).
DELETE FROM sessions;
-- Per-account sign-in throttle (key = SHA-256 of the lower-cased email; no address stored).
CREATE TABLE IF NOT EXISTS login_failures (k TEXT PRIMARY KEY, fails INTEGER NOT NULL, last_at INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0);
