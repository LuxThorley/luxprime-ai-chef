const test = require('node:test'); const assert = require('node:assert');
const R = require('../src/restaurant'); const K = require('../src/kitchen'); const W = require('../src/weekly');
const spec = x => R.MenuSpec.parse({ restaurantName: 'The Red Lion', venueType: 'pub', ...x });
test('budget + kitchen fields validate and reach the prompt', () => {
  const s = spec({ budget: { sourcing: 'luxury', foodCostPct: '28', pricing: 'fine', gpTarget: 75, coverCap: '' }, kitchen: { chefs: '1', roles: ['head'], covers: 30, prepHours: 3, equipment: 'induction only' } });
  assert.strictEqual(s.budget.foodCostPct, 28); assert.strictEqual(s.budget.coverCap, undefined);
  const p = R.builderMessages(s, {}, '').at(-1).content; assert.match(p, /Luxury/); assert.match(p, /Fine dining/); assert.match(p, /foodCost/); assert.match(p, /Solo chef/); assert.match(p, /very simple/); assert.match(p, /induction only/);
  assert.throws(() => spec({ budget: { sourcing: 'bogus' } }));
});
test('estimates scale with sourcing tier and GP; mark over-cap', async () => {
  const lo = await R.buildMenu(spec({ budget: { sourcing: 'economy', pricing: 'value' } }), {}); const hi = await R.buildMenu(spec({ budget: { sourcing: 'luxury', pricing: 'fine', coverCap: 5 } }), {});
  const d = m => m.courses[1].dishes[0].est; assert.ok(d(hi).foodCost > d(lo).foodCost * 2); assert.ok(d(hi).suggestedPrice > d(lo).suggestedPrice);
  assert.ok(hi.costing.overCap); assert.ok(hi.costing.estimates); assert.match(hi.costing.note, /Estimates/);
  const e = K.estimate({ name: 'x', description: 'a, b', foodCost: 6 }, 'Mains', { gpTarget: 70 }); assert.strictEqual(e.foodCost, 6); assert.strictEqual(e.suggestedPrice, 24);
});
test('kitchen plan delegates by role and back-times from service', async () => {
  const m = await R.buildMenu(spec({ kitchen: { chefs: '4-6', covers: 80, prepHours: 5, serviceStart: '19:00' } }), {});
  const p = m.kitchenPlan; assert.ok(p.brigade.includes('Sous chef')); assert.strictEqual(p.serviceStart, '19:00'); assert.strictEqual(p.prepFrom, '14:00');
  assert.ok(p.schedule.some(s => /Line check/.test(s.task) && s.at === '18:30')); assert.ok(Object.keys(p.stations).length >= 2);
  const solo = K.kitchenPlan(m, { chefs: '1', prepHours: 1 }); assert.ok(solo.schedule.some(s => s.at === 'D-1')); assert.match(solo.advice, /day before/);
});
test('Kitchen Pack PDF keeps its name and includes plan + costing', async () => {
  const fs = require('fs'); const fonts = Object.fromEntries(['serif', 'serifI', 'serifB', 'sans', 'sansB'].map(k => [k, new Uint8Array(fs.readFileSync(__dirname + '/../public/mag/' + k + '.bin'))]));
  const m = await R.buildMenu(spec({ kitchen: { chefs: '2-3' } }), {}); const pdf = Buffer.from(R.menuPdf(m, fonts, { kitchen: true })); assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-');
});
test('weekly issue is personalised and only sends Monday 08:00+ UK', () => {
  const i = W.buildIssue({ profile: { name: 'The Red Lion', venueType: 'pub' }, menus: [{ title: 'Autumn Pub Classics' }], keywords: ['cosy'] }, new Date('2026-10-26T09:00:00Z'));
  assert.strictEqual(i.venue, 'The Red Lion'); assert.match(i.intro, /Autumn Pub Classics/); assert.match(i.intro, /cosy/); assert.strictEqual(i.week, '2026-W44');
  assert.ok(i.sections.find(s => s.h === 'In season now').items[0].length > 20); assert.ok(i.sections.find(s => s.h === 'Cost-saving tips'));
  const h = W.renderHtml(i, { unsubUrl: 'https://x/u', webUrl: 'https://x/w' }); assert.match(h, /Unsubscribe/); assert.ok(!/<script/i.test(h));
  assert.ok(W.sendWindow(new Date('2026-10-26T08:05:00Z'))); assert.ok(!W.sendWindow(new Date('2026-10-26T07:55:00Z'))); assert.ok(!W.sendWindow(new Date('2026-10-27T09:00:00Z')));
  assert.ok(W.sendWindow(new Date('2026-06-01T07:05:00Z'))); // BST: 08:05 UK
});
