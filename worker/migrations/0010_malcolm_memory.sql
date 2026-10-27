-- Additive: opt-in Malcolm personal memory (UK GDPR / PECR). Off by default: no rows exist until a member consents.
-- First-party only. No IP addresses, user agents, device IDs, fingerprints or third-party trackers are stored.
CREATE TABLE IF NOT EXISTS member_consent (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  chat INTEGER NOT NULL DEFAULT 0, search INTEGER NOT NULL DEFAULT 0, behaviour INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, consented_at INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS member_chats (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','malcolm')), text TEXT NOT NULL, surface TEXT NOT NULL DEFAULT 'assistant', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS member_chats_user ON member_chats(user_id, created_at);
CREATE TABLE IF NOT EXISTS member_searches (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, query_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS member_searches_user ON member_searches(user_id, created_at);
CREATE TABLE IF NOT EXISTS member_events (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, ref TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS member_events_user ON member_events(user_id, created_at);
CREATE TABLE IF NOT EXISTS member_profile (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, profile_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
