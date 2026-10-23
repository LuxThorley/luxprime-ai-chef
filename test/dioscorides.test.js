'use strict';
const test = require('node:test'); const assert = require('node:assert');
const D = require('../src/dioscorides'); const B = require('../src/brief'); const ai = require('../src/ai'); const C = require('../src/chat');
test('data: food entries with book.chapter refs; dangerous substances never recipe-safe', () => {
  assert.ok(D.ENTRIES.length >= 120); assert.match(D.ATTRIBUTION, /Osbaldeston/);
  for (const e of D.ENTRIES) assert.match(e.ref, /^De Materia Medica (I|II|III|IV|V)\.\d+/);
  const bad = /hemlock|mandrake|aconite|hellebore|henbane|opium|poppy|lead|arsenic|mercury|copper/i;
  assert.ok(D.SAFE.every(e => !bad.test(e.name)));
  for (const n of ['Rue', 'Pennyroyal', 'Wormwood']) { const e = D.ENTRIES.find(x => x.name === n); assert.ok(e && !e.recipeSafe && e.caution); }
  assert.ok(D.BY_ID['D2-182'].name === 'Garlic' && D.BY_ID['D2-101'].caution.match(/12 months/));
});
test('activation: Medicinal cuisine (alone or fused) or Dioscorides mode', () => {
  assert.ok(D.active({ cuisines: ['Medicinal'] })); assert.ok(D.active({ cuisines: ['Moroccan', 'Medicinal'] })); assert.ok(D.active({ inspirationMode: 'dioscorides' }));
  assert.ok(!D.active({ cuisines: ['Moroccan'], inspirationMode: 'blend' }));
  assert.match(D.cuisineDirective({ cuisines: ['Medicinal', 'Moroccan'] }), /fused with Moroccan/);
});
test('references + citations: grounded in cook ingredients and intents; toxic ingredients rejected', () => {
  const r = D.references({ include: ['lentils'], dish: 'something warming for digestion' });
  assert.ok(r.length <= 6 && r[0].no === 'D2-129'); assert.ok(r.some(x => x.no === 'D3-81'));
  const c = D.cite({ inspiredBy: 'D2-129', ingredients: [{ name: 'red lentils' }, { name: 'honey' }] });
  assert.equal(c[0].label, 'Dioscorides, De Materia Medica II.129: Lentil'); assert.ok(c.find(x => x.name === 'Honey').caution);
  assert.ok(D.unsafe({ ingredients: [{ name: 'a sprig of rue' }] })); assert.ok(!D.unsafe({ ingredients: [{ name: 'fennel' }] }));
  assert.equal(D.cite({ inspiredBy: 'D3-52', ingredients: [] }).length, 0);
});
test('brief parser: medicinal intents become a chip and switch Medicinal on', () => {
  const b = B.parseBrief('a soothing supper, something warming for digestion'); assert.deepEqual(b.hints.medicinal.value.sort(), ['digestion', 'soothing', 'warming']);
  assert.match(b.hints.medicinal.label, /Medicinal \(Dioscorides\)/);
  const q = B.applyHints({ cuisines: ['Moroccan'] }, b); assert.deepEqual(q.cuisines, ['Moroccan', 'Medicinal']);
  assert.ok(!B.parseBrief('quick chicken pasta').hints.medicinal);
  assert.deepEqual(B.applyHints({ cuisines: [] }, B.without(b, ['medicinal'])).cuisines, []);
});
test('AI layer: Medicinal recipes carry citations + disclaimer, toxic ones dropped, long cuisine clamped', async () => {
  process.env.AI_PROVIDER = 'openai'; process.env.AI_BASE_URL = 'http://fake.local/v1';
  const base = { difficulty: 'easy', totalMinutes: 30, servings: 2, matchScore: 90, whyItFits: 'Dioscorides held that lentils nourish', steps: [{ text: 'Simmer lentils', timerMinutes: 20 }, { text: 'Dress with oil', timerMinutes: null }], allergens: [], nutritionPerServing: { kcal: 400, proteinG: 20, carbsG: 50, fatG: 10 }, substitutions: [] };
  const good = { recipes: [{ ...base, title: 'Lentils with Cumin and Honey', cuisine: 'Medicinal (Dioscorides) fused with Moroccan and much more text', inspiredBy: 'D2-129', ingredients: [{ name: 'green lentils', qty: 200, unit: 'g' }, { name: 'ground cumin', qty: 1, unit: 'tsp' }, { name: 'honey', qty: 1, unit: 'tbsp' }] },
    { ...base, title: 'Rue Salad', cuisine: 'Medicinal', ingredients: [{ name: 'rue leaves', qty: 5, unit: 'g' }, { name: 'olive oil', qty: 1, unit: 'tbsp' }] }] };
  let sent; const out = await ai.generate({ include: ['lentils'], cuisines: ['Medicinal', 'Moroccan'], servings: 2 }, { retries: 0, fetchImpl: async (u, o) => { sent = JSON.parse(o.body); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(good) } }] }) }; } });
  assert.equal(out.recipes.length, 1); const r = out.recipes[0];
  assert.equal(r.dioscorides[0].ref, 'De Materia Medica II.129'); assert.match(r.medicinalNote, /not medical advice/); assert.equal(r.cuisine, 'Medicinal–Moroccan fusion'); assert.ok(r.healthBenefits.items.length); assert.ok(r.cuisine.length <= 40); assert.ok(!r.escoffier);
  const user = JSON.parse(sent.messages[1].content); assert.match(user.cuisine, /Dioscorides/); assert.ok(user.references.some(x => x.no === 'D2-129'));
  assert.match(sent.messages[0].content, /MEDICINAL \(DIOSCORIDES\)/);
  delete process.env.AI_PROVIDER;
});
test('chat context: medicinal guidance only when Medicinal/Dioscorides is on', () => {
  const m = C.buildChatMessages({ message: 'why fennel?', history: [], context: { cuisines: ['Medicinal'] }, recipes: [] });
  assert.match(m[1].content, /not-medical-advice/);
  const n = C.buildChatMessages({ message: 'why?', history: [], context: { cuisines: ['Thai'] }, recipes: [] }); assert.ok(!/Dioscorides/.test(n[1].content));
});
test('list API data: public entries omit long excerpts', () => {
  const l = D.list({ q: 'garlic' }); assert.ok(l.entries.find(e => e.id === 'D2-182')); assert.match(l.disclaimer, /not medical advice/);
  assert.ok(l.entries.every(e => !e.excerpt && (!e.note || e.note.length <= 170)));
});
test('health benefits: historical uses with refs, cautious modern notes, cautions, disclaimer', () => {
  const h = D.healthBenefits({ ingredients: [{ name: 'garlic' }, { name: 'red lentils' }, { name: 'olive oil' }] });
  assert.match(h.disclaimer, /not medical advice.*see a doctor/);
  const g = h.items.find(i => i.name === 'Garlic'); assert.equal(g.ref, 'De Materia Medica II.182'); assert.ok(g.dioscorides.length); assert.match(g.cautions.join(' '), /blood-thinning/);
  assert.ok(!h.items.find(i => i.name === 'Olive'));
  for (const i of h.items) assert.ok(!/\b(cures?|treats?)\b/i.test(i.modern));
  for (const m of Object.values(D.MODERN)) assert.ok(!/\b(cures?|treats?|studies show|proven)\b/i.test(m), m);
});
