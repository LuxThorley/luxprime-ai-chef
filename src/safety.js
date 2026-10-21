'use strict';
// Food-safety guardrails applied to every recipe (AI or curated).
const { allergensFor, UK14 } = require('./recipes');
const CORE_TEMPS = [
  [/chicken|turkey|poultry/i, 'Poultry: cook until juices run clear and core reaches 75°C (or 70°C for 2 min). No pink meat.'],
  [/mince|burger|sausage|kofta/i, 'Minced meat & sausages: cook right through to at least 70°C for 2 minutes; no pink in the middle.'],
  [/pork/i, 'Pork: cook to at least 70°C core for 2 minutes.'],
  [/salmon|fish|cod|tuna|haddock/i, 'Fish: cook until opaque and flakes easily (63°C core).'],
  [/prawn/i, 'Prawns: cook until pink and opaque throughout.'],
  [/\begg/i, 'Eggs: use British Lion-stamped eggs if serving runny eggs to children, pregnant or elderly people; otherwise cook until set.'],
  [/rice/i, 'Rice: cool leftovers within 1 hour, refrigerate, eat within 24h and reheat until steaming hot (once only).'],
  [/flour|batter|dough/i, 'Raw flour and raw batter/dough can carry bacteria: do not taste before cooking.'],
  [/kidney beans/i, 'Dried kidney beans must be soaked and boiled hard for 10+ minutes; tinned are pre-cooked.']
];
const BANNED = [
  /raw (chicken|pork|kidney beans)/i, /eat (it )?raw (flour|dough|batter)/i, /\bhoney\b.*\b(baby|infant|under 1)/i,
  /leave .*(rice|meat).* (out|at room temperature) overnight/i, /(serve|eat) (chicken|pork|poultry) (pink|rare)/i,
  /wash (raw )?chicken/i, /can(ning)? .* without (a )?pressure/i, /foraged? (wild )?mushroom/i
];
function safetyNotes(recipe, { kidsMode } = {}) {
  const text = [recipe.title, ...recipe.ingredients.map(i => i.name), ...recipe.steps.map(s => s.text)].join(' ');
  const notes = CORE_TEMPS.filter(([re]) => re.test(text)).map(([, n]) => n);
  notes.push('Wash hands before cooking and after handling raw meat, fish or eggs. Use separate boards for raw meat.');
  if (recipe.diet && recipe.diet.halal && /beef|lamb|chicken|mince/i.test(text)) notes.push('Halal: use halal-certified meat and stock.');
  if (kidsMode) notes.push('Kids mode: an adult should handle knives, hobs, ovens, hot liquids and blenders.');
  if (/honey/i.test(text)) notes.push('Do not give honey to babies under 12 months.');
  if (/whole (nut|peanut)|grape/i.test(text)) notes.push('Choking hazard for under-5s: chop small round foods.');
  return notes;
}
function isUnsafe(recipe) {
  const text = [recipe.title, ...(recipe.steps || []).map(s => s.text), ...(recipe.tips || [])].join(' ');
  return BANNED.some(re => re.test(text));
}
// Re-derive allergens from ingredients and union with what the AI claimed (never trust AI alone)
function enforceAllergens(recipe) {
  const derived = allergensFor(recipe.ingredients.map(i => (i.name || '').toLowerCase()));
  const claimed = (recipe.allergens || []).filter(a => UK14.includes(a));
  recipe.allergens = UK14.filter(a => derived.includes(a) || claimed.includes(a));
  return recipe;
}
const DISCLAIMER = 'Allergen tags are guidance only — always check product labels. Nutrition values are estimates.';
module.exports = { safetyNotes, isUnsafe, enforceAllergens, DISCLAIMER };
