'use strict';
const test = require('node:test'); const assert = require('node:assert');
process.env.AI_PROVIDER = 'none'; process.env.JWT_SECRET = 'test-secret'; process.env.IMAGE_PROVIDER = 'none';
const request = require('supertest'); const { createApp } = require('../src/server'); const { open } = require('../src/db'); const AE = require('../src/account-email');

function rig() {
  const sent = []; const fetchImpl = async (url, o) => { const b = JSON.parse(o.body); sent.push(b); return { ok: true, json: async () => ({ id: 'm' + sent.length }), text: async () => '' }; };
  const stripeCalls = []; const stripe = { customers: { update: async (id, p) => { stripeCalls.push([id, p]); return {}; } } };
  const db = open(':memory:'); const mk = () => createApp({ db, stripe, fetchImpl, mailEnv: { RESEND_API_KEY: 'test' } });
  const link = (kind) => { const m = sent.map(s => s.text).join('\n').match(new RegExp(`${kind}=([0-9a-f]{64})`, 'g')); return m && m[m.length - 1].split('=')[1]; };
  return { db, sent, stripeCalls, mk, link };
}
async function member(R, email, pw = 'supersecret1') { const ag = request.agent(R.mk()); const t = (await ag.get('/api/csrf')).body.csrfToken;
  const r = await ag.post('/api/auth/register').set('x-csrf-token', t).send({ email, password: pw }); return { ag, t, id: r.body.user.id }; }

test('email change: re-auth, verification gating, old-address notice, Stripe update, sessions revoked, household follows', async () => {
  const R = rig(); const a = await member(R, 'old@x.co'); R.db.prepare("UPDATE users SET stripe_customer_id='cus_test' WHERE id=?").run(a.id);
  const other = request.agent(R.mk()); const ot = (await other.get('/api/csrf')).body.csrfToken; await other.post('/api/auth/login').set('x-csrf-token', ot).send({ email: 'old@x.co', password: 'supersecret1' });
  assert.equal((await other.get('/api/me')).body.user.id, a.id);
  const owner = R.db.prepare("INSERT INTO users(email,password_hash) VALUES('own@x.co','h')").run().lastInsertRowid;
  R.db.prepare("INSERT INTO plan_members(owner_id,email,user_id,token,status) VALUES(?,?,?,?,?)").run(owner, 'old@x.co', a.id, 'tok1', 'joined');
  assert.equal((await a.ag.post('/api/account/email').send({ newEmail: 'new@x.co', currentPassword: 'supersecret1' })).status, 403); // CSRF
  assert.equal((await a.ag.post('/api/account/email').set('x-csrf-token', a.t).send({ newEmail: 'new@x.co', currentPassword: 'wrongpass1' })).status, 401);
  const r = await a.ag.post('/api/account/email').set('x-csrf-token', a.t).send({ newEmail: 'New@X.co', currentPassword: 'supersecret1' });
  assert.equal(r.status, 200); assert.equal(r.body.pending, 'new@x.co');
  const mailNew = R.sent[R.sent.length - 1]; assert.deepEqual(mailNew.to, ['new@x.co']);
  assert.equal(R.db.prepare('SELECT email FROM users WHERE id=?').get(a.id).email, 'old@x.co'); // not switched before confirmation
  assert.equal((await a.ag.get('/api/account/details')).body.pendingEmail, 'new@x.co');
  assert.equal((await a.ag.post('/api/account/email/confirm').set('x-csrf-token', a.t).send({ token: 'f'.repeat(64) })).status, 400);
  const c = await a.ag.post('/api/account/email/confirm').set('x-csrf-token', a.t).send({ token: R.link('email-change') });
  assert.equal(c.status, 200); assert.equal(c.body.email, 'new@x.co'); assert.equal(c.body.stripe, 'updated'); assert.equal(c.body.oldNotified, true);
  assert.deepEqual(R.stripeCalls, [['cus_test', { email: 'new@x.co' }]]);
  const notice = R.sent[R.sent.length - 1]; assert.deepEqual(notice.to, ['old@x.co']); assert.match(notice.text, /changed from old@x\.co to new@x\.co/);
  assert.equal((await a.ag.get('/api/me')).body.user.email, 'new@x.co'); // this device stays signed in
  assert.equal((await other.get('/api/me')).body.user, null); // other session revoked
  assert.equal(R.db.prepare('SELECT email FROM plan_members WHERE user_id=?').get(a.id).email, 'new@x.co');
  assert.equal((await a.ag.post('/api/account/email/confirm').set('x-csrf-token', a.t).send({ token: R.link('email-change') })).status, 400); // single use
  const l = request.agent(R.mk()); const lt = (await l.get('/api/csrf')).body.csrfToken;
  assert.equal((await l.post('/api/auth/login').set('x-csrf-token', lt).send({ email: 'old@x.co', password: 'supersecret1' })).status, 401);
  assert.equal((await l.post('/api/auth/login').set('x-csrf-token', lt).send({ email: 'new@x.co', password: 'supersecret1' })).status, 200);
});

