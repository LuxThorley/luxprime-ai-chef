'use strict';
// Secure email change and verified magazine delivery address. Works with any async q = { all, get, run }.
// Tokens reuse email_tokens (SHA-256 only stored, single use, 24h): purposes 'email-change' and 'mag-delivery'.
const { z } = require('zod'); const mailer = require('./mailer'); const { sha256, TTL_MS } = require('./verify');
const Email = z.string().trim().toLowerCase().email('Enter a valid email address').max(200);
const ChangeReq = z.object({ currentPassword: z.string().min(1, 'Enter your current password').max(200), newEmail: Email });
const ProfileReq = z.object({ name: z.string().trim().max(80) });
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const escH = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fail = (status, error, extra = {}) => ({ status, json: { error, ...extra } });

async function issue(q, uid, purpose, target, now = Date.now()) {
  const raw = hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  await q.run('DELETE FROM email_tokens WHERE user_id=? AND purpose=?', [uid, purpose]); // only the newest request is valid
  await q.run('INSERT INTO email_tokens(token_hash,user_id,purpose,expires_at,created_at,target_email) VALUES(?,?,?,?,?,?)', [await sha256(raw), uid, purpose, now + TTL_MS, now, target]);
  return raw;
}
async function take(q, raw, purpose, now = Date.now()) {
  if (!/^[0-9a-f]{64}$/.test(String(raw || ''))) return { error: 'Invalid link' };
  const h = await sha256(raw); const row = await q.get('SELECT * FROM email_tokens WHERE token_hash=? AND purpose=?', [h, purpose]);
  if (!row) return { error: 'This link is invalid or has already been used' };
  await q.run('DELETE FROM email_tokens WHERE token_hash=?', [h]);
  if (row.expires_at < now) return { error: 'This link has expired — please request a new one', expired: true };
  return { row };
}
const taken = async (q, email, uid) => !!(await q.get('SELECT 1 FROM users WHERE lower(email)=? AND id!=?', [email, uid]));
const mail = (env, to, subject, lines, link, button, fetchImpl) => mailer.send(env, { to, subject, text: lines.join('\n\n') + (link ? `\n\n${link}` : '') + '\n\nMalcolm · AIchef.food',
  html: `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:28px;color:#25211c;background:#fbf8f2">${lines.map(l => `<p>${escH(l)}</p>`).join('')}${link ? `<p><a href="${escH(link)}" style="background:#f29a1f;color:#2a1104;text-decoration:none;padding:12px 20px;border-radius:999px;font:600 14px Arial,sans-serif">${escH(button)}</a></p>` : ''}<p style="font:12px Arial,sans-serif;color:#7a7065">Malcolm · AIchef.food</p></div>` }, fetchImpl);

// ---- Profile fields ----
async function updateProfile(q, u, b) { const p = ProfileReq.safeParse(b || {}); if (!p.success) return fail(400, p.error.issues[0].message);
  await q.run('UPDATE users SET name=? WHERE id=?', [p.data.name || null, u.id]); return { status: 200, json: { ok: true, name: p.data.name || null } }; }

// ---- Email change: re-auth → link to NEW address → switch only on confirmation → notify OLD address ----
async function requestChange(q, env, u, b, { verifyPassword, base, fetchImpl }) {
  const p = ChangeReq.safeParse(b || {}); if (!p.success) return fail(400, p.error.issues[0].message);
  if (!(await verifyPassword(p.data.currentPassword, u.password_hash))) return fail(401, 'Your current password isn’t right');
  const to = p.data.newEmail; if (to === String(u.email).toLowerCase()) return fail(400, 'That’s already your email address');
  if (await taken(q, to, u.id)) return fail(409, 'That email address is already used by another account');
  if (!mailer.ready(env)) return fail(503, 'Email changes need our email service, which isn’t switched on yet — please try again later.', { reason: 'email-not-configured' });
  const raw = await issue(q, u.id, 'email-change', to);
  await mail(env, to, 'Confirm your new email for AIchef.food', [`Hello ${u.name || 'there'},`, `Please confirm that you want ${to} to become the email address for your AIchef.food account. Nothing changes until you click the link below, which expires in 24 hours.`, 'If you didn’t ask for this, just ignore this email.'], `${base}/account.html?email-change=${raw}`, 'CONFIRM NEW EMAIL', fetchImpl);
  return { status: 200, json: { ok: true, pending: to } };
}
// revokeSessions(uid) signs out every other session; stripeUpdate(customerId, email) updates the billing email.
async function confirmChange(q, env, raw, { fetchImpl, revokeSessions, stripeUpdate } = {}) {
  const t = await take(q, raw, 'email-change'); if (t.error) return fail(400, t.error, { expired: !!t.expired });
  const { user_id: uid, target_email: to } = t.row; const u = await q.get('SELECT * FROM users WHERE id=?', [uid]); if (!u || !to) return fail(400, 'This link is no longer valid');
  if (await taken(q, to, uid)) return fail(409, 'That email address is now used by another account');
  const old = u.email; const now = Date.now();
  await q.run('UPDATE users SET email=?, email_verified=1, verified_at=? WHERE id=?', [to, now, uid]);
  await q.run('DELETE FROM email_tokens WHERE user_id=? AND purpose=?', [uid, 'verify']);
  // Household seats are keyed by email: keep this member's joined seats and pending invites pointing at them.
  await q.run('UPDATE OR IGNORE plan_members SET email=? WHERE user_id=?', [to, uid]);
  await q.run('UPDATE OR IGNORE plan_members SET email=? WHERE user_id IS NULL AND lower(email)=?', [to, String(old).toLowerCase()]);
  await q.run('UPDATE magazine_subs SET delivery_email=NULL, delivery_verified_at=NULL WHERE user_id=? AND lower(delivery_email)=?', [uid, to]).catch(() => {});
  if (revokeSessions) await revokeSessions(uid);
  let stripe = 'none'; if (u.stripe_customer_id && stripeUpdate) { try { await stripeUpdate(u.stripe_customer_id, to); stripe = 'updated'; } catch (e) { stripe = 'failed'; console.error('stripe email update', e && e.message); } }
  let notified = false; try { notified = !!(await mail(env, old, 'Your AIchef.food email address was changed', [`Hello ${u.name || 'there'},`, `The email address for your AIchef.food account was changed from ${old} to ${to} on ${new Date(now).toLocaleString('en-GB', { timeZone: 'Europe/London' })} (UK time). For your security, other devices have been signed out.`, `If this wasn’t you, reply to this email or contact malcolm@aichef.food straight away.`], null, null, fetchImpl)).sent; } catch (e) { console.error('old-address notice', e && e.message); }
  return { status: 200, json: { ok: true, email: to, stripe, oldNotified: notified }, userId: uid };
}

