const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs');
const R = require('../src/restaurant');
const fonts = () => Object.fromEntries(['serif', 'serifI', 'serifB', 'sans', 'sansB'].map(k => [k, new Uint8Array(fs.readFileSync(__dirname + '/../public/mag/' + k + '.bin'))]));
const shape = m => m.courses.map(c => c.dishes.length);
const aiMenu = spec => JSON.stringify({ title: 'Autumn', intro: 'i', courses: R.courseNames(spec).map(n => ({ name: n, dishes: Array.from({ length: spec.dishesPerCourse }, (_, i) => ({ name: `${n} plate ${i + 1}`, description: 'squash, sage, brown butter', tags: ['vegetarian'], price: 12 })) })), chefNote: '', rationale: 'r' });
test('offline composer always returns every course with the requested dishes (was dropping courses)', async () => {
  for (const [menuType, courses, dishesPerCourse] of [['a-la-carte', 5, 6], ['pub-classics', 6, 8], ['tasting', 12, 1], ['small-plates', 12, 8], ['brunch', 8, 5], ['sunday-roast', 7, 4]]) {
    const m = await R.buildMenu(R.MenuSpec.parse({ menuType, courses, dishesPerCourse }), {});
    assert.deepEqual(shape(m), Array(courses).fill(dishesPerCourse), menuType);
    const names = m.courses.flatMap(c => c.dishes.map(d => d.name)); assert.strictEqual(new Set(names).size, names.length, `${menuType}: no duplicate dishes`);
    assert.strictEqual(m.completion.expected, courses * dishesPerCourse); assert.strictEqual(m.completion.got, courses * dishesPerCourse);
  }
});
test('truncated AI JSON is salvaged and the rest completed (was falling back to a generic offline menu)', async () => {
  const spec = R.MenuSpec.parse({ courses: 4, dishesPerCourse: 4 }); const full = aiMenu(spec);
  for (const f of [0.35, 0.6, 0.85]) { const m = await R.buildMenu(spec, {}, { llm: async () => full.slice(0, Math.floor(full.length * f)) });
    assert.strictEqual(m.source, 'malcolm'); assert.deepEqual(shape(m), [4, 4, 4, 4]); assert.match(m.courses[0].dishes[0].name, /plate 1/); }
  assert.ok(R.repairJson('{"a":[{"b":1},{"b":2},{"b"')); assert.deepEqual(R.repairJson('{"a":[{"b":1},{"b":2},{"b"').a, [{ b: 1 }, { b: 2 }]);
  assert.strictEqual(R.repairJson('no json here'), null);
});
test('short AI menus are completed to the exact shape and the gap is disclosed', async () => {
  const spec = R.MenuSpec.parse({ courses: 4, dishesPerCourse: 3, courseNames: ['Snacks', 'Starters', 'Mains', 'Puddings'] });
  const m = await R.buildMenu(spec, {}, { llm: async () => JSON.stringify({ title: 'T', courses: [{ name: 'Snacks', dishes: [{ name: 'Gougères', description: 'comté' }] }, { name: 'Extra', dishes: [{ name: 'X' }] }, { name: 'Mains', dishes: [] }, { name: 'Puds', dishes: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] }, { name: 'Too many', dishes: [{ name: 'Z' }] }] }) });
  assert.deepEqual(m.courses.map(c => c.name), ['Snacks', 'Starters', 'Mains', 'Puddings']); assert.deepEqual(shape(m), [3, 3, 3, 3]);
  assert.strictEqual(m.courses[0].dishes[0].name, 'Gougères'); assert.ok(m.courses[0].dishes[1].filled); assert.ok(m.completion.filled >= 7); assert.match(m.rationale, /completed from Malcolm/);
});
test('builder prompt fits the Malcolm worker 4000-char message limit and asks for every dish; tokens/timeout scale', async () => {
  const spec = R.MenuSpec.parse({ courses: 8, dishesPerCourse: 6, sourceMenu: 'Starters\n' + 'Dish name with a long description £9\n'.repeat(300), description: 'd'.repeat(1500), refine: { personal: 'p'.repeat(400), keywords: 'cosy, autumn' }, kitchen: { chefs: '2-3', equipment: 'e'.repeat(300) } });
  const msgs = R.builderMessages(spec, {}, 'persona'); assert.ok(msgs[1].content.length <= 3900, String(msgs[1].content.length)); assert.match(msgs[1].content, /COMPLETENESS: return all 8 courses with exactly 6 dishes/); assert.match(msgs[1].content, /Kitchen:/);
  assert.ok(!msgs[1].content.includes('\u0000'));
  assert.ok(R.menuTokens(spec) > 1800 && R.menuTokens(spec) <= 4000); let seen;
  await R.buildMenu(spec, {}, { llm: async (_m, o) => { seen = o; return aiMenu(spec); } }); assert.ok(seen.timeoutMs >= 45000); assert.strictEqual(seen.maxTokens, R.menuTokens(spec));
});
test('benchmark dishes are never used to fill gaps', async () => {
  const spec = R.MenuSpec.parse({ courses: 2, dishesPerCourse: 8, sourceKind: 'benchmark', sourceMenu: 'Mains\nRoast cod £20\nSlow-braised beef short rib £24' });
  const m = await R.buildMenu(spec, {}); const n = m.courses.flatMap(c => c.dishes.map(d => d.name.toLowerCase())); assert.ok(!n.includes('roast cod')); assert.ok(!n.includes('slow-braised beef short rib'));
});
test('kitchen pack: every dish gets a sheet (prep sheet when no recipe) and the PDF renders for a large menu', async () => {
  const m = await R.buildMenu(R.MenuSpec.parse({ restaurantName: 'The Lantern', courses: 6, dishesPerCourse: 5, kitchen: { chefs: '4-6', covers: 90 } }), {});
  const recipes = {}; m.courses.forEach((c, ci) => c.dishes.forEach((_, di) => { recipes[R.dishKey(ci, di)] = R.prepSheet(m, ci, di); }));
  const ps = recipes['0-0']; assert.ok(ps.placeholder && ps.approximate && ps.steps.length >= 2 && ps.ingredients.length >= 1); assert.strictEqual(R.prepSheet(m, 99, 0), null);
  const pdf = Buffer.from(R.menuPdf(m, fonts(), { kitchen: true, recipes, linkFor: k => recipes[k] && recipes[k].id ? 'x' : null })).toString('latin1');
  assert.ok(pdf.endsWith('%%EOF\n')); const guest = Buffer.from(R.menuPdf(m, fonts())).toString('latin1'); const pages = s => (s.match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pages(pdf) >= pages(guest) + 30 + 2, `pages ${pages(pdf)} vs guest ${pages(guest)}`); assert.doesNotMatch(pdf, /\/Annots/);
});
test('unrelated library stand-ins are rejected in favour of a prep sheet', () => {
  assert.ok(!R.sameDish('Toad in the Hole', 'Crab on crisp toast')); assert.ok(!R.sameDish('Thai Green Curry', 'Pint of prawns')); assert.ok(!R.sameDish('Egg Fried Rice', 'Scotch egg')); assert.ok(!R.sameDish('Rice Pudding', 'Bread and butter pudding'));
  assert.ok(R.sameDish('Classic Sticky Toffee Pudding', 'Sticky toffee pudding')); assert.ok(R.sameDish('Pan-fried Cod with Leeks', 'Roast cod'));
});
test('kitchen plan puts first/amuse/intermezzo courses on the right station; prep sheets skip fake nutrition', async () => {
  const K = require('../src/kitchen'); assert.strictEqual(K.kindOf('First course'), 'start'); assert.strictEqual(K.kindOf('Amuse-bouche'), 'start'); assert.strictEqual(K.kindOf('Intermezzo'), 'dessert'); assert.strictEqual(K.kindOf('Mignardises'), 'dessert'); assert.strictEqual(K.kindOf('Fish course'), 'main');
  const m = await R.buildMenu(R.MenuSpec.parse({ menuType: 'tasting', courses: 6, dishesPerCourse: 1 }), {}); const recipes = { '0-0': R.prepSheet(m, 0, 0) };
  const pdf = Buffer.from(R.menuPdf(m, fonts(), { kitchen: true, recipes })).toString('latin1'); assert.ok(pdf.endsWith('%%EOF\n')); assert.ok(!recipes['0-0'].nutrition);
});
