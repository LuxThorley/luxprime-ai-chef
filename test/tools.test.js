'use strict';
const test = require('node:test'); const assert = require('node:assert'); const fs = require('node:fs'); const path = require('node:path');
const Database = require('better-sqlite3');
const T = require('../src/tools'); const A = require('../src/assistant'); const M = require('../src/memory'); const plans = require('../src/plans');

function setup() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT, plan TEXT, sub_status TEXT); INSERT INTO users(id) VALUES(1),(2),(99);');
  db.exec("CREATE TABLE favourites (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, recipe_id TEXT NOT NULL, recipe_json TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, recipe_id));");
  db.exec(fs.readFileSync(path.join(__dirname, '../worker/migrations/0013_shopping_list.sql'), 'utf8'));
  const q = { all: async (s, p = []) => db.prepare(s).all(...p), get: async (s, p = []) => db.prepare(s).get(...p) || null, run: async (s, p = []) => db.prepare(s).run(...p) };
  const paid = { id: 1, email: 'p@x.co', plan: 'monthly', sub_status: 'active' }; const free = { id: 2, email: 'f@x.co', plan: 'free', sub_status: null };
  const allowed = new Map();
  const ctx = (u, extra = {}) => ({ q, u, mem: null, can: A.can, isPremium: plans.isPremium, allow: async (b, lim) => { const n = (allowed.get(b) || 0) + 1; allowed.set(b, n); return { ok: n <= lim }; }, imageFor: async r => ({ src: '/api/dish-image/' + 'a'.repeat(32), alt: r.title }), newRecipe: async () => [200, { source: 'malcolm', recipes: [{ id: 'x', title: 'Duck with Plums', totalMinutes: 40 }] }], ...extra });
  return { db, q, paid, free, ctx };
}

test('intent routing picks the right tool and resolves recipes from the message or the last card', () => {
  assert.deepStrictEqual(T.detect('add eggs and milk to my shopping list'), { name: 'add_shopping', args: { items: ['eggs', 'milk'] } });
  assert.strictEqual(T.detect('scale it for 6 people', { lastRecipeIds: ['chicken-tikka-masala'] }).args.recipeId, 'chicken-tikka-masala');
  assert.strictEqual(T.detect('does the spaghetti bolognese contain gluten?').name, 'check_allergens');
  assert.deepStrictEqual(T.detect('clear my shopping list').args, { confirmed: false });
  assert.strictEqual(T.detect('what wine goes with steak?'), null);
  assert.strictEqual(T.detect('anything', { confirm: 'clear_shopping' }).name, 'clear_shopping');
});

test('scale and allergen tools are exact (library data, UK14) and flag the member’s own allergies', async () => {
  const { ctx, paid } = setup();
  const s = await T.execute({ name: 'scale_recipe', args: { recipeId: 'classic-spaghetti-bolognese', servings: 8 } }, ctx(paid));
  assert.ok(s.ok); assert.strictEqual(s.data.recipe.servings, 8); assert.ok(s.data.recipe.ingredients.length > 3);
  const al = await T.execute({ name: 'check_allergens', args: { recipeId: 'classic-spaghetti-bolognese' } }, ctx(paid, { mem: { allergies: ['cereals containing gluten'] } }));
  assert.ok(al.data.allergens.includes('cereals containing gluten')); assert.deepStrictEqual(al.data.clashes, ['cereals containing gluten']); assert.match(al.reply, /⚠️/);
  const unknown = await T.execute({ name: 'scale_recipe', args: { servings: 4 } }, ctx(paid)); assert.strictEqual(unknown.ok, false);
});

test('shopping list is owner-scoped, entitlement-gated, de-duplicated, and clearing needs confirmation', async () => {
  const { ctx, paid, free, db } = setup();
  assert.strictEqual((await T.execute({ name: 'add_shopping', args: { items: ['eggs'] } }, ctx(null))).ok, false);
  const f = await T.execute({ name: 'add_shopping', args: { items: ['eggs'] } }, ctx(free)); assert.strictEqual(f.ok, false); assert.strictEqual(f.upgrade, '/pricing.html');
  await T.execute({ name: 'add_shopping', args: { items: ['eggs', 'milk'] } }, ctx(paid));
  const again = await T.execute({ name: 'add_shopping', args: { items: ['Eggs'] } }, ctx(paid)); assert.strictEqual(again.data.items.length, 2);
  const rec = await T.execute({ name: 'add_shopping', args: { recipeId: 'chicken-tikka-masala', servings: 2 } }, ctx(paid)); assert.ok(rec.data.items.length > 2);
  db.prepare('INSERT INTO shopping_items(user_id,item,created_at) VALUES(99,?,0)').run('someone else');
  const ask = await T.execute({ name: 'clear_shopping', args: { confirmed: false } }, ctx(paid)); assert.ok(ask.needsConfirm);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM shopping_items WHERE user_id=1').get().n > 0, 'not cleared before confirm');
  await T.execute({ name: 'clear_shopping', args: { confirmed: true } }, ctx(paid));
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM shopping_items WHERE user_id=1').get().n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM shopping_items WHERE user_id=99').get().n, 1, 'other members untouched');
});

