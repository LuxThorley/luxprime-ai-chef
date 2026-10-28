'use strict';
// TOTP two-factor authentication (RFC 6238 / RFC 4226): HMAC-SHA1, 6 digits, 30 s, ±1 step, replay-protected. WebCrypto only.
// Works in Node 18+ and Workers. Storage via async q = { all, get, run }. Secrets encrypted at rest with env.TOTP_ENC_KEY (AES-256-GCM).
const qrcode = require('qrcode-generator');
const C = globalThis.crypto; const te = new TextEncoder();
const ISSUER = 'AIchef.food'; const STEP = 30; const DIGITS = 6;
const CHALLENGE_MS = 5 * 60e3; const CHALLENGE_TRIES = 5; const TRUST_DAYS = 30; const BACKUP_COUNT = 10;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await C.subtle.digest('SHA-256', te.encode(s)));
const rand = n => C.getRandomValues(new Uint8Array(n));
const b64 = u => btoa(String.fromCharCode(...u)); const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
function b32enc(bytes) { let bits = 0, v = 0, out = ''; for (const b of bytes) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(v << (5 - bits)) & 31]; return out; }
function b32dec(s) { s = String(s).toUpperCase().replace(/[\s=-]/g, ''); let bits = 0, v = 0; const out = []; for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32'); v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(out); }
async function hotp(secretBytes, counter) {
  const key = await C.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8); let x = counter; for (let i = 7; i >= 0; i--) { msg[i] = x & 255; x = Math.floor(x / 256); }
  const h = new Uint8Array(await C.subtle.sign('HMAC', key, msg)); const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}
const totp = (secretB32, now = Date.now()) => hotp(b32dec(secretB32), Math.floor(now / 1000 / STEP));
// Returns the matched step (> lastStep) or 0. Constant-ish: always checks the whole window.
async function verifyCode(secretB32, code, { now = Date.now(), lastStep = 0, window = 1 } = {}) {
  code = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(code)) return 0;
  const bytes = b32dec(secretB32); const t = Math.floor(now / 1000 / STEP); let hit = 0;
  for (let w = -window; w <= window; w++) { const s = t + w; if ((await hotp(bytes, s)) === code && s > lastStep) hit = s; }
  return hit;
}
// ---- Encryption at rest ----
const encKey = async env => { const k = env && env.TOTP_ENC_KEY; if (!k || String(k).length < 16) throw Object.assign(new Error('TOTP_ENC_KEY not configured'), { code: 'no-key' });
  return C.subtle.importKey('raw', await C.subtle.digest('SHA-256', te.encode('aichef-totp-v1:' + k)), 'AES-GCM', false, ['encrypt', 'decrypt']); };
