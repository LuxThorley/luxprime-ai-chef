'use strict';
// Hardening round 2 (29 Oct 2026): hashed session IDs, per-account login throttle, security.txt, log redaction, Worker config lockdown.
const test = require('node:test'); const assert = require('node:assert'); const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const W = (...p) => path.join(__dirname, '..', 'worker', ...p);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// In-memory fake D1 that understands just the statements these flows use.
function fakeDB(user) {
  const sessions = new Map(); const fails = new Map(); const rl = new Map(); const log = [];
  const exec = (sql, a) => {
    log.push([sql, a]);
    if (/FROM sessions s JOIN users u/.test(sql)) { const s = sessions.get(a[0]); return s && s.expires_at > a[1] && user && s.user_id === user.id ? { ...user } : null; }
    if (/^INSERT INTO sessions/.test(sql)) { sessions.set(a[0], { user_id: a[1], expires_at: a[2] }); return null; }
    if (/^DELETE FROM sessions WHERE id=\?/.test(sql)) { sessions.delete(a[0]); return null; }
    if (/FROM users WHERE email=\?/.test(sql)) return user && user.email === a[0] ? { ...user } : null;
    if (/^SELECT .*FROM login_failures WHERE k=\?/.test(sql)) return fails.get(a[0]) || null;
    if (/INSERT OR REPLACE INTO login_failures/.test(sql)) { fails.set(a[0], { fails: a[1], last_at: a[2], locked_until: a[3] }); return null; }
    if (/DELETE FROM login_failures WHERE k=\?/.test(sql)) { fails.delete(a[0]); return null; }
    if (/FROM rate_limits WHERE k=\?/.test(sql)) return rl.get(a[0]) || null;
    if (/INSERT OR REPLACE INTO rate_limits/.test(sql)) { rl.set(a[0], { n: a[1], reset_at: a[2] }); return null; }
    if (/UPDATE rate_limits SET n=n\+1/.test(sql)) { const r = rl.get(a[0]); if (r) r.n++; return null; }
    return null;
  };
  const prepare = sql => { let a = []; const s = { bind: (...x) => { a = x; return s; }, first: async () => exec(sql, a), run: async () => { exec(sql, a); return { meta: { changes: 1 } }; }, all: async () => ({ results: [] }) }; return s; };
  return { DB: { prepare, batch: async l => Promise.all(l.map(s => s.run())) }, sessions, fails, log };
}
const env = DB => ({ DB, IMAGES: { get: async () => null, put: async () => {}, delete: async () => {} } });
const post = (url, body, cookie = '') => new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'tok', cookie: `lp_csrf=tok${cookie ? '; ' + cookie : ''}`, 'cf-connecting-ip': '203.0.113.' + Math.floor(Math.random() * 250) }, body: JSON.stringify(body) });
let mod; const app = async () => (mod ||= await import(W('src', 'index.js'))).default;
const ctx = { waitUntil() {} };
async function mkUser() { const { hashPassword } = await import(W('src', 'crypto.js')); return { id: 7, email: 'chef@example.com', password_hash: await hashPassword('correct horse'), plan: 'free', searches_used: 0, email_verified: 1 }; }

test('sessions: D1 stores only SHA-256 of the cookie; lookup and logout use the hash', async () => {
  const a = await app(); const u = await mkUser(); const f = fakeDB(u);
  const r = await a.fetch(post('https://aichef.food/api/auth/login', { email: u.email, password: 'correct horse' }), env(f.DB), ctx);
  assert.equal(r.status, 200);
  const sid = /lp_session=([^;]+)/.exec(r.headers.get('set-cookie'))[1];
  assert.equal(f.sessions.size, 1); const stored = [...f.sessions.keys()][0];
  assert.notEqual(stored, sid); assert.equal(stored, sha('sid:' + sid)); assert.ok(![...f.sessions.keys()].includes(sid));
  const me = await (await a.fetch(new Request('https://aichef.food/api/me', { headers: { cookie: `lp_session=${sid}` } }), env(f.DB), ctx)).json();
  assert.equal(me.user && me.user.email, u.email);
  const forged = await (await a.fetch(new Request('https://aichef.food/api/me', { headers: { cookie: `lp_session=${stored}` } }), env(f.DB), ctx)).json();
  assert.equal(forged.user, null, 'a leaked DB value must not work as a cookie');
  await a.fetch(post('https://aichef.food/api/auth/logout', {}, `lp_session=${sid}`), env(f.DB), ctx); assert.equal(f.sessions.size, 0);
});

