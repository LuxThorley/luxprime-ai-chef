'use strict';
const test = require('node:test'); const assert = require('node:assert');
process.env.AI_PROVIDER = 'none'; process.env.JWT_SECRET = 'test-secret'; process.env.IMAGE_PROVIDER = 'none';
const M = require('../src/memory'); const request = require('supertest'); const { createApp } = require('../src/server'); const { open } = require('../src/db');

async function member(db, llm, email) {
  const ag = request.agent(createApp({ db, stripe: null, llm })); const t = (await ag.get('/api/csrf')).body.csrfToken;
  const r = await ag.post('/api/auth/register').set('x-csrf-token', t).send({ email, password: 'supersecret1' });
  db.prepare("UPDATE users SET plan='monthly', sub_status='active' WHERE email=?").run(email);
  return { ag, t, id: r.body.user.id };
}
const count = (db, t, id) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE user_id=?`).get(id).n;

test('consent gating: off by default, nothing stored or injected before consent, signed-out never tracked', async () => {
  const db = open(':memory:'); let sys = ''; const llm = async m => { sys = m[0].content; return '{"reply":"A Rioja.","action":"answer"}'; };
  const a = await member(db, llm, 'a@x.co');
  const c0 = await a.ag.get('/api/memory/consent'); assert.equal(c0.body.consent.recorded, false); assert.equal(c0.body.consent.chat, false);
  await a.ag.post('/api/chat').set('x-csrf-token', a.t).send({ message: 'what wine with steak?' });
  await a.ag.post('/api/search').set('x-csrf-token', a.t).send({ include: ['beef'], dish: 'steak' });
  assert.equal((await a.ag.post('/api/memory/event').set('x-csrf-token', a.t).send({ kind: 'page_view', ref: '/app.html' })).body.recorded, false);
  for (const t of ['member_chats', 'member_searches', 'member_events']) assert.equal(count(db, t, a.id), 0, t);
  assert.doesNotMatch(sys, /MEMBER MEMORY/);
  const anon = request.agent(createApp({ db, stripe: null, llm })); const at = (await anon.get('/api/csrf')).body.csrfToken;
  assert.equal((await anon.post('/api/memory/event').set('x-csrf-token', at).send({ kind: 'page_view', ref: '/' })).body.recorded, false);
  assert.equal((await anon.put('/api/memory/consent').set('x-csrf-token', at).send({ chat: true })).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM member_events').get().n, 0);
  // Separate toggles: chat only
  const c1 = await a.ag.put('/api/memory/consent').set('x-csrf-token', a.t).send({ chat: true });
  assert.equal(c1.body.consent.chat, true); assert.equal(c1.body.consent.search, false); assert.equal(c1.body.consent.version, M.CONSENT_VERSION); assert.ok(c1.body.consent.consentedAt);
  await a.ag.post('/api/search').set('x-csrf-token', a.t).send({ include: ['beef'], dish: 'steak' }); assert.equal(count(db, 'member_searches', a.id), 0);
  await a.ag.post('/api/chat').set('x-csrf-token', a.t).send({ message: 'what wine with steak?' }); assert.equal(count(db, 'member_chats', a.id), 2);
  await a.ag.post('/api/chat').set('x-csrf-token', a.t).send({ message: 'and a wine for lamb?' }); assert.match(sys, /MEMBER MEMORY[\s\S]*wine with steak/);
  // Pause stops recording and recall
  await a.ag.put('/api/memory/consent').set('x-csrf-token', a.t).send({ paused: true }); const before = count(db, 'member_chats', a.id);
  await a.ag.post('/api/chat').set('x-csrf-token', a.t).send({ message: 'pudding wine?' }); assert.equal(count(db, 'member_chats', a.id), before); assert.doesNotMatch(sys, /MEMBER MEMORY/);
  // Withdrawing a toggle deletes what it collected
  await a.ag.put('/api/memory/consent').set('x-csrf-token', a.t).send({ paused: false, chat: false }); assert.equal(count(db, 'member_chats', a.id), 0);
});

test('profile derived from searches + behaviour; events sanitised (no query strings, unknown kinds rejected)', async () => {
  const db = open(':memory:'); const a = await member(db, null, 'p@x.co');
  await a.ag.put('/api/memory/consent').set('x-csrf-token', a.t).send({ search: true, behaviour: true });
  for (const d of ['thai green curry', 'thai noodles']) await a.ag.post('/api/search').set('x-csrf-token', a.t).send({ include: ['chicken', 'lime'], dish: d, cuisines: ['Thai'], diets: ['dairy-free'], maxMinutes: 30, servings: 2 });
  await a.ag.post('/api/memory/event').set('x-csrf-token', a.t).send({ kind: 'page_view', ref: '/app.html?email=a@x.co' });
  assert.equal((await a.ag.post('/api/memory/event').set('x-csrf-token', a.t).send({ kind: 'mouse_move', ref: 'x' })).body.recorded, false);
  await a.ag.post('/api/memory/event').set('x-csrf-token', a.t).send({ kind: 'recipe_save', ref: 'Pad Thai' });
  const v = (await a.ag.get('/api/memory')).body;
  assert.deepEqual(v.profile.cuisines, ['thai']); assert.ok(v.profile.ingredients.includes('chicken')); assert.deepEqual(v.profile.dietary, ['dairy-free']); assert.equal(v.profile.servings, 2); assert.equal(v.profile.typicalMinutes, 30); assert.deepEqual(v.profile.recentRecipes, ['pad thai']);
  assert.equal(v.events.find(e => e.kind === 'page_view').ref, '/app.html');
  assert.deepEqual(Object.keys(v.events[0]).sort(), ["created_at", "kind", "ref"]); assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_master WHERE name LIKE 'member_%'").all().map(r => r.sql).join(" "), /\bip\b|user_agent|fingerprint/i);
  assert.deepEqual(M.biasSearch({}, { dish: 'x' }, v.profile), { dish: 'x', servings: 2, maxMinutes: 30 }); assert.equal(M.biasSearch({ servings: 4 }, { servings: 4 }, v.profile).servings, 4);
});

test('isolation: members only ever see and recall their own memory; admin stats expose counts only', async () => {
  const db = open(':memory:'); let sys = ''; const llm = async m => { sys = m[0].content; return '{"reply":"Lovely.","action":"answer"}'; };
  process.env.ADMIN_EMAILS = 'boss@x.co';
  const a = await member(db, llm, 'iso-a@x.co'), b = await member(db, llm, 'iso-b@x.co'), boss = await member(db, llm, 'boss@x.co');
  for (const m of [a, b]) await m.ag.put('/api/memory/consent').set('x-csrf-token', m.t).send({ chat: true });
  await a.ag.post('/api/chat').set('x-csrf-token', a.t).send({ message: 'my secret saffron risotto plan' });
  await b.ag.post('/api/chat').set('x-csrf-token', b.t).send({ message: 'saffron risotto ideas?' }); assert.doesNotMatch(sys, /secret/);
  const bv = (await b.ag.get('/api/memory')).body; assert.ok(bv.chats.every(c => !/secret/.test(c.text)));
  const ex = await b.ag.get('/api/memory/export'); assert.match(ex.headers['content-disposition'], /attachment/); assert.doesNotMatch(JSON.stringify(ex.body), /secret/);
  const st = await boss.ag.get('/api/admin/memory-stats'); assert.equal(st.status, 200); assert.equal(st.body.members.chat, 2); assert.equal(st.body.rows.chats, 4); assert.doesNotMatch(JSON.stringify(st.body), /saffron|secret|iso-/);
  assert.equal((await a.ag.get('/api/admin/memory-stats')).status, 403);
  assert.equal((await request(createApp({ db, stripe: null })).get('/api/memory')).status, 401);
  delete process.env.ADMIN_EMAILS;
});

test('deletion: delete all removes chats, searches, events, profile and consent for that member only', async () => {
  const db = open(':memory:'); const llm = async () => '{"reply":"Yes.","action":"answer"}';
  const a = await member(db, llm, 'd-a@x.co'), b = await member(db, llm, 'd-b@x.co');
  for (const m of [a, b]) { await m.ag.put('/api/memory/consent').set('x-csrf-token', m.t).send({ chat: true, search: true, behaviour: true });
    await m.ag.post('/api/chat').set('x-csrf-token', m.t).send({ message: 'hello chef' }); await m.ag.post('/api/search').set('x-csrf-token', m.t).send({ include: ['eggs'], dish: 'omelette' });
    await m.ag.post('/api/memory/event').set('x-csrf-token', m.t).send({ kind: 'recipe_view', ref: 'Omelette' }); }
  const r = await a.ag.delete('/api/memory').set('x-csrf-token', a.t); assert.equal(r.body.deleted, true); assert.equal(r.body.consent.recorded, false);
  for (const t of ['member_chats', 'member_searches', 'member_events', 'member_profile', 'member_consent']) { assert.equal(count(db, t, a.id), 0, t); assert.ok(count(db, t, b.id) > 0, t); }
  await a.ag.post('/api/chat').set('x-csrf-token', a.t).send({ message: 'hello again' }); assert.equal(count(db, 'member_chats', a.id), 0);
  // Account deletion cascades
  db.prepare('DELETE FROM users WHERE id=?').run(b.id); assert.equal(count(db, 'member_chats', b.id), 0);
});

test('prompt injection size: memory block capped and system message never exceeds 4,000 chars', async () => {
  const big = { cuisines: Array(5).fill('x'.repeat(60)), ingredients: Array(8).fill('y'.repeat(60)), frequentSearches: Array(5).fill('z'.repeat(60)), recentRecipes: Array(5).fill('w'.repeat(60)) };
  const chats = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'malcolm' : 'user', text: 'q'.repeat(1500), created_at: i }));
  const blk = M.memoryBlock(big, chats); assert.ok(blk.length <= M.LIMITS.block, blk.length); assert.match(blk, /^MEMBER MEMORY/); assert.match(blk, /Profile:/);
  let seen; const llm = async m => { seen = m; return 'ok'; };
  await M.withMemory(llm, blk)([{ role: 'system', content: 's'.repeat(3500) }, { role: 'user', content: 'hi' }]); assert.ok(seen[0].content.length <= 4000, seen[0].content.length);
  await M.withMemory(llm, blk)([{ role: 'system', content: 's'.repeat(3990) }, { role: 'user', content: 'hi' }]); assert.equal(seen[0].content.length, 3990);
  assert.equal(M.memoryBlock(null, []), ''); assert.equal(M.withMemory(llm, ''), llm);
  // Retention purge
  const db = open(':memory:'); const q = { all: async (s, p) => db.prepare(s).all(...p), get: async (s, p) => db.prepare(s).get(...p) || null, run: async (s, p) => db.prepare(s).run(...p) };
  db.prepare("INSERT INTO users(email,password_hash) VALUES('r@x.co','h')").run(); await M.setConsent(q, 1, { chat: true });
  db.prepare("INSERT INTO member_chats(user_id,role,text,created_at) VALUES(1,'user','old',?)").run(Date.now() - 400 * 864e5);
  await M.recordChat(q, 1, [{ role: 'user', text: 'new' }]); assert.deepEqual(db.prepare('SELECT text FROM member_chats').all().map(r => r.text), ['new']);
  assert.equal(M.retentionDays({ MEMORY_RETENTION_DAYS: '90' }), 90); assert.equal(M.retentionDays({}), 365);
});
