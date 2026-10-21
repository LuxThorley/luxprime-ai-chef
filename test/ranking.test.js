'use strict';
const test = require('node:test'); const assert = require('node:assert');
const { rank } = require('../src/ranker'); const { RECIPES, scale, UK14 } = require('../src/recipes');
const { isUnsafe, enforceAllergens } = require('../src/safety'); const { curatedImage } = require('../src/images');

test('dataset has ~60 valid recipes with UK-14 allergens and images', () => {
  assert.ok(RECIPES.length >= 60);
  for (const r of RECIPES) { assert.ok(r.steps.length >= 2); assert.ok(r.allergens.every(a => UK14.includes(a))); assert.match(r.image.src, /^\/img\/.+\.webp$/); }
});
test('ingredient overlap ranks best match first', () => {
  const out = rank({ include: ['chicken', 'honey', 'rice'], servings: 4 });
  assert.equal(out[0].title, 'Sticky Honey Garlic Chicken'); assert.ok(out[0].matchScore >= out[1].matchScore);
});
test('dish description search works', () => { assert.match(rank({ dish: 'thai green curry' })[0].title, /Thai Green Curry/); });
test('diet filters are hard constraints', () => {
  for (const d of ['vegan', 'gluten-free', 'dairy-free', 'nut-free', 'halal', 'vegetarian']) for (const r of rank({ dish: 'dinner curry pasta soup', include: ['onion'], diets: [d], limit: 10 })) assert.ok(r.diet[d], `${r.title} not ${d}`);
  assert.ok(rank({ include: ['onion'], diets: ['vegan'], limit: 20 }).every(r => !/chicken|beef|butter|cheese/i.test(r.ingredients.map(i => i.name).join())));
});
test('exclusions and time budget respected', () => {
  const out = rank({ include: ['pasta', 'tomato'], exclude: ['mince'], maxMinutes: 30, limit: 10 });
  assert.ok(out.every(r => !r.ingredients.some(i => /mince/.test(i.name)))); assert.ok(out.every(r => r.totalMinutes <= 37.5));
});
test('difficulty preference boosts matching recipes', () => { const out = rank({ include: ['rice'], difficulty: 'hard', limit: 3 }); assert.equal(out[0].difficulty, 'hard'); });
test('scaling to servings', () => {
  const b = RECIPES.find(r => r.title === 'Classic Spaghetti Bolognese'); const s = scale(b, 8);
  assert.equal(s.ingredients[0].qty, 800); assert.match(s.ingredients[1].display, /1 kg beef mince/);
});
test('shopping list lists missing ingredients only', () => { const r = rank({ include: ['spaghetti', 'beef mince'], dish: 'bolognese' })[0]; assert.ok(!r.shoppingList.some(x => /spaghetti/.test(x))); assert.ok(r.shoppingList.some(x => /onion/.test(x))); });
test('deterministic output', () => { const q = { include: ['egg'], maxMinutes: 30 }; assert.deepStrictEqual(rank(q).map(r => r.id), rank(q).map(r => r.id)); });
test('safety guardrails flag unsafe advice and re-derive allergens', () => {
  assert.ok(isUnsafe({ title: 'x', steps: [{ text: 'Serve chicken pink in the middle' }] }));
  assert.ok(!isUnsafe({ title: 'x', steps: [{ text: 'Cook chicken to 75°C' }] }));
  const r = enforceAllergens({ ingredients: [{ name: 'king prawns' }, { name: 'peanut butter' }], allergens: [] });
  assert.deepStrictEqual(r.allergens, ['crustaceans', 'peanuts']);
});
test('curated image fallback picks closest category', () => { assert.match(curatedImage({ title: 'Mystery Ramen Noodle Bowl' }).src, /asian/); assert.match(curatedImage({ title: 'Lemon Drizzle Cake' }).src, /baking/); });
