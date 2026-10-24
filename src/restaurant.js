'use strict';
// Restauranteur plan: restaurant website analysis, menu-file parsing, smart recipe search over account history,
// AI Menu Builder (with deterministic offline fallback) and an elegant menu PDF. Pure functions; I/O is injected.
const { z } = require('zod');
const { Doc, wrap } = require('./pdf');
const { RECIPES } = require('./recipes');
const dioscorides = require('./dioscorides');

// ---------- SSRF-safe URL handling ----------
const MAX_BYTES = 1_500_000, TIMEOUT_MS = 8000, MAX_REDIRECTS = 3;
const BAD_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|test|invalid|example|arpa|onion)$/i;
function checkUrl(raw) {
  let u; try { u = new URL(String(raw || '').trim().replace(/^(?!https?:\/\/)/i, 'https://')); } catch { return { ok: false, error: 'That doesn’t look like a web address' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, error: 'Only http(s) web addresses are allowed' };
  if (u.username || u.password) return { ok: false, error: 'Web addresses with credentials aren’t allowed' };
  if (u.port && !['80', '443'].includes(u.port)) return { ok: false, error: 'Only standard web ports are allowed' };
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || BAD_HOST.test(h)) return { ok: false, error: 'Please use a public restaurant website address' };
  if (/^[\d.]+$/.test(h) || h.startsWith('[') || h.includes(':') || /^0x/i.test(h)) return { ok: false, error: 'Please use the restaurant’s domain name, not an IP address' };
  if (h.endsWith('aichef.food') || h.endsWith('workers.dev') && h.includes('luxprime')) return { ok: false, error: 'Please use your restaurant’s own website' };
  u.hash = ''; return { ok: true, url: u.toString(), host: h };
}
async function readCapped(res, max = MAX_BYTES) {
  if (!res.body || !res.body.getReader) { const t = await res.text(); return t.slice(0, max); }
  const reader = res.body.getReader(); const chunks = []; let n = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > max) { chunks.push(value.slice(0, value.length - (n - max))); try { await reader.cancel(); } catch {} break; } chunks.push(value); }
  const all = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0)); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}
async function safeFetch(raw, fetchImpl = fetch, { timeoutMs = TIMEOUT_MS } = {}) {
  let chk = checkUrl(raw); if (!chk.ok) throw new Error(chk.error);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res; try { res = await fetchImpl(chk.url, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'AIchefFood-MenuBuilder/1.0 (+https://aichef.food/restauranteur.html)', Accept: 'text/html,text/plain;q=0.9' } }); }
    catch (e) { clearTimeout(t); throw new Error(e && e.name === 'AbortError' ? 'The website took too long to respond' : 'We couldn’t reach that website'); }
    try {
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { chk = checkUrl(new URL(res.headers.get('location'), chk.url).toString()); if (!chk.ok) throw new Error(chk.error); continue; }
      if (!res.ok) throw new Error(`The website answered with an error (${res.status})`);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct && !/text\/html|text\/plain|application\/xhtml/.test(ct)) throw new Error('That page isn’t a web page we can read (try the menu page, or upload the menu file)');
      return { url: chk.url, html: await readCapped(res) };
    } finally { clearTimeout(t); }
  }
  throw new Error('Too many redirects');
}

