'use strict';
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const R = require('../src/restaurant'); const plans = require('../src/plans');
const fonts = () => Object.fromEntries(['serif', 'serifI', 'serifB', 'sans', 'sansB'].map(k => [k, new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'public', 'mag', k + '.bin')))]));
test('SSRF guard: only public http(s) hostnames on standard ports', () => {
  for (const bad of ['file:///etc/passwd', 'http://localhost/', 'http://127.0.0.1/', 'http://10.0.0.1', 'http://[::1]/', 'http://169.254.169.254/latest', 'http://0x7f000001/', 'http://intranet/', 'https://a.internal/', 'http://u:p@site.co.uk/', 'http://site.co.uk:8080/', 'gopher://x.com', 'https://aichef.food/'])
    assert.equal(R.checkUrl(bad).ok, false, bad);
  assert.equal(R.checkUrl('thelantern.co.uk').url, 'https://thelantern.co.uk/'); assert.ok(R.checkUrl('https://www.example-restaurant.com/menu#x').ok);
});
test('safeFetch re-checks redirects, enforces content type and size cap', async () => {
  const mk = (status, headers, body) => new Response(body, { status, headers });
  await assert.rejects(R.safeFetch('https://good.co.uk', async () => mk(302, { location: 'http://127.0.0.1/admin' }, '')), /IP address/);
  await assert.rejects(R.safeFetch('https://good.co.uk', async () => mk(200, { 'content-type': 'application/zip' }, 'x')), /isn’t a web page/);
  const big = 'a'.repeat(R.MAX_BYTES + 5000); const r = await R.safeFetch('https://good.co.uk', async () => mk(200, { 'content-type': 'text/html' }, big)); assert.equal(r.html.length, R.MAX_BYTES);
});
const HTML = `<html><head><title>The Lantern | Seasonal Bistro, Bath</title><meta name="description" content="A neighbourhood bistro cooking seasonal, locally sourced food."><script type="application/ld+json">{"@type":"Restaurant","name":"The Lantern","servesCuisine":["French","British"],"priceRange":"££"}</script></head><body><h1>The Lantern</h1><a href="/menus/dinner">Dinner menu</a><a href="https://other.com/menu">x</a>
<h2>Starters</h2><p>Chicken liver parfait, brioche £9</p><p>Heritage beetroot, goat's curd £8.50</p><h2>Mains</h2><p>Confit duck leg, lentils £21</p><p>Roast cod, mussels, saffron £23</p><script>var x="£99"</script></body></html>`;
test('site extraction + menu parsing + heuristic analysis', () => {
  const s = R.extractSite(HTML, 'https://thelantern.co.uk/'); assert.equal(s.siteName, 'The Lantern'); assert.deepEqual(s.cuisines, ['French', 'British']);
  assert.deepEqual(s.menuLinks, ['https://thelantern.co.uk/menus/dinner']); assert.doesNotMatch(s.text, /var x/);
  const p = R.parseMenuText(s.text); assert.equal(p.dishCount, 4); assert.deepEqual(p.sections.map(x => x.name), ['Starters', 'Mains']); assert.equal(p.sections[0].dishes[1].price, '8.50');
  const a = R.heuristicAnalysis(s, p); assert.ok(a.cuisines.includes('French')); assert.ok(a.ideas.length >= 3); assert.ok(a.gaps.some(g => /dessert/i.test(g)));
});
test('analyse uses Malcolm JSON when valid, heuristic otherwise', async () => {
  const s = R.extractSite(HTML, 'https://thelantern.co.uk/'); const p = R.parseMenuText(s.text);
  const a = await R.analyse(s, p, { llm: async () => '```json {"summary":"A smart bistro.","cuisines":["French"],"style":["bistro"],"priceBand":"££","strengths":["a"],"gaps":["b"],"ideas":["c","d"]}```' });
  assert.equal(a.source, 'malcolm'); assert.equal(a.summary, 'A smart bistro.');
  assert.equal((await R.analyse(s, p, { llm: async () => 'nope' })).source, 'heuristic');
});
test('PDF text extraction (Flate stream)', async () => {
  const content = 'BT /F1 12 Tf 72 700 Td (STARTERS) Tj T* (Soup of the day \\243 7) Tj ET';
  const z = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const pdf = Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${z.length} /Filter /FlateDecode >> stream\n`), z, Buffer.from('\nendstream endobj\n%%EOF')]);
  const t = await R.pdfText(new Uint8Array(pdf), async b => new Uint8Array(zlib.inflateSync(Buffer.from(b))));
  assert.match(t, /STARTERS/); assert.match(t, /Soup of the day £ ?7/); assert.equal(R.parseMenuText(t).dishCount, 1);
});
test('smart search: history first, filters, variety', () => {
  const items = R.historyItems({ favourites: [{ recipe_json: JSON.stringify({ title: 'Lamb Rump, Peas & Mint', cuisine: 'British', ingredients: [{ name: 'lamb' }, { name: 'peas' }], diets: ['gluten-free'] }) }], history: [{ query_json: JSON.stringify({ include: ['squash'], cuisines: ['Italian'] }), titles: 'Squash Risotto · Lamb Rump, Peas & Mint' }] });
  assert.equal(items.length, 2); const r = R.smartSearch(items, { q: 'lamb' }); assert.equal(r[0].title, 'Lamb Rump, Peas & Mint'); assert.equal(r[0].source, 'favourite');
  const autumn = R.smartSearch(items, { season: 'autumn', library: false }); assert.ok(autumn.find(x => x.title === 'Squash Risotto').why.some(w => /season/.test(w)));
  assert.deepEqual(R.smartSearch(items, { diet: 'gluten-free', library: false }).map(x => x.title), ['Lamb Rump, Peas & Mint']);
  assert.throws(() => R.smartSearch(items, { sort: 'evil' }));
});
test('Menu Builder: spec validation, offline menu honours courses/dishes/diets/pins, Malcolm output normalised & toxic plants dropped', async () => {
  assert.equal(R.MenuSpec.safeParse({ courses: 20 }).success, false); assert.equal(R.MenuSpec.safeParse({ menuType: 'buffet-of-doom' }).success, false);
  const spec = R.MenuSpec.parse({ restaurantName: 'The Lantern', menuType: 'a-la-carte', courses: 3, dishesPerCourse: 3, pinned: ['Squash Risotto'], refine: { diets: ['vegan'] } });
  const m = R.offlineMenu(spec, { priceBand: '££' }); assert.deepEqual(m.courses.map(c => c.name), ['Starters', 'Mains', 'Desserts']); assert.ok(m.courses.every(c => c.dishes.length === 3));
  assert.ok(m.courses[0].dishes[0].fromHistory); assert.ok(m.courses.slice(1).every(c => c.dishes[0].tags.includes('vegan'))); assert.ok(m.courses.flatMap(c => c.dishes).every(d => d.price > 0));
  const t = R.offlineMenu(R.MenuSpec.parse({ menuType: 'tasting', courses: 7, dishesPerCourse: 1 }), {}); assert.equal(t.courses.length, 7); assert.match(t.chefNote, /per person/);
  const bad = JSON.stringify({ title: 'Spring', courses: [{ name: 'Starters', dishes: [{ name: 'Hemlock soup', description: 'x' }, { name: 'Pea velouté', description: 'mint', tags: ['vegan', 'evil'], price: '9', pairing: 'Muscadet £30' }] }] });
  const out = await R.buildMenu(spec, {}, { llm: async () => bad }); assert.equal(out.source, 'malcolm'); assert.deepEqual(out.courses[0].dishes.map(d => d.name), ['Pea velouté']);
  assert.deepEqual(out.courses[0].dishes[0].tags, ['vegan']); assert.equal(out.courses[0].dishes[0].price, 9); assert.doesNotMatch(out.courses[0].dishes[0].pairing, /£/);
  assert.equal((await R.buildMenu(spec, {}, { llm: async () => { throw new Error('busy'); } })).source, 'offline');
  const msgs = R.builderMessages(R.MenuSpec.parse({ cuisines: ['Medicinal'], sourceMenu: 'Starters\nSoup £5' }), {}, ''); assert.match(msgs[1].content, /Dioscorides/); assert.match(msgs[1].content, /Soup £5/);
});
test('menu PDF renders a valid multi-course A4 document', async () => {
  const spec = R.MenuSpec.parse({ restaurantName: 'The Lantern', menuType: 'tasting', courses: 9, dishesPerCourse: 2, refine: { pairings: true } });
  const m = await R.buildMenu(spec, {}); m.courses.forEach(c => c.dishes.forEach(d => { d.pairing = 'Chablis, Burgundy'; }));
  const pdf = R.menuPdf(m, fonts()); const s = Buffer.from(pdf).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.7') && s.trimEnd().endsWith('%%EOF')); assert.ok((s.match(/\/Type \/Page\b/g) || []).length >= 2); assert.match(s, /The Lantern/);
});
test('Restauranteur plan: priced, gated, not in Gastronomique, includes magazine', () => {
  const p = plans.plans(); assert.equal(p.restaurant.price, '£29'); assert.equal(p.restaurant.annualPrice, '£290'); assert.equal(p.restaurant.features[0], 'Everything in Head Chef');
  assert.ok(!p.gastronomique.features.some(f => /menu builder|restaurant/i.test(f)));
  const sub = (plan, extra) => ({ email: 'x@y.z', plan, sub_status: 'active', ...extra });
  assert.equal(plans.isRestaurateur(sub('restaurant')), true); assert.equal(plans.isRestaurateur(sub('gastronomique')), false); assert.equal(plans.isRestaurateur(sub('head')), false);
  assert.equal(plans.isRestaurateur(sub('restaurant', { sub_status: 'canceled' })), false); assert.equal(plans.isRestaurateur(sub('head', { _trial: true, sub_status: 'trialing' })), false);
  assert.equal(plans.magazineIncluded(sub('restaurant')), true); assert.equal(plans.planName(sub('restaurant')), 'Restauranteur');
  process.env.STRIPE_PRICE_RESTAURANT = 'price_r_m'; process.env.STRIPE_PRICE_RESTAURANT_ANNUAL = 'price_r_y';
  assert.equal(plans.planFromPrice('price_r_m'), 'restaurant'); assert.equal(plans.planFromPrice('price_r_y'), 'restaurant');
  delete process.env.STRIPE_PRICE_RESTAURANT; delete process.env.STRIPE_PRICE_RESTAURANT_ANNUAL;
});
test('use-my-restaurant in searches: off by default, blends context when on, keeps chosen cuisines', () => {
  const prof = { name: 'The Lantern', description: 'Seasonal bistro', analysis: { cuisines: ['French'], style: ['bistro'], priceBand: '££' }, websiteMenu: 'Starters\nChicken liver parfait £9\nMains\nConfit duck leg £21' };
  assert.equal(R.searchContext(prof), null); assert.equal(R.searchContext(null), null);
  const ctx = R.searchContext({ ...prof, useInSearch: true }); assert.match(ctx.text, /French/); assert.match(ctx.text, /Confit duck leg/); assert.doesNotMatch(ctx.text, /£21/);
  const q = R.applySearchContext({ dish: 'quick lunch', cuisines: [], cuisine: 'any' }, ctx); assert.match(q.dish, /^quick lunch\nRestaurant context/); assert.equal(q.cuisine, 'French'); assert.equal(q.restaurantContext, 'The Lantern');
  const q2 = R.applySearchContext({ dish: '', cuisines: ['Thai'], cuisine: 'Thai' }, ctx); assert.equal(q2.cuisine, 'Thai');
  assert.equal(R.searchContext({ useInSearch: true }), null);
});
