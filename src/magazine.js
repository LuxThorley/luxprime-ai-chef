'use strict';
// Lux Prime Kitchen Magazine — personalisation (profile, query, shopping list, pairings, letter) + PDF layout.
const { Doc, wrap, width } = require('./pdf');
const { clean } = require('./dishimage');

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SEASON = [['leeks','blood oranges','celeriac'],['forced rhubarb','cauliflower','purple sprouting broccoli'],['wild garlic','spring greens','purple sprouting broccoli'],['asparagus','new potatoes','radishes'],['asparagus','peas','broad beans'],['strawberries','courgettes','broad beans'],['tomatoes','courgettes','raspberries'],['sweetcorn','plums','runner beans'],['blackberries','squash','apples'],['squash','wild mushrooms','apples'],['pumpkin','pears','wild mushrooms'],['parsnips','brussels sprouts','clementines']];
const SEASON_LINE = ['the quiet, frosted start of the year','the last of winter, when forced rhubarb glows pink','the first green shoots of spring','asparagus season — the year’s great green fanfare','the long light of late spring','early summer and the first sweet berries','high summer, ripe and generous','the golden end of summer','the turn of the year into harvest','deep autumn, rich with mushrooms and squash','misty November, made for slow cooking','the festive season, candlelit and generous'];
const PRINCIPLES = ['Escoffier’s rule of simplicity — “faites simple” — asks us to let a few excellent ingredients speak clearly.', 'For Escoffier, a great sauce began with a sound stock: time spent on foundations repays every dish built upon them.', 'Escoffier organised his brigade so that every cook mastered one thing perfectly; at home, master one technique at a time.', 'Escoffier cooked with the seasons: the market, not the menu, should decide what reaches the table.', 'Balance and restraint were Escoffier’s signatures: season boldly, garnish lightly, and serve promptly.'];
const PANTRY = /^(salt|sea salt|flaky sea salt|table salt|pepper|black pepper|white pepper|freshly ground black pepper|ground black pepper|water|cold water|warm water|boiling water|ice|oil|olive oil|extra virgin olive oil|vegetable oil|sunflower oil|rapeseed oil|neutral oil|cooking oil|sugar|caster sugar|granulated sugar|plain flour|flour|cornflour)$/i;
const AISLES = [
  ['Fruit & vegetables', /onion|shallot|garlic|leek|carrot|celer|potato|tomato|pepper(?!corn)|courgette|aubergine|mushroom|spinach|kale|cabbage|lettuce|rocket|chard|broccoli|cauliflower|squash|pumpkin|parsnip|beet|pea\b|peas|bean(?!s? ?sprout)|asparagus|cucumber|fennel|radish|lemon|lime|orange|apple|pear|berr|plum|rhubarb|banana|grape|avocado|chilli|ginger|sprout|corn|clementine|fig|cherr|mango|lettuce|salad|spring onion|watercress|artichoke/i],
  ['Fresh herbs', /parsley|thyme|rosemary|basil|tarragon|chive|dill|coriander|mint|sage|bay|chervil|oregano|marjoram|herb/i],
  ['Meat & poultry', /chicken|beef|lamb|pork|bacon|lardon|ham|sausage|duck|veal|venison|mince|steak|chorizo|pancetta|turkey|guinea fowl|pheasant|cutlet|liver/i],
  ['Fish & seafood', /salmon|cod|haddock|fish|prawn|shrimp|mussel|clam|scallop|crab|lobster|tuna|trout|mackerel|sea bass|bream|anchov|sole|plaice|squid|monkfish|hake/i],
  ['Dairy & eggs', /butter|cream|milk|cheese|parmesan|gruy|cheddar|egg|yoghurt|yogurt|crème|creme|mascarpone|ricotta|mozzarella|feta|goat/i],
  ['Bakery', /bread|brioche|baguette|sourdough|pastry|tortilla|pitta|naan|croissant|breadcrumb|panko/i],
  ['Wine & drinks', /wine|brandy|cognac|madeira|port\b|sherry|vermouth|beer|cider|calvados|kirsch|rum/i],
  ['Spices & seasonings', /cumin|paprika|cinnamon|nutmeg|clove|cardamom|turmeric|saffron|vanilla|peppercorn|mustard seed|chilli flakes|spice|star anise|allspice|cayenne|garam/i],
  ['Tins, jars & sauces', /tin|tinned|canned|passata|stock|broth|mustard|vinegar|honey|soy|miso|paste|jam|capers|olive|anchovy|sauce|syrup|tahini|coconut milk/i],
  ['Pantry & dry goods', /rice|pasta|spaghetti|noodle|flour|sugar|oats|lentil|chickpea|bean|almond|walnut|hazelnut|pistachio|nut|seed|polenta|couscous|quinoa|chocolate|cocoa|gelatin|yeast|baking|dried/i]];
