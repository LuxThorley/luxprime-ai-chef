'use strict';
const test = require('node:test'); const assert = require('node:assert');
process.env.AI_PROVIDER = 'none'; process.env.JWT_SECRET = 'test-secret'; process.env.IMAGE_PROVIDER = 'none';
const C = require('../src/chat'); const request = require('supertest'); const { createApp } = require('../src/server'); const { open } = require('../src/db');

test('refinement parser understands common follow-ups', () => {
  const p = m => C.parseRefinement(m);
  assert.equal(p('spicier').changes.spice, 8); assert.deepEqual(p('no dairy').changes.addDiets, ['dairy-free']); assert.deepEqual(p('make it vegan').changes.addDiets, ['vegan']);
  assert.ok(p('cheaper').changes.budgetGBP); assert.equal(p('quicker please').changes.maxMinutes, 20);
  const s = p('swap the fish for chicken'); assert.deepEqual(s.changes.exclude, ['fish']); assert.deepEqual(s.changes.include, ['chicken']); assert.ok(s.refine);
  assert.equal(p('what wine?').refine, false); assert.equal(p('what wine?').question, true);
});

test('applyChanges keeps context and only tightens', () => {
  const q = { include: ['salmon', 'rice'], exclude: ['olives'], diets: ['nut-free'], maxMinutes: 30, dish: 'zesty', inspirationMode: 'escoffier', cuisines: ['Thai'] };
  const n = C.applyChanges(q, { exclude: ['salmon'], include: ['chicken'], addDiets: ['dairy-free', 'bogus'], maxMinutes: 60, spice: 8 });
  assert.deepEqual(n.include, ['rice', 'chicken']); assert.deepEqual(n.exclude, ['olives', 'salmon']); assert.deepEqual(n.diets, ['nut-free', 'dairy-free']);
  assert.equal(n.maxMinutes, 30); assert.equal(n.inspirationMode, 'escoffier'); assert.deepEqual(n.cuisines, ['Thai']); assert.match(n.dish, /spice 8\/10/);
});

test('clarify only for genuinely ambiguous requests', () => {
  assert.ok(C.clarify({ include: [], dish: 'dinner' })); assert.ok(C.clarify({ include: [], dish: '' }).chips.length >= 4);
  assert.equal(C.clarify({ include: [], dish: 'thai green curry' }), null); assert.equal(C.clarify({ include: ['eggs'], dish: '' }), null);
});

test('respond: LLM JSON honoured, heuristics merged, bad JSON falls back, recipe Q&A never regenerates', async () => {
  const llm = async () => JSON.stringify({ reply: 'A chilled Albariño — its salinity loves the lime.', action: 'answer', suggestions: ['Spicier'] });
  const a = await C.respond({ message: 'what wine?', history: [], context: {}, recipes: [] }, { llm }); assert.equal(a.action, 'answer'); assert.match(a.reply, /Albariño/);
  const b = await C.respond({ message: 'spicier and no dairy', history: [], context: {}, recipes: [] }, { llm: async () => '{"reply":"On it.","action":"answer"}' });
  assert.equal(b.action, 'regenerate'); assert.equal(b.changes.spice, 8); assert.deepEqual(b.changes.addDiets, ['dairy-free']);
  const c = await C.respond({ message: 'make it vegan', history: [], context: {}, recipes: [] }, { llm: async () => 'not json' }); assert.equal(c.action, 'regenerate');
  const d = await C.respond({ message: 'swap the fish', history: [], context: {}, recipes: [], recipe: { title: 'Fish pie', ingredients: [], steps: [] } }, { llm: async () => '{"reply":"Use smoked haddock.","action":"regenerate"}' });
  assert.equal(d.action, 'answer');
  const msgs = C.buildChatMessages({ message: 'hi', history: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'malcolm' : 'user', text: 't' + i })), context: { inspirationMode: 'malcolm' }, recipes: [{ title: 'X' }] });
  assert.ok(msgs.length <= 2 + C.LIMITS.maxHistory + 1); assert.match(msgs[0].content, /British English/); assert.match(msgs[1].content, /"inspirationMode":"malcolm"/);
});

test('answerBrief returns a real answer only for questions', async () => {
  const llm = async () => '{"answer":"Pan-roast duck breast: 8 min skin-side down, rest 5."}';
  assert.match(await C.answerBrief({ raw: 'What impresses on a weeknight?', question: true }, {}, { llm }), /duck/);
  assert.equal(await C.answerBrief({ raw: 'chicken', question: false }, {}, { llm }), null);
});

