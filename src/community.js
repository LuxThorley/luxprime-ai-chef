'use strict';
// Community layer: stable recipe IDs, ratings, favourites metadata, engagement events, synced preferences
// and the "Chef of Kings" ranking. Storage-agnostic: every function takes an async adapter
//   q = { all(sql, params) -> rows[], get(sql, params) -> row|null, run(sql, params) }
// so the same code runs on better-sqlite3 (src/server.js) and Cloudflare D1 (worker/src/index.js).
const { z } = require('zod');
const { isAdmin, isTester } = require('./plans');

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, title TEXT NOT NULL, cuisine TEXT, recipe_json TEXT NOT NULL, image_key TEXT, source TEXT, created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS ratings (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, recipe_id TEXT NOT NULL, stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, recipe_id))`,
  `CREATE INDEX IF NOT EXISTS ratings_recipe ON ratings(recipe_id)`,
  `CREATE TABLE IF NOT EXISTS recipe_events (recipe_id TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, day INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (recipe_id, actor, kind, day))`,
  `CREATE INDEX IF NOT EXISTS events_recipe ON recipe_events(recipe_id)`,
  `CREATE TABLE IF NOT EXISTS user_prefs (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, prefs_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS favourites_recipe ON favourites(recipe_id)`,
  // Backfill: every existing favourite becomes a stored, rateable recipe (no data is moved or deleted).
  `INSERT OR IGNORE INTO recipes(id,title,cuisine,recipe_json,created_by) SELECT recipe_id, COALESCE(json_extract(recipe_json,'$.title'),'Recipe'), json_extract(recipe_json,'$.cuisine'), recipe_json, user_id FROM favourites`
];

// ---- Stable IDs ----
function fnv(str) { // 2 × 32-bit FNV-1a → 13 base36 chars; sync and identical in Node and Workers
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return h1.toString(36).padStart(7, '0') + h2.toString(36).padStart(7, '0');
}
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
function contentKey(r) { return norm(r.title) + '|' + [...new Set((r.ingredients || []).map(i => norm(i.name || i.display)).filter(Boolean))].sort().join(','); }
const aiId = r => 'ai-' + fnv(contentKey(r));
const ID_RE = /^(ai-[0-9a-z]{14}|esc-\d{1,4}[a-z]?|[a-z0-9-]{2,80})$/;
const validId = id => typeof id === 'string' && ID_RE.test(id);

// ---- Validation ----
const Stars = z.coerce.number().int().min(1).max(5);
const EVENT_KINDS = ['view', 'cook', 'share', 'pdf'];
const Prefs = z.object({
  diets: z.array(z.string().max(30)).max(6).default([]), servings: z.coerce.number().int().min(1).max(12).optional(),
  cuisines: z.array(z.string().trim().min(1).max(40)).max(8).default([]), difficulty: z.enum(['easy', 'medium', 'hard', 'any']).optional(),
  maxMinutes: z.coerce.number().int().min(5).max(480).optional(), kidsMode: z.boolean().optional(), inspirationMode: z.enum(['escoffier', 'blend', 'malcolm']).optional(),
  recent: z.array(z.object({ label: z.string().max(60), i: z.string().max(400).optional().default(''), d: z.string().max(200).optional().default('') })).max(8).default([])
});

// ---- Recipe store ----
// Content is bound to its ID: AI ids must hash to the submitted content, library ids must exist in the library,
// Escoffier ids are built server-side. First writer wins, so nobody can overwrite a recipe someone else rated.
function canonicalRecipe(id, blob, { library = [], escEntry = null } = {}) {
  if (id.startsWith('esc-')) return escEntry ? { id, title: escEntry.title, cuisine: 'French (Escoffier)', escoffier: { no: escEntry.no, label: `Escoffier No. ${escEntry.no}`, url: `/escoffier.html?no=${escEntry.no}` }, image: { src: '/img/home/escoffier-sm.webp', alt: escEntry.title } } : null;
  if (id.startsWith('ai-')) return blob && aiId(blob) === id ? { ...blob, id } : null;
  const lib = library.find(r => r.id === id); return lib ? { ...lib } : null;
}
async function upsertRecipe(q, recipe, userId) {
  const json = JSON.stringify(recipe); if (json.length > 60000) throw Object.assign(new Error('Recipe too large'), { status: 413 });
  await q.run('INSERT OR IGNORE INTO recipes(id,title,cuisine,recipe_json,image_key,source,created_by) VALUES(?,?,?,?,?,?,?)',
    [recipe.id, String(recipe.title || 'Recipe').slice(0, 140), recipe.cuisine ? String(recipe.cuisine).slice(0, 80) : null, json, (recipe.image && recipe.image.key) || null, recipe.source || null, userId || null]);
}
async function getRecipe(q, id) { const row = await q.get('SELECT recipe_json FROM recipes WHERE id=?', [id]); return row ? JSON.parse(row.recipe_json) : null; }

// ---- Ratings ----
const RATE_PER_HOUR = 40;
async function rate(q, user, id, stars, now = Date.now()) {
  const s = Stars.parse(stars); const t = Math.floor(now / 1000);
  const recent = await q.get('SELECT COUNT(*) n FROM ratings WHERE user_id=? AND updated_at>?', [user.id, t - 3600]);
  if (recent && recent.n >= RATE_PER_HOUR) throw Object.assign(new Error('You are rating very quickly. Please try again later.'), { status: 429 });
  await q.run('INSERT INTO ratings(user_id,recipe_id,stars,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,recipe_id) DO UPDATE SET stars=excluded.stars, updated_at=excluded.updated_at', [user.id, id, s, t, t]);
}
async function unrate(q, user, id) { await q.run('DELETE FROM ratings WHERE user_id=? AND recipe_id=?', [user.id, id]); }

async function event(q, id, actor, kind, now = Date.now()) {
  if (!EVENT_KINDS.includes(kind)) throw Object.assign(new Error('Unknown event'), { status: 400 });
  const t = Math.floor(now / 1000); // one count per actor, recipe, kind and UTC day
  await q.run('INSERT OR IGNORE INTO recipe_events(recipe_id,actor,kind,day,created_at) VALUES(?,?,?,?,?)', [id, actor, kind, Math.floor(t / 86400), t]);
}

const avg3 = (sum, n) => n ? Math.round((sum / n) * 1000) / 1000 : null;
async function stats(q, ids, userId) {
  ids = [...new Set(ids.filter(validId))].slice(0, 60); if (!ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  const [rt, fv, mine, myFav] = await Promise.all([
    q.all(`SELECT recipe_id, COUNT(*) n, SUM(stars) s FROM ratings WHERE recipe_id IN (${ph}) GROUP BY recipe_id`, ids),
    q.all(`SELECT recipe_id, COUNT(*) n FROM favourites WHERE recipe_id IN (${ph}) GROUP BY recipe_id`, ids),
    userId ? q.all(`SELECT recipe_id, stars FROM ratings WHERE user_id=? AND recipe_id IN (${ph})`, [userId, ...ids]) : [],
    userId ? q.all(`SELECT recipe_id FROM favourites WHERE user_id=? AND recipe_id IN (${ph})`, [userId, ...ids]) : []]);
  const out = Object.fromEntries(ids.map(id => [id, { avg: null, count: 0, hearts: 0, mine: null, hearted: false }]));
  rt.forEach(r => { out[r.recipe_id].count = r.n; out[r.recipe_id].avg = avg3(r.s, r.n); });
  fv.forEach(r => { out[r.recipe_id].hearts = r.n; }); mine.forEach(r => { out[r.recipe_id].mine = r.stars; }); myFav.forEach(r => { out[r.recipe_id].hearted = true; });
  return out;
}

// ---- Chef of Kings ranking (documented in README) ----
const K = { prior: 5, minRaters: 2, staffW: 0.25, selfW: 0.5, newW: 0.3, newAccountDays: 3, spikeN: 5, halfLifeDays: 60,
  w: { raters: 0.20, hearts: 0.15, cooks: 0.25, shares: 0.10, views: 0.05 } };
const parseTs = v => typeof v === 'number' ? v * 1000 : Date.parse(String(v || '').replace(' ', 'T') + (/[zZ+]/.test(String(v)) ? '' : 'Z'));
function raterWeight(r, now) {
  const u = { email: r.email, plan: r.plan };
  if (isAdmin(u) || isTester(u)) return K.staffW;
  if (r.created_by != null && +r.created_by === +r.user_id) return K.selfW;
  const age = (now - parseTs(r.u_created)) / 864e5;
  return age < K.newAccountDays ? K.newW : 1;
}
// rows: per-recipe { id, ratings:[{stars, weight, user_id, t(ms), isNew}], hearts, cooks, shares, views, lastActivity(ms) }
function scoreRecipes(rows, now = Date.now()) {
  // Anti-abuse: if a recipe gets >= spikeN ratings from new accounts inside 24 h, those ratings are ignored.
  rows.forEach(r => { const fresh = r.ratings.filter(x => x.isNew); if (fresh.length >= K.spikeN) { const t0 = Math.min(...fresh.map(x => x.t)); if (Math.max(...fresh.map(x => x.t)) - t0 < 864e5) fresh.forEach(x => { x.weight = 0; }); } });
  let gs = 0, gw = 0; rows.forEach(r => r.ratings.forEach(x => { gs += x.stars * x.weight; gw += x.weight; }));
  const m = gw ? gs / gw : 3.5; // global weighted mean (prior)
  return rows.map(r => {
    const W = r.ratings.reduce((a, x) => a + x.weight, 0), S = r.ratings.reduce((a, x) => a + x.stars * x.weight, 0);
    const bayes = (K.prior * m + S) / (K.prior + W);
    const mean = W ? S / W : m; const sd = W ? Math.sqrt(r.ratings.reduce((a, x) => a + x.weight * (x.stars - mean) ** 2, 0) / W) : 0;
    const consistency = 1 - 0.04 * sd;
    const raters = new Set(r.ratings.filter(x => x.weight > 0).map(x => x.user_id)).size;
    const L = n => Math.log1p(n || 0);
    const engagement = K.w.raters * L(raters) + K.w.hearts * L(r.hearts) + K.w.cooks * L(r.cooks) + K.w.shares * L(r.shares) + K.w.views * L(r.views);
    const days = r.lastActivity ? Math.max(0, (now - r.lastActivity) / 864e5) : 365; const recency = Math.pow(0.5, days / K.halfLifeDays);
    const score = bayes * consistency + engagement * (0.4 + 0.6 * recency);
    const count = r.ratings.length, sum = r.ratings.reduce((a, x) => a + x.stars, 0);
    return { id: r.id, score: Math.round(score * 10000) / 10000, bayes: Math.round(bayes * 1000) / 1000, avg: avg3(sum, count), count, raters, hearts: r.hearts || 0, cooks: r.cooks || 0, eligible: raters >= K.minRaters };
  }).sort((a, b) => b.score - a.score || b.count - a.count);
}
async function topRated(q, { limit = 10, now = Date.now() } = {}) {
  const [rt, fv, ev] = await Promise.all([
    q.all('SELECT r.recipe_id, r.stars, r.user_id, r.updated_at, u.email, u.plan, u.created_at u_created, rc.created_by FROM ratings r JOIN users u ON u.id=r.user_id LEFT JOIN recipes rc ON rc.id=r.recipe_id', []),
    q.all('SELECT recipe_id, COUNT(*) n, MAX(created_at) last FROM favourites GROUP BY recipe_id', []),
    q.all('SELECT recipe_id, kind, COUNT(*) n, MAX(created_at) last FROM recipe_events GROUP BY recipe_id, kind', [])]);
  const by = new Map(); const row = id => { if (!by.has(id)) by.set(id, { id, ratings: [], hearts: 0, cooks: 0, shares: 0, views: 0, lastActivity: 0 }); return by.get(id); };
  rt.forEach(x => { const r = row(x.recipe_id); const t = x.updated_at * 1000; const isNew = (now - parseTs(x.u_created)) / 864e5 < K.newAccountDays;
    r.ratings.push({ stars: x.stars, weight: raterWeight(x, now), user_id: x.user_id, t, isNew }); r.lastActivity = Math.max(r.lastActivity, t); });
  fv.forEach(x => { if (!by.has(x.recipe_id)) return; const r = row(x.recipe_id); r.hearts = x.n; r.lastActivity = Math.max(r.lastActivity, parseTs(x.last) || 0); });
  ev.forEach(x => { if (!by.has(x.recipe_id)) return; const r = row(x.recipe_id); if (x.kind === 'cook') r.cooks = x.n; else if (x.kind === 'view') r.views = x.n; else r.shares += x.n; r.lastActivity = Math.max(r.lastActivity, x.last * 1000); });
  const ranked = scoreRecipes([...by.values()], now).filter(r => r.eligible).slice(0, limit);
  if (!ranked.length) return [];
  const recs = await q.all(`SELECT id, recipe_json FROM recipes WHERE id IN (${ranked.map(() => '?').join(',')})`, ranked.map(r => r.id));
  const map = new Map(recs.map(r => [r.id, JSON.parse(r.recipe_json)]));
  return ranked.filter(r => map.has(r.id)).map((r, i) => { const rec = map.get(r.id); return { rank: i + 1, ...r,
    recipe: { id: rec.id, title: rec.title, cuisine: rec.cuisine, totalMinutes: rec.totalMinutes, difficulty: rec.difficulty, image: rec.image ? { src: rec.image.src, alt: rec.image.alt } : null, escoffier: rec.escoffier || null } }; });
}
// Additive context for Malcolm: a few top-rated dishes as loose inspiration, plus the member's own hearted titles.
async function inspiration(q, userId) {
  const top = await topRated(q, { limit: 5 }).catch(() => []);
  const likes = userId ? (await q.all('SELECT json_extract(recipe_json,\'$.title\') t FROM favourites WHERE user_id=? ORDER BY id DESC LIMIT 5', [userId]).catch(() => [])).map(r => r.t).filter(Boolean) : [];
  return { topRated: top.map(t => ({ title: t.recipe.title, cuisine: t.recipe.cuisine, avg: t.avg, count: t.count })), likes };
}

// ---- Preferences ----
async function getPrefs(q, userId) { const r = await q.get('SELECT prefs_json, updated_at FROM user_prefs WHERE user_id=?', [userId]); return r ? { ...JSON.parse(r.prefs_json), updatedAt: r.updated_at } : null; }
async function putPrefs(q, userId, body, now = Date.now()) {
  const p = Prefs.parse(body || {}); const t = Math.floor(now / 1000);
  await q.run('INSERT INTO user_prefs(user_id,prefs_json,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET prefs_json=excluded.prefs_json, updated_at=excluded.updated_at', [userId, JSON.stringify(p), t]);
  return { ...p, updatedAt: t };
}

const FUSION_CUISINES = ['Brazilian', 'Cajun', 'Caribbean', 'Ethiopian', 'Filipino', 'German', 'Indonesian', 'Korean', 'Lebanese', 'Malaysian', 'Persian', 'Peruvian', 'Portuguese', 'Scandinavian', 'Turkish', 'Vietnamese', 'West African'];
const normCuisines = (cuisines, cuisine) => { const list = [...new Set((cuisines || []).map(c => String(c).trim()).filter(c => c && c.toLowerCase() !== 'any'))].slice(0, 8); if (list.length) return list; return cuisine && cuisine !== 'any' ? [cuisine] : []; };

module.exports = { SCHEMA_SQL, fnv, aiId, contentKey, validId, canonicalRecipe, upsertRecipe, getRecipe, rate, unrate, event, stats, scoreRecipes, topRated, inspiration, getPrefs, putPrefs, Prefs, K, EVENT_KINDS, FUSION_CUISINES, normCuisines, raterWeight };
