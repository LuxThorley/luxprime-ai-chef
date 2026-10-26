// Guide nutrition (estimated) for every recipe: deterministic ingredient lookup + FSA/DHSC traffic lights.
// Works in Node (require) and the browser (window.Nutrition). Values per 100 g, compact table derived from UK CoFID / USDA FoodData Central
// typical raw/as-sold values: [kcal, fat, saturates, carbohydrate, sugars, fibre, protein, sodium mg, typical each-weight g].
(function (root) {
'use strict';
const T = [
  // fats, dairy
  ['olive oil|vegetable oil|rapeseed oil|sunflower oil|sesame oil|oil', 884, 100, 14, 0, 0, 0, 0, 0], ['butter', 744, 82, 52, 0.6, 0.6, 0, 0.6, 600], ['ghee', 898, 99.8, 62, 0, 0, 0, 0.3, 2],
  ['double cream', 445, 48, 30, 2.7, 2.7, 0, 1.7, 30], ['single cream', 193, 19, 12, 3.9, 3.9, 0, 2.6, 40], ['soured cream|sour cream|crème fraîche|creme fraiche', 200, 19, 12, 3.6, 3, 0, 2.6, 45],
  ['coconut milk', 197, 21, 18, 2.8, 2, 0, 1.8, 15], ['coconut cream', 330, 35, 31, 6, 3, 2, 3, 20], ['milk', 64, 3.6, 2.3, 4.7, 4.7, 0, 3.4, 44], ['greek yogurt|greek yoghurt', 133, 10, 6.6, 3.6, 3.6, 0, 5.7, 40], ['yogurt|yoghurt', 72, 3.3, 2.1, 6.4, 6.4, 0, 4.5, 60],
  ['parmesan|parmigiano|pecorino', 392, 29, 19, 0, 0, 0, 36, 1500], ['cheddar slice', 410, 34, 21, 0.1, 0.1, 0, 25, 650, 25], ['cheddar|gruyère|gruyere|comté|stilton', 410, 34, 21, 0.1, 0.1, 0, 25, 650], ['mozzarella|burrata', 254, 19, 13, 1, 1, 0, 19, 400], ['feta', 265, 21, 15, 1.5, 1.5, 0, 14, 1100],
  ['halloumi', 316, 25, 17, 1.6, 1.6, 0, 21, 1100], ['ricotta', 150, 11, 7, 3, 0.3, 0, 9, 100], ['goat|chèvre', 320, 26, 18, 1, 1, 0, 21, 500], ['cream cheese|mascarpone', 400, 40, 27, 4, 3, 0, 5, 300], ['egg', 143, 9.5, 2.6, 0.7, 0.4, 0, 12.6, 140, 55],
  // meat & fish
  ['beef mince', 254, 20, 8, 0, 0, 0, 17, 70], ['beef sirloin|steak|rib-eye|ribeye|fillet of beef|beef fillet', 190, 11, 4.5, 0, 0, 0, 22, 55], ['braising beef|beef shin|short rib|brisket|chuck|beef', 180, 9, 3.8, 0, 0, 0, 23, 60],
  ['lamb mince', 280, 23, 10, 0, 0, 0, 17, 70], ['lamb', 230, 17, 7.5, 0, 0, 0, 19, 65], ['pork mince', 250, 20, 7.5, 0, 0, 0, 17, 70], ['pork sausage|sausage', 300, 25, 9, 6, 1.5, 0.5, 12, 750, 60],
  ['chorizo', 455, 38, 14, 2, 1, 0, 24, 1200], ['bacon|pancetta|lardons', 400, 37, 13, 0.5, 0, 0, 14, 1500], ['ham hock|ham', 145, 6, 2, 1, 1, 0, 21, 1100], ['pork belly', 518, 53, 19, 0, 0, 0, 9, 32], ['pork', 200, 12, 4.5, 0, 0, 0, 22, 60],
  ['chicken thigh', 177, 11, 3, 0, 0, 0, 19, 85], ['chicken breast', 120, 2.6, 0.6, 0, 0, 0, 23, 60, 180], ['chicken|fowl|poussin', 165, 9, 2.5, 0, 0, 0, 20, 75], ['duck', 200, 11, 3.5, 0, 0, 0, 23, 75], ['venison|pheasant|partridge|grouse', 120, 2.5, 1, 0, 0, 0, 23, 50],
  ['salmon fillet|salmon', 208, 13, 3, 0, 0, 0, 20, 60, 130], ['smoked mackerel', 305, 25, 5, 0, 0, 0, 19, 750], ['mackerel', 205, 14, 3.3, 0, 0, 0, 19, 90], ['tuna can|tuna', 116, 1, 0.3, 0, 0, 0, 26, 320, 112], ['king prawns|prawns|shrimp', 99, 1, 0.2, 0, 0, 0, 21, 500],
  ['scallop', 88, 0.8, 0.2, 3, 0, 0, 17, 400], ['mussels|clams|cockles|oyster', 86, 2.2, 0.4, 3.7, 0, 0, 12, 290], ['crab', 97, 1.5, 0.2, 0, 0, 0, 20, 400], ['fish pie mix|cod|haddock|hake|pollock|stone bass|sea bass|bass|turbot|white fish|fish', 85, 0.8, 0.2, 0, 0, 0, 19, 70],
  ['tofu', 144, 8.7, 1.3, 2.8, 0.6, 2.3, 17, 14],
  // grains, starch, bakery
  ['arborio|paella rice|sushi rice|pudding rice|basmati|jasmine|long grain rice|rice', 355, 0.6, 0.2, 79, 0.1, 1.3, 7, 5], ['cooked rice', 130, 0.3, 0.1, 28, 0.1, 0.4, 2.7, 1], ['rice noodles', 360, 0.6, 0.2, 80, 0, 1.6, 6, 180],
  ['egg noodles', 380, 4, 1, 71, 2, 3, 14, 20], ['spaghetti|linguine|penne|macaroni|pasta|tagliatelle|lasagne sheet|cannelloni', 358, 1.5, 0.3, 72, 3, 3, 12.5, 6], ['couscous', 376, 0.6, 0.1, 77, 0.5, 5, 13, 10], ['pearl barley|barley', 352, 1.2, 0.2, 78, 0.8, 15, 10, 9],
  ['rolled oats|oats', 375, 8, 1.5, 60, 1, 9, 12.5, 2], ['granola', 450, 15, 3, 64, 24, 7, 10, 30], ['plain flour|self-raising flour|strong white flour|flour', 350, 1.3, 0.2, 74, 1.3, 3.5, 10.5, 2], ['panko|breadcrumbs', 395, 3, 0.6, 75, 4, 4, 12, 600],
  ['bread slice|sourdough|bread|toast', 250, 2, 0.4, 47, 3.5, 3, 9, 450, 40], ['burger bun|brioche', 280, 5, 1.5, 49, 6, 2.5, 9, 450, 60], ['pitta|flatbread|naan', 275, 1.5, 0.3, 55, 2, 2.5, 9, 450, 60], ['tortilla wrap|corn tortilla|tortilla', 300, 7, 2.5, 50, 2.5, 3, 8, 700, 40],
  ['puff pastry|shortcrust|pastry', 550, 37, 18, 45, 1.5, 1.5, 7, 400], ['new potatoes|baking potato|potatoes|potato|jersey royals', 77, 0.1, 0, 17, 0.8, 2.2, 2, 6, 200], ['sweet potato', 86, 0.1, 0, 20, 4.2, 3, 1.6, 55, 200],
  // pulses, nuts, seeds
  ['red lentils|green lentils|lentils', 116, 0.4, 0.1, 20, 1.8, 7.9, 9, 2], ['chickpeas', 120, 2.5, 0.3, 17, 0.5, 5.5, 7, 220], ['kidney beans|black beans|cannellini beans|butter beans|beans in', 105, 0.5, 0.1, 15, 1, 6.5, 7.5, 200],
  ['green beans|mangetout|runner beans|broad beans', 31, 0.2, 0, 5, 2, 3, 2, 6], ['frozen peas|peas', 81, 0.4, 0.1, 10, 5, 5.5, 5.4, 5], ['peanut butter', 600, 50, 9, 13, 6, 6, 25, 400], ['peanuts', 585, 49, 8, 8, 4, 8, 26, 5],
  ['almonds|hazelnut|walnut|pistachio|cashew|pecan|nuts', 600, 52, 5, 12, 4.5, 9, 20, 5], ['chestnut', 196, 1.3, 0.2, 44, 11, 5, 1.6, 2], ['tahini', 600, 54, 7.5, 9, 0.5, 9, 18, 60], ['sesame seeds|chia seeds|seeds', 560, 46, 6.5, 12, 0.3, 15, 18, 10],
  // veg & fruit
  ['onion|red onion|shallot|leek|spring onion', 40, 0.1, 0, 8, 6, 1.6, 1.2, 4, 150], ['garlic clove|garlic', 149, 0.5, 0.1, 30, 1, 2, 6.4, 17, 5], ['ginger', 80, 0.8, 0.2, 18, 1.7, 2, 1.8, 13],
  ['carrot', 41, 0.2, 0, 8, 4.7, 2.8, 0.9, 69, 80], ['celeriac|celery|fennel|parsnip|turnip|swede|root veg', 42, 0.3, 0, 8, 3, 3.5, 1.5, 60, 300], ['butternut squash|squash|pumpkin', 45, 0.1, 0, 10, 2.2, 2, 1, 4, 900],
  ['aubergine', 25, 0.2, 0, 5, 3.5, 3, 1, 2, 300], ['courgette', 17, 0.3, 0.1, 3, 2.5, 1, 1.2, 8, 200], ['red pepper|pepper', 31, 0.3, 0, 6, 4.2, 2.1, 1, 4, 160], ['red chilli|chilli', 40, 0.4, 0, 9, 5, 1.5, 1.9, 9, 10],
  ['cherry tomatoes|tomato', 18, 0.2, 0, 3.9, 2.6, 1.2, 0.9, 5, 120], ['chopped tomatoes|passata|tinned tomatoes', 24, 0.2, 0, 4, 3.5, 1, 1.2, 150], ['tomato puree|tomato purée', 82, 0.5, 0.1, 15, 12, 4, 4.3, 60],
  ['spinach|kale|cavolo nero|chard|watercress', 23, 0.4, 0.1, 1.4, 0.4, 2.2, 2.9, 79], ['broccoli|purple sprouting|cauliflower|sprouts', 34, 0.4, 0.1, 4, 1.7, 2.6, 2.8, 33], ['pak choi|cabbage|red cabbage|chicory', 20, 0.2, 0, 3.5, 2.5, 2, 1.4, 20, 500],
  ['little gem|romaine|lettuce|salad leaves|rocket', 15, 0.2, 0, 2, 1.2, 1.3, 1.2, 10, 150], ['cucumber', 15, 0.1, 0, 3, 1.7, 0.5, 0.7, 2, 300], ['beansprouts', 30, 0.2, 0, 6, 4, 1.8, 3, 6], ['sweetcorn', 86, 1.4, 0.2, 17, 6, 2.4, 3.2, 15],
  ['chestnut mushrooms|mushroom|ceps|girolles|morels', 22, 0.3, 0.1, 3.3, 2, 1, 3.1, 5], ['avocado', 160, 15, 2.1, 8.5, 0.7, 6.7, 2, 7, 150], ['kalamata olives|olives', 145, 15, 2, 4, 0, 3.3, 1, 1500],
  ['lemon|lime', 29, 0.3, 0, 9, 2.5, 2.8, 1.1, 2, 60], ['eating apple|apple|bramley', 52, 0.2, 0, 14, 10, 2.4, 0.3, 1, 150], ['ripe banana|banana', 89, 0.3, 0.1, 23, 12, 2.6, 1.1, 1, 120], ['mango', 60, 0.4, 0.1, 15, 14, 1.6, 0.8, 1, 300],
  ['mixed berries|berries|raspberr|strawberr|blackberr|blueberr', 45, 0.3, 0, 10, 7, 4, 1, 1], ['rhubarb|gooseberr|plum|damson|cherries|pear|fig|quince|apricot|orange|clementine', 50, 0.2, 0, 12, 10, 2.5, 0.8, 1, 100], ['dried apricots|dried fruit|raisins|sultanas|dates', 240, 0.5, 0, 63, 53, 7, 3.4, 10],
  // sugar, sweet, sauces, stock, spices, drinks
  ['caster sugar|demerara|light brown sugar|icing sugar|sugar', 400, 0, 0, 100, 100, 0, 0, 1], ['honey|maple syrup|golden syrup|treacle', 304, 0, 0, 82, 82, 0, 0.3, 5], ['dark chocolate', 550, 33, 20, 46, 28, 10, 6, 20], ['cocoa powder', 230, 14, 8, 58, 1.8, 33, 20, 20], ['chocolate', 535, 30, 18, 59, 56, 3, 7.5, 80],
  ['mayonnaise', 680, 75, 6, 1, 1, 0, 1, 600], ['soy sauce', 53, 0.6, 0.1, 5, 0.4, 0.8, 8, 5600], ['fish sauce', 35, 0, 0, 3.6, 3.6, 0, 5, 7800], ['worcestershire sauce', 78, 0, 0, 19, 10, 0, 0, 1000], ['rice vinegar|vinegar|balsamic', 20, 0, 0, 1, 0.5, 0, 0, 5],
  ['thai green curry paste|thai red curry paste|curry paste|tikka paste|biryani paste|tamarind paste|harissa|paste', 140, 9, 1, 12, 5, 3, 2.5, 3000], ['mustard', 66, 4, 0.2, 5.8, 3, 3.3, 4, 1100],
  ['beef stock|chicken stock|lamb stock|vegetable stock|fish stock|stock|broth', 7, 0.2, 0.1, 0.5, 0.3, 0, 0.6, 320], ['salt', 0, 0, 0, 0, 0, 0, 0, 38758], ['saffron|cardamom|cinnamon|nutmeg|cumin|coriander|paprika|chilli powder|curry powder|ras el hanout|fajita seasoning|oregano|herbes|thyme|sage|bay leaf|rosemary|dill|mint|basil|parsley|tarragon|chive|spice', 280, 10, 1.5, 45, 3, 28, 12, 60, 2],
  ['dried yeast|yeast', 325, 7.6, 1, 41, 0, 27, 40, 50], ['ale|beer|cider', 43, 0, 0, 3.6, 0.3, 0, 0.5, 4], ['white wine|red wine|wine|sherry|port|brandy', 83, 0, 0, 2.6, 1, 0, 0.1, 5], ['warm water|water|ice', 0, 0, 0, 0, 0, 0, 0, 0]
].map(([k, ...v]) => ({ re: new RegExp(`\\b(${k})`, 'i'), keys: k, v }));
const SPOON = { tsp: 5, tbsp: 15, pinch: 0.4, dash: 1, handful: 30, bunch: 30, cup: 240, sprig: 1, clove: 5, slice: 30, knob: 15, can: 400, tin: 400 };
function lookup(name) { const n = String(name || '').toLowerCase(); let best = null, bl = 0; for (const e of T) { const m = n.match(e.re); if (m && m[1].length > bl) { best = e; bl = m[1].length; } } return best; }
// Cooked-weight yield for dry starches (affects weight / per-100 g only).
const YIELD = [[/cooked rice/, 1], [/rice|risotto/, 2.8], [/spaghetti|linguine|penne|macaroni|pasta|noodles|lasagne|cannelloni|tagliatelle/, 2.4], [/couscous|barley/, 2.5], [/lentil/, 2.5], [/oats/, 2]];
function grams(ing, e) {
  const q = +ing.qty; const u = String(ing.unit || '').toLowerCase(); if (!isFinite(q) || q <= 0) return null;
  if (u === 'g') return q; if (u === 'kg') return q * 1000; if (u === 'ml') return q * (e && /oil/.test(e.keys) ? 0.92 : 1.0); if (u === 'l' || u === 'litre') return q * 1000; if (u === 'cl') return q * 10;
  if (u === 'tbsp' || u === 'tsp') { const sp = /herbes|spice|cinnamon|cumin|paprika|powder|oregano|thyme|sage|dill|mint|nutmeg|ras el|seasoning/.test(e ? e.keys : '') ? 0.45 : 1; return q * SPOON[u] * sp; }
  if (SPOON[u] && u !== 'tsp' && u !== 'tbsp') return q * SPOON[u];
  if (!u || u === 'x' || u === 'each' || u === 'whole') { const bunch = /bunch/.test(String(ing.name)); return q * (bunch ? 30 : (e && e.v[8]) || 100); }
  return null;
}
const KEYS = ['energyKcal', 'fatG', 'saturatesG', 'carbohydrateG', 'sugarsG', 'fibreG', 'proteinG', 'saltG'];
const r1 = x => Math.round(x * 10) / 10;
const pack = (o, f = 1) => { const out = { energyKj: r1(o.energyKcal * f * 4.184) }; for (const k of KEYS) out[k] = r1(o[k] * f); return out; };
// Compute guide nutrition for a full recipe. Falls back to (and blends with) any Malcolm/LLM estimate per serving.
function compute(r) {
  const servings = Math.max(1, +(r.servings || r.baseServings || 4)); const tot = Object.fromEntries(KEYS.map(k => [k, 0])); let weight = 0, matched = 0, n = 0; const unknown = [];
  for (const ing of r.ingredients || []) {
    n++; const e = lookup(ing.name); const g = grams(ing, e); if (!e || g == null) { unknown.push(ing.name); continue; }
    matched++; const y = (YIELD.find(([re]) => re.test(e.keys)) || [0, 1])[1]; weight += /water|stock|wine|ale|beer|cider|milk|coconut milk/.test(e.keys) ? g * 0.85 : g * y; // some liquid reduces in cooking
    const f = g / 100; const [kcal, fat, sat, carb, sug, fib, pro, na] = e.v; tot.energyKcal += kcal * f; tot.fatG += fat * f; tot.saturatesG += sat * f; tot.carbohydrateG += carb * f; tot.sugarsG += sug * f; tot.fibreG += fib * f; tot.proteinG += pro * f; tot.saltG += na * f * 2.5 / 1000;
  }
  const est = r.nutritionPerServing || {}; const cover = n ? matched / n : 0; let method = 'computed';
  // Low coverage (unparsed quantities) → scale up to Malcolm's kcal estimate where we have one.
  if ((cover < 0.6 || tot.energyKcal < 50) && +est.kcal > 0) {
    const target = +est.kcal * servings; const f = tot.energyKcal > 50 ? target / tot.energyKcal : 0;
    if (f) { for (const k of KEYS) tot[k] *= f; weight *= f; } else { tot.energyKcal = target; tot.proteinG = (+est.proteinG || 0) * servings; tot.carbohydrateG = (+est.carbsG || 0) * servings; tot.fatG = (+est.fatG || 0) * servings; tot.saturatesG = tot.fatG * 0.35; tot.sugarsG = tot.carbohydrateG * 0.15; tot.fibreG = tot.carbohydrateG * 0.06; tot.saltG = 1.2 * servings; weight = 350 * servings; }
    method = 'estimated';
  }
  if (!weight) weight = 350 * servings;
  const totalWeightG = Math.round(weight); const portionG = Math.round(weight / servings);
  return { guide: true, label: 'Guide values, estimated', method, coverage: Math.round(cover * 100), servings, totalWeightG, portionG,
    total: pack(tot), perServing: pack(tot, 1 / servings), per100g: pack(tot, 100 / weight), unmatched: unknown.slice(0, 8) };
}
// ---- Traffic lights: FSA/DHSC 2016 front-of-pack (food). Per 100 g: low ≤ / high >; per-portion red when portion > 100 g. ----
const FOP = { fatG: [3, 17.5, 21], saturatesG: [1.5, 5, 6], sugarsG: [5, 22.5, 27], saltG: [0.3, 1.5, 1.8] };
const RI = { energyKj: 8400, energyKcal: 2000, fatG: 70, saturatesG: 20, carbohydrateG: 260, sugarsG: 90, proteinG: 50, saltG: 6, fibreG: 30 }; // EU 1169/2011 Annex XIII (fibre: WHO/SACN 30 g)
// Smooth spectral shade: 0 (best green) → 1 (worst red), green/amber/red bands keep their hue family.
function shade(t) { t = Math.max(0, Math.min(1, t)); const h = 130 - 125 * t; const l = 40 + 6 * Math.sin(Math.PI * t); return `hsl(${Math.round(h)} 70% ${Math.round(l)}%)`; }
function band(nut, per100, perPortion, portionG) {
  const [lo, hi, portionRed] = FOP[nut]; let level, t;
  if (portionG > 100 && perPortion > portionRed) { level = 'high'; t = 0.85 + 0.15 * Math.min(1, (perPortion - portionRed) / portionRed); }
  else if (per100 > hi) { level = 'high'; t = 0.7 + 0.3 * Math.min(1, (per100 - hi) / hi); }
  else if (per100 > lo) { level = 'medium'; t = 0.34 + 0.34 * (per100 - lo) / (hi - lo); }
  else { level = 'low'; t = 0.32 * per100 / lo; }
  return { level, label: level.toUpperCase(), colour: shade(t), t: Math.round(t * 100) / 100 };
}
function lights(nu) {
  const out = {}; for (const k of Object.keys(FOP)) out[k] = band(k, nu.per100g[k], nu.perServing[k], nu.portionG);
  // Energy: %RI per serving, neutral-to-amber shading (no FSA colour for energy).
  const pct = nu.perServing.energyKcal / RI.energyKcal * 100; out.energy = { level: pct > 40 ? 'high' : pct > 20 ? 'medium' : 'low', label: `${Math.round(pct)}% RI`, ri: Math.round(pct), colour: `hsl(40 ${Math.round(20 + Math.min(60, pct))}% 45%)`, neutral: true };
  // Positive nutrients (EU 1924/2006 claims): fibre high ≥6 g/100 g, source ≥3; protein high ≥20% energy, source ≥12%.
  const fib = nu.per100g.fibreG; out.fibreG = { level: fib >= 6 ? 'high' : fib >= 3 ? 'source' : 'low', label: fib >= 6 ? 'HIGH' : fib >= 3 ? 'SOURCE' : 'LOW', colour: fib >= 6 ? shade(0) : fib >= 3 ? shade(0.18) : 'hsl(0 0% 55%)', positive: true };
  const pe = nu.perServing.energyKcal ? nu.perServing.proteinG * 4 / nu.perServing.energyKcal * 100 : 0; out.proteinG = { level: pe >= 20 ? 'high' : pe >= 12 ? 'source' : 'low', label: pe >= 20 ? 'HIGH' : pe >= 12 ? 'SOURCE' : 'LOW', pctEnergy: Math.round(pe), colour: pe >= 20 ? shade(0) : pe >= 12 ? shade(0.18) : 'hsl(0 0% 55%)', positive: true };
  return out;
}
const SOURCES = 'Guide values, estimated from ingredient quantities (UK CoFID / USDA FoodData Central typical values; Malcolm’s estimate where quantities are missing). kJ = kcal × 4.184; salt = sodium × 2.5. Colours: FSA/DHSC front-of-pack nutrition labelling guidance (2016) — per 100 g LOW/MED/HIGH, red per portion over 100 g when fat >21 g, saturates >6 g, sugars >27 g, salt >1.8 g. %RI: Reference Intakes, EU Regulation 1169/2011 (8400 kJ / 2000 kcal, fat 70 g, saturates 20 g, carbohydrate 260 g, sugars 90 g, protein 50 g, salt 6 g); fibre 30 g/day (SACN/WHO). Fibre and protein: EU 1924/2006 claim levels (high fibre ≥6 g/100 g; high protein ≥20% of energy). WHO: limit free sugars and salt (<5 g/day). Not medical advice.';
function attach(r) { if (!r || !Array.isArray(r.ingredients)) return r; if (!r.nutrition || !r.nutrition.guide) r.nutrition = compute(r); r.nutrition.lights = lights(r.nutrition); return r; }
// Deep-walk any API payload and attach to every recipe-shaped object (ingredients + steps).
function attachAll(x, depth = 0) { if (!x || typeof x !== 'object' || depth > 6) return x; if (Array.isArray(x)) { x.forEach(v => attachAll(v, depth + 1)); return x; }
  if (Array.isArray(x.ingredients) && Array.isArray(x.steps) && x.title) attach(x); for (const v of Object.values(x)) if (v && typeof v === 'object') attachAll(v, depth + 1); return x; }
const api = { compute, lights, band, shade, attach, attachAll, lookup, grams, FOP, RI, SOURCES, KEYS };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Nutrition = api;
})(typeof window !== 'undefined' ? window : globalThis);
