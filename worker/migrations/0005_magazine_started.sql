-- Recover issues whose worker run died mid-build (status stuck at 'working').
ALTER TABLE magazine_issues ADD COLUMN started_at TEXT;
