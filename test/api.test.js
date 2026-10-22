'use strict';
const test = require('node:test'); const assert = require('node:assert');
process.env.AI_PROVIDER = 'none'; process.env.JWT_SECRET = 'test-secret'; process.env.IMAGE_PROVIDER = 'none';
const request = require('supertest'); const { createApp } = require('../src/server'); const { open } = require('../src/db');
const ai = require('../src/ai');

function agent() { const db = open(':memory:'); const app = createApp({ db, stripe: null }); return { db, ag: request.agent(app) }; }
async function csrf(ag) { const r = await ag.get('/api/csrf'); return r.body.csrfToken; }
async function signup(ag, email = 'cook@example.com') { const t = await csrf(ag); const r = await ag.post('/api/auth/register').set('x-csrf-token', t).send({ email, password: 'supersecret1' }); assert.equal(r.status, 201); return t; }

test('health + plans + security headers', async () => {
  const { ag } = agent(); const h = await ag.get('/api/health'); assert.equal(h.body.ai, 'none'); assert.ok(h.headers['content-security-policy']); assert.ok(!h.headers['x-powered-by']);
  const p = await ag.get('/api/plans'); assert.deepStrictEqual(p.body.plans.map(x => x.id), ['free', 'monthly', 'head']);
});
test('CSRF required on mutating requests', async () => { const { ag } = agent(); await ag.get('/api/csrf'); const r = await ag.post('/api/auth/register').send({ email: 'a@b.co', password: 'supersecret1' }); assert.equal(r.status, 403); });
test('auth: register, duplicate, login, wrong password', async () => {
  const { ag } = agent(); const t = await signup(ag);
  assert.equal((await ag.post('/api/auth/register').set('x-csrf-token', t).send({ email: 'cook@example.com', password: 'supersecret1' })).status, 409);
  assert.equal((await ag.post('/api/auth/login').set('x-csrf-token', t).send({ email: 'cook@example.com', password: 'wrongpass1' })).status, 401);
  assert.equal((await ag.post('/api/auth/login').set('x-csrf-token', t).send({ email: 'cook@example.com', password: 'supersecret1' })).status, 200);
});
test('search requires login and validates input', async () => {
  const { ag } = agent(); const t = await csrf(ag);
  assert.equal((await ag.post('/api/search').set('x-csrf-token', t).send({ include: ['egg'] })).status, 401);
  await signup(ag); assert.equal((await ag.post('/api/search').set('x-csrf-token', t).send({})).status, 400);
  assert.equal((await ag.post('/api/search').set('x-csrf-token', t).send({ include: ['<script>'] })).status, 400);
});
test('offline search returns complete recipes; free trial gated after 3', async () => {
  const { ag } = agent(); const t = await signup(ag);
  const r = await ag.post('/api/search').set('x-csrf-token', t).send({ include: ['chicken', 'rice'], maxMinutes: 40, servings: 4, diets: ['dairy-free'], kidsMode: true });
  assert.equal(r.status, 200); assert.equal(r.body.source, 'offline'); assert.ok(r.body.recipes.length >= 1 && r.body.recipes.length <= 3);
  const x = r.body.recipes[0]; for (const k of ['title', 'matchScore', 'whyItFits', 'ingredients', 'steps', 'allergens', 'nutritionPerServing', 'substitutions', 'shoppingList', 'safetyNotes', 'image']) assert.ok(k in x, k);
  assert.ok(x.nutritionPerServing.isEstimate); assert.ok(x.safetyNotes.some(n => /75°C/.test(n)));
  await ag.post('/api/search').set('x-csrf-token', t).send({ dish: 'soup' }); await ag.post('/api/search').set('x-csrf-token', t).send({ dish: 'pasta' });
  const g = await ag.post('/api/search').set('x-csrf-token', t).send({ dish: 'curry' }); assert.equal(g.status, 402);
});
test('premium gating for favourites; premium user gets 5 results + favourites', async () => {
  const { ag, db } = agent(); const t = await signup(ag);
  assert.equal((await ag.get('/api/favourites')).status, 402);
  db.prepare("UPDATE users SET plan='monthly', sub_status='active'").run();
  const r = await ag.post('/api/search').set('x-csrf-token', t).send({ include: ['onion'] }); assert.equal(r.body.recipes.length, 5);
  assert.equal((await ag.post('/api/favourites').set('x-csrf-token', t).send({ recipe: r.body.recipes[0] })).status, 201);
  assert.equal((await ag.get('/api/favourites')).body.favourites.length, 1); assert.equal((await ag.get('/api/history')).body.history.length, 1);
});
test('share creates public page with Open Graph meta', async () => {
  const { ag } = agent(); const t = await signup(ag);
  const r = await ag.post('/api/search').set('x-csrf-token', t).send({ dish: 'bolognese' });
  const s = await ag.post('/api/share').set('x-csrf-token', t).send({ recipe: r.body.recipes[0] }); assert.equal(s.status, 201);
  const page = await request(ag.app).get('/r/' + s.body.id); assert.equal(page.status, 200);
  assert.match(page.text, /og:title" content="[^"]*Bolognese/); assert.match(page.text, /twitter:card/); assert.match(page.text, /og:image" content="[^"]+\/img\/pasta\.jpg/);
});
test('billing endpoints report not configured without Stripe keys; webhook rejects', async () => {
  const { ag } = agent(); const t = await signup(ag);
  assert.equal((await ag.post('/api/billing/checkout').set('x-csrf-token', t).send({ plan: 'monthly' })).status, 503);
  assert.equal((await request(ag.app).post('/api/billing/webhook').set('content-type', 'application/json').send('{}')).status, 503);
});
test('AI layer: validates JSON, retries on bad output, enforces allergens', async () => {
  process.env.AI_PROVIDER = 'openai'; process.env.AI_BASE_URL = 'http://fake.local/v1';
  const good = { recipes: [{ title: 'Prawn Rice Bowl', cuisine: 'Asian', difficulty: 'easy', totalMinutes: 20, servings: 2, matchScore: 90, whyItFits: 'uses prawns', ingredients: [{ name: 'king prawns', qty: 200, unit: 'g' }, { name: 'rice', qty: 150, unit: 'g' }], steps: [{ text: 'Cook rice', timerMinutes: 12 }, { text: 'Fry prawns until pink', timerMinutes: 3 }], allergens: [], nutritionPerServing: { kcal: 400, proteinG: 25, carbsG: 50, fatG: 8 }, substitutions: [] }] };
  let calls = 0; const fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: calls++ === 0 ? 'not json at all' : JSON.stringify(good) } }] }) });
  const out = await ai.generate({ include: ['prawns'], servings: 2 }, { fetchImpl });
  assert.equal(calls, 2); assert.equal(out.source, 'openai'); assert.deepStrictEqual(out.recipes[0].allergens, ['crustaceans']);
  const bad = await ai.generate({ include: ['egg'] }, { fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(bad.source, 'offline'); assert.ok(bad.fallbackReason);
  process.env.AI_PROVIDER = 'none';
});

