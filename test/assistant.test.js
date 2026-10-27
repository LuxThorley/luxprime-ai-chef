'use strict';
const test = require('node:test'); const assert = require('node:assert');
const A = require('../src/assistant');
const mem = (o = {}) => A.cleanMemory({ consent: true, ...o });

test('memory requires consent and validates fields', () => {
  assert.strictEqual(A.cleanMemory({ allergies: ['milk'] }), null);
  const m = mem({ allergies: ['milk', 'peanuts'], diets: ['vegetarian'], household: 4, kit: ['air fryer'] });
  assert.deepStrictEqual(m.allergies, ['milk', 'peanuts']); assert.strictEqual(m.household, 4);
  assert.strictEqual(A.cleanMemory({ consent: true, allergies: ['plutonium'] }), null);
  assert.match(A.memorySummary(m), /ALLERGIES.*milk/);
});
test('search never returns recipes containing member allergens or breaking diets', () => {
  const m = mem({ allergies: ['milk', 'cereals containing gluten'], diets: ['vegetarian'] });
  const r = A.search({ text: 'pasta dinner', mem: m, limit: 5 });
  assert.ok(r.length > 0);
  for (const c of r) { assert.ok(!c.allergens.includes('milk') && !c.allergens.includes('cereals containing gluten'), c.title); assert.ok(A.safeFor(A.recipeById(c.id), m)); }
});
test('fridge-to-plate parses text and ranks recipes that use it', () => {
  const items = A.parseIngredients('I have chicken, peppers and rice');
  assert.deepStrictEqual(items, ['chicken', 'peppers', 'rice']);
  const r = A.fridgeToPlate(items); assert.ok(r[0].uses >= 2); assert.ok(Array.isArray(r[0].missing));
  assert.deepStrictEqual(A.parseVision('Ingredients: Eggs, milk, cheddar cheese, carrots'), ['eggs', 'milk', 'cheddar cheese', 'carrots']);
});
test('cook-along plan has timers and safety; voice commands parse', () => {
  const p = A.cookPlan(A.recipeById('classic-spaghetti-bolognese'));
  assert.ok(p.steps.some(s => s.timerSec === 25 * 60)); assert.ok(p.safety.some(n => /70°C/.test(n)));
  assert.deepStrictEqual(A.parseCommand('Hey Malcolm, next step'), { cmd: 'next' });
  assert.deepStrictEqual(A.parseCommand('start timer for 5 minutes'), { cmd: 'timer', sec: 300 });
  assert.deepStrictEqual(A.parseCommand('how long left?'), { cmd: 'timeleft' });
  assert.deepStrictEqual(A.parseCommand('go back'), { cmd: 'prev' });
  assert.strictEqual(A.parseCommand('what a lovely day'), null);
});
test('meal plan respects budget, allergies and household; shopping list is aisle-sorted', () => {
  const m = mem({ allergies: ['fish'], household: 4 });
  const p = A.mealPlan({ mem: m, budgetGBP: 40 });
  assert.strictEqual(p.days.length, 7); assert.strictEqual(p.servings, 4); assert.ok(new Set(p.days.map(d => d.id)).size === 7);
  for (const d of p.days) assert.ok(!d.allergens.includes('fish'));
  const s = A.shoppingList(p.days.map(d => d.id), { servings: 4 });
  const aisles = s.map(a => a.aisle); assert.ok(aisles.length >= 3);
  assert.ok(!s.flatMap(a => a.items).some(i => i.name === 'salt'));
  assert.strictEqual(A.aisleOf('chopped tomatoes'), 'Tins, jars & dried'); assert.strictEqual(A.aisleOf('red onion'), 'Fruit & veg'); assert.strictEqual(A.aisleOf('cheddar'), 'Dairy & eggs');
});
test('premium gating follows existing plans', () => {
  const free = { id: 1, plan: 'free', sub_status: null, email: 'a@b.c' }, cdp = { id: 2, plan: 'monthly', sub_status: 'active', email: 'x@y.z' }, gas = { id: 3, plan: 'gastronomique', sub_status: 'active', email: 'g@h.i' };
  assert.strictEqual(A.tierOf(null), 'guest'); assert.strictEqual(A.tierOf(free), 'free'); assert.strictEqual(A.tierOf(cdp), 'paid'); assert.strictEqual(A.tierOf(gas), 'household');
  assert.ok(A.can(null, 'chat') && A.can(null, 'cookalong') && A.can(null, 'fridgeText'));
  assert.ok(!A.can(free, 'mealPlan') && A.can(cdp, 'mealPlan') && !A.can(cdp, 'householdPlan') && A.can(gas, 'householdPlan'));
  assert.ok(!A.can(null, 'memory') && A.can(free, 'memory'));
  assert.match(A.gate(free, 'fridgePhoto').upgrade, /pricing/);
});
test('safety layer: unsafe questions, medical questions, allergen warnings, disclosure', async () => {
  const r = await A.respond({ message: 'Can I eat pink chicken?', history: [] }, {});
  assert.match(r.reply + r.notes.join(' '), /75°C/); assert.match(r.disclosure, /AI/);
  const m = await A.respond({ message: 'What should I eat for my diabetes?', history: [] }, {});
  assert.ok(m.notes.includes(A.MEDICAL_NOTE));
  const a = await A.respond({ message: 'recipe with peanuts please', history: [] }, { mem: mem({ allergies: ['peanuts'] }) });
  assert.ok(a.notes.some(n => /peanuts/.test(n))); for (const c of a.recipes) assert.ok(!c.allergens.includes('peanuts'));
  const bad = await A.respond({ message: 'quick dinner', history: [] }, { llm: async () => 'Just serve the chicken pink, it is fine.' });
  assert.doesNotMatch(bad.reply, /pink/);
});
test('LLM used when available, library fallback when it fails', async () => {
  const ok = await A.respond({ message: 'what can I cook tonight?', history: [] }, { llm: async () => 'Try the fajitas — 20 minutes, sizzling hot pan.' });
  assert.strictEqual(ok.source, 'ai'); assert.match(ok.reply, /fajitas/);
  const fb = await A.respond({ message: 'what can I cook tonight?', history: [] }, { llm: async () => { throw new Error('quota'); } });
  assert.notStrictEqual(fb.source, 'ai'); assert.ok(fb.recipes.length);
});
test('site guide answers plans, gifts, restaurateur, account; escalation to Oliver', async () => {
  assert.match(A.guide('how much are your plans?').reply, /Chef de Partie/);
  assert.strictEqual(A.guide('can I buy a gift certificate').link, '/gift.html');
  assert.strictEqual(A.guide('tell me about restauranteur packs').link, '/restauranteur.html');
  assert.strictEqual(A.guide('I forgot my password').link, '/account.html');
  const e = await A.respond({ message: 'I want to speak to a real person', history: [] }, {}); assert.ok(e.escalate);
  assert.match(A.mailtoEscalation({ message: 'refund please', email: 'a@b.c' }), /^mailto:malcolm@aichef\.food\?subject=/);
  assert.ok(!A.Escalation.safeParse({ message: 'hi' }).success);
});
test('knowledge index grounds site answers with sources and admits ignorance', async () => {
  const K = require('../src/knowledge'); assert.ok(K.size > 100);
  const g = await A.respond({ message: 'how do I redeem a gift certificate?', history: [] }, {}); assert.ok(g.sources.some(s => /redeem|gift/i.test(s.url)));
  const r = await A.respond({ message: 'what is in the restauranteur kitchen pack?', history: [] }, {}); assert.ok(r.sources.some(s => s.url === '/restauranteur.html'));
  const n = await A.respond({ message: 'do you deliver groceries to my house?', history: [] }, {}); assert.strictEqual(n.reply, A.DONT_KNOW); assert.ok(n.escalate);
  const n2 = await A.respond({ message: 'do you deliver groceries to my house?', history: [] }, { llm: async () => 'Yes, next-day delivery!' }); assert.strictEqual(n2.reply, A.DONT_KNOW);
  const id = await A.respond({ message: 'are you human?', history: [] }, {}); assert.match(id.reply, /AI chef assistant/); assert.match(id.reply, /not a human/);
  assert.match(A.PERSONA, /Escoffier/); assert.match(A.PERSONA, /never claim to be human/);
});
test('LLM receives knowledge, profile and adaptive skill guidance', async () => {
  let seen; await A.respond({ message: 'how much is head chef?', history: [] }, { llm: async m => { seen = m[0].content; return 'Head Chef is £7.99 a month.'; }, mem: mem({ skill: 'beginner' }) });
  assert.match(seen, /KNOWLEDGE/); assert.match(seen, /Head Chef/); assert.match(seen, /Skill: beginner/);
});
test('follow-up: ingredient questions route to search; Escoffier only when relevant; provider surfaced; errors logged', async () => {
  assert.strictEqual(A.intent('What can I cook tonight with chicken and peppers?'), 'fridge');
  const r = await A.respond({ message: 'What can I cook tonight with chicken and peppers?', history: [] }, {}); assert.strictEqual(r.recipes[0].title, 'Chicken Fajitas');
  const s = await A.respond({ message: 'Why does my sauce split?', history: [] }, { refs: [{ no: 2624, title: 'Blanc-Mange', snippet: 'x' }] }); assert.doesNotMatch(s.reply, /Blanc-Mange/);
  const h = await A.respond({ message: 'Why does my hollandaise split?', history: [] }, { refs: [{ no: 100, title: 'Hollandaise Sauce', snippet: 'y' }] }); assert.match(h.reply, /Hollandaise/);
  const p = await A.respond({ message: 'why does bread go stale?', history: [] }, { llm: async () => ({ text: 'Starch retrogradation, mostly.', provider: 'malcolm-sync:gemini' }) }); assert.strictEqual(p.source, 'malcolm-sync:gemini');
  const orig = console.error; let logged = ''; console.error = (...a) => { logged += a.join(' '); };
  try { const f = await A.respond({ message: 'why does bread go stale?', history: [] }, { llm: async () => { throw new Error('boom'); } }); assert.notStrictEqual(f.source, 'ai'); } finally { console.error = orig; }
  assert.match(logged, /assistant llm error boom/);
});
test('unwraps JSON-wrapped model replies', () => {
  assert.strictEqual(A.unwrapReply('{ "response": "Use fajitas." }'), 'Use fajitas.');
  assert.strictEqual(A.unwrapReply('[{"role":"assistant","content":"Soda needs acid."}]'), 'Soda needs acid.');
  assert.strictEqual(A.unwrapReply('{"response": "Cut off mid'), 'Cut off mid');
  assert.strictEqual(A.unwrapReply('Plain text.'), 'Plain text.');
});
test('unwraps live Malcolm-sync shapes', () => {
  assert.strictEqual(A.unwrapReply('[ { "chef": "Malcolm", "response": "Whisk in boiling water." } ]'), 'Whisk in boiling water.');
  assert.strictEqual(A.unwrapReply('{ "message": "No peanuts for you." }'), 'No peanuts for you.');
  assert.match(A.unwrapReply('{ "recipe": "Chicken Fajitas", "description": "Sizzling strips of chicken.", "prep_and_cook_time": "25 minutes" }'), /^Sizzling strips/);
  assert.strictEqual(A.unwrapReply('```json\n{"reply":"Hi."}\n```'), 'Hi.');
});
test('strips leftover leading labels', () => {
  assert.strictEqual(A.unwrapReply('recipe: Chicken Fajitas. Slice your chicken thinly.'), 'Slice your chicken thinly.');
  assert.strictEqual(A.unwrapReply('Answer: Whisk in boiling water.'), 'Whisk in boiling water.');
  assert.strictEqual(A.unwrapReply('Malcolm: Rest the meat.'), 'Rest the meat.');
  assert.strictEqual(A.unwrapReply('Recipes are great. Try fajitas.'), 'Recipes are great. Try fajitas.');
});