// ---- Magazine delivery address ----
async function requestDelivery(q, env, u, b, { base, fetchImpl }) {
  const p = Email.safeParse((b || {}).email); if (!p.success) return fail(400, p.error.issues[0].message);
  if (!(await q.get('SELECT 1 FROM magazine_subs WHERE user_id=?', [u.id]))) return fail(400, 'Set up your magazine first, then choose where it’s delivered');
  if (p.data === String(u.email).toLowerCase()) { await revertDelivery(q, u); return { status: 200, json: { ok: true, delivery: u.email, usingAccountEmail: true } }; }
  if (!mailer.ready(env)) return fail(503, 'Delivery changes need our email service, which isn’t switched on yet.', { reason: 'email-not-configured' });
  const raw = await issue(q, u.id, 'mag-delivery', p.data);
  await mail(env, p.data, 'Confirm magazine delivery to this address', [`Hello,`, `${u.name || 'An AIchef.food member'} would like their personalised AIchef.food Magazine delivered to ${p.data}. Please confirm this is your address. Nothing is sent here until you do; the link expires in 24 hours.`, 'If you weren’t expecting this, ignore this email.'], `${base}/account.html?mag-delivery=${raw}`, 'CONFIRM DELIVERY ADDRESS', fetchImpl);
  return { status: 200, json: { ok: true, pending: p.data } };
}
async function confirmDelivery(q, raw) {
  const t = await take(q, raw, 'mag-delivery'); if (t.error) return fail(400, t.error, { expired: !!t.expired });
  await q.run('UPDATE magazine_subs SET delivery_email=?, delivery_verified_at=? WHERE user_id=?', [t.row.target_email, Date.now(), t.row.user_id]);
  return { status: 200, json: { ok: true, delivery: t.row.target_email } };
}
async function revertDelivery(q, u) { await q.run('UPDATE magazine_subs SET delivery_email=NULL, delivery_verified_at=NULL WHERE user_id=?', [u.id]); await q.run("DELETE FROM email_tokens WHERE user_id=? AND purpose='mag-delivery'", [u.id]); return { status: 200, json: { ok: true, usingAccountEmail: true } }; }
// The only place the magazine sender chooses an address: the verified alternative, otherwise the account email.
const deliveryAddress = (u, row) => (row && row.delivery_email && row.delivery_verified_at) ? row.delivery_email : u.email;
async function status(q, u) { const row = await q.get('SELECT delivery_email,delivery_verified_at FROM magazine_subs WHERE user_id=?', [u.id]);
  const pend = await q.get("SELECT target_email FROM email_tokens WHERE user_id=? AND purpose='email-change' AND expires_at>?", [u.id, Date.now()]);
  const pd = await q.get("SELECT target_email FROM email_tokens WHERE user_id=? AND purpose='mag-delivery' AND expires_at>?", [u.id, Date.now()]);
  return { status: 200, json: { email: u.email, name: u.name || null, pendingEmail: pend ? pend.target_email : null, magazine: row ? { delivery: deliveryAddress(u, row), usingAccountEmail: !(row.delivery_email && row.delivery_verified_at), pending: pd ? pd.target_email : null } : null } }; }
module.exports = { ChangeReq, updateProfile, requestChange, confirmChange, requestDelivery, confirmDelivery, revertDelivery, deliveryAddress, status };
