'use strict';
const test = require('node:test'); const assert = require('node:assert');
process.env.AI_PROVIDER = 'none'; process.env.JWT_SECRET = 'test-secret'; process.env.IMAGE_PROVIDER = 'none';
const request = require('supertest'); const { createApp } = require('../src/server'); const { open } = require('../src/db');
const mailer = require('../src/mailer'); const V = require('../src/verify');
const csrf = async ag => (await ag.get('/api/csrf')).body.csrfToken;

test('mailer: one sender, Malcolm From + Reply-To, env override, inactive without key', async () => {
  assert.equal(mailer.from({}), '"Malcolm · AIchef.food" <malcolm@aichef.food>');
  assert.equal(mailer.from({ MAGAZINE_FROM: 'm@x.co' }), 'm@x.co'); assert.equal(mailer.from({ MAIL_FROM: 'a@x.co', MAGAZINE_FROM: 'm@x.co' }), 'a@x.co');
  assert.deepEqual(await mailer.send({}, { to: 'a@b.co', subject: 's', text: 't' }, () => { throw new Error('must not call'); }), { sent: false, reason: 'email-not-configured' });
  let seen; const f = async (url, o) => { seen = { url, o }; return { ok: true, json: async () => ({ id: 'e1' }) }; };
  assert.deepEqual(await mailer.send({ RESEND_API_KEY: 'k' }, { to: 'a@b.co', subject: 's', text: 't' }, f), { sent: true, id: 'e1' });
  const b = JSON.parse(seen.o.body); assert.equal(seen.url, 'https://api.resend.com/emails'); assert.equal(b.from, mailer.DEFAULT_FROM); assert.equal(b.reply_to, 'malcolm@aichef.food'); assert.deepEqual(b.to, ['a@b.co']);
});

test('sign-up: confirm password checked server-side; pending state without a mail key', async () => {
  const ag = request.agent(createApp({ db: open(':memory:'), stripe: null, mailEnv: {} })); const t = await csrf(ag);
  const bad = await ag.post('/api/auth/register').set('x-csrf-token', t).send({ email: 'p@x.co', password: 'supersecret1', confirmPassword: 'supersecret2' });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /match/);
  const r = await ag.post('/api/auth/register').set('x-csrf-token', t).send({ email: 'p@x.co', password: 'supersecret1', confirmPassword: 'supersecret1' });
  assert.equal(r.status, 201); assert.equal(r.body.user.emailVerified, false); assert.equal(r.body.verification, 'pending');
  const rs = await ag.post('/api/auth/verify/resend').set('x-csrf-token', t); assert.equal(rs.status, 503); assert.equal(rs.body.pending, true);
  assert.equal((await ag.post('/api/auth/password').set('x-csrf-token', t).send({ currentPassword: 'supersecret1', newPassword: 'brandnew123', confirmPassword: 'brandnew124' })).status, 400);
  assert.equal((await ag.post('/api/auth/password').set('x-csrf-token', t).send({ currentPassword: 'supersecret1', newPassword: 'brandnew123', confirmPassword: 'brandnew123' })).status, 200);
});

test('verification email: hashed single-use token, 24h expiry, verifies account', async () => {
  const db = open(':memory:'); const sent = [];
  const fetchImpl = async (url, o) => { sent.push(JSON.parse(o.body)); return { ok: true, json: async () => ({ id: 'x' }) }; };
  const ag = request.agent(createApp({ db, stripe: null, fetchImpl, mailEnv: { RESEND_API_KEY: 'test-key' } })); const t = await csrf(ag);
  const r = await ag.post('/api/auth/register').set('x-csrf-token', t).send({ email: 'v@x.co', password: 'supersecret1', confirmPassword: 'supersecret1' });
  assert.equal(r.body.verification, 'sent'); assert.equal(sent.length, 1); assert.equal(sent[0].from, mailer.DEFAULT_FROM); assert.deepEqual(sent[0].to, ['v@x.co']);
  const token = sent[0].text.match(/verify=([0-9a-f]{64})/)[1];
  const row = db.prepare('SELECT * FROM email_tokens').get(); assert.notEqual(row.token_hash, token, 'raw token never stored'); assert.equal(row.token_hash, await V.sha256(token));
  assert.ok(Math.abs(row.expires_at - row.created_at - 24 * 3600e3) < 1000);
  assert.equal((await ag.post('/api/auth/verify').set('x-csrf-token', t).send({ token: 'nope' })).status, 400);
  const ok = await ag.post('/api/auth/verify').set('x-csrf-token', t).send({ token }); assert.equal(ok.status, 200); assert.equal(ok.body.user.emailVerified, true);
  assert.equal((await ag.post('/api/auth/verify').set('x-csrf-token', t).send({ token })).status, 400, 'single use');
  assert.equal((await ag.get('/api/me')).body.user.emailVerified, true);
  // expired tokens are rejected
  const q = { all: async (s, p) => db.prepare(s).all(...p), get: async (s, p) => db.prepare(s).get(...p), run: async (s, p) => db.prepare(s).run(...p) };
  db.prepare('UPDATE users SET email_verified=0').run(); const raw = await V.issue(q, ok.body.user.id, Date.now() - 25 * 3600e3);
  const ex = await V.consume(q, raw); assert.equal(ex.ok, false); assert.equal(ex.expired, true);
});

test('existing accounts are marked verified on upgrade, new ones are not', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path'); const Database = require('better-sqlite3');
  const f = path.join(os.tmpdir(), `vmig-${process.pid}.db`); try { fs.unlinkSync(f); } catch {}
  const d = new Database(f); d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT, plan TEXT NOT NULL DEFAULT 'free', sub_status TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT, searches_used INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP); INSERT INTO users(email,password_hash) VALUES('oliverthorley@hotmail.co.uk','x'),('test@luxprime.chef','x')"); d.close();
  const db = open(f); assert.deepEqual(db.prepare('SELECT email_verified FROM users').all().map(r => r.email_verified), [1, 1]);
  db.prepare("INSERT INTO users(email,password_hash) VALUES('new@x.co','x')").run(); assert.equal(db.prepare("SELECT email_verified FROM users WHERE email='new@x.co'").get().email_verified, 0);
  db.close(); fs.unlinkSync(f);
});