const aisleOf = n => (AISLES.find(([, re]) => re.test(n)) || ['Other'])[0];
const cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const mode = arr => { const m = new Map(); for (const v of arr) if (v != null && v !== '') m.set(v, (m.get(v) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1])[0]?.[0]; };

// ---- Profile from search history + favourites (+ saved options) ----
function buildProfile({ history = [], favourites = [], user = {} }, now = new Date()) {
  const freq = new Map(); const bump = (n, w = 1) => { const k = clean(n); if (k && !PANTRY.test(k) && k.length < 40) freq.set(k, (freq.get(k) || 0) + w); };
  const qs = history.map(h => { try { return typeof h.query_json === 'string' ? JSON.parse(h.query_json) : (h.query || h); } catch { return {}; } });
  qs.forEach(q => (q.include || []).forEach(i => bump(i, 2)));
  const favs = favourites.map(f => { try { return typeof f.recipe_json === 'string' ? JSON.parse(f.recipe_json) : f; } catch { return {}; } });
  favs.forEach(r => (r.ingredients || []).forEach(i => bump(i.name || i.display, 1)));
  const top = [...freq].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  const dietCount = new Map(); qs.forEach(q => (q.diets || []).forEach(d => dietCount.set(d, (dietCount.get(d) || 0) + 1)));
  const diets = [...dietCount].filter(([, n]) => n >= Math.max(1, qs.length / 2)).map(([d]) => d);
  const excludeAllergens = [...new Set(qs.flatMap(q => q.excludeAllergens || []))];
  const exclude = [...new Set(qs.flatMap(q => q.exclude || []))].slice(0, 12);
  const mins = qs.map(q => +q.maxMinutes).filter(Boolean).sort((a, b) => a - b);
  const m = now.getUTCMonth();
  const synthetic = qs.length + favs.length < 2;
  return {
    name: user.name || cap(String(user.email || 'Chef').split('@')[0].replace(/[^a-z]/gi, ' ').trim().split(' ')[0]) || 'Chef',
    searches: qs.length, favourites: favs.length, favTitles: favs.map(r => r.title).filter(Boolean).slice(0, 3), top: top.slice(0, 12), diets, excludeAllergens, exclude,
    difficulty: mode(qs.map(q => q.difficulty).filter(d => d && d !== 'any')) || 'medium', maxMinutes: mins.length ? Math.max(30, mins[Math.floor(mins.length / 2)]) : 60,
    cuisine: mode(qs.map(q => q.cuisine).filter(c => c && c !== 'any')) || 'any', servings: +mode(qs.map(q => q.servings)) || 2, kidsMode: qs.length > 0 && qs.filter(q => q.kidsMode).length > qs.length / 2,
    month: MONTHS[m], monthIndex: m, year: now.getUTCFullYear(), season: SEASON[m], seasonLine: SEASON_LINE[m], synthetic
  };
}

// Malcolm query: two of their most-used ingredients (rotated monthly) + one seasonal hero; their diet, skill, time, cuisine.
function buildQuery(p) {
  const tops = p.top.map(t => t.name); const k = p.monthIndex % Math.max(1, Math.min(4, tops.length));
  const picks = tops.length ? [tops[k % tops.length], tops[(k + 1) % tops.length]].filter((v, i, a) => v && a.indexOf(v) === i) : [];
  const include = [...new Set([...picks, p.season[0]])].slice(0, 3);
  return { include, exclude: p.exclude, maxMinutes: p.maxMinutes, difficulty: p.difficulty, servings: p.servings, diets: p.diets, excludeAllergens: p.excludeAllergens, cuisine: p.cuisine, kidsMode: p.kidsMode, limit: 3,
    dish: `Lux Prime Kitchen Magazine, ${p.month} issue: three distinct dishes for this cook — a light starter or small plate, a main course, and a dessert or seasonal showpiece. Seasonal for ${p.month} in the UK, special but achievable.` };
}

