'use strict';
// Expands the compact dataset, derives UK-14 allergens + diet flags, scales quantities.
const RAW = require('../data/recipes.js');

const UK14 = ['celery','cereals containing gluten','crustaceans','eggs','fish','lupin','milk','molluscs','mustard','peanuts','tree nuts','sesame','soya','sulphites'];

// keyword -> allergens (conservative; always tell users to check labels)
const ALLERGEN_RULES = [
  [/flour|spaghetti|linguine|penne|macaroni|lasagne|cannelloni|noodle(?!s?.*rice)|egg noodles|bun|bread|pitta|flatbread|tortilla wrap|panko|couscous|pastry|ale|granola|oats|worcestershire|soy sauce|biryani paste/, 'cereals containing gluten'],
  [/\begg\b|egg noodles|mayonnaise|lasagne sheet|pastry/, 'eggs'],
  [/(?<!coconut |oat |almond |soya |plant )milk|(?<!peanut |seed |nut )butter|(?<!coconut )cream|cheese|cheddar|mozzarella|parmesan|ricotta|feta|halloumi|yogurt|ghee/, 'milk'],
  [/prawn|shrimp|crab|lobster/, 'crustaceans'],
  [/salmon|tuna|cod|haddock|fish|anchov|worcestershire/, 'fish'],
  [/mussel|squid|oyster|clam/, 'molluscs'],
  [/peanut|satay/, 'peanuts'],
  [/almond|cashew|walnut|hazelnut|pecan|pistachio/, 'tree nuts'],
  [/sesame|tahini|hummus/, 'sesame'],
  [/soy|tofu|edamame|teriyaki/, 'soya'],
  [/mustard|caesar/, 'mustard'],
  [/celery|stock|ras el hanout|curry powder/, 'celery'],
  [/wine|dried apricot|ale|worcestershire|chorizo|sausage/, 'sulphites'],
  [/lupin/, 'lupin']
];
const MEAT = /beef|lamb|pork|chicken|sausage|chorizo|mince|bacon|ham/;
const PORK = /pork|sausage|chorizo|bacon|ham|\bale\b|wine/; // also flags alcohol for halal
const SEAFOOD = /prawn|salmon|tuna|fish|cod|haddock/;
const ANIMAL = /egg|(?<!coconut )milk|(?<!peanut )butter|(?<!coconut )cream|cheese|cheddar|mozzarella|parmesan|ricotta|feta|halloumi|yogurt|honey|fish sauce|worcestershire|mayonnaise/;
const SUBS = {
  'beef mince':'turkey mince, green lentils or plant-based mince','lamb mince':'beef mince or plant mince','chicken breast':'chicken thigh, firm tofu or chickpeas',
  'chicken thigh':'chicken breast or firm tofu','double cream':'single cream, crème fraîche or oat cream','butter':'olive oil or dairy-free spread',
  'milk':'any plant milk (oat/soya)','cheddar':'any hard cheese or vegan cheese','parmesan':'vegetarian hard cheese or nutritional yeast',
  'egg':'1 tbsp ground flaxseed + 3 tbsp water (baking only)','plain flour':'gluten-free plain flour','soy sauce':'tamari (gluten-free) or coconut aminos',
  'king prawns':'chicken pieces or firm tofu','natural yogurt':'coconut yogurt','greek yogurt':'coconut or soya yogurt','fish sauce':'soy sauce + squeeze of lime',
  'honey':'maple syrup','peanuts':'toasted seeds (nut-free)','peanut butter':'sunflower seed butter (nut-free)','white wine':'stock + 1 tsp lemon juice',
  'ale':'beef stock + 1 tsp balsamic','spaghetti':'gluten-free or wholewheat spaghetti','pork sausage':'chicken or vegetarian sausages','chorizo':'smoked paprika + chicken'
};

