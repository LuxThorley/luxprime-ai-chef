'use strict';
const test = require('node:test'); const assert = require('node:assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { open } = require('../src/db'); const esc = require('../src/escoffier'); const { parse } = require('../scripts/build-escoffier');
const db = open(':memory:'); const all = (s, p) => db.prepare(s).all(...p);

test('parser: strips Gutenberg licence, numbers entries, assigns sections and quantities', () => {
  const raw = 'The Project Gutenberg eBook\nlicence\n*** START OF THE PROJECT GUTENBERG EBOOK X ***\n\nCHAPTER II\n\nTHE LEADING WARM SAUCES\n\n\n28—BÉCHAMEL SAUCE\n\n_Quantities Required for Four Quarts._\n\n  1 lb. of white roux.\n  4½ quarts of boiling milk.\n\n_Preparation._—Pour the milk on the roux (see No. 21).\n\n\n29—TOMATO SAUCE\n\nTomatoes.\n\nMENUS DE DEJEUNERS.\n\n_Menu._\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\nlicence footer';
  const e = parse(raw); assert.equal(e.length, 2); assert.equal(e[0].no, '28'); assert.equal(e[0].section, 'Leading warm sauces');
  assert.deepStrictEqual(e[0].ingredients, ['1 lb. of white roux.', '4½ quarts of boiling milk.']); assert.deepStrictEqual(e[0].refs, ['21']);
  assert.ok(!/Gutenberg|licence|MENUS/.test(JSON.stringify(e)));
});
test('library: full 1907 guide loaded into FTS5 with attribution', async () => {
  assert.equal(db.prepare('SELECT COUNT(*) c FROM escoffier').get().c, 2999);
  const l = await esc.list(all, { q: 'béchamel' }); assert.equal(l.entries[0].no, '28'); assert.match(l.attribution, /Heinemann, 1907.*Gutenberg/);
  const one = await esc.one(all, '27'); assert.equal(one.entry.title, 'Allemande Sauce or Thickened Velouté');
  assert.equal(await esc.one(all, '99999'), null);
});
test('retrieval: relevant dishes plus their foundation sauces, compact for the token budget', async () => {
  const r = await esc.references(all, { include: ['chicken', 'mushrooms'] });
  assert.ok(r.filter(x => x.role === 'primary').length >= 2); assert.ok(r.some(x => x.role === 'foundation'));
  assert.ok(JSON.stringify(r).length < 3500, 'context too large');
  const pinned = await esc.references(all, { dish: 'anything' }, { pinned: '1500' }); assert.equal(pinned[0].no, '1500');
  const veg = await esc.references(all, { include: ['mushrooms'], diets: ['vegetarian'] }); assert.ok(veg.every(x => !['Poultry & game', 'Fish'].includes(x.section)));
});
test('citation: only numbers actually supplied are cited', () => {
  const refs = [{ no: '1540', title: 'POULET SAUTÉ BRETONNE' }];
  assert.equal(esc.cite({ inspiredBy: '1540' }, refs).label, 'Inspired by Escoffier, Guide No. 1540: Poulet Sauté Bretonne');
  assert.equal(esc.cite({ inspiredBy: 'No. 9999' }, refs), null); assert.equal(esc.cite({ inspiredBy: null }, refs), null); assert.equal(esc.cite({ inspiredBy: '1540' }, []), null);
});
test('AI grounding: references sent to Malcolm and citation badge attached', async () => {
  process.env.AI_PROVIDER = 'malcolm'; process.env.MALCOLM_AI_URL = 'https://example.invalid/'; process.env.MALCOLM_AI_MODE = 'lattice';
  delete require.cache[require.resolve('../src/ai')]; const ai = require('../src/ai');
  const references = await esc.references(all, { include: ['chicken', 'mushrooms'] }); let sent;
  const r = { title: 'Chicken Sauté Bretonne', cuisine: 'French', difficulty: 'medium', totalMinutes: 45, servings: 2, matchScore: 90, whyItFits: 'Escoffier classic.', inspiredBy: references[0].no,
    ingredients: [{ name: 'chicken thighs', qty: 4, unit: 'x' }, { name: 'mushrooms', qty: 200, unit: 'g' }], steps: [{ text: 'Brown the chicken.', timerMinutes: 8 }, { text: 'Cook to 75C core.', timerMinutes: 20 }],
    allergens: ['milk'], nutritionPerServing: { kcal: 600, proteinG: 45, carbsG: 10, fatG: 35 }, substitutions: [] };
  const out = await ai.generate({ include: ['chicken', 'mushrooms'], maxMinutes: 45, servings: 2, diets: [] }, { references, retries: 0,
    fetchImpl: async (u, o) => { sent = JSON.parse(o.body); return { ok: true, json: async () => ({ recipes: [r] }) }; } });
  assert.equal(sent.references.length, references.length); assert.ok(sent.references[0].text.length > 50);
  assert.match(out.recipes[0].escoffier.label, /^Inspired by Escoffier, Guide No\. \d+/); assert.ok(!('inspiredBy' in out.recipes[0]));
  for (const k of ['AI_PROVIDER', 'MALCOLM_AI_URL', 'MALCOLM_AI_MODE']) delete process.env[k];
});
test('API: /api/escoffier browse + entry endpoints are public', async () => {
  process.env.AI_PROVIDER = 'none'; delete require.cache[require.resolve('../src/server')];
  const request = require('supertest'); const { createApp } = require('../src/server'); const ag = request(createApp({ db, stripe: null }));
  const l = await ag.get('/api/escoffier?q=sole&section=Fish'); assert.equal(l.status, 200); assert.ok(l.body.entries.length > 0 && l.body.entries.every(e => e.section === 'Fish'));
  const b = await ag.get('/api/escoffier?page=1'); assert.equal(b.body.entries.length, 24); assert.equal(b.body.sections.length, 23);
  assert.equal((await ag.get('/api/escoffier/28')).body.entry.no, '28'); assert.equal((await ag.get('/api/escoffier/nope')).status, 404);
});