// ---- Shopping list ----
function shoppingList(recipes, profile) {
  const regular = new Set(profile.top.map(t => t.name)); const items = new Map(); const assumed = new Set();
  recipes.forEach((r, ri) => (r.ingredients || []).forEach(i => {
    const n0 = clean(i.name || i.display); if (!n0) return; const n = [...items.keys()].find(k => k.replace(/s$/, '') === n0.replace(/s$/, '')) || n0;
    if (PANTRY.test(n)) { assumed.add(n); return; }
    const it = items.get(n) || { name: n, qty: [], recipes: new Set(), aisle: aisleOf(n), regular: [...regular].some(g => n.includes(g) || g.includes(n)) };
    const q = i.qty != null && i.qty !== '' ? `${i.qty}${i.unit && i.unit !== 'x' ? (/^[a-z]{1,3}$/.test(i.unit) ? '' : ' ') + i.unit : ''}` : '';
    if (q) it.qty.push(q); it.recipes.add(ri + 1); items.set(n, it);
  }));
  const groups = new Map();
  for (const it of [...items.values()].sort((a, b) => (b.regular - a.regular) || a.name.localeCompare(b.name))) { if (!groups.has(it.aisle)) groups.set(it.aisle, []); groups.get(it.aisle).push({ ...it, recipes: [...it.recipes] }); }
  const order = [...AISLES.map(a => a[0]), 'Other'];
  const aisles = [...groups].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([aisle, list]) => ({ aisle, items: list }));
  const onList = new Set(items.keys());
  const maybeOut = profile.top.filter(t => t.n >= 2 && ![...onList].some(k => k.includes(t.name) || t.name.includes(k.replace(/s$/, '')))).slice(0, 5).map(t => ({ name: t.name, why: `You cook with ${t.name} often` }));
  return { aisles, assumed: [...assumed].slice(0, 8), maybeOut };
}

// ---- Pairings & accompaniments (styles, grapes, regions; never brands or prices) ----
const WINES = [
  [/chocolate|cocoa|brownie|truffle/i, 'Banyuls or a tawny Port-style fortified red (Roussillon / Douro)'],
  [/tart|cake|pudding|dessert|crème|creme|soufflé|souffle|poached pear|apple|berr|rhubarb|clafoutis|mousse|sorbet|pastry/i, 'Sweet Loire Chenin Blanc (Coteaux du Layon) or a late-harvest Riesling'],
  [/beef|steak|venison|bourguignon|braised.*red wine|ox/i, 'Full-bodied red: Northern Rhône Syrah or a Rioja Reserva (Tempranillo)'],
  [/lamb|mutton/i, 'Bordeaux-style Cabernet–Merlot blend, or Rioja Crianza'],
  [/duck|game|pheasant|guinea/i, 'Red Burgundy (Pinot Noir) or a Northern Rhône Syrah'],
  [/\bpork|sausage|\bham\b|bacon/i, 'Dry Alsace Riesling or a light Pinot Noir'],
  [/salmon|trout/i, 'White Burgundy (Chardonnay) or a chilled Loire Pinot Noir'],
  [/cod|haddock|sole|plaice|bass|bream|hake|monkfish|fish/i, 'Crisp Sauvignon Blanc (Sancerre-style) or Albariño (Rías Baixas)'],
  [/prawn|scallop|crab|lobster|mussel|seafood|clam/i, 'Muscadet sur lie (Loire) or Chablis (Chardonnay)'],
  [/curry|spic|chilli|thai|harissa/i, 'Off-dry Riesling (Mosel) or Gewurztraminer (Alsace)'],
  [/mushroom|truffle|risotto/i, 'Red Burgundy (Pinot Noir) or a mature white Rioja'],
  [/chicken|poultry|velouté|veloute|suprême|supreme|cream/i, 'Oaked Chardonnay (Burgundy, Mâconnais) or a dry Chenin Blanc'],
  [/tomato|pasta|pizza|ragù|ragu/i, 'Sangiovese (Chianti Classico) or Barbera d’Asti'],
  [/./, 'Dry Grüner Veltliner (Austria) or a Côtes du Rhône red']];
