'use strict';
const test = require('node:test'); const assert = require('node:assert');
process.env.AI_PROVIDER = 'none'; process.env.JWT_SECRET = 'test-secret'; process.env.IMAGE_PROVIDER = 'none';
const request = require('supertest'); const { createApp } = require('../src/server'); const { open } = require('../src/db'); const T = require('../src/twofa');
const ENV = { TOTP_ENC_KEY: 'k'.repeat(40) };
const mk = (db, env = ENV) => createApp({ db, stripe: null, mailEnv: env });
async function agent(db, env) { const ag = request.agent(mk(db, env)); const t = (await ag.get('/api/csrf')).body.csrfToken; return { ag, t }; }
async function member(db, email, env) { const a = await agent(db, env); const r = await a.ag.post('/api/auth/register').set('x-csrf-token', a.t).send({ email, password: 'supersecret1' }); return { ...a, id: r.body.user.id }; }
const secretOf = s => s.manualKey.replace(/\s/g, '');
const codeAt = (sec, ms) => T.totp(sec, ms);
async function enrol(m) { const s = (await m.ag.post('/api/2fa/setup').set('x-csrf-token', m.t).send({ password: 'supersecret1' })).body; const sec = secretOf(s);
  const e = await m.ag.post('/api/2fa/enable').set('x-csrf-token', m.t).send({ code: await codeAt(sec, Date.now() - 30e3) }); return { sec, s, e }; }

test('RFC 6238 vectors, base32 round trip, replay protection, encryption at rest', async () => {
  const sec = T.b32enc(new TextEncoder().encode('12345678901234567890'));
  for (const [t, e] of [[59, '287082'], [1111111109, '081804'], [1234567890, '005924'], [2000000000, '279037']]) assert.equal(await T.totp(sec, t * 1000), e);
  const now = 1234567890000; const st = await T.verifyCode(sec, '005924', { now }); assert.ok(st);
  assert.equal(await T.verifyCode(sec, '005924', { now, lastStep: st }), 0); assert.equal(await T.verifyCode(sec, '12345', { now }), 0);
  const ct = await T.encrypt(ENV, sec); assert.ok(!ct.includes(sec)); assert.equal(await T.decrypt(ENV, ct), sec);
  await assert.rejects(T.decrypt({ TOTP_ENC_KEY: 'z'.repeat(40) }, ct)); await assert.rejects(T.encrypt({}, sec));
  assert.match(T.otpauth('a@x.co', sec), /^otpauth:\/\/totp\/AIchef\.food:a%40x\.co\?secret=[A-Z2-7]+&issuer=AIchef\.food&algorithm=SHA1&digits=6&period=30$/);
  assert.match(T.qrDataUrl('otpauth://x'), /^data:image\/svg\+xml;base64,/);
});

