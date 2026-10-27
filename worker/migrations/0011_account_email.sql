-- Additive: secure email change + verified alternative magazine delivery address.
-- email_tokens gains the address a token is confirming (email change / magazine delivery); existing 'verify' tokens unaffected.
ALTER TABLE email_tokens ADD COLUMN target_email TEXT;
ALTER TABLE magazine_subs ADD COLUMN delivery_email TEXT;
ALTER TABLE magazine_subs ADD COLUMN delivery_verified_at INTEGER;
