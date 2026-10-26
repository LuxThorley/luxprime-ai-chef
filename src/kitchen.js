'use strict';
// Restauranteur: budget (sourcing + customer pricing) and kitchen/brigade refinements, per-dish cost estimates and the Kitchen Plan.
const { z } = require('zod');
const SOURCING = { economy: 'Economy (value suppliers, cheaper cuts, high-yield veg)', mid: 'Mid-range (good wholesale, seasonal, some named producers)', premium: 'Premium (named British producers, dry-aged meat, day-boat fish)', luxury: 'Luxury (finest produce: wagyu, caviar, truffle, langoustine)' };
const PRICING = { value: 'Value', mid: 'Mid-market', premium: 'Premium', fine: 'Fine dining' };
const CHEFS = { '1': 'Solo chef', '2-3': '2–3 chefs', '4-6': '4–6 chefs', '7+': '7+ chefs (full brigade)' };
const ROLES = { head: 'Head chef', sous: 'Sous chef', cdp: 'Chef de partie', commis: 'Commis', pastry: 'Pastry chef', kp: 'Kitchen porter' };
const opt = (lo, hi) => z.preprocess(v => (v === '' || v == null ? undefined : v), z.coerce.number().min(lo).max(hi).optional());
const Budget = z.object({ sourcing: z.enum(['', ...Object.keys(SOURCING)]).default(''), foodCostPct: opt(10, 60), coverCap: opt(1, 500),
  pricing: z.enum(['', ...Object.keys(PRICING)]).default(''), targetDish: opt(1, 500), targetCover: opt(1, 2000), gpTarget: opt(40, 90) }).default({});
const Kitchen = z.object({ chefs: z.enum(['', ...Object.keys(CHEFS)]).default(''), roles: z.array(z.enum(Object.keys(ROLES))).max(6).default([]), equipment: z.string().trim().max(300).default(''),
  covers: opt(1, 1000), prepHours: opt(0.5, 16), serviceStart: z.string().regex(/^\d{2}:\d{2}$/).default('18:00') }).default({});