test('enrolment needs password + confirming code; secret stored encrypted; login step-up; backup codes single-use; trusted device', async () => {
  const db = open(':memory:'); const a = await member(db, 'tf@x.co');
  assert.equal((await a.ag.post('/api/2fa/setup').set('x-csrf-token', a.t).send({ password: 'wrongpass1' })).status, 401);
  const s = (await a.ag.post('/api/2fa/setup').set('x-csrf-token', a.t).send({ password: 'supersecret1' })).body; const sec = secretOf(s);
  assert.match(s.qr, /^data:image\/svg/); assert.ok(!db.prepare('SELECT secret_enc FROM user_totp').get().secret_enc.includes(sec));
  assert.equal((await a.ag.get('/api/2fa/status')).body.enabled, false);
  assert.equal((await a.ag.post('/api/2fa/enable').set('x-csrf-token', a.t).send({ code: '000000' })).status, 400);
  const e = await a.ag.post('/api/2fa/enable').set('x-csrf-token', a.t).send({ code: await codeAt(sec, Date.now()) });
  assert.equal(e.status, 200); assert.equal(e.body.backupCodes.length, 10); assert.ok(db.prepare('SELECT code_hash FROM totp_backup_codes').all().every(r => /^[0-9a-f]{64}$/.test(r.code_hash)));
  assert.equal((await a.ag.get('/api/me')).body.user.id, a.id); // enabling device stays signed in
  // Login now needs the second step; no session from password alone
  const b = await agent(db); const l = await b.ag.post('/api/auth/login').set('x-csrf-token', b.t).send({ email: 'tf@x.co', password: 'supersecret1' });
  assert.equal(l.body.twoFactor, 'required'); assert.ok(!l.body.user); assert.equal((await b.ag.get('/api/me')).body.user, null);
  assert.equal(db.prepare('SELECT id_hash FROM login_challenges').get().id_hash.length, 64); assert.notEqual(db.prepare('SELECT id_hash FROM login_challenges').get().id_hash, l.body.challenge);
  const bad = await b.ag.post('/api/auth/2fa').set('x-csrf-token', b.t).send({ challenge: l.body.challenge, code: '000000' }); assert.equal(bad.status, 401); assert.equal(bad.body.attemptsLeft, 4);
  const bk = e.body.backupCodes[0];
  const ok = await b.ag.post('/api/auth/2fa').set('x-csrf-token', b.t).send({ challenge: l.body.challenge, backupCode: bk.toUpperCase(), trustDevice: true });
  assert.equal(ok.status, 200); assert.equal(ok.body.via, 'backup'); assert.equal(ok.body.backupCodesLeft, 9); assert.equal(ok.body.user.email, 'tf@x.co'); assert.ok(!('password_hash' in ok.body.user));
  assert.equal((await b.ag.get('/api/me')).body.user.id, a.id);
  // challenge single use; backup code single use
  assert.equal((await b.ag.post('/api/auth/2fa').set('x-csrf-token', b.t).send({ challenge: l.body.challenge, backupCode: bk })).status, 400);
  const c = await agent(db); const l2 = await c.ag.post('/api/auth/login').set('x-csrf-token', c.t).send({ email: 'tf@x.co', password: 'supersecret1' });
  assert.equal((await c.ag.post('/api/auth/2fa').set('x-csrf-token', c.t).send({ challenge: l2.body.challenge, backupCode: bk })).status, 401);
  // trusted device (b) skips the step; after forgetting devices it doesn't
  await b.ag.post('/api/auth/logout').set('x-csrf-token', b.t);
  const l3 = await b.ag.post('/api/auth/login').set('x-csrf-token', b.t).send({ email: 'tf@x.co', password: 'supersecret1' }); assert.ok(l3.body.user); assert.ok(!l3.body.twoFactor);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM trusted_devices').get().n, 1); assert.equal(db.prepare('SELECT id_hash FROM trusted_devices').get().id_hash.length, 64);
  await a.ag.delete('/api/2fa/devices').set('x-csrf-token', a.t); await b.ag.post('/api/auth/logout').set('x-csrf-token', b.t);
  assert.equal((await b.ag.post('/api/auth/login').set('x-csrf-token', b.t).send({ email: 'tf@x.co', password: 'supersecret1' })).body.twoFactor, 'required');
});

test('challenge brute force capped; expired challenge rejected; another user\'s trust cookie useless', async () => {
  const db = open(':memory:'); const a = await member(db, 'bf@x.co'); await enrol(a);
  const b = await agent(db); const l = await b.ag.post('/api/auth/login').set('x-csrf-token', b.t).send({ email: 'bf@x.co', password: 'supersecret1' });
  for (let i = 0; i < 5; i++) await b.ag.post('/api/auth/2fa').set('x-csrf-token', b.t).send({ challenge: l.body.challenge, code: '000000' });
  assert.equal((await b.ag.post('/api/auth/2fa').set('x-csrf-token', b.t).send({ challenge: l.body.challenge, code: '000000' })).status, 429);
  const l2 = await b.ag.post('/api/auth/login').set('x-csrf-token', b.t).send({ email: 'bf@x.co', password: 'supersecret1' });
  db.prepare('UPDATE login_challenges SET expires_at=1').run();
  assert.equal((await b.ag.post('/api/auth/2fa').set('x-csrf-token', b.t).send({ challenge: l2.body.challenge, code: '000000' })).body.restart, true);
  const o = await member(db, 'other@x.co'); await enrol(o); // a trust row for "other" can't unlock bf@x.co
  db.prepare("INSERT INTO trusted_devices(id_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)").run(await require('../src/verify').sha256('td:' + 'a'.repeat(64)), o.id, Date.now(), Date.now() + 864e5);
  const r = await b.ag.post('/api/auth/login').set('x-csrf-token', b.t).set('Cookie', `lp_trust=${'a'.repeat(64)}; lp_csrf=${b.t}`).send({ email: 'bf@x.co', password: 'supersecret1' });
  assert.equal(r.body.twoFactor, 'required');
});

