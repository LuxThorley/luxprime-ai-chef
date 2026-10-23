'use strict';
// Email verification: random 32-byte token emailed once; only its SHA-256 is stored (D1/SQLite), 24h expiry, single use.
const mailer = require('./mailer');
const TTL_MS = 24 * 3600e3;
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS email_tokens (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, purpose TEXT NOT NULL DEFAULT 'verify', expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id)`];
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const isVerified = u => !!(u && (u.email_verified === 1 || u.email_verified === true));
async function issue(q, userId, now = Date.now()) {
  const raw = hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  await q.run("DELETE FROM email_tokens WHERE user_id=? AND purpose='verify'", [userId]);
  await q.run("INSERT INTO email_tokens(token_hash,user_id,purpose,expires_at,created_at) VALUES(?,?,'verify',?,?)", [await sha256(raw), userId, now + TTL_MS, now]);
  return raw;
}
async function consume(q, raw, now = Date.now()) {
  if (!/^[0-9a-f]{64}$/.test(String(raw || ''))) return { ok: false, error: 'Invalid verification link' };
  const h = await sha256(raw); const row = await q.get("SELECT * FROM email_tokens WHERE token_hash=? AND purpose='verify'", [h]);
  if (!row) return { ok: false, error: 'This verification link is invalid or has already been used' };
  await q.run('DELETE FROM email_tokens WHERE token_hash=?', [h]);
  if (row.expires_at < now) return { ok: false, expired: true, error: 'This verification link has expired — request a new one' };
  await q.run('UPDATE users SET email_verified=1, verified_at=? WHERE id=?', [now, row.user_id]);
  return { ok: true, userId: row.user_id };
}
// Issues a token and emails it when Resend is configured; otherwise leaves the account in "verification pending".
async function sendVerification(q, env, user, base, fetchImpl) {
  if (!mailer.ready(env)) return { sent: false, reason: 'email-not-configured' };
  const raw = await issue(q, user.id); const link = `${base}/account.html?verify=${raw}`; const name = user.name || 'there';
  return mailer.send(env, { to: user.email, subject: 'Confirm your email for AIchef.food',
    text: `Hello ${name},\n\nPlease confirm your email address for AIchef.food so your ratings count and you can receive the magazine and household invites:\n${link}\n\nThis link expires in 24 hours. If you didn't create an account, just ignore this email.\n\nMalcolm · AIchef.food`,
    html: `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:28px;color:#25211c;background:#fbf8f2"><h1 style="font-weight:normal;font-style:italic">Confirm your email</h1><p>Hello ${String(name).replace(/[&<>"]/g, '')}, please confirm your address so your ratings count and you can receive the magazine and household invites.</p><p><a href="${link}" style="background:#f29a1f;color:#2a1104;text-decoration:none;padding:12px 20px;border-radius:999px;font:600 14px Arial,sans-serif">CONFIRM MY EMAIL</a></p><p style="font:12px Arial,sans-serif;color:#7a7065">This link expires in 24 hours. If you didn't create an account, ignore this email.<br>Malcolm · AIchef.food</p></div>` }, fetchImpl);
}
module.exports = { SCHEMA_SQL, TTL_MS, sha256, isVerified, issue, consume, sendVerification };