const LINE = /^([\d.]+)\s*(g|kg|ml|l|tsp|tbsp|x|pinch)\s+(.+)$/;
function parseLine(s) {
  const m = LINE.exec(s.trim());
  if (!m) return { name: s, qty: null, unit: '' };
  let qty = parseFloat(m[1]), unit = m[2];
  if (unit === 'kg') { qty *= 1000; unit = 'g'; }
  if (unit === 'l') { qty *= 1000; unit = 'ml'; }
  return { name: m[3], qty, unit };
}
function allergensFor(names) {
  const set = new Set();
  for (const n of names) for (const [re, a] of ALLERGEN_RULES) if (re.test(n)) set.add(a);
  return UK14.filter(a => set.has(a));
}
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function expand(r) {
  const ingredients = r.i.map(parseLine);
  const names = ingredients.map(x => x.name.toLowerCase());
  const all = names.join(' | ');
  const allergens = allergensFor(names);
  const vegetarian = !MEAT.test(all) && !SEAFOOD.test(all) && !/fish sauce|worcestershire|parmesan/.test(all);
  const vegan = vegetarian && !ANIMAL.test(all);
  const diet = {
    vegetarian, vegan,
    'gluten-free': !allergens.includes('cereals containing gluten'),
    'dairy-free': !allergens.includes('milk'),
    'nut-free': !allergens.includes('peanuts') && !allergens.includes('tree nuts'),
    slimming: r.n[0] <= 550 && r.n[1] >= 15, // lower-calorie, decent protein (see src/keywords.js)
    halal: !PORK.test(all) // meat must also be halal-certified: flagged in notes
  };
  const steps = r.st.map((text, idx) => {
    const t = /\[(\d+)\]/.exec(text);
    return { n: idx + 1, text: text.replace(/\s*\[\d+\]/, '').trim(), timerMinutes: t ? +t[1] : null };
  });
  const substitutions = ingredients.filter(x => SUBS[x.name.toLowerCase()]).map(x => ({ ingredient: x.name, swap: SUBS[x.name.toLowerCase()] }));
  return {
    id: slug(r.t), title: r.t, cuisine: r.c, difficulty: r.d, totalMinutes: r.m, baseServings: r.s,
    ingredients, steps, allergens, diet, tags: r.tags || [], substitutions,
    nutritionPerServing: { kcal: r.n[0], proteinG: r.n[1], carbsG: r.n[2], fatG: r.n[3], isEstimate: true },
    kidFriendly: (r.tags || []).includes('kids') || r.d === 'easy',
    source: 'AIchef.food curated library'
  };
}
const RECIPES = RAW.map(expand);
const { curatedImage } = require('./images');
RECIPES.forEach(r => { r.image = curatedImage(r); });

function roundQty(q, unit) {
  if (q == null) return null;
  if (unit === 'x') return Math.max(0.5, Math.round(q * 2) / 2);
  if (unit === 'tsp' || unit === 'tbsp') return Math.max(0.25, Math.round(q * 4) / 4);
  if (unit === 'pinch') return Math.max(1, Math.round(q));
  return q >= 100 ? Math.round(q / 5) * 5 : Math.round(q);
}
function fmtQty(q, unit, name) {
  if (q == null) return name;
  if (unit === 'x') return `${q} ${name}`;
  if (unit === 'g' && q >= 1000) return `${(q / 1000).toFixed(2).replace(/\.?0+$/, '')} kg ${name}`;
  if (unit === 'ml' && q >= 1000) return `${(q / 1000).toFixed(2).replace(/\.?0+$/, '')} litre ${name}`;
  return `${q} ${unit} ${name}`;
}
function scale(recipe, servings) {
  const f = servings / recipe.baseServings;
  return {
    ...recipe, servings,
    ingredients: recipe.ingredients.map(x => {
      const qty = roundQty(x.qty == null ? null : x.qty * f, x.unit);
      return { ...x, qty, display: fmtQty(qty, x.unit, x.name) };
    })
  };
}
module.exports = { RECIPES, UK14, scale, allergensFor, parseLine };