test('disable needs password + code; admin/tester must enrol (graceful), others optional; no key = feature off', async () => {
  process.env.ADMIN_EMAILS = 'boss@x.co'; process.env.TESTER_EMAILS = 'test@x.co';
  const db = open(':memory:'); const a = await member(db, 'd@x.co'); const { sec } = await enrol(a);
  assert.equal((await a.ag.post('/api/2fa/disable').set('x-csrf-token', a.t).send({ password: 'supersecret1', code: '000000' })).status, 401);
  assert.equal((await a.ag.post('/api/2fa/disable').set('x-csrf-token', a.t).send({ password: 'wrongpass1', code: await codeAt(sec, Date.now() + 30e3) })).status, 401);
  assert.equal((await a.ag.post('/api/2fa/disable').set('x-csrf-token', a.t).send({ password: 'supersecret1', code: await codeAt(sec, Date.now() + 30e3) })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_totp').get().n, 0);
  for (const email of ['boss@x.co', 'test@x.co']) {
    const m = await member(db, email); const me = await m.ag.get('/api/me'); assert.equal(me.status, 200);
    const blocked = await m.ag.get('/api/history'); assert.equal(blocked.status, 403); assert.equal(blocked.body.enrol2fa, true);
    const l = await m.ag.post('/api/auth/login').set('x-csrf-token', m.t).send({ email, password: 'supersecret1' }); assert.equal(l.body.enrol2fa, true);
    assert.equal((await m.ag.get('/api/2fa/status')).body.required, true);
    await enrol(m); assert.notEqual((await m.ag.get('/api/history')).status, 403);
  }
  const plain = await member(db, 'p@x.co'); assert.notEqual((await plain.ag.get('/api/history')).status, 403);
  const off = await member(open(':memory:'), 'boss@x.co', {}); assert.notEqual((await off.ag.get('/api/history')).status, 403); // TOTP_ENC_KEY unset: not enforced
  assert.equal((await off.ag.post('/api/2fa/setup').set('x-csrf-token', off.t).send({ password: 'supersecret1' })).status, 503);
  delete process.env.ADMIN_EMAILS; delete process.env.TESTER_EMAILS;
});

test('password change and 2FA enable revoke other sessions', async () => {
  const db = open(':memory:'); const a = await member(db, 'pw@x.co');
  const b = await agent(db); await b.ag.post('/api/auth/login').set('x-csrf-token', b.t).send({ email: 'pw@x.co', password: 'supersecret1' }); assert.ok((await b.ag.get('/api/me')).body.user);
  assert.equal((await a.ag.post('/api/auth/password').set('x-csrf-token', a.t).send({ currentPassword: 'supersecret1', newPassword: 'newsecret22' })).status, 200);
  assert.equal((await b.ag.get('/api/me')).body.user, null); assert.ok((await a.ag.get('/api/me')).body.user);
  await b.ag.post('/api/auth/login').set('x-csrf-token', b.t).send({ email: 'pw@x.co', password: 'newsecret22' }); assert.ok((await b.ag.get('/api/me')).body.user);
  const s = (await a.ag.post('/api/2fa/setup').set('x-csrf-token', a.t).send({ password: 'newsecret22' })).body;
  await a.ag.post('/api/2fa/enable').set('x-csrf-token', a.t).send({ code: await codeAt(secretOf(s), Date.now()) });
  assert.equal((await b.ag.get('/api/me')).body.user, null); assert.ok((await a.ag.get('/api/me')).body.user);
});