test('API: search answers questions & clarifies; chat refines, answers, rate-limits', async () => {
  const llm = async msgs => /recipe request/.test(msgs[0].content) ? '{"answer":"A seared steak with chimichurri — 15 minutes, big flavour."}' : (/wine/i.test(msgs[msgs.length - 1].content) ? '{"reply":"A Rioja Crianza.","action":"answer","suggestions":["Spicier"]}' : '{"reply":"Turning up the heat!","action":"regenerate","changes":{"spice":8}}');
  const db = open(':memory:'); const ag = request.agent(createApp({ db, stripe: null, llm })); const t = (await ag.get('/api/csrf')).body.csrfToken;
  await ag.post('/api/auth/register').set('x-csrf-token', t).send({ email: 'c@x.co', password: 'supersecret1' });
  db.prepare("UPDATE users SET plan='monthly', sub_status='active'").run();
  const s = await ag.post('/api/search').set('x-csrf-token', t).send({ include: ['beef'], dish: 'What impresses on a weeknight?' });
  assert.equal(s.status, 200); assert.match(s.body.answer, /steak/); assert.ok(s.body.recipes.length);
  const cl = await ag.post('/api/search').set('x-csrf-token', t).send({ dish: 'dinner' }); assert.ok(cl.body.clarify); assert.equal(cl.body.recipes.length, 0);
  const ctx = { include: ['beef'], dish: 'steak', inspirationMode: 'malcolm', cuisines: ['French'] };
  const w = await ag.post('/api/chat').set('x-csrf-token', t).send({ message: 'what wine?', context: ctx, recipes: [{ title: 'Steak' }] });
  assert.equal(w.status, 200); assert.equal(w.body.action, 'answer'); assert.match(w.body.reply, /Rioja/); assert.ok(!w.body.search);
  const r = await ag.post('/api/chat').set('x-csrf-token', t).send({ message: 'spicier', context: ctx, history: [{ role: 'user', text: 'what wine?' }, { role: 'malcolm', text: 'A Rioja Crianza.' }] });
  assert.equal(r.body.action, 'regenerate'); assert.ok(r.body.search.recipes.length); assert.equal(r.body.context.inspirationMode, 'malcolm'); assert.deepEqual(r.body.context.cuisines, ['French']); assert.match(r.body.context.dish, /spice 8/);
  assert.equal((await ag.post('/api/chat').set('x-csrf-token', t).send({ message: 'x'.repeat(501) })).status, 400);
  db.prepare("UPDATE rate_limits SET n=999 WHERE k LIKE 'chat:%'").run();
  const lim = await ag.post('/api/chat').set('x-csrf-token', t).send({ message: 'hello' }); assert.equal(lim.status, 429); assert.match(lim.body.error, /breather/);
});

test('malcolmLlm calls Malcolm /v1/chat and falls back to Workers AI', async () => {
  let seen; const ok = async (url, o) => { seen = { url, body: JSON.parse(o.body), auth: o.headers.Authorization }; return { ok: true, json: async () => ({ text: '{"reply":"hi"}' }) }; };
  const env = { MALCOLM_AI_URL: 'https://m.example/v1/recipes', MALCOLM_AI_KEY: 'k' };
  assert.equal(await C.malcolmLlm(env, ok)([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]), '{"reply":"hi"}');
  assert.equal(seen.url, 'https://m.example/v1/chat'); assert.equal(seen.body.system, 'S'); assert.deepEqual(seen.body.messages, [{ role: 'user', content: 'U' }]);
  const fb = await C.malcolmLlm({ ...env, AI: { run: async () => ({ response: '{"reply":"wai"}' }) } }, async () => ({ ok: false, status: 502 }))([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
  assert.equal(fb, '{"reply":"wai"}');
});

test('respond tolerates sloppy model JSON (long suggestions, string numbers, nulls)', async () => {
  const r = await C.respond({ message: 'what wine?', history: [], context: {}, recipes: [] }, { llm: async () => JSON.stringify({ reply: 'A Rioja.', action: 'answer', changes: { spice: null, maxMinutes: '30' }, suggestions: ['x'.repeat(90), 'b', 'c', 'd', 'e', 'f'] }) });
  assert.equal(r.reply, 'A Rioja.'); assert.equal(r.action, 'answer'); assert.equal(r.suggestions.length, 5); assert.equal(r.suggestions[0].length, 60);
});