const SIDES = [[/dessert|tart|cake|crème|creme|soufflé|souffle|pear|apple|berr|rhubarb|chocolate|mousse/i, 'A spoon of crème fraîche and a small strong coffee'], [/fish|salmon|cod|seafood|prawn|scallop|sole|bass/i, 'Buttered new potatoes and a lemony green salad'], [/beef|lamb|venison|braise|stew/i, 'Pommes purée and buttered seasonal greens'], [/chicken|pork|duck/i, 'Crisp roast potatoes and a bitter-leaf salad'], [/soup|velouté|veloute/i, 'Warm crusty bread and cultured butter'], [/./, 'Crusty bread and a simple dressed green salad']];
const ZERO = [[/dessert|tart|cake|chocolate|pear|apple|berr|rhubarb/i, 'Chilled spiced apple juice'], [/fish|seafood|salmon|chicken|cream/i, 'Sparkling water with cucumber and mint'], [/./, 'Sparkling elderflower or a dry alcohol-free red']];
const pick = (t, table) => table.find(([re]) => re.test(t))[1];
function pairing(r) {
  const t = [r.title, r.tagline, ...(r.ingredients || []).map(i => i.name)].join(' ');
  const malcolm = r.pairing && !/£|\$|€/.test(r.pairing) ? String(r.pairing).trim() : null;
  return { wine: malcolm || pick(t, WINES), alt: malcolm ? pick(t, WINES) : null, side: pick(t, SIDES), zero: pick(t, ZERO) };
}
function whyForYou(r, p) {
  const ings = (r.ingredients || []).map(i => clean(i.name)); const hit = p.top.map(t => t.name).filter(n => ings.some(i => i.includes(n) || n.includes(i))).slice(0, 2);
  if (p.synthetic) return `A ${p.month} dish chosen to introduce you to the magazine — your next issues learn from every search.`;
  const bits = []; if (hit.length) bits.push(`you often cook with ${hit.join(' and ')}`); if (p.diets.length) bits.push(`it is ${p.diets.join(', ')}`);
  if (r.totalMinutes && r.totalMinutes <= p.maxMinutes) bits.push(`it fits your usual ${p.maxMinutes}-minute window`);
  return bits.length ? cap(`Chosen because ${bits.join(', ')}.`).replace(/^Chosen/, 'Chosen') : `A seasonal ${p.month} dish matched to your ${p.difficulty} skill level.`;
}
function letter(p, recipes, blessing) {
  const titles = recipes.map(r => r.title); const tops = p.top.slice(0, 3).map(t => t.name);
  const paras = [`Dear ${p.name},`,
    `Welcome to your ${p.month} issue. We are in ${p.seasonLine}, and I have composed this month’s menu with you in mind.`,
    p.synthetic ? `Your kitchen story is only beginning, so this first issue leans on the season. Every search you make and every recipe you save teaches me more, and next month’s issue will be shaped around you.`
      : `I have been quietly studying your kitchen — ${p.searches} search${p.searches === 1 ? '' : 'es'}${p.favourites ? ` and ${p.favourites} saved favourite${p.favourites === 1 ? '' : 's'}` : ''} — and I notice your hands return again and again to ${tops.length > 1 ? tops.slice(0, -1).join(', ') + ' and ' + tops.slice(-1) : tops[0] || 'good, honest ingredients'}${p.diets.length ? `, always ${p.diets.join(' and ')}` : ''}. So here they are, dressed for the season.`,
    `This month: ${titles.length > 1 ? titles.slice(0, -1).join(', ') + ' and ' + titles.slice(-1) : titles[0]}. Your shopping list is overleaf, grouped by aisle, with a few gentle reminders of things you may be running low on.`,
    blessing ? String(blessing).trim() : 'May your pans be hot, your knives sharp and your table full.',
    'Cook with joy, taste as you go, and let the season lead.'];
  return paras;
}

