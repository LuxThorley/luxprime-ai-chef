'use strict';
const test = require('node:test'); const assert = require('node:assert');
process.env.AI_PROVIDER = 'none'; process.env.JWT_SECRET = 'test-secret'; process.env.IMAGE_PROVIDER = 'none';
const B = require('../src/brief'); const ai = require('../src/ai');
const request = require('supertest'); const { createApp } = require('../src/server'); const { open } = require('../src/db');
const keys = s => B.summary(B.parseBrief(s)).map(x => x.key);

test('brief parser: numbers, units, budget, time, servings, spice, diets, avoid, moods, memory, questions', () => {
  const b = B.parseBrief('Smoky, sticky, sharp chicken for 4 under 600 kcal, at least 35g protein, £12 budget, spice level 7/10, no mushrooms, 40 mins').hints;
  assert.equal(b.kcalMax.value, 600); assert.equal(b.proteinMin.value, 35); assert.equal(b.budgetGBP.value, 12); assert.equal(b.servings.value, 4);
  assert.equal(b.spice.value, 7); assert.deepEqual(b.avoid.value, ['mushrooms']); assert.equal(b.maxMinutes.value, 40); assert.deepEqual(b.moods.value, ['smoky', 'sticky', 'sharp']);
  const n = B.parseBrief("like my nan's Sunday roast but vegan and gluten free, 1.5 hours").hints;
  assert.equal(n.memory.value, "my nan's sunday roast"); assert.deepEqual(n.diets.value, ['vegan', 'gluten-free']); assert.equal(n.maxMinutes.value, 90);
  assert.equal(B.parseBrief('that street food in Marrakech, mild').hints.spice.label, 'mild');
  const q = B.parseBrief('What can I make that impresses in 20 min?'); assert.equal(q.question, true); assert.equal(q.hints.maxMinutes.value, 20);
  assert.equal(B.parseBrief('a cosy creamy pasta').question, false); assert.deepEqual(keys('a cosy creamy pasta'), ['moods']);
  assert.deepEqual(keys(''), []); assert.equal(B.parseBrief('x'.repeat(5000)).raw.length, 1000);
  assert.ok(!('spice' in B.parseBrief('£5 for 2').hints)); assert.equal(B.parseBrief('£5 for 2').hints.servings.value, 2);
});

test('hints only tighten the query and can be dropped by the user', () => {
  const b = B.parseBrief('vegan, 20 minutes, no garlic, for 3');
  const q = B.applyHints({ maxMinutes: 60, diets: ['nut-free'], exclude: ['olives'], servings: 2 }, b);
  assert.equal(q.maxMinutes, 20); assert.deepEqual(q.diets, ['nut-free', 'vegan']); assert.deepEqual(q.exclude, ['olives', 'garlic']); assert.equal(q.servings, 3);
  assert.equal(B.applyHints({ maxMinutes: 15 }, b).maxMinutes, 15, 'never loosens');
  const kept = B.without(b, ['maxMinutes', 'avoid']); assert.ok(!kept.hints.maxMinutes && !kept.hints.avoid && kept.hints.diets);
});

test('prompt carries inspiration mode, brief and constraints', () => {
  const p = JSON.parse(ai.buildUserPrompt({ include: [], exclude: [], dish: 'x', maxMinutes: 30, servings: 2, diets: [], inspirationMode: 'escoffier', brief: { raw: 'x?', constraints: { kcalMax: 500 }, question: true } }, []));
  assert.equal(p.inspirationMode, 'escoffier'); assert.equal(p.brief.constraints.kcalMax, 500); assert.equal(p.brief.question, true);
  assert.ok(/strictly classical/.test(ai.MODE_RULE.escoffier) && /no Escoffier/.test(ai.MODE_RULE.malcolm) && /blend/.test(ai.MODE_RULE.blend));
});

test('API: /api/brief preview, search echoes mode + understood, ignore list, prefs keep mode', async () => {
  const ag = request.agent(createApp({ db: open(':memory:'), stripe: null })); const t = (await ag.get('/api/csrf')).body.csrfToken;
  const pv = await ag.post('/api/brief').set('x-csrf-token', t).send({ text: 'vegan for 2 under £8 in 20 min?' }); assert.equal(pv.status, 200); assert.ok(pv.body.question);
  assert.deepEqual(pv.body.understood.map(x => x.key).sort(), ['budgetGBP', 'diets', 'maxMinutes', 'servings']);
  await ag.post('/api/auth/register').set('x-csrf-token', t).send({ email: 'b@x.co', password: 'supersecret1' });
  const r = await ag.post('/api/search').set('x-csrf-token', t).send({ dish: 'something smoky with chicken, 25 minutes, no peppers', inspirationMode: 'malcolm', briefIgnore: ['avoid'] });
  assert.equal(r.status, 200); assert.equal(r.body.inspirationMode, 'malcolm'); assert.deepEqual(r.body.understood.map(x => x.key), ['maxMinutes', 'moods']);
  assert.ok(r.body.recipes.every(x => !x.escoffier));
  assert.equal((await ag.post('/api/search').set('x-csrf-token', t).send({ dish: 'x', inspirationMode: 'nope' })).status, 400);
  assert.equal((await ag.post('/api/search').set('x-csrf-token', t).send({ dish: 'y'.repeat(1001) })).status, 400);
  assert.equal((await ag.put('/api/prefs').set('x-csrf-token', t).send({ inspirationMode: 'escoffier' })).body.prefs.inspirationMode, 'escoffier');
});