// Base food cost (GBP per portion) by course kind × sourcing multiplier; selling-price multipliers by pricing tier.
const BASE = { start: 2.4, main: 4.6, dessert: 1.9, other: 1.6 };
const SRC_X = { '': 1, economy: 0.7, mid: 1, premium: 1.55, luxury: 2.6 };
const GP_DEFAULT = { '': 70, value: 65, mid: 70, premium: 72, fine: 75 };
const kindOf = name => { const n = String(name).toLowerCase(); return /start|snack|small|soup|raw|amuse|nibble|platter|board|share/.test(n) ? 'start' : /pud|dessert|sweet|pastry|petits|cheese/.test(n) ? 'dessert' : /side|bread|extra|veg|trimming/.test(n) ? 'other' : 'main'; };
const r50 = x => Math.max(0.5, Math.round(x * 2) / 2);
const gpOf = b => b.gpTarget || (b.foodCostPct ? 100 - b.foodCostPct : GP_DEFAULT[b.pricing || '']);
// UK menu prices include 20% VAT; GP is calculated on the net (ex-VAT) price.
function estimate(dish, course, b = {}) {
  const k = kindOf(course); let cost = isFinite(+dish.foodCost) && +dish.foodCost > 0 ? +dish.foodCost : BASE[k] * SRC_X[b.sourcing || ''] * (1 + Math.min(0.4, (String(dish.description || '').split(',').length - 2) * 0.08));
  cost = Math.round(cost * 100) / 100; const gp = gpOf(b); let price = r50(cost / (1 - gp / 100) * 1.2);
  if (b.targetDish && k === 'main') price = r50((price + b.targetDish) / 2);
  const menuPrice = dish.price || null; const net = (menuPrice || price) / 1.2; const gpAt = Math.round((1 - cost / net) * 100);
  return { foodCost: cost, suggestedPrice: price, gpPct: gpAt, kind: k };
}
function annotate(menu, b = {}) {
  let perCover = 0; const kinds = {};
  menu.courses.forEach(c => c.dishes.forEach(d => { d.est = estimate(d, c.name, b); (kinds[d.est.kind] = kinds[d.est.kind] || []).push(d.est); }));
  for (const k of ['start', 'main', 'dessert']) if (kinds[k]) perCover += kinds[k].reduce((s, e) => s + e.foodCost, 0) / kinds[k].length;
  perCover = Math.round(perCover * 100) / 100; const priceCover = ['start', 'main', 'dessert'].reduce((s, k) => s + (kinds[k] ? kinds[k].reduce((a, e) => a + e.suggestedPrice, 0) / kinds[k].length : 0), 0);
  menu.costing = { currency: 'GBP', estimates: true, avgFoodCostPerCover: perCover, avgSpendPerCover: Math.round(priceCover * 2) / 2, gpTarget: gpOf(b), overCap: !!(b.coverCap && perCover > b.coverCap), overTargetCover: !!(b.targetCover && priceCover > b.targetCover),
    note: 'Estimates only: food cost per portion from typical UK wholesale prices for the chosen sourcing tier; suggested prices include 20% VAT and target the GP shown. Check against your own supplier prices.' };
  return menu;
}
function promptRules(b = {}, k = {}) {
  const out = [];
  if (b.sourcing) out.push(`Ingredient sourcing tier: ${SOURCING[b.sourcing]}. Choose ingredients, cuts and garnish to match.`);
  if (b.foodCostPct) out.push(`Target food cost: ${b.foodCostPct}% of the net selling price.`); if (b.coverCap) out.push(`Food cost per cover must stay under £${b.coverCap}.`);
  if (b.pricing) out.push(`Customer pricing tier: ${PRICING[b.pricing]}; pitch dishes, portioning and menu prices accordingly.`);
  if (b.targetDish) out.push(`Target main-course price about £${b.targetDish}.`); if (b.targetCover) out.push(`Target spend per cover about £${b.targetCover}.`); if (b.gpTarget) out.push(`Gross-profit target ${b.gpTarget}%.`);
  if (b.sourcing || b.pricing || b.foodCostPct || b.gpTarget) out.push('For every dish add "foodCost": estimated ingredient cost per portion in GBP (number).');
  if (k.chefs || k.roles.length || k.covers || k.prepHours || k.equipment) {
    const amb = { '1': 'very simple: few components, mostly prep-ahead, one-pan finishing, no à la minute sauces', '2-3': 'moderate: 3–4 components, mostly prepared ahead, quick pick-up', '4-6': 'ambitious: refined garnishes and sauces are fine', '7+': 'full ambition: complex, multi-component plates are fine' }[k.chefs] || 'match the brigade';
    out.push(`Kitchen: ${k.chefs ? CHEFS[k.chefs] : 'brigade unknown'}${k.roles.length ? ` (${k.roles.map(r => ROLES[r]).join(', ')})` : ''}${k.covers ? `, about ${k.covers} covers per service` : ''}${k.prepHours ? `, ${k.prepHours} h prep before service` : ''}${k.equipment ? `; equipment: ${k.equipment}` : ''}. Menu complexity: ${amb}. Only use techniques the listed equipment allows.`);
  }
  return out;
}
// Deterministic Kitchen Plan: stations, delegation by role, mise en place schedule back-timed from service start.
const STATION = { start: 'Larder / cold starters', main: 'Hot section (sauce & grill)', dessert: 'Pastry', other: 'Veg & sides' };
const hm = m => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
function kitchenPlan(menu, k = {}, recipes = {}) {
  const roles = k.roles && k.roles.length ? [...k.roles] : ({ '1': ['head'], '2-3': ['head', 'cdp', 'kp'], '4-6': ['head', 'sous', 'cdp', 'commis', 'kp'], '7+': ['head', 'sous', 'cdp', 'pastry', 'commis', 'kp'] }[k.chefs] || ['head', 'cdp', 'kp']);
  const cooks = roles.filter(r => r !== 'kp'); const covers = k.covers || 40; const prepMin = Math.round((k.prepHours || 4) * 60);
  const [sh, sm] = String(k.serviceStart || '18:00').split(':').map(Number); const service = sh * 60 + sm; const start = service - prepMin;
  const pick = kind => { const pref = { start: ['cdp', 'commis', 'sous'], main: ['sous', 'cdp', 'head'], dessert: ['pastry', 'commis', 'cdp'], other: ['commis', 'cdp', 'kp'] }[kind]; return pref.find(r => cooks.includes(r)) || (kind === 'other' && roles.includes('kp') ? 'kp' : cooks[0] || 'head'); };
  const stations = {}; const tasks = [];
  menu.courses.forEach((c, ci) => c.dishes.forEach((d, di) => {
    const kind = (d.est && d.est.kind) || kindOf(c.name); const role = pick(kind); (stations[STATION[kind]] = stations[STATION[kind]] || { role: ROLES[role], dishes: [] }).dishes.push(d.name);
    const r = recipes[`${ci}-${di}`]; const prep = Math.min(150, Math.max(20, (r && (r.prepMinutes || Math.round((r.totalMinutes || 60) * 0.6))) || 30)) + Math.round(covers / 30) * 10;
    tasks.push({ dish: d.name, course: c.name, role, roleLabel: ROLES[role], prepMin: prep, kind, pickUp: kind === 'main' ? 'à la minute, 8–12 min' : kind === 'start' ? 'plate to order, 4–6 min' : kind === 'dessert' ? 'plate to order, 3–5 min' : 'batch & hold, refresh hourly' });
  }));
  // Long jobs first (stocks, braises, pastry); each goes to the least-loaded suitable cook; anything that won't fit moves to the day before.
  const clock = {}; const sched = []; const ord = x => x.dayBefore ? -1 : x.min;
  if (roles.includes('kp')) sched.push({ min: start, role: 'kp', roleLabel: ROLES.kp, task: 'Deliveries checked & dated, veg washed and peeled, pots and trays ready' });
  sched.push({ min: start, role: cooks[0] || 'head', roleLabel: ROLES[cooks[0] || 'head'], task: 'Briefing: covers, allergies, 86 list, prep list signed off' });
  for (const t of [...tasks].sort((a, b) => b.prepMin - a.prepMin)) {
    const pool = [t.role, ...cooks.filter(r => r !== t.role && (r !== 'head' || cooks.length <= 3))]; const role = pool.reduce((best, r) => ((clock[r] ?? start + 15) < (clock[best] ?? start + 15) - 30 ? r : best), t.role);
    const at = clock[role] ?? start + 15;
    if (at + t.prepMin > service - 30) { sched.push({ dayBefore: true, min: 0, role, roleLabel: ROLES[role], task: `Day before — ${t.dish} (${t.course}): batch-prepare & chill, ~${t.prepMin} min` }); continue; }
    clock[role] = at + t.prepMin; t.role = role; t.roleLabel = ROLES[role]; sched.push({ min: at, role, roleLabel: ROLES[role], task: `Mise en place — ${t.dish} (${t.course}), ~${t.prepMin} min` });
  }
  sched.push({ min: service - 30, role: cooks[0] || 'head', roleLabel: ROLES[cooks[0] || 'head'], task: 'Line check: taste sauces, labels & temperatures, stations stocked (FIFO)' });
  sched.push({ min: service - 10, role: 'all', roleLabel: 'Everyone', task: 'Pre-service briefing; pass ready' });
  sched.push({ min: service, role: 'all', roleLabel: 'Service', task: `Service starts — ${covers} covers; ${cooks.includes('head') ? 'head chef' : 'senior chef'} on the pass calling tickets` });
  sched.sort((a, b) => ord(a) - ord(b)); for (const x of sched) { x.at = x.dayBefore ? 'D-1' : hm(x.min); delete x.min; }
  const overloaded = sched.some(s => s.dayBefore);
  return { brigade: roles.map(r => ROLES[r]), covers, serviceStart: hm(service), prepFrom: hm(start), stations, tasks, schedule: sched,
    advice: overloaded ? 'Not everything fits today’s prep window, so the longest jobs are moved to the day before (marked D-1). Add prep time or a chef, or simplify a dish, to bring them back to the day.' : 'Prep fits the window with time for a line check.' };
}
module.exports = { SOURCING, PRICING, CHEFS, ROLES, Budget, Kitchen, estimate, annotate, promptRules, kitchenPlan, kindOf };
