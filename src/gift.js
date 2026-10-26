'use strict';
// Smart Gift memberships: prepaid one-off purchases of any plan (incl. Restauranteur and the Magazine) for someone else.
// Storage is a KV-like store { get(k), put(k, v, opts), delete(k) } — Workers KV in production, a Map in tests.
// Codes are random (60 bits, unambiguous alphabet), shown once to the buyer, stored only as a SHA-256 hash, single-use.
const { z } = require('zod');
const { PRICES } = require('./plans');
const GIFT_PLANS = {
  monthly: { name: 'Chef de Partie', blurb: 'Unlimited AI chef searches, 5 ranked recipes, favourites and shopping lists' },
  head: { name: 'Head Chef', blurb: 'Everything in Chef de Partie plus the monthly AIchef.food Magazine and priority Malcolm' },
  gastronomique: { name: 'Gastronomique · Lux Prime', blurb: 'Everything in Head Chef, shared with up to 5 household members' },
  restaurant: { name: 'Restauranteur', blurb: 'Everything in Head Chef plus restaurant & pub website analysis and the Menu Builder' },
  magazine: { name: 'AIchef.food Magazine', blurb: 'The monthly personalised AIchef.food Magazine, by email and PDF' }
};
const TERMS = [1, 3, 6, 12];
const EXPIRY_DAYS = 365; const DAY = 864e5;
// Price in pence: monthly × months; 12 months = the annual price (the annual saving passes to the buyer).
function amountPence(plan, months) {
  const p = PRICES[plan]; if (!p || !TERMS.includes(months)) return null;
  return Math.round((months === 12 ? p[1] : p[0] * months) * 100);
}
const gbp = pence => '£' + (pence % 100 ? (pence / 100).toFixed(2) : String(pence / 100));
const termLabel = m => m === 1 ? '1 month' : m === 12 ? '12 months (1 year)' : `${m} months`;

const OrderSchema = z.object({
  plan: z.enum(Object.keys(GIFT_PLANS)), months: z.coerce.number().int().refine(m => TERMS.includes(m), 'Choose 1, 3, 6 or 12 months'),
  delivery: z.enum(['email', 'print']), buyerName: z.string().trim().min(1).max(80),
  recipientName: z.string().trim().min(1).max(80), recipientEmail: z.string().trim().toLowerCase().email().max(200).optional().or(z.literal('')),
  message: z.string().trim().max(600).default(''), sendOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal(''))
}).superRefine((o, ctx) => {
  if (o.delivery === 'email' && !o.recipientEmail) ctx.addIssue({ code: 'custom', path: ['recipientEmail'], message: "Add the recipient's email" });
  if (o.sendOn) { const t = Date.parse(o.sendOn + 'T08:00:00Z'); if (!t || t > Date.now() + 366 * DAY) ctx.addIssue({ code: 'custom', path: ['sendOn'], message: 'Send date must be within a year' }); }
});

