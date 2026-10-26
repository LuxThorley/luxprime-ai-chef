const test = require('node:test'); const assert = require('node:assert');
const K = require('../src/keywords'); const { rank } = require('../src/ranker'); const chat = require('../src/chat'); const ai = require('../src/ai');
const base = { dish: '', diets: [], cuisines: [], servings: 2, maxMinutes: 480, limit: 5, inspirationMode: 'blend', exclude: [], include: [] };
test('parseKeywords normalises, singularises and dedupes', () => {
  assert.deepStrictEqual(K.parseKeywords('snack, Romantic,, magical; quick, cakes, Christmas, cake'), ['snack', 'romantic', 'magical', 'quick', 'cake', 'christmas']);
  assert.ok(K.parseKeywords(Array(30).fill(0).map((_, i) => 'k' + i)).length <= 12);
});
test('keyword boost moves matching recipes up', () => {
  const plain = rank({ ...base }).map(r => r.title); const kw = rank({ ...base, keywords: ['curry'] });
  assert.ok(/curry/i.test(JSON.stringify(kw[0])), kw[0].title); assert.ok(plain.length);
});
test('slimming is a hard diet filter on kcal/protein', () => {
  const out = rank({ ...base, diets: ['slimming'], limit: 10 }); assert.ok(out.length);
  for (const r of out) { const n = require('../src/nutrition').compute(r).perServing; assert.ok(n.energyKcal <= 550 && n.proteinG >= 15, r.title); }
  assert.match(K.SLIMMING_NOTE, /not medical/i); assert.match(K.SLIMMING_NOTE, /pregnan/i);
});
test('style cuisines exist with rules', () => {
  for (const c of ['Haute Cuisine', 'Family', 'Experimental']) { assert.ok(K.isStyleCuisine(c)); assert.ok(K.cuisineRules([c]).length === 1); }
  assert.ok(rank({ ...base, cuisines: ['Family'] }).length);
});
test('prompt carries keywords, style and slimming rules', () => {
  const s = JSON.stringify(ai.buildUserPrompt({ ...base, keywords: ['romantic'], cuisines: ['Haute Cuisine'], diets: ['slimming'] }, []));
  assert.match(s, /romantic/); assert.match(s, /Haute Cuisine/); assert.match(s, /kcal/i);
});
test('chat refinement keeps and extends keywords', () => {
  const r = chat.parseRefinement('make it more romantic'); assert.deepStrictEqual(r.changes.addKeywords, ['romantic']);
  assert.deepStrictEqual(chat.applyChanges({ ...base, keywords: ['snack'] }, r.changes).keywords, ['snack', 'romantic']);
  assert.deepStrictEqual(chat.applyChanges({ ...base, keywords: ['snack'] }, {}).keywords, ['snack']);
  assert.ok(chat.parseRefinement('help me lose weight').changes.addDiets.includes('slimming'));
});