// ---------- HTML extraction ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', eacute: 'é', egrave: 'è', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…', agrave: 'à', ccedil: 'ç' };
const decode = s => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
const clean = s => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
function htmlToText(html) {
  return decode(String(html || '').replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/dt|\/dd)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
}
const meta = (html, re) => { const m = html.match(re); return m ? clean(m[1]) : ''; };
function extractSite(html, url) {
  html = String(html || '');
  const title = meta(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = meta(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i) || meta(html, /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)/i);
  const siteName = meta(html, /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']*)/i);
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map(m => clean(m[1])).filter(h => h && h.length < 90).slice(0, 30);
  const ld = { cuisines: [], priceRange: '', name: '', menuItems: [] };
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk);
        const t = [].concat(o['@type'] || []).join(' ');
        if (/Restaurant|FoodEstablishment|CafeOrCoffeeShop|BarOrPub/.test(t)) { ld.name = ld.name || o.name || ''; ld.cuisines.push(...[].concat(o.servesCuisine || [])); ld.priceRange = ld.priceRange || o.priceRange || ''; }
        if (/MenuItem/.test(t) && o.name) ld.menuItems.push({ name: String(o.name), description: String(o.description || ''), price: o.offers && o.offers.price ? String(o.offers.price) : '' });
        for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v); };
      walk(JSON.parse(m[1].trim()));
    } catch {}
  }
  const base = (() => { try { return new URL(url); } catch { return null; } })();
  const menuLinks = base ? [...new Set([...html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .filter(m => /menu|food|dining|eat|carte|tasting|lunch|dinner/i.test(m[1] + ' ' + clean(m[2])))
    .map(m => { try { const u = new URL(decode(m[1]), base); return u.hostname === base.hostname && /^https?:$/.test(u.protocol) ? u.toString().replace(/#.*$/, '') : null; } catch { return null; } })
    .filter(u => u && u !== base.toString()))].slice(0, 6) : [];
  const text = htmlToText(html).slice(0, 40000);
  return { url, title, siteName: siteName || ld.name, description, headings, cuisines: [...new Set(ld.cuisines.map(String))].slice(0, 6), priceRange: String(ld.priceRange || ''), menuLinks, text, ldMenu: ld.menuItems.slice(0, 120) };
}

// ---------- Menu text parsing (website text, uploads) ----------
const SECTION = /^(?:to start|starters?|appeti[sz]ers?|small plates?|snacks?|nibbles|bar snacks|entr[ée]es?|antipasti|primi|secondi|mains?|main courses?|large plates?|grill|from the grill|fish|seafood|meat|sides?|side dishes|vegetables|salads?|soups?|pasta|pizzas?|desserts?|puddings?|sweets?|dolci|cheese|cheeses|afters|drinks?|cocktails|wines?|tasting menu|set menu|lunch|dinner|sunday roast|brunch|breakfast|kids|children'?s menu|specials|amuse[- ]bouche|pre[- ]dessert|petits? fours|course \w+|first course|second course|third course)\b[\s:–-]*$/i;
const PRICE = /(?:£|€|\$)\s?(\d{1,3}(?:[.,]\d{1,2})?)|(?:^|\s)(\d{1,3}\.\d{2}|\d{1,2}(?:\.5)?)\s*$/;
function parseMenuText(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && l.length < 220);
  const sections = []; let cur = null; const ensure = name => { cur = { name, dishes: [] }; sections.push(cur); return cur; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; const isHead = SECTION.test(l) || (l.length < 34 && l === l.toUpperCase() && /[A-Z]{3}/.test(l) && !PRICE.test(l));
    if (isHead) { ensure(l.replace(/[:–-]+$/, '').trim().replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase())); continue; }
    const pm = l.match(PRICE); const name = pm ? l.slice(0, pm.index).replace(/[.·…\s–-]+$/, '').trim() : l;
    if (!cur && !pm) continue;
    if (!pm && cur && cur.dishes.length && name.length > 40) { const d = cur.dishes[cur.dishes.length - 1]; if (!d.description) { d.description = name; continue; } }
    if (name.length < 3 || name.length > 120 || /cookie|privacy|©|copyright|book a table|reserv|opening|allergen|service charge|@|http|newsletter/i.test(name)) continue;
    (cur || ensure('Menu')).dishes.push({ name, price: pm ? (pm[1] || pm[2]).replace(',', '.') : '', description: '' });
  }
  const out = sections.filter(s => s.dishes.length).map(s => ({ ...s, dishes: s.dishes.slice(0, 30) })).slice(0, 14);
  return { sections: out, dishCount: out.reduce((a, s) => a + s.dishes.length, 0) };
}
// Minimal PDF text extraction (Flate or raw streams; Tj/TJ strings). Works for most text-based menus; scanned/CID-encoded PDFs need an image or text upload.
async function pdfText(bytes, inflate, cap = 60000) {
  const s = new TextDecoder('latin1').decode(bytes); const out = [];
  const re = /<<([^]*?)>>\s*stream\r?\n/g; let m;
  let total = 0; while ((m = re.exec(s)) && total < cap) { total = out.reduce((a, l) => a + l.length, 0);
    const start = m.index + m[0].length; const end = s.indexOf('endstream', start); if (end < 0) break;
    let data = bytes.subarray(start, end); const dict = m[1];
    if (/\/Subtype\s*\/Image|\/FontFile|\/Length1/.test(dict)) continue;
    if (/FlateDecode/.test(dict)) { try { data = await inflate(data); } catch { continue; } } else if (/\/Filter/.test(dict)) continue;
    const c = new TextDecoder('latin1').decode(data); if (!/T[jJ*']|TJ/.test(c)) continue;
    let line = '';
    for (const t of c.matchAll(/\((?:\\.|[^\\)])*\)\s*(?:Tj|'|")|\[(?:[^\]]*)\]\s*TJ|T\*|Td|TD|ET/g)) {
      const k = t[0];
      if (/^(T\*|Td|TD|ET)$/.test(k.trim())) { if (line.trim()) out.push(line.trim()); line = ''; continue; }
      const strs = [...k.matchAll(/\(((?:\\.|[^\\)])*)\)|(-?\d+(?:\.\d+)?)/g)].map(x => x[1] !== undefined ? x[1].replace(/\\([nrt()\\]|\d{1,3})/g, (q, e) => /\d/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '', t: ' ' }[e] ?? e)) : (+x[2] < -200 ? ' ' : ''));
      line += strs.join('');
    }
    if (line.trim()) out.push(line.trim());
  }
  return out.join('\n').replace(/\u0092/g, '’').replace(/\u0096/g, '–').replace(/\u00a3/g, '£');
}

// ---------- Analysis ----------
const CUISINE_WORDS = { Italian: /\b(pasta|risotto|antipasti|trattoria|osteria|pizza|gnocchi|burrata|tiramis[uù])\b/i, French: /\b(bistro|brasserie|confit|gratin|terrine|tarte|jus|beurre|soufflé|à la)\b/i, British: /\b(pub|sunday roast|fish (and|&) chips|pie|scotch egg|sticky toffee|yorkshire)\b/i,
  Indian: /\b(curry|tandoor|masala|biryani|dal|naan|tikka|paneer)\b/i, Japanese: /\b(sushi|sashimi|ramen|izakaya|yakitori|miso|tempura|omakase)\b/i, Chinese: /\b(dim sum|szechuan|sichuan|cantonese|bao|wok|peking)\b/i, Thai: /\b(pad thai|green curry|tom yum|som tam|thai)\b/i,
  Mexican: /\b(taco|tacos|burrito|mezcal|quesadilla|mole|tortilla)\b/i, Spanish: /\b(tapas|paella|jamón|chorizo|patatas bravas|croquetas)\b/i, 'Middle Eastern': /\b(mezze|meze|hummus|shawarma|falafel|labneh|za'atar)\b/i, Greek: /\b(souvlaki|moussaka|taverna|spanakopita|tzatziki)\b/i, Mediterranean: /\b(mediterranean|grilled octopus|olive oil|mezze)\b/i, Medicinal: /\b(apothecary|herbal|botanical|wellness|dioscorides)\b/i };
const STYLE_WORDS = [['fine dining', /\b(tasting menu|michelin|fine dining|degustation|amuse|chef'?s table)\b/i], ['casual', /\b(casual|relaxed|neighbourhood|family[- ]friendly|walk[- ]ins)\b/i], ['gastropub', /\b(gastro ?pub|pub|ales?)\b/i], ['seasonal / farm-to-table', /\b(seasonal|local(ly)? sourced|farm|foraged|kitchen garden)\b/i], ['plant-forward', /\b(vegan|plant[- ]based|vegetarian)\b/i], ['seafood-led', /\b(oyster|seafood|fish market|catch of the day)\b/i]];
function heuristicAnalysis(site, parsed, kind = 'mine') {
  const blob = [site.title, site.description, site.headings.join(' '), site.text.slice(0, 15000)].join(' ');
  const scores = Object.entries(CUISINE_WORDS).map(([c, re]) => [c, (blob.match(new RegExp(re.source, 'gi')) || []).length]).filter(x => x[1]).sort((a, b) => b[1] - a[1]);
  const cuisines = [...new Set([...site.cuisines, ...scores.slice(0, 3).map(x => x[0])])].slice(0, 4);
  const style = STYLE_WORDS.filter(([, re]) => re.test(blob)).map(x => x[0]);
  const prices = parsed.sections.flatMap(s => s.dishes.map(d => +d.price)).filter(n => n > 0 && n < 400).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  const priceBand = site.priceRange || (median == null ? 'unknown' : median < 12 ? '£ (accessible)' : median < 22 ? '££ (mid-market)' : median < 35 ? '£££ (premium)' : '££££ (luxury)');
  const secNames = parsed.sections.map(s => s.name.toLowerCase());
  const gaps = [];
  if (parsed.dishCount && !secNames.some(n => /dessert|pudding|sweet|dolci/.test(n))) gaps.push('No dessert section found — a short, signature dessert list lifts average spend.');
  if (parsed.dishCount && !/vegan|plant/i.test(site.text)) gaps.push('No clearly marked vegan dishes — add at least one per course.');
  if (!/allergen|allergy|gluten/i.test(site.text)) gaps.push('Allergen information isn’t easy to find on the site — Natasha’s Law and UK-14 labelling build trust.');
  if (parsed.dishCount > 45) gaps.push('A long menu — consider tightening to fewer, stronger dishes per section.');
  if (!/season|spring|summer|autumn|winter/i.test(site.text)) gaps.push('No seasonal messaging — a rotating seasonal special keeps regulars returning.');
  const c0 = cuisines[0] || 'Modern British';
  const ideas = [`A ${c0} tasting menu of five courses that tells the restaurant’s story, with an optional wine flight.`, `A seasonal ${new Date().toLocaleString('en-GB', { month: 'long' })} special built around one hero British ingredient at its peak.`,
    `A plant-forward ${c0} main with the same craft and price point as the signature meat dish.`, `A Dioscorides-inspired “apothecary” dessert or digestif course (fennel, honey, mint) — historical food lore as a talking point.`, `A weekday set lunch (2 or 3 courses) to fill quieter covers.`];
  if (kind === 'benchmark') { gaps.splice(0, gaps.length, ...gaps.map(g => 'Benchmark: ' + g.replace(/ — .*$/, '') + ' — a chance for you to differentiate.')); ideas.splice(0, ideas.length, `Take inspiration from this benchmark’s ${c0} positioning and create an original signature dish that answers it.`, `Where this benchmark is ${style[0] || 'conventional'}, differentiate with a clearly seasonal, story-led menu.`, `Offer something it doesn’t: a plant-forward tasting option or a Dioscorides-inspired botanical course.`, `Compare price points (${priceBand}) and design a set lunch that out-values it.`); }
  return { kind, name: site.siteName || site.title.split(/[|–—-]/)[0].trim(), cuisines, style: style.length ? style : ['modern'], priceBand, menuSections: parsed.sections.map(s => `${s.name} (${s.dishes.length})`), dishCount: parsed.dishCount,
    summary: `${site.siteName || 'The restaurant'} reads as a ${style[0] || 'modern'} ${cuisines.join(' / ') || 'contemporary'} restaurant${priceBand !== 'unknown' ? ` at a ${priceBand} price point` : ''}${parsed.dishCount ? `, with ${parsed.dishCount} dishes across ${parsed.sections.length} menu sections` : ''}.`,
    strengths: [site.description && `Clear positioning: “${site.description.slice(0, 160)}”`, parsed.dishCount && `${parsed.dishCount} dishes found and parsed from the site`, cuisines.length && `Distinct identity: ${cuisines.join(', ')}`].filter(Boolean), gaps, ideas, source: 'heuristic' };
}
function analysisMessages(site, parsed, persona, { kind = 'mine', mine = null } = {}) {
  const menu = parsed.sections.map(s => `${s.name}: ${s.dishes.slice(0, 12).map(d => d.name + (d.price ? ` (£${d.price})` : '')).join('; ')}`).join('\n').slice(0, 5000);
  return [{ role: 'system', content: `${persona}\nYou are reviewing a restaurant for its owner/executive chef. Be specific, commercially savvy and constructive. Reply with JSON only: {"summary":string,"cuisines":[string],"style":[string],"priceBand":string,"strengths":[string],"gaps":[string],"ideas":[string]} — 3-5 items per list; ideas are concrete new dishes or menu concepts that suit this restaurant.${kind === 'benchmark' ? ' This site is a BENCHMARK (a competitor or inspiration), not the member’s restaurant: treat it as comparison only — in gaps, note where the member can differentiate; in ideas, propose original dishes inspired by (never copied from) it. Never reproduce its dish names or descriptions verbatim.' + (mine ? ` The member’s own restaurant: ${String(mine).slice(0, 400)}` : '') : ''}` },
    { role: 'user', content: `Website: ${site.url}\nTitle: ${site.title}\nDescription: ${site.description}\nHeadings: ${site.headings.slice(0, 15).join(' | ')}\nDeclared cuisine: ${site.cuisines.join(', ')}\nMenu found:\n${menu || '(no menu parsed)'}\nPage text (excerpt):\n${site.text.slice(0, 3500)}` }];
}
function jsonFrom(raw) { const s = String(raw || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b <= a) return null; try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; } }
const strList = (v, n = 6, len = 300) => (Array.isArray(v) ? v : []).map(x => String(typeof x === 'string' ? x : (x && (x.name || x.title || x.idea)) || '').trim().slice(0, len)).filter(Boolean).slice(0, n);
async function analyse(site, parsed, { llm, persona = '', kind = 'mine', mine = null } = {}) {
  const h = heuristicAnalysis(site, parsed, kind);
  if (!llm) return h;
  try {
    const j = jsonFrom(await llm(analysisMessages(site, parsed, persona, { kind, mine }), { maxTokens: 900 }));
    if (!j || !j.summary) return h;
    return { ...h, summary: String(j.summary).slice(0, 700), cuisines: strList(j.cuisines, 4, 40).length ? strList(j.cuisines, 4, 40) : h.cuisines, style: strList(j.style, 4, 60).length ? strList(j.style, 4, 60) : h.style,
      priceBand: String(j.priceBand || h.priceBand).slice(0, 60), strengths: strList(j.strengths).length ? strList(j.strengths) : h.strengths, gaps: strList(j.gaps).length ? strList(j.gaps) : h.gaps, ideas: strList(j.ideas).length ? strList(j.ideas) : h.ideas, source: 'malcolm' };
  } catch { return h; }
}

// ---------- Cookbook benchmarks (private reference; style only, never reproduced) ----------
const TECHNIQUES = ['braise', 'confit', 'cure', 'ferment', 'pickle', 'smoke', 'roast', 'poach', 'sous vide', 'grill', 'char', 'emulsify', 'reduce', 'glaze', 'brine', 'laminate', 'temper', 'infuse', 'sear', 'steam', 'stew', 'bake', 'fry', 'dehydrate', 'foam', 'gel', 'purée', 'velouté', 'beurre blanc', 'stock'];
const FLAVOURS = ['lemon', 'garlic', 'thyme', 'rosemary', 'sage', 'tarragon', 'chilli', 'ginger', 'miso', 'soy', 'honey', 'butter', 'anchovy', 'capers', 'fennel', 'apple', 'pear', 'chocolate', 'hazelnut', 'almond', 'saffron', 'cumin', 'coriander', 'mint', 'basil', 'tomato', 'mushroom', 'truffle', 'vanilla', 'orange', 'rhubarb', 'cream', 'yoghurt', 'parmesan', 'olive oil', 'smoked paprika', 'lime', 'sesame', 'dill', 'mustard'];
function cookbookHeuristic(text, title) {
  const t = String(text || '').toLowerCase(); const count = w => (t.match(new RegExp('\\b' + w.replace(/ /g, '\\s+') + '\\w*', 'g')) || []).length;
  const techniques = TECHNIQUES.map(w => [w, count(w)]).filter(x => x[1] > 1).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
  const paras = t.split(/\n{2,}|\.\s/).slice(0, 4000); const pc = new Map(); const top = FLAVOURS.filter(f => count(f) > 1);
  for (const pa of paras) { const hit = top.filter(f => pa.includes(f)); for (let i = 0; i < hit.length; i++) for (let j = i + 1; j < hit.length; j++) { const k = hit[i] + ' & ' + hit[j]; pc.set(k, (pc.get(k) || 0) + 1); } }
  const pairings = [...pc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
  const sections = String(text || '').split('\n').filter(l => SECTION.test(l.trim())).map(l => l.trim()).slice(0, 10);
  const cz = Object.entries(CUISINE_WORDS).map(([c, re]) => [c, (t.match(new RegExp(re.source, 'gi')) || []).length]).filter(x => x[1] > 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
  return { kind: 'cookbook', title: title || 'Cookbook', cuisines: cz, techniques, pairings, structure: [...new Set(sections)].slice(0, 8), themes: [cz[0] && `${cz[0]} cooking`, techniques[0] && `technique-led (${techniques.slice(0, 3).join(', ')})`].filter(Boolean),
    summary: `${title || 'This cookbook'} leans on ${techniques.slice(0, 3).join(', ') || 'classic techniques'}${pairings.length ? `, with signature pairings such as ${pairings.slice(0, 3).join('; ')}` : ''}.`, ideas: [], strengths: [], gaps: [], style: [], priceBand: 'n/a', source: 'heuristic' };
}
async function analyseCookbook(text, title, { llm, persona = '' } = {}) {
  const h = cookbookHeuristic(text, title); if (!llm) return h;
  const s = String(text || ''); const n = s.length; const sample = [0, 0.25, 0.5, 0.75].map(f => s.slice(Math.floor(n * f), Math.floor(n * f) + 1500)).join('\n…\n');
  try {
    const j = jsonFrom(await llm([{ role: 'system', content: `${persona}\nYou are studying a cookbook the member has the right to use for private reference. Extract ONLY transferable style: techniques, flavour pairings, menu/book structure, themes and philosophy. Do NOT reproduce any recipe, ingredient list, method or sentence from it. Reply with JSON only: {"summary":string (your own words, max 60 words),"cuisines":[string],"techniques":[string],"pairings":[string],"structure":[string],"themes":[string],"ideas":[string] (original dish ideas inspired by its style)}` },
      { role: 'user', content: `Cookbook: ${title}\nExcerpts (for analysis only):\n${sample}` }], { maxTokens: 900 }));
    if (!j || !j.summary) return h;
    return { ...h, summary: String(j.summary).slice(0, 500), cuisines: strList(j.cuisines, 4, 40).length ? strList(j.cuisines, 4, 40) : h.cuisines, techniques: strList(j.techniques, 10, 60).length ? strList(j.techniques, 10, 60) : h.techniques,
      pairings: strList(j.pairings, 10, 80).length ? strList(j.pairings, 10, 80) : h.pairings, structure: strList(j.structure, 8, 80), themes: strList(j.themes, 6, 120), ideas: strList(j.ideas, 6, 200), source: 'malcolm' };
  } catch { return h; }
}
const cookbookBrief = a => `“${a.title}” (style only: techniques ${(a.techniques || []).slice(0, 5).join(', ') || 'n/a'}; pairings ${(a.pairings || []).slice(0, 4).join('; ') || 'n/a'}; themes ${(a.themes || []).slice(0, 3).join('; ') || 'n/a'})`;
// Long verbatim runs (8+ consecutive words) from a private cookbook must never appear in output.
function verbatimRisk(out, sourceText, n = 8) {
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean); const src = ' ' + norm(sourceText).join(' ') + ' '; const w = norm(out);
  for (let i = 0; i + n <= w.length; i++) if (src.includes(' ' + w.slice(i, i + n).join(' ') + ' ')) return true; return false;
}

// ---------- Smart search over account history / favourites ----------
const SEASON = { spring: /asparagus|lamb|pea|wild garlic|rhubarb|radish|jersey royal|spring onion|mint|crab/i, summer: /tomato|strawberr|courgette|basil|peach|berr|cucumber|mackerel|corn|aubergine|salad/i, autumn: /squash|pumpkin|mushroom|apple|pear|game|venison|blackberr|beetroot|fig|chestnut/i, winter: /parsnip|cabbage|kale|leek|beef|braise|stew|orange|clementine|chestnut|root|celeriac|sprout/i };
const seasonNow = (d = new Date()) => ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'][d.getMonth()];
const PROTEIN = /beef|lamb|pork|chicken|duck|venison|salmon|cod|haddock|mackerel|prawn|scallop|crab|tofu|halloumi|paneer|egg|chickpea|lentil|bean|mushroom/i;
const TASTE = { rich: /cream|butter|braise|cheese|confit|chocolate|caramel|pork belly|duck/i, fresh: /citrus|lemon|lime|herb|salad|ceviche|cucumber|mint|yuzu|raw|tartare/i, spicy: /chilli|chili|curry|harissa|jalape|szechuan|sichuan|pepper|gochujang/i, sweet: /honey|sugar|caramel|chocolate|fruit|tart|pudding|cake|meringue/i, umami: /miso|soy|parmesan|mushroom|anchovy|dashi|seaweed/i };
const COST = { budget: /lentil|bean|chickpea|potato|egg|pasta|cabbage|chicken thigh|mackerel|squash|rice|pork shoulder|mince/i, premium: /fillet|scallop|lobster|truffle|caviar|wagyu|turbot|langoustine|foie|saffron|venison|halibut|sea bass/i };
function historyItems({ history = [], favourites = [] }) {
  const items = []; const seen = new Set();
  const add = (title, extra) => { const t = String(title || '').trim(); const k = t.toLowerCase(); if (!t || t.length > 140 || seen.has(k)) return; seen.add(k); items.push({ title: t, ...extra }); };
  for (const f of favourites) { try { const r = typeof f.recipe_json === 'string' ? JSON.parse(f.recipe_json) : f; add(r.title, { source: 'favourite', cuisine: r.cuisine || '', text: [r.title, r.cuisine, r.tagline, ...(r.ingredients || []).map(i => i.name || i)].join(' '), diets: r.diets || [], minutes: r.totalMinutes || null }); } catch {} }
  for (const h of history) { let q = {}; try { q = JSON.parse(h.query_json || '{}'); } catch {} for (const t of String(h.titles || '').split(' · ')) add(t, { source: 'history', cuisine: (q.cuisines || [])[0] || (q.cuisine !== 'any' ? q.cuisine : '') || '', text: [t, ...(q.include || []), q.dish || '', ...(q.cuisines || [])].join(' '), diets: q.diets || [], minutes: q.maxMinutes || null }); }
  return items;
}
const SearchOpts = z.object({ q: z.string().trim().max(120).default(''), cuisine: z.string().trim().max(40).default(''), diet: z.string().trim().max(30).default(''), season: z.enum(['', 'now', 'spring', 'summer', 'autumn', 'winter']).default(''),
  taste: z.enum(['', 'rich', 'fresh', 'spicy', 'sweet', 'umami']).default(''), cost: z.enum(['', 'budget', 'premium']).default(''), sort: z.enum(['appeal', 'variety', 'recent']).default('appeal'), library: z.coerce.boolean().default(true) });
function smartSearch(items, raw = {}, now = new Date()) {
  const o = SearchOpts.parse(raw); const season = o.season === 'now' ? seasonNow(now) : o.season; const words = o.q.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  let pool = items.map((it, i) => ({ ...it, _i: i }));
  if (o.library) for (const r of RECIPES) if (!pool.some(p => p.title.toLowerCase() === r.title.toLowerCase())) pool.push({ title: r.title, source: 'library', cuisine: r.cuisine, text: [r.title, r.cuisine, ...r.ingredients.map(x => x.name)].join(' '), diets: r.diets || [], minutes: r.totalMinutes, _i: 1000 + pool.length });
  const scored = pool.map(it => {
    const t = it.text.toLowerCase(); let s = it.source === 'favourite' ? 3 : it.source === 'history' ? 2 : 0; const why = [];
    if (words.length) { const hit = words.filter(w => t.includes(w)).length; if (!hit) return null; s += hit * 3; }
    if (o.cuisine) { if (it.cuisine.toLowerCase() === o.cuisine.toLowerCase() || t.includes(o.cuisine.toLowerCase())) { s += 3; why.push(o.cuisine); } else s -= 2; }
    if (o.diet) { if ((it.diets || []).includes(o.diet)) { s += 3; why.push(o.diet); } else return null; }
    if (season) { if (SEASON[season].test(t)) { s += 2; why.push(`in season (${season})`); } }
    if (o.taste && TASTE[o.taste].test(t)) { s += 2; why.push(o.taste); }
    if (o.cost && COST[o.cost].test(t)) { s += 2; why.push(o.cost === 'budget' ? 'good GP margin' : 'premium'); }
    if (it.source === 'favourite') why.unshift('your favourite'); else if (it.source === 'history') why.unshift('from your history');
    return { title: it.title, source: it.source, cuisine: it.cuisine, protein: (t.match(PROTEIN) || [''])[0], score: s, why, _i: it._i };
  }).filter(Boolean);
  scored.sort((a, b) => o.sort === 'recent' ? a._i - b._i : b.score - a.score || a._i - b._i);
  if (o.sort === 'variety' || o.sort === 'appeal') { // diversify: avoid repeating the same protein/cuisine back-to-back
    const out = []; const used = new Map(); const rest = [...scored];
    while (rest.length && out.length < 60) { let k = rest.findIndex(x => (used.get(x.protein || x.title) || 0) === Math.min(...rest.map(y => used.get(y.protein || y.title) || 0))); if (o.sort === 'appeal' && k > 2) k = 0; const [x] = rest.splice(Math.max(0, k), 1); used.set(x.protein || x.title, (used.get(x.protein || x.title) || 0) + 1); out.push(x); }
    return out.map(({ _i, ...x }) => x).slice(0, 40);
  }
  return scored.slice(0, 40).map(({ _i, ...x }) => x);
}

// ---------- Menu Builder ----------
const MENU_TYPES = { 'a-la-carte': 'À la carte', tasting: 'Tasting menu', set: 'Set menu', 'prix-fixe': 'Prix fixe', banquet: 'Banquet / sharing', 'small-plates': 'Small plates', 'sunday-lunch': 'Sunday lunch', brunch: 'Brunch', 'private-dining': 'Private dining', seasonal: 'Seasonal special' };
const DEFAULT_COURSES = { tasting: ['Amuse-bouche', 'First course', 'Fish course', 'Main course', 'Pre-dessert', 'Dessert', 'Petits fours', 'Cheese', 'Second fish', 'Intermezzo', 'Second main', 'Mignardises'],
  default: ['Starters', 'Mains', 'Desserts', 'Sides', 'Cheese', 'Petits fours', 'Intermezzo', 'Amuse-bouche', 'Fish', 'Pre-dessert', 'Sharing', 'Digestif'], 'small-plates': ['Snacks', 'Small plates', 'Larger plates', 'Sides', 'Sweet plates', 'Cheese', 'Extras', 'Petits fours', 'Bread', 'Raw', 'Grill', 'Garden'],
  brunch: ['To start', 'Brunch plates', 'Sweet', 'Sides', 'Pastries', 'Extras', 'Juices', 'Bakery', 'Eggs', 'Bowls', 'Grill', 'Treats'], banquet: ['To share', 'Feast', 'Sides', 'Sweet finish', 'Cheese', 'Petits fours', 'Bread', 'Raw', 'Grill', 'Garden', 'Extras', 'Digestif'] };
const DIET_TAGS = ['vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'nut-free', 'halal'];
const MenuSpec = z.object({
  name: z.string().trim().max(80).default(''), restaurantName: z.string().trim().max(80).default(''), description: z.string().trim().max(1500).default(''),
  menuType: z.enum(Object.keys(MENU_TYPES)).default('a-la-carte'), cuisines: z.array(z.string().trim().min(1).max(40)).max(6).default([]), style: z.string().trim().max(120).default(''),
  courses: z.coerce.number().int().min(1).max(12).default(3), dishesPerCourse: z.coerce.number().int().min(1).max(8).default(3), courseNames: z.array(z.string().trim().max(40)).max(12).default([]),
  pinned: z.array(z.string().trim().min(1).max(140)).max(40).default([]), sourceMenu: z.string().max(12000).default(''), sourceKind: z.enum(['mine', 'benchmark']).default('mine'), useCookbooks: z.boolean().default(true),
  refine: z.object({ appeal: z.enum(['broad', 'adventurous', 'classic', 'family']).default('broad'), variety: z.enum(['balanced', 'high', 'focused']).default('balanced'), taste: z.enum(['balanced', 'rich', 'fresh', 'spicy', 'umami']).default('balanced'),
    diets: z.array(z.enum(DIET_TAGS)).max(6).default([]), season: z.enum(['now', 'spring', 'summer', 'autumn', 'winter', 'any']).default('now'), cost: z.enum(['any', 'budget', 'mid', 'premium']).default('any'),
    prices: z.boolean().default(true), pairings: z.boolean().default(false), personal: z.string().trim().max(400).default('') }).default({})
});
function courseNames(spec) { const pool = DEFAULT_COURSES[spec.menuType] || DEFAULT_COURSES.default; return Array.from({ length: spec.courses }, (_, i) => spec.courseNames[i] || pool[i] || `Course ${i + 1}`); }
const perCourse = spec => ['tasting', 'set', 'prix-fixe', 'private-dining'].includes(spec.menuType) && spec.dishesPerCourse > 2 ? spec.dishesPerCourse : spec.dishesPerCourse;
function builderMessages(spec, ctx, persona) {
  const names = courseNames(spec); const r = spec.refine; const season = r.season === 'now' ? seasonNow() : r.season;
  return [{ role: 'system', content: `${persona}\nYou are Malcolm, consulting executive chef, composing a restaurant menu for a professional client. British English, UK seasonal produce, menu-card prose (concise, evocative, no clichés). Never include toxic plants or anything unsafe to eat; Dioscorides/medicinal notes are historical food lore only, never health claims. Reply with JSON only:
{"title":string,"intro":string (1-2 sentences for the top of the card),"courses":[{"name":string,"dishes":[{"name":string,"description":string (max 22 words, key components),"tags":[from ${DIET_TAGS.join('|')}],"price":number|null,"pairing":string|null,"fromHistory":boolean}]}],"chefNote":string,"rationale":string (2-3 sentences on balance, variety and appeal)}` },
    { role: 'user', content: [`Restaurant: ${spec.restaurantName || 'the restaurant'}`, spec.description && `About the restaurant: ${spec.description}`, `Menu type: ${MENU_TYPES[spec.menuType]}`, `Cuisine/style: ${[...spec.cuisines, spec.style].filter(Boolean).join(', ') || 'chef’s choice'}`,
      `Courses (exactly these, in order): ${names.join(' | ')}; ${spec.dishesPerCourse} dish${spec.dishesPerCourse > 1 ? 'es' : ''} per course${spec.menuType === 'tasting' ? ' (for a tasting menu with 1 dish per course, make each a single plate)' : ''}.`,
      `Appeal: ${r.appeal}. Variety: ${r.variety} (avoid repeating main proteins/techniques). Taste profile: ${r.taste}. Season: ${season}. Food cost target: ${r.cost}.`, r.diets.length && `Every course must include at least one dish that is: ${r.diets.join(', ')}.`,
      r.prices ? `Suggest GBP menu prices suited to ${ctx.priceBand || 'the restaurant'}${spec.menuType === 'tasting' || spec.menuType === 'set' || spec.menuType === 'prix-fixe' ? ' (put the per-person price in chefNote and use null for dish prices)' : ''}.` : 'No prices (null).', r.pairings && 'Add a wine or drink pairing per dish (style/grape/region, no brands).',
      spec.cuisines.some(c => /medicinal/i.test(c)) && `Medicinal cuisine: draw on Dioscorides’ recipe-safe foods (${dioscorides.SAFE.slice(0, 30).map(e => e.name).join(', ')}).`,
      spec.pinned.length && `Must feature (refine and elevate) these dishes from the chef’s account history: ${spec.pinned.join('; ')}. Mark them fromHistory true.`,
      ctx.cookbooks && ctx.cookbooks.length && `Cookbook inspiration — borrow style, techniques, pairings and structure only; every dish must be original; never reproduce recipes, dish names or text from these books: ${ctx.cookbooks.map(cookbookBrief).join(' | ')}.`,
      ctx.analysis && `Website analysis: ${ctx.analysis.summary} Ideas: ${(ctx.analysis.ideas || []).slice(0, 3).join(' / ')}`,
      spec.sourceMenu && (spec.sourceKind === 'benchmark' ? `Benchmark menu (a competitor or inspiration, NOT the client’s): use it only for inspiration and contrast — create original dishes, never reuse its dish names or descriptions verbatim:\n${spec.sourceMenu.slice(0, 4000)}` : `Existing/example menu to explore, develop and elaborate on (keep its identity, raise its ambition):\n${spec.sourceMenu.slice(0, 4000)}`), r.personal && `Personal brief: ${r.personal}`].filter(Boolean).join('\n') }];
}
// Offline composer: deterministic, uses history + library + course-appropriate templates.
const TPL = {
  start: [['Heritage beetroot, whipped goat’s curd, hazelnut, aged balsamic', ['vegetarian', 'gluten-free']], ['Seared scallops, cauliflower purée, brown butter, capers', ['gluten-free']], ['Ham hock terrine, piccalilli, toasted sourdough', []], ['Charred leeks, romesco, toasted almonds, chive oil', ['vegan', 'dairy-free', 'gluten-free']], ['Crab on crisp toast, brown crab mayonnaise, apple, fennel', []], ['Chicken liver parfait, spiced fig chutney, brioche', []], ['Burrata, blood orange, pistachio, mint', ['vegetarian', 'gluten-free']], ['Roast squash velouté, sage, toasted seeds', ['vegan', 'gluten-free', 'dairy-free']]],
  main: [['Roast cod, mussels, leeks, saffron and cider sauce', ['gluten-free']], ['Slow-braised beef short rib, celeriac, bone-marrow jus', ['gluten-free', 'dairy-free']], ['Wild mushroom and chestnut pithivier, truffle jus', ['vegetarian']], ['Herb-crusted rack of lamb, pressed potato, salsa verde', ['gluten-free']], ['Pan-roast duck breast, plum, red chicory, five-spice jus', ['gluten-free', 'dairy-free']], ['Chickpea and aubergine tagine, preserved lemon, herb couscous', ['vegan', 'dairy-free']], ['Stone bass, brown shrimp, sea vegetables, beurre blanc', ['gluten-free']], ['Pork belly, black pudding, apple, cider jus', []]],
  dessert: [['Dark chocolate delice, salted caramel, crème fraîche', ['vegetarian']], ['Vanilla panna cotta, poached rhubarb, ginger crumb', ['vegetarian']], ['Sticky toffee pudding, clotted cream ice cream', ['vegetarian']], ['Lemon tart, raspberry sorbet, Italian meringue', ['vegetarian']], ['Coconut rice pudding, mango, lime, toasted coconut', ['vegan', 'gluten-free', 'dairy-free']], ['Honey and fennel-seed cake, figs, yoghurt (after Dioscorides)', ['vegetarian']], ['Baked apple, oat crumble, cinnamon custard', ['vegetarian']]],
  other: [['British cheeses, oatcakes, quince, celery', ['vegetarian']], ['Hand-made petits fours', ['vegetarian']], ['Seasonal sorbet, mint', ['vegan', 'gluten-free', 'dairy-free']], ['Buttered seasonal greens, lemon', ['vegetarian', 'gluten-free']], ['Triple-cooked chips, rosemary salt', ['vegan', 'gluten-free', 'dairy-free']], ['Warm sourdough, cultured butter', ['vegetarian']]] };
const kind = name => /start|first|amuse|snack|small|share|raw|soup|antipasti|entr|bread|to start/i.test(name) ? 'start' : /dessert|sweet|pudding|pre-dessert|dolci/i.test(name) ? 'dessert' : /cheese|petit|mignard|side|intermezzo|digestif|extra|juice|bakery|pastr/i.test(name) ? 'other' : 'main';
function offlineMenu(spec, ctx = {}) {
  const names = courseNames(spec); const r = spec.refine; const pinned = [...spec.pinned]; const usedNames = new Set(); let seed = [...(spec.restaurantName + spec.menuType + spec.cuisines.join())].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const rnd = n => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
  const courses = names.map(name => {
    const k = kind(name); const pool = TPL[k].filter(([n]) => !usedNames.has(n)); const dishes = [];
    for (let i = 0; i < spec.dishesPerCourse; i++) {
      if (pinned.length && (k === 'main' || k === 'start') && i === 0) { const t = pinned.shift(); dishes.push({ name: t, description: 'From your kitchen history, refined for the pass — Malcolm will elevate the garnish and plating.', tags: [], price: null, pairing: null, fromHistory: true }); continue; }
      let cands = pool.filter(([n]) => !usedNames.has(n)); if (r.diets.length && i === 0) { const d = cands.filter(([, t]) => r.diets.every(x => t.includes(x))); if (d.length) cands = d; }
      if (!cands.length) break; const [n, tags] = cands[rnd(cands.length)]; usedNames.add(n);
      const [title, ...rest] = n.split(', '); dishes.push({ name: title, description: rest.join(', '), tags, price: null, pairing: null, fromHistory: false });
    }
    return { name, dishes };
  }).filter(c => c.dishes.length);
  const band = String(ctx.priceBand || ''); const mult = /££££/.test(band) || r.cost === 'premium' ? 1.6 : /£££/.test(band) ? 1.3 : /^£ |budget/.test(band) || r.cost === 'budget' ? 0.75 : 1;
  const per = spec.menuType === 'tasting' || spec.menuType === 'set' || spec.menuType === 'prix-fixe' || spec.menuType === 'banquet';
  if (r.prices && !per) for (const c of courses) for (const d of c.dishes) { const base = { start: 10, main: 22, dessert: 9, other: 6 }[kind(c.name)]; d.price = Math.round(base * mult * 2) / 2; }
  const pp = per ? Math.round((spec.menuType === 'tasting' ? 18 * names.length : 14 + 9 * names.length) * mult) : null;
  return { title: spec.name || `${MENU_TYPES[spec.menuType]}${spec.cuisines.length ? ' · ' + spec.cuisines.join(' & ') : ''}`, intro: spec.description ? spec.description.split(/(?<=\.)\s/)[0].slice(0, 220) : `A ${r.season === 'now' ? seasonNow() : r.season === 'any' ? 'seasonal' : r.season} menu composed by Malcolm for ${spec.restaurantName || 'your restaurant'}.`,
    courses, chefNote: r.prices && pp ? `£${pp} per person.` : '', rationale: 'Composed offline from Malcolm’s classical repertoire because the AI kitchen was busy — regenerate for a fully bespoke menu.', source: 'offline' };
}
const safeText = s => { const b = dioscorides.banned(s); return b ? null : s; };
function normaliseMenu(j, spec) {
  const names = courseNames(spec); if (!j || !Array.isArray(j.courses) || !j.courses.length) return null;
  const courses = j.courses.slice(0, 12).map((c, i) => ({ name: String((c && c.name) || names[i] || `Course ${i + 1}`).slice(0, 40), dishes: (Array.isArray(c && c.dishes) ? c.dishes : []).slice(0, 8).map(d => ({ name: String((d && d.name) || '').slice(0, 90), description: String((d && d.description) || '').slice(0, 220),
    tags: (Array.isArray(d && d.tags) ? d.tags : []).map(String).filter(t => DIET_TAGS.includes(t)), price: d && d.price != null && isFinite(+d.price) && +d.price > 0 && +d.price < 1000 ? Math.round(+d.price * 2) / 2 : null, pairing: d && d.pairing ? String(d.pairing).replace(/£\s?\d+(\.\d+)?/g, '').slice(0, 90) : null, fromHistory: !!(d && d.fromHistory) }))
    .filter(d => d.name && safeText(d.name + ' ' + d.description)) })).filter(c => c.dishes.length);
  if (!courses.length) return null;
  return { title: String(j.title || spec.name || MENU_TYPES[spec.menuType]).slice(0, 90), intro: String(j.intro || '').slice(0, 300), courses, chefNote: String(j.chefNote || '').slice(0, 300), rationale: String(j.rationale || '').slice(0, 500), source: 'malcolm' };
}
async function buildMenu(spec, ctx = {}, { llm, persona = '' } = {}) {
  let menu = null;
  if (llm) { try { menu = normaliseMenu(jsonFrom(await llm(builderMessages(spec, ctx, persona), { maxTokens: 1800 })), spec); } catch {} }
  if (menu && spec.sourceKind === 'benchmark' && spec.sourceMenu) { // never copy a benchmark's dishes verbatim
    const theirs = new Set(menuDishes(spec.sourceMenu).map(n => n.toLowerCase().replace(/[^a-z ]/g, '').trim()));
    menu.courses = menu.courses.map(c => ({ ...c, dishes: c.dishes.filter(d => !theirs.has(d.name.toLowerCase().replace(/[^a-z ]/g, '').trim())) })).filter(c => c.dishes.length); if (!menu.courses.length) menu = null; }
  if (menu && ctx.cookbookText) menu.courses = menu.courses.map(c => ({ ...c, dishes: c.dishes.filter(d => !verbatimRisk(d.name + ' ' + d.description, ctx.cookbookText)) })).filter(c => c.dishes.length);
  if (menu && !menu.courses.length) menu = null;
  menu = menu || offlineMenu(spec, ctx);
  if (ctx.cookbooks && ctx.cookbooks.length) menu.inspiredBy = ctx.cookbooks.map(b => b.title).slice(0, 4);
  return { ...menu, restaurantName: spec.restaurantName, menuType: spec.menuType, menuTypeLabel: MENU_TYPES[spec.menuType], cuisines: spec.cuisines, diets: spec.refine.diets, description: spec.description, createdAt: new Date().toISOString() };
}

// ---------- PDF ----------
const PC = { paper: '#fbf8f2', ink: '#1d1a17', gold: '#b08a45', gold2: '#d8bd84', mute: '#7a7065', rule: '#d9cdb8', copper: '#a8683e', night: '#16171b' };
const TAG = { vegetarian: 'V', vegan: 'VG', 'gluten-free': 'GF', 'dairy-free': 'DF', 'nut-free': 'NF', halal: 'H' };
function menuPdf(menu, fontFiles, { url = '' } = {}) {
  const W = 595.28, H = 841.89, M = 64, CW = W - 2 * M; const doc = new Doc({ title: `${menu.restaurantName || 'Menu'} — ${menu.title}`, fontFiles });
  const frame = pg => { pg.rect(0, 0, W, H, PC.paper); pg.rect(22, 22, W - 44, H - 44, null, { stroke: PC.gold, lw: 0.8 }); pg.rect(27, 27, W - 54, H - 54, null, { stroke: PC.gold2, lw: 0.35 });
    for (const [x, y] of [[22, 22], [W - 22, 22], [22, H - 22], [W - 22, H - 22]]) pg.rect(x - 3, y - 3, 6, 6, PC.gold); };
  const footer = (pg, n, total) => { pg.line(W / 2 - 60, H - 64, W / 2 + 60, H - 64, PC.gold2, 0.5);
    const legend = [...new Set(menu.courses.flatMap(c => c.dishes.flatMap(d => d.tags)))].map(t => `${TAG[t]} ${t}`).join('  ·  ');
    pg.text((legend ? legend + '  ·  ' : '') + 'Please tell your server about any allergies', W / 2, H - 50, { font: 'sans', size: 6.5, color: PC.mute, align: 'center', maxW: CW });
    pg.text(`Menu composed with Malcolm · AIchef.food${total > 1 ? `   ·   ${n} / ${total}` : ''}`, W / 2, H - 39, { font: 'sans', size: 6, spacing: 0.8, color: PC.gold, align: 'center' }); };
  // Layout pass: measure blocks so courses never split awkwardly.
  const blocks = []; for (const c of menu.courses) { const ds = c.dishes.map(d => { const desc = d.description ? wrap(d.description, 'serifI', 10.5, CW - 70) : []; return { d, desc, h: 22 + desc.length * 14 + (d.pairing ? 13 : 0) + 8 }; }); blocks.push({ c, ds, h: 46 + ds.reduce((a, x) => a + x.h, 0) }); }
  const pages = []; let pg = null, y = 0, first = true; const bottom = H - 86;
  const newPage = () => { pg = doc.page(W, H); frame(pg); pages.push(pg); y = 74;
    if (first) { pg.text((menu.restaurantName || 'Your Restaurant').toUpperCase(), W / 2, y + 12, { font: 'sansB', size: 9, spacing: 4.2, color: PC.gold, align: 'center', maxW: CW });
      y = pg.para(menu.title, M, y + 58, CW, { font: 'serifI', size: menu.title.length > 34 ? 28 : 36, lead: 1.1, color: PC.ink, align: 'center', maxLines: 2 }) + 2;
      pg.text([menu.menuTypeLabel, ...(menu.cuisines || [])].filter(Boolean).join('  ·  ').toUpperCase(), W / 2, y, { font: 'sans', size: 7, spacing: 2, color: PC.mute, align: 'center', maxW: CW }); y += 16;
      pg.line(W / 2 - 24, y, W / 2 + 24, y, PC.gold, 0.9); pg.rect(W / 2 - 2.2, y - 2.2, 4.4, 4.4, PC.gold); y += 20;
      if (menu.intro) y = pg.para(menu.intro, M + 30, y + 4, CW - 60, { font: 'serifI', size: 11.5, lead: 1.4, color: '#4a4239', align: 'center', maxLines: 4 }) + 10;
      first = false; } else y = 84; };
  newPage();
  for (const b of blocks) {
    if (y + Math.min(b.h, 46 + b.ds[0].h) > bottom) newPage();
    y += 14; pg.text(b.c.name.toUpperCase(), W / 2, y, { font: 'sansB', size: 8.5, spacing: 3.2, color: PC.copper, align: 'center' }); y += 9; pg.line(W / 2 - 14, y, W / 2 + 14, y, PC.gold2, 0.6); y += 20;
    for (const x of b.ds) {
      if (y + x.h > bottom) { newPage(); }
      const d = x.d; const tags = d.tags.map(t => TAG[t]).join(' '); const price = d.price != null ? (Number.isInteger(d.price) ? String(d.price) : d.price.toFixed(2)) : '';
      pg.text(d.name, W / 2, y, { font: 'serifB', size: 13, color: PC.ink, align: 'center', maxW: CW - 80 });
      if (price) pg.text(price, W - M + 4, y, { font: 'serif', size: 11, color: PC.gold, align: 'right' });
      if (tags) pg.text(tags, M - 4, y, { font: 'sansB', size: 6.5, spacing: 0.8, color: PC.mute });
      y += 15; for (const l of x.desc) { pg.text(l, W / 2, y, { font: 'serifI', size: 10.5, color: '#5b5249', align: 'center' }); y += 14; }
      if (d.pairing) { pg.text(`To drink: ${d.pairing}`, W / 2, y, { font: 'sans', size: 7.5, color: PC.gold, align: 'center', maxW: CW - 60 }); y += 13; }
      y += 8;
    }
  }
  if (menu.inspiredBy && menu.inspiredBy.length) { if (y + 30 > bottom) newPage(); y += 14; pg.text(`Inspired by the style of ${menu.inspiredBy.map(t => '“' + t + '”').join(', ')} · original dishes`, W / 2, y, { font: 'serifI', size: 9, color: PC.mute, align: 'center', maxW: CW }); y += 8; }
  if (menu.chefNote) { if (y + 40 > bottom) newPage(); y += 10; pg.line(M + 120, y, W - M - 120, y, PC.rule, 0.5); y = pg.para(menu.chefNote, M + 40, y + 20, CW - 80, { font: 'serifI', size: 12, lead: 1.35, color: PC.ink, align: 'center', maxLines: 3 }); }
  pages.forEach((p, i) => footer(p, i + 1, pages.length));
  return doc.save();
}
// Restauranteur "use my restaurant in searches": a compact culinary context blended into general recipe searches.
const menuDishes = txt => String(txt || '').split('\n').filter(l => l && !/^[A-Z][\w &'-]{0,30}$/.test(l)).map(l => l.split(/ £| — /)[0].trim()).filter(Boolean);
// Linked sources: [{ id, kind: 'mine'|'benchmark', name, url, analysis, websiteMenu, useInSearch }]. Legacy single-URL profiles count as one 'mine' source.
function sourcesOf(profile) {
  if (!profile) return []; if (Array.isArray(profile.sources)) return profile.sources;
  return profile.url || profile.analysis || profile.websiteMenu ? [{ id: 'main', kind: 'mine', name: profile.name || '', url: profile.url || '', analysis: profile.analysis || null, websiteMenu: profile.websiteMenu || '', useInSearch: true }] : [];
}
function searchContext(profile) {
  if (!profile || !profile.useInSearch) return null;
  const chosen = sourcesOf(profile).filter(s => s.useInSearch !== false); const mineSrc = chosen.filter(s => s.kind === 'mine' || !s.kind); const bench = chosen.filter(s => s.kind === 'benchmark'); const books = chosen.filter(s => s.kind === 'cookbook' && s.analysis);
  const describe = s => { const a = s.analysis || {}; return [a.cuisines && a.cuisines.length && `cuisine ${a.cuisines.join(', ')}`, a.style && a.style.length && `style ${a.style.join(', ')}`, a.priceBand && a.priceBand !== 'unknown' && `price point ${a.priceBand}`].filter(Boolean); };
  const mineParts = [...mineSrc.flatMap(describe), profile.description && `concept: ${String(profile.description).slice(0, 300)}`, ...mineSrc.map(s => menuDishes(s.websiteMenu).slice(0, 10)).filter(d => d.length).map(d => `current menu includes ${d.join('; ')}`)].filter(Boolean);
  const benchParts = bench.map(s => { const d = describe(s); const dishes = menuDishes(s.websiteMenu).slice(0, 6); return (d.length || dishes.length) ? `${s.name || 'a benchmark'} (${[...d, dishes.length && `known for dishes like ${dishes.join('; ')}`].filter(Boolean).join('; ')})` : null; }).filter(Boolean);
  if (!mineParts.length && !benchParts.length && !books.length) return null;
  const text = [mineParts.length && `Restaurant context (${profile.name || 'the cook’s restaurant'}) — make the recipes suit this kitchen and fit its menu: ${mineParts.join('; ')}.`,
    benchParts.length && `Benchmarks for inspiration and contrast only (do not copy their dishes; create original ideas that compete with or differentiate from them): ${benchParts.join(' | ')}.`, books.length && `Cookbook inspiration (style only, never reproduce its recipes or text): ${books.map(b => cookbookBrief({ ...b.analysis, title: b.name || b.analysis.title })).join(' | ')}.`].filter(Boolean).join(' ').slice(0, 1400);
  const cz = [...mineSrc, ...bench].flatMap(s => (s.analysis && s.analysis.cuisines) || []);
  const names = [mineSrc.length && (profile.name || 'your restaurant'), ...bench.map(s => s.name || 'a benchmark'), ...books.map(s => `“${s.name || 'cookbook'}”`)].filter(Boolean);
  return { name: names.slice(0, 4).join(', '), sources: names, inspiredBy: books.map(s => s.name || s.analysis.title), cuisines: [...new Set(cz)].slice(0, 3), text };
}
function applySearchContext(q, ctx) {
  if (!ctx) return q; const out = { ...q, dish: [q.dish, ctx.text].filter(Boolean).join('\n').slice(0, 1900), restaurantContext: ctx.name };
  if ((!q.cuisines || !q.cuisines.length) && ctx.cuisines.length) { out.cuisines = ctx.cuisines.slice(0, 1); out.cuisine = ctx.cuisines[0]; }
  return out;
}
module.exports = { cookbookHeuristic, analyseCookbook, verbatimRisk, sourcesOf, menuDishes, searchContext, applySearchContext, checkUrl, safeFetch, readCapped, extractSite, htmlToText, parseMenuText, pdfText, heuristicAnalysis, analyse, historyItems, smartSearch, SearchOpts, MenuSpec, MENU_TYPES, DIET_TAGS, courseNames, builderMessages, offlineMenu, normaliseMenu, buildMenu, menuPdf, seasonNow, jsonFrom, MAX_BYTES };
