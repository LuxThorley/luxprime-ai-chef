'use strict';
// Free-text search keywords ("snack, romantic, magical, quick, cakes, Christmas"), special style cuisines and the Slimming diet.
const SYN = {
  quick: ['fast', 'speedy', 'easy', 'weeknight', 'minute'], snack: ['nibble', 'bite', 'bites', 'canape', 'starter', 'small plate', 'dip'], romantic: ['date night', 'date', 'valentine', 'for two', 'elegant', 'chocolate', 'steak'],
  magical: ['enchanted', 'whimsical', 'sparkle', 'colourful', 'rainbow', 'fairy'], cake: ['cakes', 'bake', 'sponge', 'traybake', 'cupcake', 'gateau'], christmas: ['festive', 'xmas', 'yule', 'turkey', 'mince pie', 'cranberry', 'gingerbread', 'sprout'],
  healthy: ['light', 'fresh', 'nutritious', 'wholesome'], comfort: ['cosy', 'hearty', 'warming', 'stew', 'pie'], spicy: ['hot', 'chilli', 'fiery', 'curry'], party: ['crowd', 'sharing', 'buffet', 'canape'], kids: ['child', 'children', 'family', 'kid'],
  breakfast: ['brunch', 'morning', 'eggs'], dessert: ['pudding', 'sweet', 'afters'], vegetarian: ['veggie', 'meat-free'], budget: ['cheap', 'thrifty', 'economical'], halloween: ['pumpkin', 'spooky'], easter: ['lamb', 'chocolate egg', 'hot cross'], summer: ['bbq', 'barbecue', 'salad', 'picnic'], winter: ['warming', 'roast', 'stew', 'soup'] };
const CANON = {}; for (const [k, vs] of Object.entries(SYN)) { CANON[k] = k; for (const v of vs) if (!CANON[v]) CANON[v] = k; }
const singular = w => w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('s') && !/(ss|as|is|us|os)$/.test(w) ? w.slice(0, -1) : w;
// "Snack, romantic,, MAGICAL; quick / cakes, Christmas" -> ['snack','romantic','magical','quick','cake','christmas'] (max 12, 30 chars each)
function parseKeywords(input) {
  const raw = Array.isArray(input) ? input.join(',') : String(input || '');
  const out = [];
  for (let k of raw.split(/[,;/\n]+/)) { k = k.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N} '\-&]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 30); if (!k) continue; k = k.split(' ').map(singular).join(' '); if (!out.includes(k)) out.push(k); if (out.length >= 12) break; }
  return out;
}
const expand = k => { const c = CANON[k] || k; return [...new Set([k, c, ...(SYN[c] || [])])]; };
// Score text fields against keywords: title x3, tags x2, description/ingredients x1. Returns { score 0-1, hits[] }.
function keywordScore(keywords, { title = '', tags = [], description = '', ingredients = [] } = {}) {
  if (!keywords || !keywords.length) return { score: 0, hits: [] };
  const T = ' ' + String(title).toLowerCase() + ' ', G = ' ' + [].concat(tags).join(' ').toLowerCase() + ' ', D = ' ' + [description, ...[].concat(ingredients)].join(' ').toLowerCase() + ' ';
  let s = 0; const hits = [];
  for (const k of keywords) { const vs = expand(k); const has = h => vs.some(v => h.includes(' ' + v) || h.includes(v + ' ') || (v.length > 4 && h.includes(v)));
    const w = has(T) ? 3 : has(G) ? 2 : has(D) ? 1 : 0; if (w) { s += w; hits.push(k); } }
  return { score: Math.min(1, s / (3 * keywords.length)), hits };
}
const promptRule = kw => kw && kw.length ? `The cook added these keywords — let each shape the recipes (mood, occasion, style, format) and reflect them in titles or whyItFits where natural: ${kw.join(', ')}.` : '';

// Style cuisines (not regional): guidance for Malcolm + offline ranking hints.
const STYLE_CUISINES = {
  'Haute Cuisine': { rule: 'Haute Cuisine: refined, classical French-led fine dining — precise technique, mother sauces and reductions, elegant plating, premium seasonal produce; restaurant-quality presentation notes.', match: r => /french/i.test(r.cuisine) || r.difficulty === 'hard', boost: ['sauce', 'jus', 'confit', 'fillet', 'reduction'] },
  Family: { rule: 'Family: generous, crowd-pleasing, budget-aware dishes that suit all ages — gentle spice, make-ahead or one-pot where possible, kid-friendly with grown-up options.', match: r => r.kidFriendly || (r.tags || []).includes('family'), boost: ['family', 'traybake', 'pie', 'pasta', 'bake'] },
  Experimental: { rule: 'Experimental: playful, modernist and boundary-pushing — unexpected flavour pairings, contrasting textures, fermentation, smoke, gels or foams achievable in a home kitchen; explain any novel technique clearly and safely.', match: r => (r.tags || []).some(t => /fusion|modern/.test(t)) || /fusion/i.test(r.cuisine), boost: ['fusion', 'miso', 'smoked', 'pickled', 'ferment'] }
};
const isStyleCuisine = c => Object.prototype.hasOwnProperty.call(STYLE_CUISINES, c);
function cuisineRules(cuisines) { return (cuisines || []).filter(isStyleCuisine).map(c => STYLE_CUISINES[c].rule); }

// Slimming / weight loss diet.
const SLIMMING = { kcalMax: 550, proteinMin: 20 };
const SLIMMING_RULE = `Slimming / weight loss: keep each serving at or under ${SLIMMING.kcalMax} kcal, high in protein (≥${SLIMMING.proteinMin} g) and fibre (vegetables, pulses, wholegrains), lean cooking methods, sensible portions (give a portion guide, e.g. "a fist of carbs, half a plate of veg"); always fill nutritionPerServing accurately and mention kcal per serving in whyItFits. Never use crash-diet language.`;
const SLIMMING_NOTE = 'Slimming recipes are general healthy-eating guidance with estimated calories, not medical or dietetic advice. They are not suitable during pregnancy or breastfeeding, for children, or for anyone with (or recovering from) an eating disorder; if you have a health condition or take medication, speak to your GP or a registered dietitian first.';
const isSlimming = n => !!n && +n.kcal > 0 && +n.kcal <= SLIMMING.kcalMax && (+n.proteinG || 0) >= SLIMMING.proteinMin - 5;
module.exports = { parseKeywords, keywordScore, expand, promptRule, STYLE_CUISINES, isStyleCuisine, cuisineRules, SLIMMING, SLIMMING_RULE, SLIMMING_NOTE, isSlimming };
