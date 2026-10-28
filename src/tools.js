'use strict';
// Malcolm assistant tools: real, server-side actions for the signed-in member, chosen by deterministic intent routing
// (never by free-form model output). Every tool acts only on the caller's own user_id, respects plan entitlements,
// and anything destructive returns needsConfirm first. Works with any async q = { all, get, run } (D1 or SQLite).
const { RECIPES, UK14, scale } = require('./recipes');
const plansMod = require('./plans');

const LIMITS = { shoppingItems: 100, itemLen: 60, imagesPerDay: 6, newRecipesPerDay: 10 };
const SHOP = '(?:shopping|grocery|groceries)(?: list)?';
const ALLERGEN_WORDS = { gluten: 'cereals containing gluten', wheat: 'cereals containing gluten', dairy: 'milk', milk: 'milk', lactose: 'milk', egg: 'eggs', eggs: 'eggs', nut: 'tree nuts', nuts: 'tree nuts', 'tree nuts': 'tree nuts', peanut: 'peanuts', peanuts: 'peanuts', fish: 'fish', shellfish: 'crustaceans', crustaceans: 'crustaceans', prawn: 'crustaceans', prawns: 'crustaceans', molluscs: 'molluscs', sesame: 'sesame', soy: 'soya', soya: 'soya', mustard: 'mustard', celery: 'celery', lupin: 'lupin', sulphites: 'sulphites', sulfites: 'sulphites' };

