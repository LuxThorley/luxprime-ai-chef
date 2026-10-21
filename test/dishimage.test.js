'use strict';
const test = require('node:test'); const assert = require('node:assert'); const d = require('../src/dishimage');
const r = { title: 'Poulet Sauté Bretonne Moderne', tagline: 'Golden chicken, leeks and mushrooms in cream.', servings: 2,
  ingredients: [{ name: '4 chicken thighs' }, { name: '200 g chestnut mushrooms, sliced' }, { name: '1 leek' }, { name: 'olive oil' }, { name: 'salt' }, { name: '100 ml double cream' }, { name: 'tarragon (optional)' }],
  steps: [{ text: 'Sear the chicken until golden.' }, { text: 'Sauté the leek and mushrooms.' }] };
test('prompt is built from the real recipe: title, visible ingredients, method, garnish, plating, constraints', () => {
  const p = d.buildPrompt(r);
  for (const k of ['Poulet Sauté Bretonne Moderne', 'chicken thighs', 'chestnut mushrooms', 'leek', 'double cream', 'pan-seared', 'tarragon', 'window light', 'No text', 'no hands']) assert.ok(p.includes(k), k);
  assert.ok(!/olive oil|\bsalt\b/.test(p.split('Clearly visible')[1].split('.')[0]), 'pantry staples excluded'); assert.ok(p.length <= 1400);
  assert.match(d.buildPrompt({ title: 'Velouté de Champignons', ingredients: [{ name: 'mushrooms' }], steps: [] }), /soup bowl/);
});
test('alt text and stable cache key (title + key ingredients, order-independent)', async () => {
  assert.match(d.altText(r), /^Photo of Poulet Sauté Bretonne Moderne with chicken thighs/);
  const k1 = await d.imageKey(r); const k2 = await d.imageKey({ ...r, ingredients: [...r.ingredients].reverse(), steps: [] });
  assert.match(k1, /^[0-9a-f]{32}$/); assert.equal(k1, k2); assert.notEqual(k1, await d.imageKey({ ...r, title: 'Other' }));
});
test('daily caps protect quotas: admin > tester > member > free', () => { const c = d.DAILY_CAPS; assert.ok(c.admin > c.tester && c.tester > c.member && c.member > c.free && c.free > 0); });