async function encrypt(env, plain) { const iv = rand(12); const ct = new Uint8Array(await C.subtle.encrypt({ name: 'AES-GCM', iv }, await encKey(env), te.encode(plain))); return `v1:${b64(iv)}:${b64(ct)}`; }
async function decrypt(env, s) { const [v, iv, ct] = String(s).split(':'); if (v !== 'v1') throw new Error('bad ciphertext'); return new TextDecoder().decode(await C.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await encKey(env), unb64(ct))); }
const ready = env => !!(env && env.TOTP_ENC_KEY && String(env.TOTP_ENC_KEY).length >= 16);
// ---- QR (generated locally, inline SVG data URL; no third-party service) ----
const otpauth = (email, secret) => `otpauth://totp/${encodeURIComponent(ISSUER)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
function qrDataUrl(text) { const q = qrcode(0, 'M'); q.addData(text); q.make(); const svg = q.createSvgTag({ cellSize: 5, margin: 4, scalable: true }); return 'data:image/svg+xml;base64,' + b64(te.encode(svg)); }
// ---- State ----
const row = (q, uid) => q.get('SELECT * FROM user_totp WHERE user_id=?', [uid]);
const isEnabled = async (q, uid) => { const r = await row(q, uid); return !!(r && r.enabled_at); };
const mustHave = u => { const P = require('./plans'); return P.isAdmin(u) || P.isTester(u); }; // admin + shared all-access accounts
const fmtCode = s => s.slice(0, 5) + '-' + s.slice(5);
const normBackup = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function newBackupCodes(q, uid) {
  await q.run('DELETE FROM totp_backup_codes WHERE user_id=?', [uid]); const out = []; const now = Date.now();
  for (let i = 0; i < BACKUP_COUNT; i++) { const c = b32enc(rand(7)).slice(0, 10).toLowerCase(); out.push(fmtCode(c)); await q.run('INSERT INTO totp_backup_codes(user_id,code_hash,created_at) VALUES(?,?,?)', [uid, await sha256('bk:' + uid + ':' + c), now]); }
  return out;
}
// Verifies a TOTP or (if allowBackup) a single-use backup code; burns what it uses.
async function checkSecondFactor(q, env, uid, { code, backupCode } = {}, { allowBackup = true } = {}) {
  const r = await row(q, uid); if (!r || !r.enabled_at) return { ok: false };
  if (code) { const step = await verifyCode(await decrypt(env, r.secret_enc), code, { lastStep: r.last_step });
    if (step) { const u = await q.run('UPDATE user_totp SET last_step=? WHERE user_id=? AND last_step<?', [step, uid, step]); if ((u.meta ? u.meta.changes : u.changes) > 0) return { ok: true, via: 'totp' }; } }
  if (backupCode && allowBackup) { const h = await sha256('bk:' + uid + ':' + normBackup(backupCode));
    const u = await q.run('UPDATE totp_backup_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL', [Date.now(), uid, h]); if ((u.meta ? u.meta.changes : u.changes) > 0) return { ok: true, via: 'backup' }; }
  return { ok: false };
}
// ---- Handlers. io = { verifyPassword(pw, hash), startSession(u), revokeOtherSessions(uid), getTrust(), setTrust(token, maxAgeSec), clearTrust() } ----
const res = (status, json) => ({ status, json });
async function status(q, env, u) {
  const r = await row(q, u.id); const left = ((await q.get('SELECT COUNT(*) n FROM totp_backup_codes WHERE user_id=? AND used_at IS NULL', [u.id])) || {}).n || 0;
  const devices = await q.all('SELECT substr(id_hash,1,12) id, label, created_at, expires_at, last_used_at FROM trusted_devices WHERE user_id=? AND expires_at>? ORDER BY created_at DESC', [u.id, Date.now()]);
  return res(200, { enabled: !!(r && r.enabled_at), enabledAt: r && r.enabled_at || null, required: mustHave(u), available: ready(env), backupCodesLeft: left, trustedDevices: devices });
}
async function setup(q, env, u, b, io) {
  if (!ready(env)) return res(503, { error: 'Two-factor authentication isn’t switched on yet on this site' });
  if (await isEnabled(q, u.id)) return res(400, { error: 'Two-factor authentication is already on' });
  if (!(await io.verifyPassword(String((b || {}).password || ''), u.password_hash))) return res(401, { error: 'Your password isn’t right' });
  const secret = b32enc(rand(20)); const now = Date.now();
  await q.run('INSERT INTO user_totp(user_id,secret_enc,enabled_at,last_step,created_at) VALUES(?,?,NULL,0,?) ON CONFLICT(user_id) DO UPDATE SET secret_enc=excluded.secret_enc, enabled_at=NULL, last_step=0, created_at=excluded.created_at', [u.id, await encrypt(env, secret), now]);
  const uri = otpauth(u.email, secret);
  return res(200, { otpauthUri: uri, qr: qrDataUrl(uri), manualKey: secret.match(/.{1,4}/g).join(' '), issuer: ISSUER, account: u.email, digits: DIGITS, period: STEP });
}
async function enable(q, env, u, b, io) {
  const r = await row(q, u.id); if (!r) return res(400, { error: 'Start set-up first' }); if (r.enabled_at) return res(400, { error: 'Already on' });
  const step = await verifyCode(await decrypt(env, r.secret_enc), (b || {}).code); if (!step) return res(400, { error: 'That code didn’t match — check the time on your phone and try the newest code' });
  await q.run('UPDATE user_totp SET enabled_at=?, last_step=? WHERE user_id=?', [Date.now(), step, u.id]);
  const codes = await newBackupCodes(q, u.id); if (io.revokeOtherSessions) await io.revokeOtherSessions(u.id);
  return res(200, { ok: true, enabled: true, backupCodes: codes, note: 'Save these backup codes somewhere safe. Each works once. They won’t be shown again.' });
}
async function disable(q, env, u, b, io) {
  b = b || {}; if (!(await io.verifyPassword(String(b.password || ''), u.password_hash))) return res(401, { error: 'Your password isn’t right' });
  if (!(await checkSecondFactor(q, env, u.id, b)).ok) return res(401, { error: 'That code didn’t match' });
  for (const t of ['user_totp', 'totp_backup_codes', 'trusted_devices', 'login_challenges']) await q.run(`DELETE FROM ${t} WHERE user_id=?`, [u.id]);
  if (io.clearTrust) io.clearTrust();
  return res(200, { ok: true, enabled: false, ...(mustHave(u) ? { note: 'This account requires two-factor authentication, so you’ll be asked to set it up again.' } : {}) });
}
async function regenerate(q, env, u, b) { if (!(await checkSecondFactor(q, env, u.id, { code: (b || {}).code }, { allowBackup: false })).ok) return res(401, { error: 'That code didn’t match' }); return res(200, { ok: true, backupCodes: await newBackupCodes(q, u.id) }); }
async function forgetDevices(q, u, io) { await q.run('DELETE FROM trusted_devices WHERE user_id=?', [u.id]); if (io.clearTrust) io.clearTrust(); return res(200, { ok: true }); }
// After a correct password: returns { session: true } or a challenge. Never starts a session itself.
async function afterPassword(q, env, u, io) {
  if (!(await isEnabled(q, u.id)) || !ready(env)) return { done: true };
  const t = io.getTrust && io.getTrust();
  if (t) { const h = await sha256('td:' + t); const d = await q.get('SELECT user_id FROM trusted_devices WHERE id_hash=? AND user_id=? AND expires_at>?', [h, u.id, Date.now()]);
    if (d) { await q.run('UPDATE trusted_devices SET last_used_at=? WHERE id_hash=?', [Date.now(), h]); return { done: true, trusted: true }; } }
  const raw = hex(rand(32)); const now = Date.now();
  await q.run('DELETE FROM login_challenges WHERE user_id=? OR expires_at<?', [u.id, now]);
  await q.run('INSERT INTO login_challenges(id_hash,user_id,expires_at,attempts,created_at) VALUES(?,?,?,0,?)', [await sha256('lc:' + raw), u.id, now + CHALLENGE_MS, now]);
  return { done: false, json: { twoFactor: 'required', challenge: raw, expiresInSec: CHALLENGE_MS / 1000 } };
}
async function completeLogin(q, env, b, io) {
  b = b || {}; const raw = String(b.challenge || ''); if (!/^[0-9a-f]{64}$/.test(raw)) return res(400, { error: 'Your sign-in has expired — please start again' });
  const h = await sha256('lc:' + raw); const ch = await q.get('SELECT * FROM login_challenges WHERE id_hash=?', [h]);
  if (!ch || ch.expires_at < Date.now()) return res(400, { error: 'Your sign-in has expired — please start again', restart: true });
  if (ch.attempts >= CHALLENGE_TRIES) { await q.run('DELETE FROM login_challenges WHERE id_hash=?', [h]); return res(429, { error: 'Too many attempts — please sign in again', restart: true }); }
  await q.run('UPDATE login_challenges SET attempts=attempts+1 WHERE id_hash=?', [h]);
  const f = await checkSecondFactor(q, env, ch.user_id, b); if (!f.ok) return res(401, { error: 'That code didn’t match', attemptsLeft: CHALLENGE_TRIES - ch.attempts - 1 });
  await q.run('DELETE FROM login_challenges WHERE id_hash=?', [h]);
  const u = await q.get('SELECT * FROM users WHERE id=?', [ch.user_id]);
  if (b.trustDevice === true && io.setTrust) { const t = hex(rand(32)); const now = Date.now();
    await q.run('INSERT INTO trusted_devices(id_hash,user_id,label,created_at,expires_at) VALUES(?,?,?,?,?)', [await sha256('td:' + t), u.id, String(b.deviceLabel || '').slice(0, 60) || null, now, now + TRUST_DAYS * 864e5]); io.setTrust(t, TRUST_DAYS * 86400); }
  await io.startSession(u);
  const left = ((await q.get('SELECT COUNT(*) n FROM totp_backup_codes WHERE user_id=? AND used_at IS NULL', [u.id])) || {}).n || 0;
  return res(200, { ok: true, user: u, via: f.via, backupCodesLeft: left });
}
// Paths a signed-in admin/tester without 2FA may use until they enrol ("enrolment on next login").
const ENROL_OK = /^\/api\/(csrf|me|auth\/logout|2fa\/(status|setup|enable))$/;
async function enrolmentBlock(q, env, u, path) {
  if (!u || !ready(env) || !mustHave(u) || ENROL_OK.test(path)) return null;
  if (await isEnabled(q, u.id)) return null;
  return { status: 403, json: { error: 'This account needs two-factor authentication. Please set it up to continue.', enrol2fa: true, setup: '/account.html#security' } };
}
module.exports = { ISSUER, STEP, TRUST_DAYS, BACKUP_COUNT, CHALLENGE_TRIES, b32enc, b32dec, hotp, totp, verifyCode, encrypt, decrypt, ready, otpauth, qrDataUrl, isEnabled, mustHave, checkSecondFactor, newBackupCodes,
  H: { status, setup, enable, disable, regenerate, forgetDevices }, afterPassword, completeLogin, enrolmentBlock, ENROL_OK };