// ---- PDF layout ----
const C = { ink: '#16171b', ink2: '#24262c', cream: '#f6f1e7', paper: '#fbf8f2', gold: '#c9a35a', gold2: '#e6c891', copper: '#a8683e', text: '#25211c', mute: '#7a7065', rule: '#d9cdb8', ivory: '#f5efe4' };
const PW = 595.28, PH = 841.89, M = 48;
function render(data, imgs, fontFiles) {
  const { profile: p, recipes, shop, escoffierNote, issueNo, manageUrl } = data;
  const doc = new Doc({ title: `Lux Prime Kitchen Magazine — ${p.month} ${p.year} — for ${p.name}`, fontFiles });
  const hero = imgs.hero ? doc.addJpeg(imgs.hero) : null; const dish = recipes.map((_, i) => imgs.dishes[i] ? doc.addJpeg(imgs.dishes[i]) : hero);
  const folio = (pg, n, dark) => { pg.line(M, PH - 40, PW - M, PH - 40, dark ? '#3a3a3a' : C.rule, 0.5); pg.text('LUX PRIME KITCHEN MAGAZINE', M, PH - 27, { font: 'sansB', size: 6.5, spacing: 1.6, color: dark ? C.gold : C.mute }); pg.text(`${p.month.toUpperCase()} ${p.year}  ·  ${n}`, PW - M, PH - 27, { font: 'sans', size: 6.5, spacing: 1.2, color: dark ? C.gold : C.mute, align: 'right' }); };
  const label = (pg, s, x, y, color = C.copper) => pg.text(s.toUpperCase(), x, y, { font: 'sansB', size: 7, spacing: 1.8, color });

  // 1. Cover
  let pg = doc.page(); pg.rect(0, 0, PW, PH, C.ink);
  if (hero) pg.image(hero, 0, 0, PW, PH);
  pg.rect(0, 0, PW, 200, C.ink, { alpha: 0.8 }); pg.line(0, 200, PW, 200, C.gold, 0.8, 0.9);
  pg.rect(0, PH - 330, PW, 330, C.ink, { alpha: 0.86 }); pg.line(0, PH - 330, PW, PH - 330, C.gold, 0.8, 0.9);
  pg.text('LUX PRIME KITCHEN', PW / 2, 58, { font: 'sansB', size: 10, spacing: 6, color: C.gold2, align: 'center' });
  pg.line(PW / 2 - 140, 72, PW / 2 + 140, 72, C.gold, 0.6);
  pg.text('Magazine', PW / 2, 138, { font: 'serifI', size: 74, color: C.ivory, align: 'center' });
  pg.text(`${p.month.toUpperCase()} ${p.year}   ·   ISSUE ${String(issueNo).toUpperCase()}`, PW / 2, 170, { font: 'sans', size: 8, spacing: 3, color: C.gold2, align: 'center' });
  pg.text(`Prepared for ${p.name}`, M, PH - 286, { font: 'serifI', size: 24, color: C.gold2 });
  pg.line(M, PH - 271, M + 60, PH - 271, C.gold, 1);
  let y = PH - 236;
  recipes.forEach((r, i) => { pg.text(String(i + 1).padStart(2, '0'), M, y, { font: 'sansB', size: 9, spacing: 1.5, color: C.gold }); y = pg.para(r.title, M + 28, y, PW - 2 * M - 40, { font: 'serif', size: 19, lead: 1.12, color: C.ivory, maxLines: 2 }) + 10; });
  pg.text('Three personal recipes  ·  Your shopping list  ·  Wines to match  ·  A note from Escoffier', M, PH - 52, { font: 'sans', size: 7.5, spacing: 0.6, color: C.gold2 });
  pg.text('Composed for you by Malcolm AI, grounded in Escoffier’s Le Guide Culinaire (1907)', M, PH - 38, { font: 'sans', size: 6.5, color: '#9c9184' });

  // 2. Letter + contents
  pg = doc.page(); pg.rect(0, 0, PW, PH, C.cream);
  label(pg, 'A letter from the chef', M, 70); pg.text('From Malcolm’s kitchen', M, 108, { font: 'serif', size: 34, color: C.ink });
  pg.line(M, 124, M + 50, 124, C.gold, 1);
  const LW = 300; y = 158;
  const paras = letter(p, recipes, data.blessing);
  paras.forEach((t, i) => { y = pg.para(t, M, y, LW, { font: i === 0 ? 'serifI' : 'serif', size: i === 0 ? 15 : 12, lead: 1.42, color: C.text }) + 8; });
  y += 4; pg.text('Malcolm', M, y + 14, { font: 'serifI', size: 26, color: C.copper }); pg.text('EXECUTIVE AI CHEF, LUX PRIME KITCHEN', M, y + 32, { font: 'sansB', size: 6.5, spacing: 1.4, color: C.mute });
  const RX = M + LW + 34, RW = PW - RX - M; label(pg, 'In this issue', RX, 160);
  let ry = 182; recipes.forEach((r, i) => { pg.image(dish[i], RX, ry, RW, 82); pg.text(`${String(i + 1).padStart(2, '0')}  ·  PAGE ${i + 3}`, RX, ry + 98, { font: 'sansB', size: 6.5, spacing: 1.2, color: C.copper }); ry = pg.para(r.title, RX, ry + 114, RW, { font: 'serif', size: 12.5, lead: 1.15, color: C.ink, maxLines: 3 }) + 12; });
  [['Your shopping list', 6], ['Wines & accompaniments', 7], ['The Escoffier note', 7]].forEach(([t, n]) => { pg.line(RX, ry - 4, RX + RW, ry - 4, C.rule, 0.5); pg.text(t, RX, ry + 10, { font: 'serif', size: 12, color: C.ink }); pg.text(String(n), RX + RW, ry + 10, { font: 'sans', size: 8, color: C.mute, align: 'right' }); ry += 24; });
  folio(pg, 2);

  // 3-5. Recipes
  recipes.forEach((r, i) => {
    pg = doc.page(); pg.rect(0, 0, PW, PH, C.paper); const IH = 300;
    pg.image(dish[i], 0, 0, PW, IH); pg.rect(0, IH - 64, 120, 64, C.ink, { alpha: 0.55 });
    pg.text(String(i + 1).padStart(2, '0'), M, IH - 22, { font: 'serifI', size: 54, color: C.ivory });
    pg.text('AI-GENERATED ILLUSTRATION', PW - M, IH - 14, { font: 'sans', size: 5.5, spacing: 1, color: '#e9e2d6', align: 'right', alpha: 0.8 });
    let y = IH + 42; y = pg.para(r.title, M, y, PW - 2 * M, { font: 'serifB', size: 26, lead: 1.08, color: C.ink, maxLines: 2 });
    if (r.tagline) y = pg.para(r.tagline, M, y + 2, PW - 2 * M, { font: 'serifI', size: 13.5, lead: 1.25, color: C.copper, maxLines: 2 });
    const chips = [r.totalMinutes && `${r.totalMinutes} MIN`, r.difficulty && String(r.difficulty).toUpperCase(), r.servings && `SERVES ${r.servings}`, r.cuisine && String(r.cuisine).toUpperCase()].filter(Boolean).join('   ·   ');
    pg.text(chips, M, y + 6, { font: 'sansB', size: 7, spacing: 1.2, color: C.mute }); y += 16;
    y = pg.para(whyForYou(r, p), M, y + 8, PW - 2 * M, { font: 'sans', size: 8, lead: 1.4, color: C.copper, maxLines: 2 }) + 2;
    pg.line(M, y, PW - M, y, C.rule, 0.6); y += 20;
    const bottomH = 118, colTop = y, colBottom = PH - 52 - bottomH; const IW = 158, SX = M + IW + 24, SW = PW - SX - M;
    const ings = (r.ingredients || []).map(x => x.display || x.name); const steps = (r.steps || []).map(s => s.text || s);
    let fs = 10.5; const fits = s => { let h = 0; steps.forEach(t => h += wrap(t, 'serif', s, SW - 18).length * s * 1.32 + 5); let h2 = 0; ings.forEach(t => h2 += wrap(t, 'sans', s * 0.82, IW - 10).length * s * 0.82 * 1.38 + 3); return Math.max(h, h2) + 20 <= colBottom - colTop; };
    while (fs > 7.4 && !fits(fs)) fs -= 0.3;
    label(pg, 'Ingredients', M, colTop); label(pg, 'Method', SX, colTop);
    let iy = colTop + 18; for (const t of ings) { if (iy > colBottom) break; pg.rect(M, iy - fs * 0.82 * 0.36, 2.4, 2.4, C.gold); iy = pg.para(t, M + 9, iy, IW - 10, { font: 'sans', size: fs * 0.82, lead: 1.38, color: C.text }) + 3; }
    let sy = colTop + 18; steps.forEach((t, n) => { if (sy > colBottom) return; pg.text(String(n + 1), SX, sy, { font: 'serifB', size: fs, color: C.gold }); sy = pg.para(t, SX + 18, sy, SW - 18, { font: 'serif', size: fs, lead: 1.32, color: C.text }) + 5; });
    const by = PH - 62 - bottomH + 8; pg.rect(M, by, PW - 2 * M, bottomH - 14, C.cream); pg.rect(M, by, 3, bottomH - 14, C.gold);
    const pr = r._pairing; const BW = (PW - 2 * M - 40) / 3; const bx = [M + 16, M + 16 + BW + 12, M + 16 + 2 * (BW + 12)];
    label(pg, 'Chef’s secret', bx[0], by + 20); pg.para(r.chefSecret || (r.tips && r.tips[0]) || 'Taste and season at every stage — that is the whole secret.', bx[0], by + 36, BW - 6, { font: 'serifI', size: 9.5, lead: 1.3, color: C.text, maxLines: 6 });
    label(pg, 'To drink', bx[1], by + 20); let wy = pg.para(pr.wine, bx[1], by + 36, BW - 6, { font: 'serif', size: 9.5, lead: 1.3, color: C.text, maxLines: 4 }); pg.para(`Alcohol-free: ${pr.zero}`, bx[1], wy + 2, BW - 6, { font: 'sans', size: 7, lead: 1.35, color: C.mute, maxLines: 2 });
    label(pg, 'Alongside', bx[2], by + 20); pg.para(pr.side, bx[2], by + 36, BW - 6, { font: 'serif', size: 9.5, lead: 1.3, color: C.text, maxLines: 4 });
    if (r.escoffier) pg.text(`Inspired by Escoffier, Le Guide Culinaire (1907), No. ${r.escoffier.no}: ${r.escoffier.title}`, M, PH - 50, { font: 'sans', size: 6.5, color: C.mute, maxW: PW - 2 * M });
    folio(pg, i + 3);
  });

  // 6. Shopping list
  pg = doc.page(); pg.rect(0, 0, PW, PH, C.cream);
  label(pg, 'For the market', M, 70); pg.text('Your shopping list', M, 108, { font: 'serif', size: 34, color: C.ink }); pg.line(M, 124, M + 50, 124, C.gold, 1);
  pg.para(`Everything for all three recipes, grouped by aisle. Your regulars come first in each aisle, marked with a gold bar. Numbers show which recipe needs it.`, M, 146, PW - 2 * M, { font: 'serifI', size: 11.5, lead: 1.35, color: C.text });
  const colW = (PW - 2 * M - 28) / 2; const yMax = PH - 214; const total = shop.aisles.reduce((t, a) => t + 24 + a.items.length * 14.5, 0);
  let col = 0, sy2 = 190, acc = 0;
  for (const a of shop.aisles) {
    const h = 24 + a.items.length * 14.5;
    if (col === 0 && acc > 0 && (acc + h / 2 > total / 2 || sy2 + h > yMax)) { col = 1; sy2 = 190; }
    acc += h; const x = M + col * (colW + 28); label(pg, a.aisle, x, sy2, C.copper); pg.line(x, sy2 + 5, x + colW, sy2 + 5, C.rule, 0.4); sy2 += 19;
    for (const it of a.items) {
      if (sy2 > yMax) break;
      if (it.regular) pg.rect(x - 8, sy2 - 7, 2.5, 9, C.gold);
      pg.rect(x, sy2 - 7, 7, 7, null, { stroke: C.mute, lw: 0.5 });
      pg.text(cap(it.name), x + 13, sy2, { font: it.regular ? 'sansB' : 'sans', size: 8.5, color: C.text, maxW: colW - 80 });
      pg.text(`${it.qty.slice(0, 2).join(' + ')}${it.qty.length ? '   ' : ''}${it.recipes.map(n => '0' + n).join(' ')}`, x + colW, sy2, { font: 'sans', size: 7, color: C.mute, align: 'right' });
      sy2 += 14.5;
    }
    sy2 += 9;
  }
  const bY = PH - 196; pg.rect(M, bY, PW - 2 * M, 136, C.ink);
  label(pg, 'You may be running low on', M + 20, bY + 26, C.gold2);
  const mo = shop.maybeOut.length ? shop.maybeOut.map(m => `${cap(m.name)} — ${m.why.toLowerCase()}; worth a quick look.`) : ['Nothing stands out yet — as your history grows, Malcolm will suggest staples you may need to top up.'];
  let my = bY + 44; mo.slice(0, 4).forEach(t => { my = pg.para(t, M + 20, my, (PW - 2 * M) * 0.56, { font: 'serif', size: 10.5, lead: 1.3, color: C.ivory, maxLines: 2 }) + 2; });
  const ax = M + (PW - 2 * M) * 0.62; label(pg, 'Assumed in your cupboard', ax, bY + 26, C.gold2);
  pg.para(shop.assumed.length ? shop.assumed.map(cap).join(', ') + '.' : 'Salt, pepper and oil.', ax, bY + 44, PW - M - ax - 16, { font: 'serifI', size: 10.5, lead: 1.3, color: C.ivory, maxLines: 4 });
  pg.para('Suggestions only — we can’t see your cupboards.', ax, bY + 112, PW - M - ax - 16, { font: 'sans', size: 6.5, lead: 1.3, color: '#9c9184' });
  folio(pg, 6);

  // 7. Wines + Escoffier note (dark)
  pg = doc.page(); pg.rect(0, 0, PW, PH, C.ink);
  label(pg, 'To the table', M, 70, C.gold); pg.text('Wines & accompaniments', M, 108, { font: 'serif', size: 32, color: C.ivory }); pg.line(M, 124, M + 50, 124, C.gold, 1);
  y = 152; recipes.forEach((r, i) => {
    pg.image(dish[i], M, y, 92, 92); const x = M + 110, w = PW - M - x; const pr = r._pairing;
    pg.text(r.title, x, y + 12, { font: 'serif', size: 14, color: C.gold2, maxW: w });
    let yy = pg.para(`Wine: ${pr.wine}`, x, y + 30, w, { font: 'serif', size: 10.5, lead: 1.3, color: C.ivory, maxLines: 3 });
    if (pr.alt) yy = pg.para(`Or: ${pr.alt}`, x, yy, w, { font: 'serif', size: 9.5, lead: 1.3, color: '#cfc6b8', maxLines: 2 });
    pg.para(`Alongside: ${pr.side}.  Alcohol-free: ${pr.zero}.`, x, yy + 2, w, { font: 'sans', size: 7.5, lead: 1.35, color: '#a99f90', maxLines: 2 });
    y += 110;
  });
  y += 8; pg.line(M, y, PW - M, y, '#3a3a3a', 0.5); y += 34;
  label(pg, 'The Escoffier note', M, y, C.gold); y += 20;
  if (escoffierNote.quote) { pg.text('“', M - 6, y + 26, { font: 'serif', size: 60, color: C.gold, alpha: 0.6 }); y = pg.para(escoffierNote.quote, M + 26, y + 6, PW - 2 * M - 40, { font: 'serifI', size: 12, lead: 1.4, color: C.ivory, maxLines: 7 }); pg.text(escoffierNote.source, M + 26, y + 4, { font: 'sans', size: 7, spacing: 0.6, color: C.gold2, maxW: PW - 2 * M - 40 }); y += 22; }
  y = pg.para(escoffierNote.note, M + 26, y + 4, PW - 2 * M - 40, { font: 'serif', size: 10.5, lead: 1.4, color: '#d8cfc1', maxLines: 5 });
  const fy = PH - 118; pg.line(M, fy, PW - M, fy, '#3a3a3a', 0.5);
  pg.para('Photographs are AI-generated illustrations. Nutrition is estimated. Allergen tags are guidance only — always check product labels, and adapt to your own dietary needs. Wine suggestions are styles, not endorsements; please drink responsibly (18+).', M, fy + 18, PW - 2 * M, { font: 'sans', size: 6.8, lead: 1.4, color: '#8f8578' });
  pg.para(`You receive this because you opted in to Lux Prime Kitchen Magazine. Manage, pause or cancel any time: ${manageUrl}`, M, fy + 48, PW - 2 * M, { font: 'sans', size: 6.8, lead: 1.4, color: '#8f8578' });
  folio(pg, 7, true);
  return doc.save();
}

function escoffierNote(recipes, entry, p) {
  const principle = PRINCIPLES[p.monthIndex % PRINCIPLES.length];
  if (entry) {
    const r = recipes.find(x => x.escoffier && x.escoffier.no === entry.no);
    const q = String(entry.text || '').replace(/\s+/g, ' ').trim(); const cut = q.length > 380 ? q.slice(0, 380).replace(/\s+\S*$/, '') + ' …' : q;
    return { quote: cut, source: `AUGUSTE ESCOFFIER, LE GUIDE CULINAIRE (1907), No. ${entry.no} — ${String(entry.title || '').toUpperCase()}`, note: `${r ? `Our ${r.title} takes its cue from this classic, adapted for a modern home kitchen. ` : ''}${principle}` };
  }
  return { quote: null, source: '', note: principle };
}
module.exports = { buildProfile, buildQuery, shoppingList, pairing, whyForYou, letter, render, escoffierNote, aisleOf, MONTHS };