test('email change: uniqueness at request and at confirmation; isolation of tokens; profile name edit', async () => {
  const R = rig(); const a = await member(R, 'ua@x.co'), b = await member(R, 'ub@x.co');
  assert.equal((await a.ag.post('/api/account/email').set('x-csrf-token', a.t).send({ newEmail: 'UB@x.co', currentPassword: 'supersecret1' })).status, 409);
  assert.equal((await a.ag.post('/api/account/email').set('x-csrf-token', a.t).send({ newEmail: 'free@x.co', currentPassword: 'supersecret1' })).status, 200); const tok = R.link('email-change');
  R.db.prepare("UPDATE users SET email='free@x.co' WHERE id=?").run(b.id); // someone takes it meanwhile
  assert.equal((await a.ag.post('/api/account/email/confirm').set('x-csrf-token', a.t).send({ token: tok })).status, 409);
  assert.equal(R.db.prepare('SELECT email FROM users WHERE id=?').get(a.id).email, 'ua@x.co');
  assert.equal((await b.ag.get('/api/account/details')).body.pendingEmail, null); // b never sees a's pending change
  assert.equal((await a.ag.put('/api/account/profile').set('x-csrf-token', a.t).send({ name: 'Alice' })).body.name, 'Alice');
  assert.equal(R.db.prepare('SELECT name FROM users WHERE id=?').get(b.id).name, null);
  const noMail = createApp({ db: open(':memory:'), stripe: null, mailEnv: {} }); const n = request.agent(noMail); const nt = (await n.get('/api/csrf')).body.csrfToken;
  await n.post('/api/auth/register').set('x-csrf-token', nt).send({ email: 'n@x.co', password: 'supersecret1' });
  assert.equal((await n.post('/api/account/email').set('x-csrf-token', nt).send({ newEmail: 'n2@x.co', currentPassword: 'supersecret1' })).status, 503);
});

test('magazine delivery: verified before use, routing, revert, isolation', async () => {
  const R = rig(); const a = await member(R, 'ma@x.co'), b = await member(R, 'mb@x.co');
  assert.equal((await a.ag.post('/api/magazine/delivery').set('x-csrf-token', a.t).send({ email: 'kitchen@x.co' })).status, 400); // no magazine yet
  for (const m of [a, b]) R.db.prepare("INSERT INTO magazine_subs(user_id,status,opt_in) VALUES(?,'active',1)").run(m.id);
  const row = id => R.db.prepare('SELECT * FROM magazine_subs WHERE user_id=?').get(id); const u = id => R.db.prepare('SELECT * FROM users WHERE id=?').get(id);
  await a.ag.post('/api/magazine/delivery').set('x-csrf-token', a.t).send({ email: 'Kitchen@x.co' });
  assert.deepEqual(R.sent[R.sent.length - 1].to, ['kitchen@x.co']);
  assert.equal(AE.deliveryAddress(u(a.id), row(a.id)), 'ma@x.co'); // unverified: still account email
  assert.equal(AE.deliveryAddress(u(a.id), { delivery_email: 'x@y.z', delivery_verified_at: null }), 'ma@x.co');
  assert.equal((await a.ag.get('/api/account/details')).body.magazine.pending, 'kitchen@x.co');
  const c = await b.ag.post('/api/magazine/delivery/confirm').set('x-csrf-token', b.t).send({ token: R.link('mag-delivery') }); // token is bound to a, whoever clicks
  assert.equal(c.status, 200); assert.equal(AE.deliveryAddress(u(a.id), row(a.id)), 'kitchen@x.co'); assert.equal(AE.deliveryAddress(u(b.id), row(b.id)), 'mb@x.co');
  assert.equal((await a.ag.get('/api/account/details')).body.magazine.usingAccountEmail, false);
  await a.ag.delete('/api/magazine/delivery').set('x-csrf-token', a.t); assert.equal(AE.deliveryAddress(u(a.id), row(a.id)), 'ma@x.co');
  assert.equal((await a.ag.post('/api/magazine/delivery').set('x-csrf-token', a.t).send({ email: 'ma@x.co' })).body.usingAccountEmail, true);
});