const ALPHA = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O, 1/I/L, U
function randomCode() {
  const b = new Uint8Array(12); globalThis.crypto.getRandomValues(b); let s = '';
  for (const x of b) s += ALPHA[x % ALPHA.length]; // 30^12 ≈ 2^59
  return `AICF-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
const normCode = s => { const t = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^AICF/, ''); return t.length === 12 ? `AICF-${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8)}` : null; };
async function hashCode(code) { const d = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode('aichef-gift:' + code)); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''); }
const token = (n = 24) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return [...b].map(x => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[x & 63]).join(''); };
const getJ = async (kv, k) => { const v = await kv.get(k); return v ? JSON.parse(v) : null; };
const putJ = (kv, k, v, opts) => kv.put(k, JSON.stringify(v), opts);

// Pending order (before payment). The buyer token lets the buyer view status/certificate later.
async function createOrder(kv, input, buyer) {
  const o = OrderSchema.parse(input); const id = token(12); const amount = amountPence(o.plan, o.months);
  const order = { id, buyerToken: token(), status: 'pending', plan: o.plan, months: o.months, amount, delivery: o.delivery, buyerName: o.buyerName, buyerEmail: buyer.email, buyerId: buyer.id,
    recipientName: o.recipientName, recipientEmail: o.recipientEmail || '', message: o.message, sendOn: o.delivery === 'email' ? (o.sendOn || '') : '', createdAt: Date.now() };
  await putJ(kv, `giftorder/${id}`, order, { expirationTtl: 400 * DAY / 1000 });
  return order;
}
// Webhook fulfilment: idempotent; only called after Stripe confirms payment.
async function fulfil(kv, orderId, session, now = Date.now()) {
  const order = await getJ(kv, `giftorder/${orderId}`); if (!order) return { error: 'unknown order' };
  if (order.status !== 'pending') return { order, already: true };
  if (session && (session.payment_status !== 'paid' || +session.amount_total !== order.amount)) return { error: 'not paid' };
  let code, h; for (let i = 0; i < 5; i++) { code = randomCode(); h = await hashCode(code); if (!(await kv.get(`gift/code/${h}`))) break; }
  const expiresAt = now + EXPIRY_DAYS * DAY;
  await putJ(kv, `gift/code/${h}`, { orderId, plan: order.plan, months: order.months, status: 'unredeemed', expiresAt, recipientName: order.recipientName }, { expirationTtl: (EXPIRY_DAYS + 60) * 86400 });
  Object.assign(order, { status: 'paid', code, paidAt: now, expiresAt, sessionId: session && session.id });
  const sendAt = order.delivery === 'email' ? (order.sendOn ? Math.max(now, Date.parse(order.sendOn + 'T08:00:00Z')) : now) : null;
  order.sendAt = sendAt; order.emailStatus = order.delivery === 'email' ? (sendAt > now + 60e3 ? 'scheduled' : 'due') : 'n/a';
  await putJ(kv, `giftorder/${orderId}`, order);
  if (order.emailStatus === 'scheduled') await putJ(kv, `gift/sched/${String(sendAt).padStart(14, '0')}-${orderId}`, { orderId, sendAt });
  return { order };
}

// Grants: { member: [entry], magazine: [entry] }, entry { plan, months, code8, start?, end? }. Entries run back-to-back.
const addMonths = (t, m) => { const d = new Date(t); d.setUTCMonth(d.getUTCMonth() + m); return +d; };
const hasPaidSub = u => !!u && !!u.stripe_subscription_id && u.plan !== 'free' && ['active', 'trialing', 'past_due'].includes(u.sub_status);
// Start any due entries; a member gift waits while the recipient's own paid subscription is active (queued), then runs.
function resolve(grant, u, now = Date.now()) {
  if (!grant) return { changed: false, active: {} };
  let changed = false; const active = {};
  for (const track of ['member', 'magazine']) {
    let cursor = 0;
    for (const e of grant[track] || []) {
      if (!e.start) { if (track === 'member' && hasPaidSub(u)) break; e.start = Math.max(now, cursor); e.end = addMonths(e.start, e.months); changed = true; }
      cursor = Math.max(cursor, e.end);
      if (e.start <= now && now < e.end && !active[track]) active[track] = e;
    }
    const before = (grant[track] || []).length; grant[track] = (grant[track] || []).filter(e => !e.end || e.end > now); if (grant[track].length !== before) changed = true;
  }
  return { changed, active };
}
// Apply an active grant to a user row in memory (no card, no Stripe). Own paid subs are never downgraded.
function applyGrant(u, active) {
  if (!u || !active) return u; let v = u;
  if (active.member && !hasPaidSub(u)) v = { ...v, plan: active.member.plan, sub_status: 'active', _gift: { plan: active.member.plan, until: active.member.end }, _trial: false, trial_ends_at: null };
  if (active.magazine) v = { ...v, _magGift: { until: active.magazine.end } };
  return v;
}
async function grantFor(kv, u, now = Date.now()) {
  if (!kv || !u) return u; const g = await getJ(kv, `grant/${u.id}`); if (!g) return u;
  const r = resolve(g, u, now); if (r.changed) await putJ(kv, `grant/${u.id}`, g);
  return applyGrant(u, r.active);
}
// Redeem: single-use; requires a signed-in user. Extends an existing gift of the same plan, otherwise queues after it.
async function redeem(kv, rawCode, u, now = Date.now()) {
  const code = normCode(rawCode); if (!code) return { error: 'That doesn’t look like a gift code (AICF-XXXX-XXXX-XXXX)', status: 400 };
  const h = await hashCode(code); const rec = await getJ(kv, `gift/code/${h}`);
  if (!rec) return { error: 'We couldn’t find that gift code — check it and try again', status: 404 };
  if (rec.status === 'redeemed') return { error: 'This gift code has already been redeemed', status: 409 };
  if (now > rec.expiresAt) return { error: 'This gift code has expired', status: 410 };
  if (await kv.get(`gift/lock/${h}`)) return { error: 'This gift code is being redeemed — refresh in a moment', status: 409 };
  await kv.put(`gift/lock/${h}`, '1', { expirationTtl: 60 });
  const g = (await getJ(kv, `grant/${u.id}`)) || { member: [], magazine: [] }; const track = rec.plan === 'magazine' ? 'magazine' : 'member';
  resolve(g, u, now); const list = g[track] = g[track] || [];
  const last = list[list.length - 1]; let how;
  if (last && last.plan === rec.plan) { last.months += rec.months; if (last.end) last.end = addMonths(last.start, last.months); how = 'extended'; }
  else { list.push({ plan: rec.plan, months: rec.months, code8: code.slice(-4), at: now }); how = list.length > 1 ? 'queued' : 'started'; }
  const r = resolve(g, u, now); if (track === 'member' && hasPaidSub(u) && !list.some(e => e.start)) how = 'queued';
  await putJ(kv, `grant/${u.id}`, g);
  await putJ(kv, `gift/code/${h}`, { ...rec, status: 'redeemed', redeemedAt: now, redeemedBy: u.id }, { expirationTtl: 400 * 86400 });
  const order = await getJ(kv, `giftorder/${rec.orderId}`); if (order) { order.redeemedAt = now; await putJ(kv, `giftorder/${rec.orderId}`, order); }
  const e = list.find(x => x.plan === rec.plan && (!x.end || x.end > now)) || list[list.length - 1];
  return { ok: true, plan: rec.plan, planName: GIFT_PLANS[rec.plan].name, months: rec.months, how, until: e && e.end || null, active: r.active };
}
async function status(kv, rawCode, now = Date.now()) {
  const code = normCode(rawCode); if (!code) return { valid: false };
  const rec = await getJ(kv, `gift/code/${await hashCode(code)}`); if (!rec) return { valid: false };
  return { valid: rec.status === 'unredeemed' && now <= rec.expiresAt, status: now > rec.expiresAt && rec.status !== 'redeemed' ? 'expired' : rec.status, plan: rec.plan, planName: GIFT_PLANS[rec.plan].name, months: rec.months, expiresAt: rec.expiresAt, recipientName: rec.recipientName };
}
// Scheduled emails due now (cron).
async function dueScheduled(kv, now = Date.now()) {
  const { keys } = await kv.list({ prefix: 'gift/sched/' }); const out = [];
  for (const k of keys) { const v = await getJ(kv, k.name); if (v && v.sendAt <= now) out.push({ key: k.name, ...v }); }
  return out;
}
const fmtDate = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function recipientEmail(order, base) {
  const p = GIFT_PLANS[order.plan]; const url = `${base}/redeem?code=${encodeURIComponent(order.code)}`;
  const text = `Dear ${order.recipientName},\n\n${order.buyerName} has given you ${termLabel(order.months)} of ${p.name} on AIchef.food.\n\n${order.message ? `“${order.message}”\n\n` : ''}Your gift code: ${order.code}\nRedeem it here (sign in or create a free account; no card needed): ${url}\n\n${p.blurb}.\n\nRedeem by ${fmtDate(order.expiresAt)}. Bon appétit!\nMalcolm · AIchef.food`;
  const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:auto;color:#2b2118"><p style="letter-spacing:.2em;font-size:12px;color:#9a7b3f">A GIFT FROM ${esc(order.buyerName.toUpperCase())}</p><h1 style="font-weight:normal">${esc(termLabel(order.months))} of ${esc(p.name)}</h1><p>Dear ${esc(order.recipientName)},</p>${order.message ? `<blockquote style="font-style:italic;border-left:3px solid #c9a14a;margin:0;padding:4px 14px">${esc(order.message)}</blockquote>` : ''}<p>${esc(p.blurb)}.</p><p style="font-size:20px;letter-spacing:.12em;background:#f7f1e6;padding:12px;text-align:center"><b>${esc(order.code)}</b></p><p style="text-align:center"><a href="${esc(url)}" style="background:#2b2118;color:#fff;padding:12px 22px;text-decoration:none;border-radius:6px">Redeem your gift</a></p><p style="font-size:12px;color:#777">Sign in or create a free account to redeem — no card needed. Redeem by ${fmtDate(order.expiresAt)}.</p></div>`;
  return { to: order.recipientEmail, subject: `${order.buyerName} sent you a gift: ${p.name} on AIchef.food`, text, html };
}
function receiptEmail(order, base) {
  const p = GIFT_PLANS[order.plan]; const view = `${base}/gift?order=${order.id}&t=${order.buyerToken}`;
  const deliv = order.delivery === 'print' ? `Print or download the gift certificate: ${view}` : order.emailStatus === 'scheduled' ? `We’ll email ${order.recipientName} on ${fmtDate(order.sendAt)}.` : `We’ve emailed ${order.recipientName} (${order.recipientEmail}).`;
  const text = `Thank you, ${order.buyerName}!\n\nReceipt — AIchef.food Gift\n${p.name}, ${termLabel(order.months)}: ${gbp(order.amount)} (paid once, no renewal)\nFor: ${order.recipientName}\nOrder: ${order.id}\n\n${deliv}\nGift code (keep it safe): ${order.code}\nView your order and certificate: ${view}\n\nThe code is single-use and can be redeemed until ${fmtDate(order.expiresAt)}. Gifts are non-refundable once redeemed.\nMalcolm · AIchef.food`;
  return { to: order.buyerEmail, subject: `Your AIchef.food gift receipt — ${p.name}, ${termLabel(order.months)}`, text };
}

