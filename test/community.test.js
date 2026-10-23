'use strict';
const test = require('node:test'); const assert = require('node:assert');
process.env.AI_PROVIDER = 'none'; process.env.JWT_SECRET = 'test-secret'; process.env.IMAGE_PROVIDER = 'none';
const request = require('supertest'); const { createApp } = require('../src/server'); const { open } = require('../src/db');
const C = require('../src/community'); const { RECIPES } = require('../src/recipes');

function agent(db) { return request.agent(createApp({ db, stripe: null })); }
async function signup(ag, email) { const t = (await ag.get('/api/csrf')).body.csrfToken; const r = await ag.post('/api/auth/register').set('x-csrf-token', t).send({ email, password: 'supersecret1' }); assert.equal(r.status, 201); return t; }
const age = (db, email, days) => db.prepare("UPDATE users SET created_at=datetime('now', ?), email_verified=1 WHERE email=?").run(`-${days} days`, email);
const aiRecipe = { title: 'Saffron Miso Salmon', cuisine: 'French–Japanese fusion', ingredients: [{ name: 'salmon' }, { name: 'miso' }, { name: 'saffron' }], steps: [{ text: 'Cook' }], totalMinutes: 25, difficulty: 'easy', nutritionPerServing: { kcal: 1 } };

test('stable AI ids: same content → same id, different content → different id', () => {
  const a = C.aiId(aiRecipe), b = C.aiId({ ...aiRecipe, ingredients: [...aiRecipe.ingredients].reverse() }), c = C.aiId({ ...aiRecipe, title: 'Other' });
  assert.match(a, /^ai-[0-9a-z]{14}$/); assert.equal(a, b); assert.notEqual(a, c); assert.ok(C.validId(a) && C.validId('esc-123') && !C.validId('../x'));
});

test('ranking: Bayesian prior, min raters, staff/self/new-account discounts, spike filter, engagement', () => {
  const now = Date.now(), R = (stars, user_id, weight = 1, isNew = false) => ({ stars, user_id, weight, isNew, t: now - 864e5 });
  const rows = [
    { id: 'one5', ratings: [R(5, 1)], hearts: 0, lastActivity: now },                                  // single 5★: not eligible
    { id: 'many4', ratings: [1, 2, 3, 4, 5, 6, 7, 8].map(u => R(4 + (u % 2) * 0.5 > 4 ? 5 : 4, u)), hearts: 3, cooks: 2, lastActivity: now },
    { id: 'two5', ratings: [R(5, 1), R(5, 2)], hearts: 0, lastActivity: now },
    { id: 'spike', ratings: [1, 2, 3, 4, 5, 6].map(u => R(5, 100 + u, 0.3, true)), hearts: 0, lastActivity: now },
    { id: 'old', ratings: [R(5, 1), R(5, 2), R(4, 3)], hearts: 0, lastActivity: now - 400 * 864e5 }];
  const s = C.scoreRecipes(rows, now); const by = Object.fromEntries(s.map(r => [r.id, r]));
  assert.equal(by.one5.eligible, false); assert.equal(by.spike.eligible, false, 'new-account spike ignored');
  assert.ok(by.many4.score > by.two5.score, 'many consistent ratings beat two perfect ones');
  assert.ok(by.two5.bayes < 5 && by.two5.bayes > 3.5, 'Bayesian shrinkage toward the global mean');
  assert.ok(by.two5.score > by.old.score - 1 && by.old.raters === 3);
  assert.equal(by.many4.avg, Math.round(s.find(r => r.id === 'many4').avg * 1000) / 1000);
  process.env.ADMIN_EMAILS = 'boss@x.co';
  assert.equal(C.raterWeight({ email: 'boss@x.co', u_created: '2020-01-01 00:00:00' }, now), C.K.staffW);
  assert.equal(C.raterWeight({ email: 'a@x.co', verified: 1, user_id: 7, created_by: 7, u_created: '2020-01-01 00:00:00' }, now), C.K.selfW);
  assert.equal(C.raterWeight({ email: 'a@x.co', verified: 1, user_id: 7, created_by: 8, u_created: new Date(now - 3600e3).toISOString() }, now), C.K.newW);
  assert.equal(C.raterWeight({ email: 'a@x.co', verified: 1, user_id: 7, created_by: 8, u_created: '2020-01-01 00:00:00' }, now), 1);
  assert.equal(C.raterWeight({ email: 'a@x.co', verified: 0, user_id: 7, created_by: 8, u_created: '2020-01-01 00:00:00' }, now), 0, 'unverified ratings never count');
  delete process.env.ADMIN_EMAILS;
});

