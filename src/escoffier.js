'use strict';
// Escoffier grounding: shared by the Node server (better-sqlite3) and the Worker (D1). Pure helpers + SQL; no data import here.
const ATTRIBUTION = 'From A. Escoffier, “A Guide to Modern Cookery” (London: William Heinemann, 1907). Public domain; text via Project Gutenberg eBook #71395 (www.gutenberg.org).';
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS escoffier (id INTEGER PRIMARY KEY, no TEXT UNIQUE NOT NULL, n INTEGER NOT NULL, title TEXT NOT NULL, chapter TEXT, section TEXT, sub TEXT, text TEXT NOT NULL, ingredients TEXT, method TEXT, refs TEXT)`,
  `CREATE INDEX IF NOT EXISTS escoffier_section ON escoffier(section, n)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS escoffier_fts USING fts5(title, section, text, content='escoffier', content_rowid='id', tokenize='unicode61 remove_diacritics 2')`
];
const STOP = new Set('the and with for from into some any a an of in on to my me i want make like quick easy dish recipe something cosy nice tasty good fresh using use or'.split(' '));
// English → the French terms Escoffier uses in titles.
const SYN = { chicken: ['poulet', 'poularde', 'poussin', 'volaille', 'fowl'], mushroom: ['mushrooms', 'champignons', 'cèpes', 'morels'], mushrooms: ['mushroom', 'champignons'],
  beef: ['bœuf', 'boeuf', 'fillet'], lamb: ['agneau', 'mutton'], pork: ['porc'], duck: ['canard', 'caneton', 'duckling'], egg: ['eggs', 'œufs'], eggs: ['œufs'],
  fish: ['sole', 'turbot'], potato: ['potatoes', 'pommes'], potatoes: ['pommes'], tomato: ['tomatoes', 'tomates'], tomatoes: ['tomato'], cream: ['crème'],
  salmon: ['saumon'], cod: ['cabillaud'], prawn: ['prawns', 'shrimps', 'crevettes'], prawns: ['shrimps'], veal: ['veau'], rice: ['riz', 'pilaf', 'risotto'],
  onion: ['onions'], onions: ['onion'], apple: ['apples', 'pommes'], pear: ['pears', 'poires'], strawberry: ['strawberries', 'fraises'], chocolate: ['chocolat'],
  lobster: ['homard'], crab: ['crabs'], spinach: ['épinards'], peas: ['petits pois'], beans: ['haricots'], cheese: ['parmesan', 'gruyère'], lemon: ['lemons'], garlic: ['ail'] };
const words = s => String(s || '').toLowerCase().normalize('NFKC').match(/[\p{L}]{3,}/gu) || [];
function terms(q) {
  const base = [...(q.include || []), q.dish || ''].flatMap(words).filter(w => !STOP.has(w));
  const all = new Set(); for (const w of base) { all.add(w); for (const s of SYN[w] || []) words(s).forEach(x => all.add(x)); }
  return [...all].slice(0, 24);
}
const ftsExpr = ts => ts.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
const SELECT = 'SELECT e.id,e.no,e.n,e.title,e.section,e.sub,e.text,e.refs FROM escoffier_fts JOIN escoffier e ON e.id=escoffier_fts.rowid';
// all(sql, params) -> Promise<rows>
async function search(all, query, { limit = 20, offset = 0, section = null } = {}) {
  const ts = terms({ dish: query });
  if (!ts.length) {
    return section ? all('SELECT id,no,n,title,section,sub,text FROM escoffier WHERE section=? ORDER BY n,no LIMIT ? OFFSET ?', [section, limit, offset])
      : all('SELECT id,no,n,title,section,sub,text FROM escoffier ORDER BY n,no LIMIT ? OFFSET ?', [limit, offset]);
  }
  return all(`${SELECT} WHERE escoffier_fts MATCH ?${section ? ' AND e.section=?' : ''} ORDER BY bm25(escoffier_fts, 8.0, 1.0, 1.0) LIMIT ? OFFSET ?`,
    section ? [ftsExpr(ts), section, limit, offset] : [ftsExpr(ts), limit, offset]);
}
async function getEntry(all, no) { const r = await all('SELECT * FROM escoffier WHERE no=?', [String(no)]); return r[0] || null; }
// Excerpt: keep the opening (quantities + method), trimmed at a sentence boundary, measures left in the original for the AI to modernise.
function excerpt(text, max = 520) { const t = String(text || '').replace(/\s+/g, ' ').trim(); if (t.length <= max) return t; const cut = t.slice(0, max); const p = cut.lastIndexOf('. '); return (p > max * 0.5 ? cut.slice(0, p + 1) : cut) + ' …'; }
// Retrieval for grounding: top matches (prefer real dishes), plus the foundation recipes (stocks, mother sauces: Nos. ≤ 300) they reference.
async function references(all, q, { top = 3, foundations = 2, pinned = null } = {}) {
  const ts = terms(q); const out = []; const seen = new Set();
  const push = (r, role) => { if (r && !seen.has(r.no)) { seen.add(r.no); out.push({ no: r.no, title: r.title, section: r.section, role, text: excerpt(r.text, role === 'foundation' ? 360 : 520), refs: r.refs, fullText: r.text }); } };
  if (pinned) push(await getEntry(all, pinned), 'primary');
  if (ts.length) {
    const veg = (q.diets || []).some(d => d === 'vegetarian' || d === 'vegan');
    const rows = await all(`${SELECT} WHERE escoffier_fts MATCH ? AND e.n > 200 AND length(e.text) > 120${veg ? " AND e.section NOT IN ('Poultry & game','Fish','Relevés & entrées')" : ''} ORDER BY bm25(escoffier_fts, 8.0, 1.0, 1.0) LIMIT 12`, [ftsExpr(ts)]);
    // Require at least two distinct query words when possible so "chicken + mushrooms" beats plain "chicken".
    const score = r => { const h = (r.title + ' ' + r.text).toLowerCase(); return ts.filter(t => h.includes(t)).length; };
    rows.sort((a, b) => score(b) - score(a)).forEach(r => out.length < top + (pinned ? 1 : 0) && push(r, 'primary'));
  }
  const fnos = [...new Set(out.flatMap(r => { let n = []; try { n = JSON.parse(r.refs || '[]'); } catch {} return [...n.filter(x => parseInt(x, 10) <= 300), ...foundationNos(r.fullText)]; }))].filter(n => !seen.has(n)).slice(0, foundations);
  for (const n of fnos) push(await getEntry(all, n), 'foundation');
  return out.map(({ refs, fullText, ...r }) => r);
}
// Foundations named in the text (Escoffier often says "Allemande sauce" rather than "No. 27").
const FOUNDATIONS = [[/demi-glace|half-glaze/, '23'], [/espagnole/, '22'], [/allemande/, '27'], [/b[ée]chamel/, '28'], [/poultry velout[ée]|velout[ée] de volaille/, '26'],
  [/fish velout[ée]/, '26a'], [/velout[ée]/, '25'], [/supr[êe]me sauce/, '106a'], [/tomato sauce/, '29'], [/hollandaise/, '30'], [/chasseur sauce/, '33'], [/mushroom sauce/, '70'],
  [/mornay/, '91'], [/b[ée]arnaise/, '62'], [/madeira sauce/, '44'], [/cream sauce/, '79'], [/poulette/, '101'], [/brown stock|estouffade/, '7'], [/brown veal stock|veal gravy|thickened gravy/, '9'],
  [/white stock|poultry stock|chicken stock/, '10'], [/fish fumet|fish stock|fumet/, '11'], [/meat glaze|meat-glaze/, '15'], [/brown roux/, '19'], [/white roux/, '21']];
function foundationNos(text) { const t = String(text || '').toLowerCase(); return FOUNDATIONS.map(([re, no]) => { const m = t.search(re); return m < 0 ? null : [m, no]; }).filter(Boolean).sort((a, b) => a[0] - b[0]).map(x => x[1]); }
const label = r => `Inspired by Escoffier, Guide No. ${r.no}: ${titleCase(r.title)}`;
function titleCase(s) { return String(s).toLowerCase().replace(/(^|[\s(“‘'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()).replace(/\b(A|De|Du|La|Le|Les|Au|Aux|Of|Or|And|With|En)\b/g, w => w.toLowerCase()).replace(/^./, c => c.toUpperCase()); }
// Validate the model's citation against the references actually supplied (no invented numbers).
function cite(recipe, refs) {
  if (!refs || !refs.length) return null;
  const m = String(recipe.inspiredBy || '').match(/(\d{1,4}[a-z]?)/); const hit = m && refs.find(r => r.no === m[1]);
  if (!hit) return null;
  return { no: hit.no, title: titleCase(hit.title), label: label(hit), url: `/escoffier.html#no-${hit.no}` };
}
const PRINCIPLES = 'Escoffier is your primary influence: follow his methods, flavour pairings and principles (simplicity — "faites simple"; sound foundation stocks and sauces; seasonal produce; balance and restraint) adapted to the cook\'s ingredients, time and skill, with modern UK metric measures, shortcuts where time demands (e.g. good shop-bought stock for a fond) and modern food safety. Use the supplied Escoffier references (1907, public domain) as your grounding; when a recipe draws on one, set "inspiredBy" to its number (e.g. "1500"), else null. Never invent a number.';
async function list(all, qs) {
  const q = String(qs.q || '').slice(0, 100), section = qs.section ? String(qs.section).slice(0, 60) : null, page = Math.max(0, Math.min(200, parseInt(qs.page, 10) || 0));
  const rows = await search(all, q, { limit: 24, offset: page * 24, section });
  const sections = await all('SELECT section, COUNT(*) c, MIN(n) n FROM escoffier GROUP BY section ORDER BY n', []);
  return { attribution: ATTRIBUTION, sections: sections.map(s => ({ name: s.section, count: s.c })), page, entries: rows.map(r => ({ no: r.no, title: titleCase(r.title), section: r.section, snippet: excerpt(r.text, 220) })) };
}
async function one(all, no) {
  const r = await getEntry(all, String(no).slice(0, 6)); if (!r) return null;
  const refs = JSON.parse(r.refs || '[]'); const rt = refs.length ? await all(`SELECT no,title FROM escoffier WHERE no IN (${refs.map(() => '?').join(',')})`, refs) : [];
  return { attribution: ATTRIBUTION, entry: { no: r.no, title: titleCase(r.title), section: r.section, sub: r.sub, text: r.text, ingredients: JSON.parse(r.ingredients || 'null'), refs: rt.map(x => ({ no: x.no, title: titleCase(x.title) })) } };
}
module.exports = { list, one, foundationNos, ATTRIBUTION, SCHEMA_SQL, terms, ftsExpr, search, getEntry, references, excerpt, cite, label, titleCase, PRINCIPLES };
