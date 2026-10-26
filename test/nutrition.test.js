const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs');
const N = require('../src/nutrition'); const { RECIPES } = require('../src/recipes'); const { rank } = require('../src/ranker');
test('every library recipe gets complete guide nutrition to 1 dp', () => {
  for (const r of RECIPES) { const n = N.attach({ ...r }).nutrition; assert.ok(n.coverage >= 90, r.title); assert.ok(n.totalWeightG > 100);
    for (const part of ['total', 'perServing', 'per100g']) for (const k of ['energyKj', ...N.KEYS]) { const v = n[part][k]; assert.ok(Number.isFinite(v) && Math.round(v * 10) === v * 10 || Math.abs(Math.round(v * 10) - v * 10) < 1e-6, `${r.title} ${part}.${k}`); }
    assert.ok(Math.abs(n.total.energyKj - n.total.energyKcal * 4.184) < 1); }
});
test('ingredient lookup, units and salt from sodium', () => {
  assert.strictEqual(N.lookup('chicken stock').keys.includes('stock'), true); assert.ok(N.lookup('butternut squash').keys.startsWith('butternut'));
  const n = N.compute({ servings: 1, ingredients: [{ name: 'salt', qty: 1, unit: 'tsp' }, { name: 'olive oil', qty: 1, unit: 'tbsp' }], steps: [] });
  assert.ok(Math.abs(n.total.saltG - 5 * 38758 * 2.5 / 1e5) < 0.2, n.total.saltG); assert.ok(n.total.fatG > 14 && n.total.fatG < 15.5);
});
test('FSA traffic-light thresholds, per-portion reds and positive fibre/protein', () => {
  assert.strictEqual(N.band('fatG', 2, 2, 100).level, 'low'); assert.strictEqual(N.band('fatG', 10, 10, 100).level, 'medium'); assert.strictEqual(N.band('fatG', 18, 18, 100).level, 'high');
  assert.strictEqual(N.band('saltG', 1, 2.5, 250).level, 'high'); // per portion > 1.8 g when portion > 100 g
  assert.strictEqual(N.band('sugarsG', 5, 5, 100).level, 'low'); assert.strictEqual(N.band('sugarsG', 22.6, 5, 100).level, 'high');
  const a = N.band('fatG', 4, 4, 100).colour, b = N.band('fatG', 17, 17, 100).colour; assert.notStrictEqual(a, b); // smooth shading within the amber band
  const L = N.lights({ perServing: { energyKcal: 500, proteinG: 30, fatG: 5, saturatesG: 1, sugarsG: 3, saltG: 0.5 }, per100g: { fibreG: 6.5, fatG: 2, saturatesG: 0.5, sugarsG: 1, saltG: 0.2 }, portionG: 300 });
  assert.strictEqual(L.fibreG.label, 'HIGH'); assert.strictEqual(L.proteinG.label, 'HIGH'); assert.strictEqual(L.energy.label, '25% RI'); assert.match(N.SOURCES, /FSA/); assert.match(N.SOURCES, /1169\/2011/); assert.match(N.SOURCES, /WHO/);
});
test('LLM recipe without quantities falls back to Malcolm’s estimate', () => {
  const n = N.compute({ servings: 2, nutritionPerServing: { kcal: 450, proteinG: 30, carbsG: 40, fatG: 15 }, ingredients: [{ name: 'mystery thing' }], steps: [] }); assert.strictEqual(n.method, 'estimated'); assert.strictEqual(n.perServing.energyKcal, 450);
});
test('attachAll backfills nested recipes; slimming filter uses guide values', () => {
  const j = N.attachAll({ items: [{ recipe: { title: 'x', ingredients: [{ name: 'egg', qty: 2, unit: 'x' }], steps: [{ text: 'a' }] } }] }); assert.ok(j.items[0].recipe.nutrition.lights.saltG);
  const out = rank({ dish: '', diets: ['slimming'], cuisines: [], servings: 2, maxMinutes: 480, limit: 10, inspirationMode: 'blend', exclude: [], include: [] });
  for (const r of out) { const n = N.compute(r).perServing; assert.ok(n.energyKcal <= 550 && n.proteinG >= 15, r.title); }
});
test('browser copy is identical', () => assert.strictEqual(fs.readFileSync(__dirname + '/../public/js/nutrition.js', 'utf8'), fs.readFileSync(__dirname + '/../src/nutrition.js', 'utf8')));