test('ratings API: one editable rating per member, 3dp average, verification, top-rated + featured', async () => {
  const db = open(':memory:'); const lib = RECIPES[0].id; const id = C.aiId(aiRecipe);
  const agents = []; for (const [i, stars] of [5, 4, 4].entries()) { const ag = agent(db); const t = await signup(ag, `r${i}@x.co`); age(db, `r${i}@x.co`, 30); agents.push([ag, t, stars]); }
  const [[a0, t0]] = agents;
  assert.equal((await agent(db).put(`/api/recipes/${lib}/rating`).set('x-csrf-token', 'x').send({ stars: 5 })).status, 403);
  assert.equal((await a0.put(`/api/recipes/${id}/rating`).set('x-csrf-token', t0).send({ stars: 5, recipe: { ...aiRecipe, title: 'Tampered' } })).status, 400, 'content must hash to id');
  assert.equal((await a0.put(`/api/recipes/${lib}/rating`).set('x-csrf-token', t0).send({ stars: 9 })).status, 400);
  for (const [ag, t, stars] of agents) { const r = await ag.put(`/api/recipes/${id}/rating`).set('x-csrf-token', t).send({ stars, recipe: aiRecipe }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  let r = await a0.put(`/api/recipes/${id}/rating`).set('x-csrf-token', t0).send({ stars: 3, recipe: aiRecipe }); // edit, not a second vote
  assert.equal(r.body.stats.count, 3); assert.equal(r.body.stats.avg, 3.667); assert.equal(r.body.stats.mine, 3);
  for (const [ag, t] of agents.slice(0, 2)) await ag.put(`/api/recipes/${lib}/rating`).set('x-csrf-token', t).send({ stars: 5 });
  const top = (await a0.get('/api/recipes/top')).body.top; assert.equal(top.length, 2); assert.equal(top[0].rank, 1); assert.ok(top[0].recipe.title);
  const st = (await a0.get(`/api/recipes/stats?ids=${id},${lib}`)).body; assert.equal(st.stats[lib].avg, 5); assert.ok(st.featured[lib] && st.featured[id]);
  const one = await agent(db).get(`/api/recipes/${id}`); assert.equal(one.status, 200); assert.equal(one.body.recipe.title, aiRecipe.title);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recipe_events WHERE kind='view'").get().n, 1);
  assert.equal((await a0.post(`/api/recipes/${id}/event`).set('x-csrf-token', t0).send({ kind: 'cook' })).body.ok, true);
  await a0.post(`/api/recipes/${id}/event`).set('x-csrf-token', t0).send({ kind: 'cook' }); // deduped per day
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recipe_events WHERE kind='cook'").get().n, 1);
});

test('favourites keep data, sync stats and back-fill the recipe store; prefs sync across devices', async () => {
  const db = open(':memory:'); const ag = agent(db); const t = await signup(ag, 'fav@x.co');
  db.prepare("UPDATE users SET plan='monthly', sub_status='active' WHERE email='fav@x.co'").run();
  const lib = RECIPES[1];
  assert.equal((await ag.post('/api/favourites').set('x-csrf-token', t).send({ recipe: { ...aiRecipe, id: C.aiId(aiRecipe) } })).status, 201);
  assert.equal((await ag.post('/api/favourites').set('x-csrf-token', t).send({ recipe: lib })).status, 201);
  const f = (await ag.get('/api/favourites')).body; assert.equal(f.favourites.length, 2); assert.ok(f.favourites[0].addedAt); assert.equal(f.stats[lib.id].hearted, true); assert.equal(f.stats[lib.id].hearts, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recipes').get().n, 2);
  // legacy favourite rows (pre-migration) are back-filled into recipes by the schema SQL
  db.prepare("INSERT INTO favourites(user_id,recipe_id,recipe_json) VALUES(1,'legacy-dish','{\"id\":\"legacy-dish\",\"title\":\"Legacy\"}')").run(); C.SCHEMA_SQL.forEach(s => db.exec(s));
  assert.equal(db.prepare("SELECT title FROM recipes WHERE id='legacy-dish'").get().title, 'Legacy');
  assert.equal((await ag.get('/api/prefs')).body.prefs, null);
  const put = await ag.put('/api/prefs').set('x-csrf-token', t).send({ diets: ['vegan'], servings: 4, cuisines: ['French', 'Thai', 'Moroccan'], difficulty: 'medium', maxMinutes: 45, kidsMode: true, recent: [{ label: 'tofu', i: 'tofu' }] });
  assert.equal(put.status, 200); const other = agent(db); const t2 = (await other.get('/api/csrf')).body.csrfToken;
  await other.post('/api/auth/login').set('x-csrf-token', t2).send({ email: 'fav@x.co', password: 'supersecret1' });
  const g = (await other.get('/api/prefs')).body.prefs; assert.deepEqual(g.cuisines, ['French', 'Thai', 'Moroccan']); assert.equal(g.servings, 4); assert.equal(g.recent[0].label, 'tofu');
  assert.equal((await ag.put('/api/prefs').set('x-csrf-token', t).send({ servings: 99 })).status, 400);
});

test('cuisine fusion: multi-select reaches the search and the offline ranker', async () => {
  const db = open(':memory:'); const ag = agent(db); const t = await signup(ag, 'fu@x.co');
  const r = await ag.post('/api/search').set('x-csrf-token', t).send({ include: ['chicken'], cuisines: ['Thai', 'Moroccan'] });
  assert.equal(r.status, 200); assert.ok(r.body.recipes.some(x => ['Thai', 'Moroccan'].includes(x.cuisine)));
  assert.equal((await ag.post('/api/search').set('x-csrf-token', t).send({ include: ['chicken'], cuisines: ['<b>'] })).status, 400);
  assert.deepEqual(C.normCuisines(['any', 'French', 'French', 'Thai']), ['French', 'Thai']);
});