test('login throttle: 10 free failures, then exponential per-account lock; success clears; unknown emails behave the same', async () => {
  const a = await app(); const u = await mkUser(); const f = fakeDB(u);
  for (let i = 1; i <= 10; i++) assert.equal((await a.fetch(post('https://aichef.food/api/auth/login', { email: u.email, password: 'wrong pass ' + i }), env(f.DB), ctx)).status, 401);
  assert.equal([...f.fails.values()][0].locked_until, 0, 'ten mistakes do not lock anyone out');
  assert.equal((await a.fetch(post('https://aichef.food/api/auth/login', { email: u.email, password: 'wrong pass 11' }), env(f.DB), ctx)).status, 401);
  const locked = await a.fetch(post('https://aichef.food/api/auth/login', { email: u.email, password: 'correct horse' }), env(f.DB), ctx);
  assert.equal(locked.status, 429); assert.ok(+locked.headers.get('retry-after') > 0 && +locked.headers.get('retry-after') <= 60);
  assert.ok(![...f.fails.keys()].some(k => k.includes('@')), 'throttle keys never contain the email');
  // lock expires -> correct password works and clears the counter
  for (const v of f.fails.values()) v.locked_until = Date.now() - 1;
  assert.equal((await a.fetch(post('https://aichef.food/api/auth/login', { email: u.email, password: 'correct horse' }), env(f.DB), ctx)).status, 200);
  assert.equal(f.fails.size, 0);
  const g = await import(W('src', 'loginguard.js'));
  assert.deepEqual([9, 10, 11, 12, 13, 20].map(g.lockFor), [0, 0, 60e3, 120e3, 240e3, 15 * 60e3]);
  for (let i = 0; i < 11; i++) await a.fetch(post('https://aichef.food/api/auth/login', { email: 'nobody@example.com', password: 'whatever12' }), env(f.DB), ctx);
  assert.equal((await a.fetch(post('https://aichef.food/api/auth/login', { email: 'nobody@example.com', password: 'whatever12' }), env(f.DB), ctx)).status, 429);
  // quiet hour resets the count
  const D = fakeDB(null); const t0 = Date.now(); for (let i = 0; i < 9; i++) await g.fail(D.DB, 'x@example.com', t0);
  assert.equal((await g.fail(D.DB, 'x@example.com', t0 + g.WINDOW_MS + 1)).fails, 1);
});

test('security.txt: served at /.well-known/security.txt with published contact, ~1 year Expires and security headers', async () => {
  const a = await app(); const f = fakeDB(null);
  const r = await a.fetch(new Request('https://aichef.food/.well-known/security.txt'), env(f.DB), ctx); const t = await r.text();
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /^text\/plain/);
  assert.match(t, /^Contact: mailto:malcolm@aichef\.food$/m); assert.match(t, /^Canonical: https:\/\/aichef\.food\/\.well-known\/security\.txt$/m);
  const exp = Date.parse(/^Expires: (.+)$/m.exec(t)[1]); assert.ok(Math.abs(exp - Date.now() - 365 * 864e5) < 864e5);
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'public', 'privacy.html'), 'utf8').includes('malcolm@aichef.food'), 'contact must be an address the site already publishes');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.match(r.headers.get('strict-transport-security') || '', /max-age=31536000/);
  const legacy = await a.fetch(new Request('https://aichef.food/security.txt'), env(f.DB), ctx); assert.equal(legacy.status, 301);
});

test('log redaction: emails, query strings, JWTs, keys and long tokens never reach persisted logs', async () => {
  const { redact, installLogRedaction } = await import(W('src', 'logredact.js'));
  const out = redact('mail to Chef.Test+1@Example.co.uk failed for https://aichef.food/gift?order=AB&t=ddK5SvBE73qOOI9hWU17 Bearer abcdefghijklmnop eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl sk_live_ABCDEFGH12345678 ' + 'a'.repeat(64));
  for (const bad of ['Chef.Test', 'Example.co.uk', 'order=AB', 'ddK5Sv', 'abcdefghijklmnop', 'eyJhbGci', 'sk_live_', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) assert.ok(!out.includes(bad), bad + ' leaked: ' + out);
  assert.match(out, /\[email\]/); assert.match(out, /https:\/\/aichef\.food\/gift\?\[query\]/);
  const seen = []; const con = { log: (...a) => seen.push(a), error: (...a) => seen.push(a) }; installLogRedaction(con);
  con.error('verify email', new Error('rejected for someone@example.com')); con.log({ to: 'a@b.com', n: 1 });
  assert.match(seen[0][1].message, /\[email\]/); assert.deepEqual(seen[1][0], { to: '[email]', n: 1 });
  assert.equal(redact('Malcolm chat ok in 1200 ms'), 'Malcolm chat ok in 1200 ms', 'ordinary messages untouched');
});

test('Worker config: production only via aichef.food (no workers.dev / preview URLs); staging keeps workers.dev but no previews', () => {
  const strip = s => JSON.parse(s.replace(/(^|[^:"])\/\/[^\n]*/g, '$1'));
  const prod = strip(fs.readFileSync(W('wrangler.jsonc'), 'utf8')); const stg = strip(fs.readFileSync(W('wrangler.staging.jsonc'), 'utf8'));
  assert.equal(prod.workers_dev, false); assert.equal(prod.preview_urls, false); assert.equal(stg.preview_urls, false); assert.equal(stg.workers_dev, true);
  for (const c of [prod, stg]) assert.ok(c.assets.run_worker_first.includes('/.well-known/*'));
  for (const f of fs.readdirSync(W('src'))) assert.ok(!fs.readFileSync(W('src', f), 'utf8').includes('luxprime-ai-chef.oliverluxthorley.workers.dev'), f + ' still calls the workers.dev URL');
  const mig = fs.readFileSync(W('migrations', '0015_session_hash_login_throttle.sql'), 'utf8');
  assert.match(mig, /DELETE FROM sessions;/); assert.match(mig, /CREATE TABLE IF NOT EXISTS login_failures/);
});
