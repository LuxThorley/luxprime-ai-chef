-- Site-side 7-day Head Chef trial for new sign-ups (epoch ms; NULL = no trial, e.g. accounts created before Oct 2026).
ALTER TABLE users ADD COLUMN trial_ends_at INTEGER;
