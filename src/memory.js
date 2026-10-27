'use strict';
// Malcolm personal memory: opt-in, per-member, first-party only. Works with any async q = { all, get, run } (D1 or SQLite).
const CONSENT_VERSION = '2026-10-1';
const KINDS = ['page_view', 'recipe_view', 'recipe_save', 'menu_builder', 'kitchen_pack'];
const LIMITS = { chatText: 1500, recentChats: 6, scanChats: 60, scanRows: 200, block: 900, systemCap: 4000 };
const retentionDays = env => Math.max(7, Math.min(730, +((env || {}).MEMORY_RETENTION_DAYS) || 365));
const off = { chat: false, search: false, behaviour: false, paused: false, version: null, consentedAt: null, updatedAt: null, recorded: false };

async function getConsent(q, uid) {
  if (!uid) return { ...off };
  const r = await q.get('SELECT * FROM member_consent WHERE user_id=?', [uid]); if (!r) return { ...off };
  return { chat: !!r.chat, search: !!r.search, behaviour: !!r.behaviour, paused: !!r.paused, version: r.version, consentedAt: r.consented_at, updatedAt: r.updated_at, recorded: true };
}
// What may be recorded right now (never for signed-out visitors, never while paused, never for an outdated consent version).
const allowed = (c, what) => !!(c && c.recorded && !c.paused && c.version === CONSENT_VERSION && c[what]);

async function setConsent(q, uid, b = {}) {
  if (!uid) throw new Error('signed-in only');
  const cur = await getConsent(q, uid); const now = Date.now();
  const v = k => (b[k] === undefined ? cur[k] : !!b[k]);
  const n = { chat: v('chat'), search: v('search'), behaviour: v('behaviour'), paused: v('paused') };
  const any = n.chat || n.search || n.behaviour;
  await q.run(`INSERT INTO member_consent(user_id,chat,search,behaviour,paused,version,consented_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET chat=excluded.chat,search=excluded.search,behaviour=excluded.behaviour,paused=excluded.paused,version=excluded.version,consented_at=excluded.consented_at,updated_at=excluded.updated_at`,
    [uid, +n.chat, +n.search, +n.behaviour, +n.paused, CONSENT_VERSION, any ? (cur.consentedAt && cur.version === CONSENT_VERSION ? cur.consentedAt : now) : null, now]);
  // Withdrawing a toggle deletes what it collected (not just stops collecting).
  if (cur.chat && !n.chat) await q.run('DELETE FROM member_chats WHERE user_id=?', [uid]);
  if (cur.search && !n.search) await q.run('DELETE FROM member_searches WHERE user_id=?', [uid]);
  if (cur.behaviour && !n.behaviour) await q.run('DELETE FROM member_events WHERE user_id=?', [uid]);
  if (!any) await q.run('DELETE FROM member_profile WHERE user_id=?', [uid]); else await refreshProfile(q, uid);
  return getConsent(q, uid);
}

async function purge(q, uid, env) { const cut = Date.now() - retentionDays(env) * 864e5;
  for (const t of ['member_chats', 'member_searches', 'member_events']) await q.run(`DELETE FROM ${t} WHERE user_id=? AND created_at<?`, [uid, cut]); }

