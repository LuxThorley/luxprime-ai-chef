'use strict';
// AI dish photos: deterministic cache key + an accurate photography prompt built from the actual recipe. Shared by Node + Worker.
const PANTRY = /^(salt|sea salt|pepper|black pepper|white pepper|water|oil|olive oil|vegetable oil|sunflower oil|rapeseed oil|flour|plain flour|sugar|stock|chicken stock|vegetable stock|ice|cornflour|baking powder|bicarbonate)/i;
const GARNISH = /parsley|chive|tarragon|dill|basil|coriander|cilantro|mint|thyme|rosemary|chervil|cress|microgreen|lemon zest|lemon wedge|lime|spring onion|scallion|sesame|paprika|toasted|flaked almond|pomegranate|crème fraîche|creme fraiche|parmesan/i;
const METHODS = [['pan-seared', /sear|pan-fr|pan fr/i], ['sautéed', /saut/i], ['roasted', /roast/i], ['grilled', /grill|broil|chargrill/i], ['poached', /poach/i], ['braised', /brais/i],
  ['baked', /\bbake|oven-bake/i], ['gratinéed', /gratin|until bubbling|under the grill/i], ['stewed', /\bstew|simmer .* (30|40|45|60)/i], ['deep-fried', /deep-fr/i], ['steamed', /steam/i], ['stir-fried', /stir-fr|wok/i], ['glazed', /glaz/i]];
const UNIT = '(?:g|kg|ml|l|oz|lb|tsp|tbsp|teaspoons?|tablespoons?|cups?|x|pinch(?:es)?|cloves?|sprigs?|handfuls?|fillets?|pieces?|slices?|bunch(?:es)?|cans?|tins?|whole|large|small|medium|fresh|knobs?|of)';
const clean = s => {
  let x = String(s || '').replace(/\([^)]*\)/g, ' ').replace(/,.*$/, '').replace(/\s+or\s+.*$/i, '');
  x = x.replace(/^[\d½¼¾⅓⅔.,/\-\s]+/, '');
  for (let i = 0; i < 3; i++) x = x.replace(new RegExp('^' + UNIT + '\\b\\.?\\s*', 'i'), '');
  x = x.replace(/\s+/g, ' ').trim().toLowerCase();
  const w = x.split(' '); if (w.length >= 2 && w[0].replace(/s$/, '') === w[w.length - 1].replace(/s$/, '')) x = w.slice(1).join(' ');
  return new RegExp('^' + UNIT + '$', 'i').test(x) || x.length < 3 ? '' : x;
};
function keyIngredients(r, n = 6) {
  const names = (r.ingredients || []).map(i => clean(i.name || i.item || i.display)).filter(x => x && !PANTRY.test(x) && x.length < 40);
  return [...new Set(names)].slice(0, n);
}
const imageBasis = r => [String(r.title || '').toLowerCase().trim(), ...keyIngredients(r).sort()].join('|');
async function imageKey(r) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(imageBasis(r))); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32); }
function method(r) { const t = (r.steps || []).map(s => s.text || s).join(' ') + ' ' + (r.title || ''); return METHODS.filter(([, re]) => re.test(t)).map(([m]) => m).slice(0, 2); }
function garnish(r) { return [...new Set((r.ingredients || []).map(i => clean(i.name)).filter(x => GARNISH.test(x)))].slice(0, 3); }
function vessel(r) {
  const t = `${r.title} ${(r.steps || []).map(s => s.text || s).join(' ')}`.toLowerCase();
  if (/soup|velouté|veloute|consommé|bisque|chowder|broth/.test(t)) return 'in a wide shallow soup bowl';
  if (/gratin|casserole|bake|pie|tian/.test(t)) return 'in a rustic enamelled gratin dish';
  if (/salad|salade/.test(t)) return 'on a large white ceramic plate, loosely piled';
  if (/stew|ragout|ragoût|curry|braise|daube|tagine/.test(t)) return 'in a heavy cast-iron cocotte with a little sauce visible';
  if (/tart|cake|soufflé|souffle|mousse|ice|sorbet|pudding|crumble|compote|pêche|peach/.test(t)) return 'on a fine porcelain dessert plate';
  return 'neatly plated on a warm white porcelain plate';
}
function buildPrompt(r) {
  const ings = keyIngredients(r), m = method(r), g = garnish(r);
  const servings = r.servings || r.baseServings || 2;
  return [
    `Professional editorial food photograph of "${String(r.title).slice(0, 110)}"${r.tagline ? ` — ${String(r.tagline).slice(0, 140).replace(/[.!\s]+$/, '')}` : ''}.`,
    `A single home-cooked portion for ${servings > 1 ? 'one person (part of a meal for ' + servings + ')' : 'one'}${m.length ? `, ${m.join(' and ')}` : ''}, ${vessel(r)}.`,
    ings.length ? `Clearly visible, realistic ingredients exactly as cooked: ${ings.join(', ')}.` : '',
    g.length ? `Garnished simply with ${g.join(', ')}.` : 'Minimal, elegant garnish.',
    'Natural soft window light from the side, shallow depth of field, 50mm lens, three-quarter overhead angle, true-to-life colours and textures, appetising and authentic, on a neutral linen or oak surface.',
    'Show only the listed ingredients and garnish: no other vegetables, fruit, sides or garnishes; nothing impossible or invented. No text, no labels, no logos, no people, no hands, no cutlery clutter, no extra dishes.'
  ].filter(Boolean).join(' ').slice(0, 1400);
}
const altText = r => `Photo of ${String(r.title).slice(0, 110)}${keyIngredients(r, 3).length ? ' with ' + keyIngredients(r, 3).join(', ') : ''} (AI-generated illustration)`;
const DAILY_CAPS = { admin: 300, tester: 60, member: 40, free: 12 };
module.exports = { clean, imageKey, imageBasis, buildPrompt, altText, keyIngredients, method, garnish, DAILY_CAPS };