test('admin: ADMIN_EMAILS account is unlimited with all premium features; others are not', async () => {
  const prev = process.env.ADMIN_EMAILS; process.env.ADMIN_EMAILS = 'Owner@Example.com';
  try {
    const { ag } = agent(); const t = await signup(ag, 'owner@example.com');
    const me = (await ag.get('/api/me')).body.user; assert.equal(me.admin, true); assert.equal(me.premium, true); assert.equal(me.plan, 'admin'); assert.equal(me.searchesLeft, null);
    for (let i = 0; i < 5; i++) assert.equal((await ag.post('/api/search').set('x-csrf-token', t).send({ dish: 'soup' })).status, 200);
    assert.equal((await ag.get('/api/favourites')).status, 200); assert.equal((await ag.get('/api/history')).status, 200);
    const o = agent(); const t2 = await signup(o.ag, 'someone@example.com');
    const r = await o.ag.post('/api/auth/register').set('x-csrf-token', t2).send({ email: 'x@example.com', password: 'supersecret1', admin: true, plan: 'admin' });
    assert.equal(r.body.user.admin, false); assert.equal(r.body.user.premium, false);
    assert.equal((await o.ag.get('/api/favourites')).status, 402);
  } finally { if (prev === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = prev; }
});
test('admin: unset ADMIN_EMAILS grants nobody admin', () => {
  const { isAdmin, isPremium } = require('../src/plans'); const prev = process.env.ADMIN_EMAILS; delete process.env.ADMIN_EMAILS;
  try { assert.equal(isAdmin({ email: 'owner@example.com', plan: 'free' }), false); assert.equal(isPremium({ email: '', plan: 'free' }), false); assert.equal(isAdmin(null), false); }
  finally { if (prev !== undefined) process.env.ADMIN_EMAILS = prev; }
});

test('tester: TESTER_EMAILS account gets full member access but not admin; cannot be deleted', async () => {
  const pa = process.env.ADMIN_EMAILS, pt = process.env.TESTER_EMAILS; process.env.ADMIN_EMAILS = 'owner@example.com'; process.env.TESTER_EMAILS = 'Test@Example.chef';
  try {
    const { ag } = agent(); const t = await signup(ag, 'test@example.chef');
    const me = (await ag.get('/api/me')).body.user; assert.equal(me.tester, true); assert.equal(me.admin, false); assert.equal(me.premium, true); assert.equal(me.plan, 'tester');
    for (let i = 0; i < 4; i++) { const r = await ag.post('/api/search').set('x-csrf-token', t).send({ dish: 'soup' }); assert.equal(r.status, 200); }
    assert.equal((await ag.get('/api/favourites')).status, 200); assert.equal((await ag.get('/api/history')).status, 200);
    assert.equal((await ag.delete('/api/me').set('x-csrf-token', t)).status, 403);
    const { isTester, isAdmin } = require('../src/plans'); assert.equal(isTester({ email: 'owner@example.com' }), false); assert.equal(isAdmin({ email: 'test@example.chef' }), false);
  } finally { for (const [k, v] of [['ADMIN_EMAILS', pa], ['TESTER_EMAILS', pt]]) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
test('change password: needs current password, enforces length, then new password works', async () => {
  const { ag } = agent(); const t = await signup(ag, 'pw@example.com');
  assert.equal((await ag.post('/api/auth/password').set('x-csrf-token', t).send({ currentPassword: 'wrongpass1', newPassword: 'brandnew123' })).status, 401);
  assert.equal((await ag.post('/api/auth/password').set('x-csrf-token', t).send({ currentPassword: 'supersecret1', newPassword: 'short' })).status, 400);
  assert.equal((await ag.post('/api/auth/password').set('x-csrf-token', t).send({ currentPassword: 'supersecret1', newPassword: 'brandnew123' })).status, 200);
  assert.equal((await ag.post('/api/auth/login').set('x-csrf-token', t).send({ email: 'pw@example.com', password: 'supersecret1' })).status, 401);
  assert.equal((await ag.post('/api/auth/login').set('x-csrf-token', t).send({ email: 'pw@example.com', password: 'brandnew123' })).status, 200);
  const anon = agent(); const t2 = await csrf(anon.ag); assert.equal((await anon.ag.post('/api/auth/password').set('x-csrf-token', t2).send({ currentPassword: 'x', newPassword: 'yyyyyyyy' })).status, 401);
});
test('options: "any" cuisine is first so searches default to any cuisine', async () => { const { ag } = agent(); const o = await ag.get('/api/options'); assert.equal(o.body.cuisines[0], 'any'); });
test('AI busy: library fallback flagged for everyone; reason only for admin', async () => {
  const keep = { ...process.env }; Object.assign(process.env, { AI_PROVIDER: 'malcolm', MALCOLM_AI_URL: 'http://127.0.0.1:9/', MALCOLM_AI_MODE: 'lattice', AI_TIMEOUT_MS: '3000', ADMIN_EMAILS: 'boss@example.com' });
  try {
    const { ag } = agent(); const t = await signup(ag, 'cook2@example.com');
    const r = await ag.post('/api/search').set('x-csrf-token', t).send({ include: ['chicken'] }); assert.equal(r.status, 200); assert.equal(r.body.source, 'offline'); assert.equal(r.body.aiBusy, true); assert.ok(!('fallbackReason' in r.body));
    const a = agent(); const t2 = await signup(a.ag, 'boss@example.com');
    const r2 = await a.ag.post('/api/search').set('x-csrf-token', t2).send({ include: ['chicken'] }); assert.equal(r2.body.aiBusy, true); assert.ok(r2.body.fallbackReason);
  } finally { for (const k of ['AI_PROVIDER', 'MALCOLM_AI_URL', 'MALCOLM_AI_MODE', 'AI_TIMEOUT_MS', 'ADMIN_EMAILS']) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
});
test('malcolm: 502 detail and timeouts become a readable fallback reason', async () => {
  Object.assign(process.env, { AI_PROVIDER: 'malcolm', MALCOLM_AI_URL: 'https://example.invalid/', MALCOLM_AI_MODE: 'lattice' });
  delete require.cache[require.resolve('../src/ai')]; const ai = require('../src/ai');
  const out = await ai.generate({ include: ['chicken'], maxMinutes: 40, servings: 2, diets: [] }, { retries: 0, fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ detail: 'all providers failed: gemini: timeout' }) }) });
  assert.equal(out.source, 'offline'); assert.match(out.fallbackReason, /502: all providers failed: gemini: timeout/);
  const to = await ai.generate({ include: ['chicken'], maxMinutes: 40, servings: 2, diets: [] }, { retries: 0, fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
  assert.match(to.fallbackReason, /AI timeout/);
  for (const k of ['AI_PROVIDER', 'MALCOLM_AI_URL', 'MALCOLM_AI_MODE']) delete process.env[k];
});