test('save is premium-only and writes only the caller’s favourites; images and new recipes are capped per day', async () => {
  const { ctx, paid, free, db } = setup();
  assert.strictEqual((await T.execute({ name: 'save_recipe', args: { recipeId: 'chicken-tikka-masala' } }, ctx(free))).ok, false);
  assert.ok((await T.execute({ name: 'save_recipe', args: { recipeId: 'chicken-tikka-masala' } }, ctx(paid))).ok);
  assert.deepStrictEqual(db.prepare('SELECT user_id, recipe_id FROM favourites').all(), [{ user_id: 1, recipe_id: 'chicken-tikka-masala' }]);
  const c = ctx(paid); let last;
  for (let i = 0; i <= T.LIMITS.imagesPerDay; i++) last = await T.execute({ name: 'dish_image', args: { recipeId: 'chicken-tikka-masala', title: 'Chicken Tikka Masala' } }, c);
  assert.strictEqual(last.ok, false);
  const n = await T.execute({ name: 'new_recipe', args: { dish: 'duck and plums' } }, c); assert.strictEqual(n.data.generated[0].title, 'Duck with Plums');
});

test('assistant.respond narrates a tool result via the LLM (never for allergens) and returns structured data', async () => {
  let sys = ''; const llm = async m => { sys = m[0].content; return { text: 'Lovely, all on your list.', provider: 'test' }; };
  const tool = { name: 'add_shopping', ok: true, reply: 'Added 2 items.', summary: 'Added to shopping list: eggs, milk.', data: { items: [{ item: 'eggs' }, { item: 'milk' }] } };
  const out = await A.respond(A.ChatReq.parse({ message: 'add eggs and milk to my shopping list' }), { llm, tool, maxTokens: 1200 });
  assert.match(sys, /ACTION ALREADY TAKEN.*eggs, milk/); assert.match(sys, /three short paragraphs/); assert.strictEqual(out.reply, 'Lovely, all on your list.'); assert.strictEqual(out.tool.data.items.length, 2);
  let called = false; const al = await A.respond(A.ChatReq.parse({ message: 'does it contain gluten' }), { llm: async () => { called = true; return 'x'; }, tool: { name: 'check_allergens', ok: true, reply: 'It contains milk.' } });
  assert.strictEqual(called, false); assert.match(al.reply, /contains milk/);
});

test('memory block includes recent searches, stays capped, and is empty with no consent', () => {
  const b = M.memoryBlock({ cuisines: ['Italian'] }, [{ role: 'user', text: 'x'.repeat(500), created_at: 1 }], { searches: [JSON.stringify({ dish: 'quick risotto', include: ['mushroom'] })] });
  assert.match(b, /Recent searches: quick risotto with mushroom/); assert.ok(b.length <= M.LIMITS.block);
  assert.strictEqual(M.memoryBlock(null, [], { searches: [] }), '');
});

test('leaked meta/JSON model output falls back to the tool’s own reply', async () => {
  const llm = async () => ({ text: 'The system prompt demanded valid, parseable JSON only.', provider: 'test' });
  const out = await A.respond(A.ChatReq.parse({ message: 'save the chicken fajitas' }), { llm, tool: { name: 'save_recipe', ok: true, reply: 'Saved Chicken Fajitas to your favourites.' } });
  assert.strictEqual(out.reply, 'Saved Chicken Fajitas to your favourites.');
});

test('consented memory always reaches the assistant system prompt within Malcolm’s 4,000-char cap', async () => {
  const blk = M.memoryBlock({ cuisines: ['Spanish'] }, [{ role: 'user', text: 'I adore smoky Spanish flavours, especially chorizo.', created_at: 1 }]);
  for (const q of ['Suggest a dinner I would love', 'What plans do you offer and how much is Head Chef?']) {
    let S = ''; const llm = M.withMemory(async m => { S = m[0].content; return 'A fine reply.'; }, blk);
    await A.respond(A.ChatReq.parse({ message: q }), { llm, tool: { name: 'scale_recipe', ok: true, reply: 'x', summary: 'y'.repeat(900) } });
    assert.match(S, /MEMBER MEMORY[\s\S]*chorizo/, q); assert.ok(S.length <= M.LIMITS.systemCap, String(S.length)); assert.match(S, /ACTION ALREADY TAKEN/);
  }
});