// Elegant landscape A4 gift certificate with the code and a QR code to the redeem page.
function certificatePdf(order, fonts, base = 'https://aichef.food') {
  const { Doc } = require('./pdf'); const qrgen = require('qrcode-generator'); const p = GIFT_PLANS[order.plan];
  const doc = new Doc({ title: `AIchef.food Gift Certificate — ${p.name}`, fontFiles: fonts }); const W = 841.89, H = 595.28; const pg = doc.page(W, H);
  const gold = '#b08d3c', ink = '#2b2118', cream = '#fbf6ec';
  pg.rect(0, 0, W, H, cream); pg.rect(22, 22, W - 44, H - 44, null, { stroke: gold, lw: 2 }); pg.rect(30, 30, W - 60, H - 60, null, { stroke: gold, lw: 0.6 });
  for (const [x, y] of [[30, 30], [W - 30, 30], [30, H - 30], [W - 30, H - 30]]) pg.rect(x - 5, y - 5, 10, 10, gold);
  pg.text('AICHEF.FOOD', W / 2, 78, { font: 'sansB', size: 11, color: gold, align: 'center', spacing: 4 });
  pg.text('Gift Certificate', W / 2, 128, { font: 'serifI', size: 44, color: ink, align: 'center' });
  pg.line(W / 2 - 120, 146, W / 2 + 120, 146, gold, 0.8);
  pg.text('PRESENTED TO', 80, 196, { font: 'sans', size: 9, color: gold, spacing: 2.5 });
  pg.text(order.recipientName, 80, 230, { font: 'serifB', size: 28, color: ink, maxW: 470 });
  pg.text(`${termLabel(order.months)} of ${p.name}`, 80, 266, { font: 'serifI', size: 18, color: ink, maxW: 480 });
  let y = pg.para(p.blurb + '.', 80, 292, 470, { font: 'serif', size: 11, color: '#5a4a3a', maxLines: 2 });
  if (order.message) { pg.rect(80, y + 4, 2, 56, gold); y = pg.para('“' + order.message + '”', 92, y + 18, 460, { font: 'serifI', size: 12, color: ink, maxLines: 4 }); }
  pg.text(`WITH LOVE FROM  ${String(order.buyerName).toUpperCase()}`, 80, Math.max(y + 22, 420), { font: 'sans', size: 9, color: gold, spacing: 2, maxW: 470 });
  // Code panel
  pg.rect(80, 448, 470, 64, '#f3ead8', { stroke: gold, lw: 0.6 });
  pg.text('YOUR GIFT CODE', 96, 468, { font: 'sans', size: 8, color: gold, spacing: 2 });
  pg.text(order.code, 96, 498, { font: 'sansB', size: 22, color: ink, spacing: 1.6 });
  pg.text(`Redeem at ${base.replace(/^https?:\/\//, '')}/redeem by ${fmtDate(order.expiresAt)} · sign in or create a free account · no card needed`, 80, 532, { font: 'sans', size: 8, color: '#6b5a48', maxW: 480 });
  // QR
  const url = `${base}/redeem?code=${encodeURIComponent(order.code)}`; const qr = qrgen(0, 'M'); qr.addData(url); qr.make();
  const n = qr.getModuleCount(), S = 190, cell = S / (n + 8), qx = W - 80 - S, qy = 200;
  pg.rect(qx, qy, S, S, '#ffffff', { stroke: gold, lw: 0.6 });
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) pg.rect(qx + (c + 4) * cell, qy + (r + 4) * cell, cell + 0.05, cell + 0.05, ink);
  pg.link(qx, qy, S, S, url);
  pg.text('SCAN TO REDEEM', qx + S / 2, qy + S + 20, { font: 'sansB', size: 8, color: gold, align: 'center', spacing: 2 });
  pg.text('Single use · non-refundable once redeemed', qx + S / 2, qy + S + 36, { font: 'sans', size: 7.5, color: '#6b5a48', align: 'center' });
  return doc.save();
}
module.exports = { certificatePdf, GIFT_PLANS, TERMS, EXPIRY_DAYS, amountPence, gbp, termLabel, OrderSchema, randomCode, normCode, hashCode, createOrder, fulfil, resolve, applyGrant, grantFor, redeem, status, dueScheduled, recipientEmail, receiptEmail, hasPaidSub, fmtDate };
