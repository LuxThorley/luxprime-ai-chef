const test = require('node:test'); const assert = require('node:assert'); const { ensureCustomer } = require('../src/stripecust');
const mk = (getImpl) => { const log = []; return { log, opts: { key: 'sk_live_x', get: getImpl, create: async (p, d) => { log.push(['create', d]); return { id: 'cus_new' }; }, onReplace: async (id, old) => log.push(['replace', id, old]) } }; };
test('valid live customer is reused', async () => { const m = mk(async () => ({ id: 'cus_ok', livemode: true })); const r = await ensureCustomer({ id: 1, email: 'a@example.com', stripe_customer_id: 'cus_ok' }, m.opts); assert.deepStrictEqual(r, { id: 'cus_ok', replaced: false }); assert.strictEqual(m.log.length, 0); });
test('stale test-mode id is replaced and old id kept', async () => {
  const m = mk(async () => { throw new Error("Stripe 404: No such customer: 'cus_old'; a similar object exists in test mode, but a live mode key was used"); });
  const r = await ensureCustomer({ id: 2, email: 'b@example.com', stripe_customer_id: 'cus_old' }, m.opts);
  assert.strictEqual(r.id, 'cus_new'); assert.ok(r.replaced); assert.strictEqual(m.log[0][1]['metadata[previous_customer_id]'], 'cus_old'); assert.deepStrictEqual(m.log[1], ['replace', 'cus_new', 'cus_old']);
});
test('livemode mismatch and deleted customers are replaced', async () => {
  for (const cu of [{ id: 'cus_t', livemode: false }, { id: 'cus_d', deleted: true }]) { const m = mk(async () => cu); assert.strictEqual((await ensureCustomer({ id: 3, email: 'c@example.com', stripe_customer_id: cu.id }, m.opts)).id, 'cus_new'); }
});
test('other Stripe errors are not swallowed', async () => { const m = mk(async () => { throw new Error('Stripe 500: boom'); }); await assert.rejects(ensureCustomer({ id: 4, email: 'd@example.com', stripe_customer_id: 'cus_x' }, m.opts)); });
