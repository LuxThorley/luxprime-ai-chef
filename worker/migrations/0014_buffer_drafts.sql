-- 0014: Buffer social DRAFTS audit log + daily cap (OmniMaster Buffer integration, 28 Oct 2026).
-- Additive only. Rollback: DROP TABLE buffer_drafts; (no other table touched)
CREATE TABLE IF NOT EXISTS buffer_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,          -- ISO-8601 UTC
  day TEXT NOT NULL,                 -- UK calendar day (Europe/London), used for the daily cap
  source TEXT NOT NULL,              -- e.g. aichef:recipe, aichef:magazine, aichef:custom
  service TEXT NOT NULL,             -- facebook | linkedin | instagram
  channel_id TEXT NOT NULL,          -- Buffer channel id
  buffer_post_id TEXT,               -- Buffer post id when created
  status TEXT NOT NULL,              -- draft | error | capped | not_draft_deleted | not_draft_alert
  title TEXT,
  actor TEXT,                        -- admin user id that requested it
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_buffer_drafts_day ON buffer_drafts(day, status);
