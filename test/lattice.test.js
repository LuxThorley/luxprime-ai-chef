'use strict';
const test = require('node:test'); const assert = require('node:assert');
test('malcolm lattice mode: posts to /v1/recipes and falls back to library on an invalid reply', async () => {
  process.env.AI_PROVIDER = 'malcolm'; process.env.MALCOLM_AI_URL = 'https://example.invalid/'; process.env.MALCOLM_AI_KEY = 'test'; process.env.MALCOLM_AI_MODE = 'lattice';
  const ai = require('../src/ai'); const calls = [];
  const fetchImpl = async (url, o) => { calls.push({ url, body: JSON.parse(o.body) }); return { ok: true, json: async () => ({ status: 'executed', error: 'nope' }) }; };
  const out = await ai.generate({ include: ['chicken', 'rice'], maxMinutes: 40, servings: 2, diets: [] }, { fetchImpl, retries: 0 });
  assert.equal(calls[0].url, 'https://example.invalid/v1/recipes'); assert.deepStrictEqual(calls[0].body.include, ['chicken', 'rice']);
  assert.equal(out.source, 'offline'); assert.ok(out.recipes.length > 0);
  for (const k of ['AI_PROVIDER', 'MALCOLM_AI_URL', 'MALCOLM_AI_KEY', 'MALCOLM_AI_MODE']) delete process.env[k];
});
test('malcolm recipes mode: accepts valid AI recipes', async () => {
  process.env.AI_PROVIDER = 'malcolm'; process.env.MALCOLM_AI_URL = 'https://example.invalid/'; process.env.MALCOLM_AI_MODE = 'lattice';
  delete require.cache[require.resolve('../src/ai')]; const ai = require('../src/ai');
  const r = { title: 'Garlic Chicken Rice', cuisine: 'British', difficulty: 'easy', totalMinutes: 30, servings: 2, matchScore: 90, whyItFits: 'Uses all three.',
    ingredients: [{ name: 'chicken thigh', qty: 300, unit: 'g' }, { name: 'basmati rice', qty: 150, unit: 'g' }, { name: 'garlic', qty: 3, unit: 'x' }],
    steps: [{ text: 'Cook the rice.', timerMinutes: 12 }, { text: 'Fry the chicken until 75C core.', timerMinutes: 10 }], allergens: [],
    nutritionPerServing: { kcal: 550, proteinG: 40, carbsG: 60, fatG: 14 }, substitutions: [] };
  const out = await ai.generate({ include: ['chicken'], maxMinutes: 40, servings: 2, diets: [] }, { fetchImpl: async () => ({ ok: true, json: async () => ({ recipes: [r] }) }), retries: 0 });
  assert.equal(out.source, 'malcolm'); assert.equal(out.recipes[0].title, 'Garlic Chicken Rice'); assert.equal(out.recipes[0].source, 'Malcolm AI');
  for (const k of ['AI_PROVIDER', 'MALCOLM_AI_URL', 'MALCOLM_AI_MODE']) delete process.env[k];
});