const clean = s => String(s || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim();
async function recordChat(q, uid, turns, { surface = 'assistant', env } = {}) {
  const c = await getConsent(q, uid); if (!allowed(c, 'chat')) return false;
  const now = Date.now(); let i = 0;
  for (const t of turns) { const text = clean(t.text).slice(0, LIMITS.chatText); if (!text || !['user', 'malcolm'].includes(t.role)) continue;
    await q.run('INSERT INTO member_chats(user_id,role,text,surface,created_at) VALUES(?,?,?,?,?)', [uid, t.role, text, String(surface).slice(0, 20), now + i++]); }
  await purge(q, uid, env); return true;
}
const SEARCH_KEYS = ['include', 'exclude', 'diets', 'excludeAllergens', 'cuisines', 'cuisine', 'maxMinutes', 'servings', 'difficulty', 'dish', 'keywords', 'inspirationMode'];
async function recordSearch(q, uid, data, { env } = {}) {
  const c = await getConsent(q, uid); if (!allowed(c, 'search')) return false;
  const slim = {}; for (const k of SEARCH_KEYS) if (data && data[k] != null && data[k] !== '') slim[k] = typeof data[k] === 'string' ? data[k].slice(0, 300) : data[k];
  await q.run('INSERT INTO member_searches(user_id,query_json,created_at) VALUES(?,?,?)', [uid, JSON.stringify(slim), Date.now()]);
  await purge(q, uid, env); await refreshProfile(q, uid); return true;
}
// Only a whitelisted kind and a short first-party reference (a site path without query string, or a recipe id). Nothing else.
function cleanEvent(b = {}) {
  const kind = KINDS.includes(b.kind) ? b.kind : null; if (!kind) return null;
  let ref = String(b.ref || '').slice(0, 120);
  if (kind === 'page_view') { ref = ref.split(/[?#]/)[0]; if (!/^\/[A-Za-z0-9\-_.\/]*$/.test(ref)) return null; } else ref = ref.replace(/[^\p{L}\p{N} \-_'.,&:]/gu, '').trim();
  return { kind, ref: ref || null };
}
async function recordEvent(q, uid, b, { env } = {}) {
  const c = await getConsent(q, uid); if (!allowed(c, 'behaviour')) return false;
  const e = cleanEvent(b); if (!e) return false;
  await q.run('INSERT INTO member_events(user_id,kind,ref,created_at) VALUES(?,?,?,?)', [uid, e.kind, e.ref, Date.now()]);
  await purge(q, uid, env); if (e.kind !== 'page_view') await refreshProfile(q, uid); return true;
}

const top = (m, n = 5) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k);
const bump = (m, k) => { k = String(k || '').toLowerCase().trim(); if (k && k !== 'any' && k.length <= 60) m.set(k, (m.get(k) || 0) + 1); };
function deriveProfile(searches = [], events = []) {
  const cui = new Map(), ing = new Map(), diet = new Map(), avoid = new Map(), terms = new Map(), viewed = new Map(), tools = new Map(); const mins = [], serv = new Map();
  for (const s of searches) {
    (s.cuisines || []).forEach(x => bump(cui, x)); if (!(s.cuisines || []).length) bump(cui, s.cuisine);
    (s.include || []).forEach(x => bump(ing, x)); (s.diets || []).forEach(x => bump(diet, x)); (s.exclude || []).forEach(x => bump(avoid, x)); (s.excludeAllergens || []).forEach(x => bump(avoid, x));
    if (s.dish) bump(terms, String(s.dish).split(/[—.,;!?]/)[0].slice(0, 60)); if (s.maxMinutes) mins.push(+s.maxMinutes); if (s.servings) bump(serv, String(s.servings));
  }
  for (const e of events) { if (e.kind === 'recipe_view' || e.kind === 'recipe_save') bump(viewed, e.ref); if (e.kind === 'menu_builder' || e.kind === 'kitchen_pack') bump(tools, e.kind.replace('_', ' ')); }
  mins.sort((a, b) => a - b);
  return { cuisines: top(cui), ingredients: top(ing, 8), dietary: top(diet, 4), avoids: top(avoid, 6), typicalMinutes: mins.length ? mins[Math.floor(mins.length / 2)] : null,
    servings: serv.size ? +top(serv, 1)[0] : null, frequentSearches: top(terms, 5), recentRecipes: top(viewed, 5), tools: top(tools, 2), basedOn: { searches: searches.length, events: events.length } };
}
async function refreshProfile(q, uid) {
  const c = await getConsent(q, uid);
  const searches = allowed(c, 'search') ? (await q.all('SELECT query_json FROM member_searches WHERE user_id=? ORDER BY id DESC LIMIT ?', [uid, LIMITS.scanRows])).map(r => { try { return JSON.parse(r.query_json); } catch { return {}; } }) : [];
  const events = allowed(c, 'behaviour') ? await q.all("SELECT kind,ref FROM member_events WHERE user_id=? AND kind!='page_view' ORDER BY id DESC LIMIT ?", [uid, LIMITS.scanRows]) : [];
  const p = deriveProfile(searches, events);
  await q.run('INSERT INTO member_profile(user_id,profile_json,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET profile_json=excluded.profile_json,updated_at=excluded.updated_at', [uid, JSON.stringify(p), Date.now()]);
  return p;
}
async function getProfile(q, uid) { const r = await q.get('SELECT profile_json FROM member_profile WHERE user_id=?', [uid]); try { return r ? JSON.parse(r.profile_json) : null; } catch { return null; } }

const words = s => new Set(String(s || '').toLowerCase().match(/[\p{L}]{4,}/gu) || []);
// Most recent turns plus any older turns that share words with the new message, newest first, all from this member only.
async function relevantChats(q, uid, message) {
  const rows = await q.all('SELECT role,text,created_at FROM member_chats WHERE user_id=? ORDER BY created_at DESC LIMIT ?', [uid, LIMITS.scanChats]);
  const w = words(message); const recent = rows.slice(0, 4);
  const rel = rows.slice(4).map(r => ({ r, s: [...words(r.text)].filter(x => w.has(x)).length })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, LIMITS.recentChats - recent.length).map(x => x.r);
  return [...recent, ...rel].sort((a, b) => a.created_at - b.created_at);
}
function profileLine(p) {
  if (!p) return '';
  const bits = [p.cuisines && p.cuisines.length && `likes ${p.cuisines.join(', ')} cuisine`, p.ingredients && p.ingredients.length && `often cooks with ${p.ingredients.join(', ')}`,
    p.dietary && p.dietary.length && `dietary: ${p.dietary.join(', ')}`, p.avoids && p.avoids.length && `avoids ${p.avoids.join(', ')}`, p.typicalMinutes && `usually has about ${p.typicalMinutes} min`,
    p.servings && `usually cooks for ${p.servings}`, p.frequentSearches && p.frequentSearches.length && `frequent searches: ${p.frequentSearches.join('; ')}`,
    p.recentRecipes && p.recentRecipes.length && `recently viewed/saved: ${p.recentRecipes.join('; ')}`, p.tools && p.tools.length && `uses ${p.tools.join(' and ')}`].filter(Boolean);
  return bits.join('; ');
}
// Compact block for the system prompt; hard-capped so the system message never exceeds Malcolm's 4,000-character per-message limit.
function memoryBlock(profile, chats = [], { max = LIMITS.block } = {}) {
  const head = 'MEMBER MEMORY (shared by this member with consent; use it gently to personalise, never recite it back verbatim, never assume beyond it; their current message always wins):';
  const pl = profileLine(profile); const lines = [];
  if (pl) lines.push('Profile: ' + pl.slice(0, Math.floor(max * 0.55)));
  if (chats.length) { lines.push('Earlier conversation:'); for (const c of chats) lines.push(`- ${c.role === 'user' ? 'Member' : 'Malcolm'}: ${clean(c.text).replace(/\s+/g, ' ').slice(0, 160)}`); }
  if (!lines.length) return '';
  let out = head + '\n' + lines.join('\n');
  while (out.length > max && lines.length > 1) { lines.splice(pl ? 2 : 1, 1); if (lines[lines.length - 1] === 'Earlier conversation:') lines.pop(); out = head + '\n' + lines.join('\n'); }
  return out.slice(0, max);
}
function withMemory(llm, block, { cap = LIMITS.systemCap } = {}) {
  if (!llm || !block) return llm;
  return (messages, opts) => { const m = messages.slice(); if (m[0] && m[0].role === 'system') { const room = cap - m[0].content.length - 2; if (room > 80) m[0] = { ...m[0], content: m[0].content + '\n\n' + block.slice(0, room) }; } return llm(m, opts); };
}
async function contextFor(q, uid, message) {
  const c = await getConsent(q, uid); if (!uid || !c.recorded || c.paused) return '';
  const profile = (allowed(c, 'search') || allowed(c, 'behaviour')) ? await getProfile(q, uid) : null;
  const chats = allowed(c, 'chat') ? await relevantChats(q, uid, message) : [];
  return memoryBlock(profile, chats);
}
// Optional: fill only blanks the member didn't set (never adds diets or exclusions on their behalf).
function biasSearch(raw = {}, data, profile) {
  if (!profile) return data; const n = { ...data };
  if (raw.servings == null && profile.servings) n.servings = profile.servings;
  if (raw.maxMinutes == null && profile.typicalMinutes) n.maxMinutes = profile.typicalMinutes;
  return n;
}
async function exportAll(q, uid) {
  return { exportedAt: new Date().toISOString(), consent: await getConsent(q, uid), profile: await getProfile(q, uid),
    chats: await q.all('SELECT role,text,surface,created_at FROM member_chats WHERE user_id=? ORDER BY created_at', [uid]),
    searches: (await q.all('SELECT query_json,created_at FROM member_searches WHERE user_id=? ORDER BY created_at', [uid])).map(r => ({ query: JSON.parse(r.query_json), created_at: r.created_at })),
    events: await q.all('SELECT kind,ref,created_at FROM member_events WHERE user_id=? ORDER BY created_at', [uid]) };
}
async function deleteAll(q, uid, { keepConsent = false } = {}) {
  for (const t of ['member_chats', 'member_searches', 'member_events', 'member_profile']) await q.run(`DELETE FROM ${t} WHERE user_id=?`, [uid]);
  if (!keepConsent) await q.run('DELETE FROM member_consent WHERE user_id=?', [uid]);
}
// Admin view: aggregate counts only, never chat text, searches, refs or per-member rows.
async function adminStats(q) {
  const n = async sql => ((await q.get(sql, [])) || {}).n || 0;
  return { consentVersion: CONSENT_VERSION, members: { chat: await n('SELECT COUNT(*) n FROM member_consent WHERE chat=1'), search: await n('SELECT COUNT(*) n FROM member_consent WHERE search=1'), behaviour: await n('SELECT COUNT(*) n FROM member_consent WHERE behaviour=1'), paused: await n('SELECT COUNT(*) n FROM member_consent WHERE paused=1') },
    rows: { chats: await n('SELECT COUNT(*) n FROM member_chats'), searches: await n('SELECT COUNT(*) n FROM member_searches'), events: await n('SELECT COUNT(*) n FROM member_events') } };
}
const CONSENT_TEXT = {
  version: CONSENT_VERSION,
  title: 'Let Malcolm remember you?',
  intro: 'Malcolm can learn what you like so his help feels personal. It is entirely optional, off unless you switch it on, and you can view, download, pause or delete it at any time on “What Malcolm remembers”.',
  chat: 'Chat memory: keep my conversations with Malcolm so he can pick up where we left off.',
  search: 'Search preferences and history: remember my recipe searches to learn my favourite cuisines, ingredients, dietary needs, time and servings.',
  behaviour: 'Browsing on AIchef.food: note which pages and recipes I view or save and when I use the Menu Builder or Kitchen Pack. First-party only: no third-party trackers, no IP address, no fingerprinting.',
  retention: 'Kept for up to 12 months, then deleted automatically. Never sold, never used for advertising, never visible to other members or to staff.'
};
// "Clear History": one user-scoped batch of deletes (run as a single D1 batch / SQLite transaction).
// Keeps: account, login/sessions, plan/subscription/Stripe, household (plan_members), consent choices, ratings,
// paid/monthly magazine issues, community recipes already shared, and favourites unless alsoFavourites is set.
function clearHistoryStatements(uid, { alsoFavourites = false } = {}) {
  const st = [['DELETE FROM member_chats WHERE user_id=?', [uid]], ['DELETE FROM member_searches WHERE user_id=?', [uid]], ['DELETE FROM member_events WHERE user_id=?', [uid]],
    ['DELETE FROM member_profile WHERE user_id=?', [uid]], ['DELETE FROM history WHERE user_id=?', [uid]], ['DELETE FROM user_prefs WHERE user_id=?', [uid]],
    ['DELETE FROM recipe_events WHERE actor=?', ['u:' + uid]],
    // Free sample previews are just generated history; today's are kept so clearing can't reset the daily preview allowance.
    ["DELETE FROM magazine_issues WHERE user_id=? AND kind='preview' AND created_at<date('now')", [uid]]];
  if (alsoFavourites) st.push(['DELETE FROM favourites WHERE user_id=?', [uid]]);
  return st;
}
const CLEAR_TABLES = ['member_chats', 'member_searches', 'member_events', 'member_profile', 'history', 'user_prefs', 'recipe_events', 'magazine_issues', 'favourites'];
// Route handlers shared by the Worker (Hono) and the Node server: (q, user, body, env) -> { status, json }.
const ok = json => ({ status: 200, json }); const need = () => ({ status: 401, json: { error: 'Please sign in' } });
const H = {
  consentGet: async (q, u) => u ? ok({ consent: await getConsent(q, u.id), text: CONSENT_TEXT }) : ok({ consent: { ...off }, text: CONSENT_TEXT, signedIn: false }),
  consentPut: async (q, u, b) => u ? ok({ consent: await setConsent(q, u.id, b || {}) }) : need(),
  view: async (q, u) => u ? ok(await exportAll(q, u.id)) : need(),
  exportJson: async (q, u) => u ? ok(await exportAll(q, u.id)) : need(),
  deleteAll: async (q, u) => { if (!u) return need(); await deleteAll(q, u.id); return ok({ ok: true, deleted: true, consent: await getConsent(q, u.id) }); },
  event: async (q, u, b, env) => u ? ok({ recorded: await recordEvent(q, u.id, b || {}, { env }) }) : ok({ recorded: false })
};
module.exports = { H, clearHistoryStatements, CLEAR_TABLES,  CONSENT_VERSION, CONSENT_TEXT, KINDS, LIMITS, retentionDays, getConsent, allowed, setConsent, recordChat, recordSearch, recordEvent, cleanEvent, deriveProfile, refreshProfile, getProfile, relevantChats, profileLine, memoryBlock, withMemory, contextFor, biasSearch, exportAll, deleteAll, adminStats, purge };