const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
// A library recipe named in the message (best title-word overlap), else the most recent recipe the chat showed.
function resolveRecipe(message, lastIds = []) {
  const m = ' ' + norm(message) + ' '; let best = null, bestScore = 0;
  for (const r of RECIPES) { const w = norm(r.title).split(' ').filter(x => x.length > 3); if (!w.length) continue;
    const hit = w.filter(x => m.includes(' ' + x + ' ') || m.includes(' ' + x + 's ')).length; const s = hit / w.length;
    if (hit >= Math.min(2, w.length) && s > bestScore) { best = r; bestScore = s; } }
  if (best) return best;
  for (const id of lastIds || []) { const r = RECIPES.find(x => x.id === String(id)); if (r) return r; }
  return null;
}
const splitItems = s => String(s || '').split(/,|\band\b|&|\n/).map(x => x.replace(/^(some|a|an|the|more)\s+/i, '').replace(/[^\p{L}\p{N} '\-]/gu, '').trim()).filter(x => x.length > 1).map(x => x.slice(0, LIMITS.itemLen)).slice(0, 20);

// Returns { name, args } or null. Order matters: specific list/save/scale verbs win over generic recipe chat.
function detect(message, { lastRecipeIds = [], confirm } = {}) {
  const s = String(message || '').trim(); const l = s.toLowerCase();
  if (confirm === 'clear_shopping') return { name: 'clear_shopping', args: { confirmed: true } };
  if (new RegExp(`\\b(clear|empty|delete|wipe|reset)\\b.*\\b(my |the )?${SHOP}`).test(l)) return { name: 'clear_shopping', args: { confirmed: false } };
  let m = l.match(new RegExp(`\\b(?:remove|take|delete|cross)\\s+(.+?)\\s+(?:off|from|out of)\\s+(?:my |the )?${SHOP}`));
  if (m) return { name: 'remove_shopping', args: { items: splitItems(m[1]) } };
  m = l.match(new RegExp(`\\b(?:add|put|pop|stick)\\s+(.+?)\\s+(?:to|on|onto|in)\\s+(?:my |the )?${SHOP}`));
  if (m) { const what = m[1].trim(); const r = /^(it|this|that|the ingredients|everything|the lot|this recipe|that recipe|ingredients for .+)$/.test(what) || /ingredients/.test(what) ? resolveRecipe(s, lastRecipeIds) : null;
    return r ? { name: 'add_shopping', args: { recipeId: r.id, servings: +((l.match(/\bfor (\d{1,2})\b/) || [])[1]) || undefined } } : { name: 'add_shopping', args: { items: splitItems(m[1]) } }; }
  if (new RegExp(`\\b(show|see|view|read|what'?s on|what is on|open)\\b.*\\b(my |the )?${SHOP}`).test(l)) return { name: 'show_shopping', args: {} };
  if (/\b(save|bookmark|favourite|favorite|keep)\b.*\b(recipe|this|that|it|favourites?|favorites?|for later)\b/.test(l)) { const r = resolveRecipe(s, lastRecipeIds); return { name: 'save_recipe', args: { recipeId: r && r.id } }; }
  m = l.match(/\b(?:scale|resize|adjust|convert|make|do|cook)\b.*?\bfor (\d{1,2})\b|\b(?:serves?|feed|feeding) (\d{1,2})\b|\b(\d{1,2}) (?:people|servings|portions|guests)\b/);
  if (m && (/\b(scale|resize|adjust|convert|serve|serves|feed|feeding|portions|servings|people|guests)\b/.test(l) || /\b(make|do|cook) (it|this|that|them) for \d/.test(l))) { const r = resolveRecipe(s, lastRecipeIds); if (r) return { name: 'scale_recipe', args: { recipeId: r.id, servings: +(m[1] || m[2] || m[3]) } }; }
  if (/\b(allergen|allergens|allergy|allergic|contain|contains|safe for|free from|-free|gluten|dairy|nuts?|peanuts?|sesame|soya|celery|mustard|lupin|sulphites|shellfish|eggs?)\b/.test(l) && /\b(is|does|has|any|check|which|what|contain|safe|free)\b/.test(l)) { const r = resolveRecipe(s, lastRecipeIds); if (r) return { name: 'check_allergens', args: { recipeId: r.id } }; }
  if (/\b(picture|photo|image|pic)\b/.test(l) && /\b(show|see|make|generate|create|what .* look|of)\b/.test(l)) { const r = resolveRecipe(s, lastRecipeIds); return { name: 'dish_image', args: { recipeId: r && r.id, title: r ? r.title : s.replace(/^.*?\b(?:picture|photo|image|pic)\b\s*(?:of\s*)?/i, '').slice(0, 100) } }; }
  if (/\b(invent|create|generate|write|dream up|come up with|make up|design)\b.*\b(new |fresh |original |own )?recipe\b|\bnew recipe\b/.test(l)) return { name: 'new_recipe', args: { dish: s.slice(0, 300) } };
  return null;
}

const need = (u, what) => !u ? { ok: false, reply: `Sign in (it’s free) and I can ${what} for you.`, link: '/account.html', linkLabel: 'Sign in' } : null;
const qtyLabel = i => [i.qty ? (Math.round(i.qty * 100) / 100) : '', i.unit && i.unit !== 'x' ? i.unit : '', i.name].filter(Boolean).join(' ');

async function listShopping(q, uid) { return q.all('SELECT id,item,qty,recipe_title,done,created_at FROM shopping_items WHERE user_id=? ORDER BY id LIMIT ?', [uid, LIMITS.shoppingItems]); }

// ctx: { q, u, can(u, feature), isPremium(u), allow(bucket, limit, sec) -> {ok}, newRecipe(dish) -> [status, json], imageFor(recipe) -> {src, alt} }
async function run(tool, ctx) {
  const { q, u } = ctx; const a = tool.args || {}; const r = a.recipeId ? RECIPES.find(x => x.id === a.recipeId) : null; const day = new Date().toISOString().slice(0, 10);
  const out = (o) => ({ name: tool.name, ...o });
  switch (tool.name) {
    case 'scale_recipe': { const sv = Math.max(1, Math.min(24, a.servings || 2)); const s = scale(r, sv);
      return out({ ok: true, reply: `${r.title} scaled to serve ${sv}:`, summary: `Scaled "${r.title}" from ${r.baseServings} to ${sv} servings: ${s.ingredients.map(qtyLabel).join('; ')}`, data: { recipe: { id: r.id, title: r.title, servings: sv, url: `/recipe.html?id=${encodeURIComponent(r.id)}&servings=${sv}`, ingredients: s.ingredients.map(qtyLabel) } } }); }
    case 'check_allergens': { const al = r.allergens || []; const mine = ((ctx.mem && ctx.mem.allergies) || []).filter(x => al.includes(x));
      const reply = `${r.title} contains ${al.length ? al.join(', ') : 'none of the UK 14 allergens'} (from the recipe’s ingredients — always check the labels on what you buy).${mine.length ? ` ⚠️ That includes ${mine.join(', ')} from your allergy list.` : ''}`;
      return out({ ok: true, reply, summary: `UK14 allergen check for "${r.title}": ${al.length ? al.join(', ') : 'none'}. Member allergy clashes: ${mine.length ? mine.join(', ') : 'none'}. Not present: ${UK14.filter(x => !al.includes(x)).join(', ')}.`, data: { allergens: al, clashes: mine, recipeId: r.id, title: r.title } }); }
    case 'save_recipe': { const g = need(u, 'save recipes to your favourites'); if (g) return out(g);
      if (!ctx.isPremium(u)) return out({ ok: false, reply: 'Saving favourites is part of the paid plans — upgrade and I’ll keep every recipe you love.', upgrade: '/pricing.html' });
      if (!r) return out({ ok: false, reply: 'Which recipe should I save? Name it, or ask me for one first and then say “save it”.' });
      const blob = { ...scale(r, r.baseServings), id: r.id, title: r.title };
      await q.run('INSERT INTO favourites(user_id,recipe_id,recipe_json) VALUES(?,?,?) ON CONFLICT(user_id,recipe_id) DO UPDATE SET recipe_json=excluded.recipe_json', [u.id, r.id, JSON.stringify(blob)]);
      return out({ ok: true, reply: `Saved ${r.title} to your favourites.`, summary: `Saved "${r.title}" to the member's favourites.`, link: '/favourites.html', linkLabel: 'Open favourites', data: { recipeId: r.id } }); }
    case 'add_shopping': case 'show_shopping': case 'remove_shopping': case 'clear_shopping': {
      const g = need(u, 'keep a shopping list'); if (g) return out(g);
      if (!ctx.can(u, 'shopping')) return out({ ok: false, reply: 'Your own shopping list comes with Chef de Partie and above.', upgrade: '/pricing.html' });
      if (tool.name === 'clear_shopping' && !a.confirmed) { const n = (await listShopping(q, u.id)).length;
        return out({ ok: true, needsConfirm: { action: 'clear_shopping', label: `Yes, clear all ${n} item${n === 1 ? '' : 's'}` }, reply: n ? `Clear all ${n} item${n === 1 ? '' : 's'} from your shopping list? This can’t be undone.` : 'Your shopping list is already empty.', summary: 'Asked the member to confirm clearing their shopping list.' }); }
      if (tool.name === 'clear_shopping') { await q.run('DELETE FROM shopping_items WHERE user_id=?', [u.id]); return out({ ok: true, reply: 'Done — your shopping list is clear.', summary: 'Cleared the member’s shopping list.', data: { items: [] } }); }
      if (tool.name === 'remove_shopping') { let n = 0; for (const it of a.items || []) { const res = await q.run('DELETE FROM shopping_items WHERE user_id=? AND lower(item) LIKE ?', [u.id, '%' + it.toLowerCase() + '%']); n += (res && res.meta ? res.meta.changes : res && res.changes) || 0; }
        const items = await listShopping(q, u.id); return out({ ok: true, reply: n ? `Removed ${n} item${n === 1 ? '' : 's'}.` : 'I couldn’t find that on your list.', summary: `Removed ${n} item(s) from the shopping list.`, data: { items } }); }
      if (tool.name === 'add_shopping') {
        let rows = []; if (a.recipeId && r) { const s = scale(r, a.servings || r.baseServings); rows = s.ingredients.filter(i => !/^(salt|black pepper|water)$/.test(i.name)).map(i => ({ item: i.name.slice(0, LIMITS.itemLen), qty: qtyLabel(i).slice(0, 40), recipe: r.title })); }
        else rows = (a.items || []).map(item => ({ item, qty: null, recipe: null }));
        if (!rows.length) return out({ ok: false, reply: 'What should I add? e.g. “add eggs and milk to my shopping list”.' });
        const have = await listShopping(q, u.id); const room = LIMITS.shoppingItems - have.length; const now = Date.now();
        const fresh = rows.filter(x => !have.some(h => h.item.toLowerCase() === x.item.toLowerCase())).slice(0, Math.max(0, room));
        for (const x of fresh) await q.run('INSERT INTO shopping_items(user_id,item,qty,recipe_title,done,created_at) VALUES(?,?,?,?,0,?)', [u.id, x.item, x.qty, x.recipe, now]);
        const items = await listShopping(q, u.id);
        return out({ ok: true, reply: fresh.length ? `Added ${fresh.length} item${fresh.length === 1 ? '' : 's'} to your shopping list${room < rows.length ? ` (it holds ${LIMITS.shoppingItems} items max)` : ''}.` : 'Those are already on your list.', summary: `Added to shopping list: ${fresh.map(x => x.qty || x.item).join(', ') || 'nothing new'}. List now has ${items.length} items.`, data: { items } }); }
      const items = await listShopping(q, u.id);
      return out({ ok: true, reply: items.length ? `You have ${items.length} item${items.length === 1 ? '' : 's'} on your list:` : 'Your shopping list is empty — say “add eggs to my shopping list” to start one.', summary: `Shopping list (${items.length}): ${items.map(i => i.qty || i.item).join(', ')}`, data: { items } }); }
    case 'dish_image': { const g = need(u, 'make food photos'); if (g) return out(g);
      if (!a.title || a.title.length < 3) return out({ ok: false, reply: 'Which dish should I picture? Ask for a recipe first, then say “show me a photo”.' });
      if (!(await ctx.allow(`asst-img:u${u.id}:${day}`, LIMITS.imagesPerDay, 86400)).ok) return out({ ok: false, reply: `That’s today’s ${LIMITS.imagesPerDay} chat photos used — more tomorrow.` });
      const img = await ctx.imageFor(r ? { ...scale(r, r.baseServings) } : { title: a.title, ingredients: [] });
      return out({ ok: true, reply: `Here’s how ${r ? r.title : a.title} could look (AI-generated photo — tap to load).`, summary: `Prepared an AI food photo for "${r ? r.title : a.title}".`, data: { image: img } }); }
    case 'new_recipe': { const g = need(u, 'write a brand-new recipe'); if (g) return out(g);
      if (!(await ctx.allow(`asst-new:u${u.id}:${day}`, LIMITS.newRecipesPerDay, 86400)).ok) return out({ ok: false, reply: 'That’s today’s new-recipe allowance from chat — the search page still works.' });
      const [st, j] = await ctx.newRecipe(a.dish);
      if (st !== 200) return out({ ok: false, reply: j.error || 'I couldn’t write that one just now.', upgrade: j.upgrade || null });
      if (j.clarify) return out({ ok: false, reply: `Quick question first: ${j.clarify.question || 'tell me a main ingredient or two.'}` });
      const recs = (j.recipes || []).slice(0, 3);
      return out({ ok: !!recs.length, reply: recs.length ? `Fresh from my kitchen (${j.source === 'offline' ? 'library' : 'Malcolm AI'}):` : 'Nothing came back — try naming a main ingredient.', summary: `Malcolm /v1/recipes returned: ${recs.map(x => `${x.title} (${x.totalMinutes || '?'} min)`).join('; ')}`, data: { generated: recs.map(x => ({ id: x.id, title: x.title, totalMinutes: x.totalMinutes, difficulty: x.difficulty, allergens: x.allergens || [], image: x.image && x.image.src, recipe: x })) } }); }
  }
  return null;
}
// Unresolvable recipe for a recipe-specific tool → ask, don't guess.
async function execute(tool, ctx) {
  if (!tool) return null;
  if (['scale_recipe', 'check_allergens'].includes(tool.name) && !(tool.args.recipeId && RECIPES.find(x => x.id === tool.args.recipeId))) return { name: tool.name, ok: false, reply: 'Which recipe do you mean? Name it, or ask me for one first.' };
  return run(tool, ctx);
}
module.exports = { LIMITS, detect, execute, resolveRecipe, splitItems, listShopping };
