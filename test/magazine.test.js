'use strict';
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const M = require('../src/magazine'); const P = require('../src/pdf');
const H = [{ query_json: JSON.stringify({ include: ['chicken', 'mushrooms'], diets: ['gluten-free'], difficulty: 'easy', maxMinutes: 30, servings: 2, excludeAllergens: ['peanuts'] }) }, { query_json: JSON.stringify({ include: ['chicken', 'leeks'], diets: ['gluten-free'], maxMinutes: 40, servings: 2 }) }];
const R = (t, ings) => ({ title: t, tagline: 'x', totalMinutes: 30, difficulty: 'easy', servings: 2, ingredients: ings.map(n => ({ name: n, qty: 1, unit: 'x', display: '1 ' + n })), steps: [{ text: 'Cook it well.' }] });
test('profile + query use history, saved options and season; never drop excluded allergens', () => {
  const p = M.buildProfile({ history: H, favourites: [{ recipe_json: JSON.stringify(R('Fav', ['chicken thighs', 'tarragon'])) }], user: { email: 'oliver.t@x.com' } }, new Date('2026-11-01T08:00:00Z'));
  assert.equal(p.name, 'Oliver'); assert.equal(p.top[0].name, 'chicken'); assert.deepEqual(p.diets, ['gluten-free']); assert.deepEqual(p.excludeAllergens, ['peanuts']); assert.equal(p.month, 'November'); assert.equal(p.synthetic, false);
  const q = M.buildQuery(p); assert.equal(q.limit, 3); assert.ok(q.include.slice(0, 2).every(i => p.top.slice(0, 4).some(t => t.name === i))); assert.ok(q.include.includes('pumpkin')); assert.deepEqual(q.excludeAllergens, ['peanuts']); assert.match(q.dish, /November/);
  assert.equal(M.buildProfile({ history: [], favourites: [], user: {} }).synthetic, true);
});
test('shopping list: grouped by aisle, regulars first, pantry staples assumed, merged plurals, "maybe out" excludes listed items', () => {
  const p = M.buildProfile({ history: H }); const s = M.shoppingList([R('A', ['chicken thighs', 'shallot', 'salt', 'olive oil', 'double cream']), R('B', ['shallots', 'garlic', 'red wine'])], p);
  const names = s.aisles.flatMap(a => a.items.map(i => i.name)); assert.ok(!names.includes('salt') && s.assumed.includes('salt'));
  assert.equal(names.filter(n => /^shallot/.test(n)).length, 1); assert.equal(s.aisles[0].aisle, 'Fruit & vegetables');
  assert.ok(s.aisles.find(a => a.aisle === 'Meat & poultry').items[0].regular);
  assert.ok(!s.maybeOut.some(m => m.name === 'chicken')); assert.ok(s.maybeOut.every(m => /often/.test(m.why)));
});
test('pairings are styles/grapes/regions (no prices/brands) and match the dish', () => {
  assert.match(M.pairing(R('Poulet Sauté aux Champignons', ['chicken'])).wine, /Chardonnay|Burgundy|Chenin|Pinot/);
  assert.doesNotMatch(M.pairing(R('Poulet Sauté aux Champignons', ['chicken'])).wine, /Riesling \(Alsace\)|Alsace Riesling/);
  assert.match(M.pairing(R('Braised beef', ['beef'])).wine, /Syrah|Rioja/); assert.match(M.pairing(R('Poached pears', ['pears'])).wine, /Chenin|Riesling/);
  const w = M.pairing({ title: 'X', pairing: 'Brand X £12.99' }); assert.doesNotMatch(w.wine, /£/);
});
test('PDF writer: WinAnsi encoding and a valid 7-page magazine', () => {
  assert.deepEqual(P.encode('£é—’'), [0xa3, 0xe9, 0x97, 0x92]); assert.deepEqual(P.encode('🍷a'), [0x61]);
  const fontFiles = Object.fromEntries(['serif', 'serifI', 'serifB', 'sans', 'sansB'].map(k => [k, new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'public', 'mag', k + '.bin')))]));
  const jpg = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'pasta.jpg')));
  const p = M.buildProfile({ history: H, user: { name: 'Oliver' } }); const recipes = [R('Poulet Sauté', ['chicken thighs', 'mushrooms']), R('Salmon', ['salmon']), R('Pears', ['pears'])].map(r => ({ ...r, _pairing: M.pairing(r) }));
  const pdf = M.render({ profile: p, recipes, shop: M.shoppingList(recipes, p), issueNo: 1, manageUrl: 'https://x/account', escoffierNote: M.escoffierNote(recipes, null, p) }, { hero: jpg, dishes: [jpg, jpg, jpg] }, fontFiles);
  const f = path.join(require('os').tmpdir(), 'mag-test.pdf'); fs.writeFileSync(f, pdf);
  try { const info = execFileSync('pdfinfo', [f]).toString(); assert.match(info, /Pages:\s+7/); const txt = execFileSync('pdftotext', [f, '-']).toString(); assert.match(txt, /Prepared for Oliver/); assert.match(txt, /Your shopping list/); assert.match(txt, /Wines & accompaniments/); }
  catch (e) { if (e.code !== 'ENOENT') throw e; assert.equal(String.fromCharCode(...pdf.slice(0, 8)), '%PDF-1.7'); }
});
