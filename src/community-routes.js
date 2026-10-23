'use strict';
// Framework-agnostic handlers for the community API, wrapped by src/server.js (Express) and worker/src/index.js (Hono).
// ctx = { q, user, params, query, body, actor, library, escOne(no) }  →  { status, json }
const C = require('./community');
const ok = (json, status = 200) => ({ status, json });
const err = (status, error, extra) => ({ status, json: { error, ...(extra || {}) } });
let topCache = { t: 0, v: null };
async function featuredMap(q) {
  if (!topCache.v || Date.now() - topCache.t > 60_000) topCache = { t: Date.now(), v: await C.topRated(q, { limit: 10 }) };
  return topCache.v;
}
const bust = () => { topCache = { t: 0, v: null }; };
async function canonical(ctx, id) {
  let escEntry = null;
  if (id.startsWith('esc-')) escEntry = await ctx.escOne(id.slice(4)).catch(() => null);
  return C.canonicalRecipe(id, ctx.body && ctx.body.recipe, { library: ctx.library, escEntry });
}
async function ensureRecipe(ctx, id) {
  const have = await C.getRecipe(ctx.q, id); if (have) return have;
  const r = await canonical(ctx, id); if (!r) return null;
  await C.upsertRecipe(ctx.q, r, ctx.user && ctx.user.id); return r;
}
const H = {
  async stats(ctx) {
    const ids = String(ctx.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    const [stats, top] = await Promise.all([C.stats(ctx.q, ids, ctx.user && ctx.user.id), featuredMap(ctx.q)]);
    const featured = Object.fromEntries(top.filter(t => stats[t.id]).map(t => [t.id, t.rank]));
    return ok({ stats, featured });
  },
  async top(ctx) { const top = await featuredMap(ctx.q); return ok({ top, formula: 'bayesian+engagement+recency', updated: new Date(topCache.t).toISOString() }); },
  async one(ctx) {
    const id = ctx.params.id; if (!C.validId(id)) return err(400, 'Bad recipe id');
    const r = await C.getRecipe(ctx.q, id) || (id.startsWith('ai-') ? null : await canonical(ctx, id)); if (!r) return err(404, 'Recipe not found');
    await C.event(ctx.q, id, ctx.actor, 'view').catch(() => {});
    return ok({ recipe: r, stats: (await C.stats(ctx.q, [id], ctx.user && ctx.user.id))[id] });
  },
  async rate(ctx) {
    if (!ctx.user) return err(401, 'Please sign in to rate recipes');
    const id = ctx.params.id; if (!C.validId(id)) return err(400, 'Bad recipe id');
    const r = await ensureRecipe(ctx, id); if (!r) return err(400, 'We could not verify this recipe. Refresh and try again.');
    try { await C.rate(ctx.q, ctx.user, id, ctx.body && ctx.body.stars); } catch (e) { return err(e.status || 400, e.status ? e.message : 'Choose 1 to 5 stars'); }
    bust(); return ok({ stats: (await C.stats(ctx.q, [id], ctx.user.id))[id] });
  },
  async unrate(ctx) { if (!ctx.user) return err(401, 'Please sign in'); await C.unrate(ctx.q, ctx.user, ctx.params.id); bust(); return ok({ stats: (await C.stats(ctx.q, [ctx.params.id], ctx.user.id))[ctx.params.id] }); },
  async event(ctx) {
    const id = ctx.params.id; if (!C.validId(id)) return err(400, 'Bad recipe id');
    const kind = ctx.body && ctx.body.kind; if (!C.EVENT_KINDS.includes(kind)) return err(400, 'Unknown event');
    if (kind === 'cook' && !ctx.user) return err(401, 'Please sign in');
    const r = await ensureRecipe(ctx, id); if (!r) return ok({ ok: false });
    await C.event(ctx.q, id, ctx.actor, kind); return ok({ ok: true });
  },
  async favAdd(ctx, saveFav) {
    const b = ctx.body && ctx.body.recipe; if (!b || !C.validId(String(b.id || ''))) return err(400, 'Invalid recipe');
    const r = await canonical({ ...ctx, body: { recipe: b } }, b.id);
    if (r) await C.upsertRecipe(ctx.q, r, ctx.user.id);
    await saveFav(r || b); bust(); return ok({ ok: true }, 201);
  },
  async favList(ctx) {
    const rows = await ctx.q.all('SELECT recipe_id, recipe_json, created_at FROM favourites WHERE user_id=? ORDER BY id DESC', [ctx.user.id]);
    const favourites = rows.map(r => ({ ...JSON.parse(r.recipe_json), addedAt: r.created_at }));
    const stats = await C.stats(ctx.q, rows.map(r => r.recipe_id), ctx.user.id);
    return ok({ favourites, stats });
  },
  async prefsGet(ctx) { if (!ctx.user) return err(401, 'Please sign in'); return ok({ prefs: await C.getPrefs(ctx.q, ctx.user.id) }); },
  async prefsPut(ctx) { if (!ctx.user) return err(401, 'Please sign in'); try { return ok({ prefs: await C.putPrefs(ctx.q, ctx.user.id, ctx.body) }); } catch { return err(400, 'Invalid preferences'); } }
};
module.exports = { H, bust };
