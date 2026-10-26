const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs');
const G = require('../src/gift'); const plans = require('../src/plans');
const kv = () => { const m = new Map(); return { m, get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async ({ prefix }) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }) }; };
const buyer = { id: 1, email: 'buyer@example.com' };
const input = { plan: 'head', months: 3, delivery: 'email', buyerName: 'Ollie', recipientName: 'Sam', recipientEmail: 'sam@example.com', message: 'Enjoy!' };
const paid = o => ({ id: 'cs_test', payment_status: 'paid', amount_total: o.amount });
test('pricing: monthly × months, 12 months = annual price', () => {
  assert.strictEqual(G.amountPence('head', 1), 799); assert.strictEqual(G.amountPence('head', 3), 2397); assert.strictEqual(G.amountPence('head', 12), 7900);
  assert.strictEqual(G.amountPence('restaurant', 6), 17400); assert.strictEqual(G.amountPence('magazine', 12), 3490); assert.strictEqual(G.amountPence('head', 2), null);
});
test('codes are random, well-formed, normalised and stored only as hashes', async () => {
  const a = new Set(Array.from({ length: 500 }, G.randomCode)); assert.strictEqual(a.size, 500);
  for (const c of a) assert.match(c, /^AICF-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
  assert.strictEqual(G.normCode('aicf gyeh qbxs p2mq'), 'AICF-GYEH-QBXS-P2MQ'); assert.strictEqual(G.normCode('nope'), null);
  const s = kv(); const o = await G.createOrder(s, input, buyer); const { order } = await G.fulfil(s, o.id, paid(o));
  assert.ok(![...s.m.keys()].some(k => k.includes(order.code))); assert.ok(s.m.has('gift/code/' + await G.hashCode(order.code)));
});
test('fulfil only after payment, exactly once; schedules future emails', async () => {
  const s = kv(); const o = await G.createOrder(s, input, buyer);
  assert.ok((await G.fulfil(s, o.id, { payment_status: 'unpaid', amount_total: o.amount })).error);
  assert.ok((await G.fulfil(s, o.id, { payment_status: 'paid', amount_total: 1 })).error);
  const r = await G.fulfil(s, o.id, paid(o)); assert.strictEqual(r.order.status, 'paid'); assert.strictEqual(r.order.emailStatus, 'due');
  const again = await G.fulfil(s, o.id, paid(o)); assert.ok(again.already); assert.strictEqual(again.order.code, r.order.code);
  const later = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const o2 = await G.createOrder(s, { ...input, sendOn: later }, buyer); const r2 = await G.fulfil(s, o2.id, paid(o2)); assert.strictEqual(r2.order.emailStatus, 'scheduled');
  assert.strictEqual((await G.dueScheduled(s)).length, 0); assert.strictEqual((await G.dueScheduled(s, Date.now() + 6 * 864e5)).length, 1);
  assert.throws(() => G.OrderSchema.parse({ ...input, recipientEmail: '' })); assert.ok(G.OrderSchema.parse({ ...input, delivery: 'print', recipientEmail: '' }));
});
test('redeem: single-use, grants plan without card, extends same plan, queues behind a paid sub', async () => {
  const s = kv(); const mk = async (extra = {}) => { const o = await G.createOrder(s, { ...input, ...extra }, buyer); return (await G.fulfil(s, o.id, paid(o))).order.code; };
  const free = { id: 7, plan: 'free', sub_status: null, email: 'r@example.com' };
  const c1 = await mk(); const r = await G.redeem(s, c1.toLowerCase(), free); assert.ok(r.ok); assert.strictEqual(r.how, 'started');
  assert.strictEqual((await G.redeem(s, c1, free)).status, 409);
  let u = await G.grantFor(s, free); assert.strictEqual(u.plan, 'head'); assert.strictEqual(u.sub_status, 'active'); assert.ok(plans.isPremium(u)); assert.ok(plans.magazineIncluded(u));
  const until1 = u._gift.until; const c2 = await mk(); assert.strictEqual((await G.redeem(s, c2, free)).how, 'extended');
  u = await G.grantFor(s, free); assert.ok(u._gift.until > until1 + 80 * 864e5);
  // paid subscriber: member gift queued; magazine gift starts now
  const sub = { id: 9, plan: 'monthly', sub_status: 'active', stripe_subscription_id: 'sub_x', email: 's@example.com' };
  assert.strictEqual((await G.redeem(s, await mk({ plan: 'restaurant' }), sub)).how, 'queued');
  let v = await G.grantFor(s, sub); assert.strictEqual(v.plan, 'monthly'); assert.ok(!v._gift);
  v = await G.grantFor(s, { ...sub, sub_status: 'canceled' }); assert.strictEqual(v.plan, 'restaurant'); assert.ok(plans.isRestaurateur(v));
  await G.redeem(s, await mk({ plan: 'magazine' }), sub); v = await G.grantFor(s, sub); assert.ok(plans.magazineIncluded(v)); assert.strictEqual(v.plan, 'monthly');
  // expiry + garbage
  const c3 = await mk(); assert.strictEqual((await G.redeem(s, c3, free, Date.now() + 400 * 864e5)).status, 410);
  assert.strictEqual((await G.redeem(s, 'AICF-AAAA-BBBB-CCCC', free)).status, 404);
  assert.strictEqual((await G.status(s, c3)).valid, true);
});
test('grants lapse after the term', async () => {
  const g = { member: [{ plan: 'head', months: 1, start: Date.now() - 40 * 864e5, end: Date.now() - 9 * 864e5 }], magazine: [] };
  const r = G.resolve(g, { id: 1, plan: 'free' }); assert.ok(!r.active.member); assert.strictEqual(g.member.length, 0);
});
test('emails and certificate', async () => {
  const s = kv(); const o = await G.createOrder(s, { ...input, message: '<b>hi</b>' }, buyer); const { order } = await G.fulfil(s, o.id, paid(o));
  const e = G.recipientEmail(order, 'https://aichef.food'); assert.strictEqual(e.to, 'sam@example.com'); assert.ok(e.text.includes(order.code)); assert.ok(!e.html.includes('<b>hi'));
  const rc = G.receiptEmail(order, 'https://aichef.food'); assert.strictEqual(rc.to, 'buyer@example.com'); assert.match(rc.text, /non-refundable once redeemed/); assert.match(rc.text, /£23\.97/);
  const fonts = Object.fromEntries(['serif', 'serifI', 'serifB', 'sans', 'sansB'].map(k => [k, new Uint8Array(fs.readFileSync(__dirname + '/../public/mag/' + k + '.bin'))]));
  const pdf = Buffer.from(G.certificatePdf(order, fonts)); assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-'); assert.ok(pdf.toString('latin1').includes('/URI (https://aichef.food/redeem?code='));
});
