'use strict';
// Dioscorides grounding ("Medicinal" cuisine / Dioscorides inspiration). Data: src/data/dioscorides.json (built by tools/build_dioscorides.py).
const DATA = require('./data/dioscorides.json');
const ENTRIES = DATA.entries; const SAFE = ENTRIES.filter(e => e.recipeSafe);
const BY_ID = Object.fromEntries(ENTRIES.map(e => [e.id, e]));
const ATTRIBUTION = DATA.source;
const DISCLAIMER = 'Historical food lore from Dioscorides’ De Materia Medica (1st century AD), shared for culinary and cultural interest. It is not medical advice and these dishes do not treat, cure or prevent any illness. If you are pregnant, breastfeeding, on medication or have a health condition, ask a doctor or pharmacist before using herbs in quantity. Always check allergens.';
const EXCLUDED = DATA.excluded;
// Medicinal intents → Dioscorides entries (traditional properties he ascribes; historical framing only).
const INTENTS = {
  digestion: { re: /\b(digest(?:ion|ive)?|stomach|bloat(?:ed|ing)?|indigestion|tummy|gut|wind|after a heavy meal)\b/, label: 'for digestion', ids: ['D3-81', 'D3-65', 'D3-69', 'D3-66', 'D3-41', 'D2-190', 'D3-71', 'D3-67'] },
  warming: { re: /\b(warm(?:ing)?|heating|cold weather|chill(?:ed|y)?|winter warmer)\b/, label: 'warming', ids: ['D2-189', 'D2-190', 'D1-13', 'D2-184', 'D2-182', 'D3-69', 'D3-44', 'D1-12'] },
  soothing: { re: /\b(sooth(?:e|ing)|calm(?:ing)?|gentle|comfort(?:ing)?|restorative|nourishing|convalesc\w*)\b/, label: 'soothing', ids: ['D2-101', 'D2-108', 'D2-144', 'D1-176', 'D2-165', 'D3-154', 'D2-52', 'D1-183'] },
  cooling: { re: /\b(cool(?:ing)?|refresh(?:ing)?|heatwave|hot day|summery)\b/, label: 'cooling', ids: ['D2-163', 'D2-165', 'D2-150', 'D1-151', 'D2-164', 'D3-41', 'D2-160'] },
  throat: { re: /\b(throat|cough|chesty|voice|hoarse)\b/, label: 'for the throat', ids: ['D2-101', 'D3-30', 'D1-183', 'D2-108', 'D3-44'] },
  sleep: { re: /\b(sleep|bedtime|relax(?:ing)?|unwind|restful)\b/, label: 'restful', ids: ['D2-165', 'D3-154', 'D3-118', 'D2-75', 'D2-101'] },
  strength: { re: /\b(strength|energy|energi[sz]ing|stamina|hearty|sustaining)\b/, label: 'strengthening', ids: ['D2-107', 'D2-126', 'D2-54', 'D1-148', 'D2-129', 'D1-183', 'D2-111'] }
};
// Health topics (catalogue taxonomy): question phrases -> topic; entries ranked by how central the topic is in the chapter.
const TOPIC_Q = {
  respiratory: { re: /\b(cough(?:s|ing)?|cold(?:s)?|sore throat|chesty|chest|congest\w*|catarrh|phlegm|breath(?:ing)?|lungs?)\b/, label: 'coughs & chest' },
  digestion: { re: /\b(sluggish digestion|constipat\w*|bloat\w*|indigestion|heartburn|nause\w*|appetite|stomach ache|tummy|gut health)\b/, label: 'digestion' },
  'sleep & nerves': { re: /\b(insomnia|can'?t sleep|stress(?:ed)?|anxious|nerves|calm(?:ing)? (?:the )?mind)\b/, label: 'sleep & nerves' },
  'pain & inflammation': { re: /\b(headaches?|aches?|aching|inflamm\w*|swelling|sore muscles)\b/, label: 'aches & inflammation' },
  skin: { re: /\b(skin|complexion|glow(?:ing)? skin)\b/, label: 'skin' },
  'urinary & kidneys': { re: /\b(kidneys?|bladder|urinary|water retention)\b/, label: 'kidneys & urine' },
  'vitality & nourishment': { re: /\b(tired(?:ness)?|fatigue|run down|recovery|recover(?:ing)?|immune|immunity|vitality)\b/, label: 'vitality & nourishment' },
  'mouth & teeth': { re: /\b(mouth ulcers?|gums|bad breath|toothache)\b/, label: 'mouth & teeth' },
  'liver & spleen': { re: /\b(liver|detox|hangover)\b/, label: 'liver' }
};
function topicEntries(topic, n = 6) { return SAFE.filter(e => (e.topics || []).includes(topic)).sort((a, b) => a.topics.indexOf(topic) - b.topics.indexOf(topic)).slice(0, n); }
for (const [k, v] of Object.entries(TOPIC_Q)) if (!INTENTS[k]) INTENTS[k] = { re: v.re, label: 'for ' + v.label, ids: topicEntries(k, 8).map(e => e.id) };
// Name lookup (flora/fauna): recipe-safe matches, plus non-food/toxic matches so the UI can explain why they are not cooked.
const CAT = (() => { try { return require('../public/data/dioscorides-catalogue.json').entries; } catch { return []; } })();
function findNames(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z ]/g, ' ') + ' ';
  const safe = SAFE.filter(e => [e.name.toLowerCase(), ...e.keywords].some(k => k.length > 2 && (t.includes(' ' + k + ' ') || t.includes(' ' + k + 's '))));
  const other = CAT.filter(e => e.safety !== 'recipe-safe' && [e.name, e.common, e.greek, ...(e.safety === 'historical-only-toxic' ? [String(e.name).split(' ').pop()] : [])].filter(Boolean).some(k => k.length > 3 && t.includes(' ' + k.toLowerCase() + ' ')));
  return { safe, other: other.slice(0, 5).map(e => ({ id: e.id, ref: e.ref, name: e.name, safety: e.safety })) };
}
const isMedicinalCuisine = c => /^medicinal\b/i.test(String(c || ''));
const active = q => !!q && (q.inspirationMode === 'dioscorides' || (q.cuisines || []).some(isMedicinalCuisine) || isMedicinalCuisine(q.cuisine));
function intents(text) { const t = String(text || '').toLowerCase(); return Object.entries(INTENTS).filter(([, v]) => v.re.test(t)).map(([k]) => k); }
const words = s => String(s || '').toLowerCase().match(/[a-z]+(?: [a-z]+)?/g) || [];
function matchesEntry(e, name) { const n = ' ' + String(name || '').toLowerCase().replace(/[^a-z ]/g, ' ') + ' '; return e.keywords.some(k => n.includes(' ' + k + ' ') || n.includes(' ' + k + 's ')); }
function entriesFor(names) { const out = []; for (const nm of names) for (const e of SAFE) if (!out.includes(e) && matchesEntry(e, nm)) out.push(e); return out; }
function banned(name) { const n = String(name || '').toLowerCase(); return EXCLUDED.find(x => new RegExp(`\\b${x}\\b`).test(n)) || null; }
const roleText = e => String(e.summary || e.name).slice(0, 560);
// Grounding entries for the AI: the cook's own ingredients first, then intents, then classic Dioscoridean staples.
function references(q, { top = 6 } = {}) {
  const picked = []; const add = e => { if (e && e.recipeSafe && !picked.includes(e) && picked.length < top) picked.push(e); };
  entriesFor([...(q.include || []), q.dish || '']).forEach(add);
  const it = intents([q.dish, q.brief && q.brief.raw].join(' ')); it.forEach(k => INTENTS[k].ids.slice(0, 3).forEach(id => add(BY_ID[id])));
  ['D1-30', 'D2-101', 'D3-81', 'D3-71', 'D2-129', 'D2-182'].forEach(id => add(BY_ID[id]));
  return picked.map(e => ({ no: e.id, title: `${e.name}, De Materia Medica ${e.ref.split(' ').pop()}`, role: 'primary', text: roleText(e) }));
}
const label = e => `Dioscorides, ${e.ref}: ${e.name}`;
const citation = e => ({ id: e.id, ref: e.ref, name: e.name, label: label(e), url: `/dioscorides.html#${e.id}`, ...(e.caution ? { caution: e.caution } : {}) });
// Citations validated against the data: the entry the model named (if real) plus documented ingredients actually used.
function cite(recipe) {
  const out = []; const m = String(recipe.inspiredBy || '').match(/D?([1-5]-\d+[a-z]?)/); const hit = m && BY_ID['D' + m[1]];
  if (hit && hit.recipeSafe) out.push(hit);
  entriesFor((recipe.ingredients || []).map(i => i.name)).forEach(e => { if (!out.includes(e) && !['D5-18', 'D5-126'].includes(e.id)) out.push(e); });
  const ids = out.map(e => e.id); const dd = out.filter(e => !(e.id === 'D1-138' && (ids.includes('D1-30') || ids.includes('D1-29')) && !(recipe.ingredients || []).some(i => /\bolives?\b/i.test(i.name) && !/oil/i.test(i.name))) && !(e.id === 'D1-29' && ids.includes('D1-30')) && !(e.id === 'D5-7' && ids.includes('D5-11')));
  return dd.slice(0, 5).map(citation);
}
const unsafe = recipe => (recipe.ingredients || []).some(i => banned(i.name));
const RULE = 'MEDICINAL (DIOSCORIDES) CUISINE — build every recipe mainly from the supplied Dioscorides De Materia Medica references (edible plants, grains, fruit, oils, honey, wine, vinegar, dairy) using ancient Greco-Roman methods (decoctions, honeyed wine, oxymel, brines, roasting, barley gruel, olive-oil dressings) adapted to modern UK kitchens. Set inspiredBy to the main reference no (e.g. D2-182). In whyItFits/tips explain the traditional properties Dioscorides ascribed, in historical framing ("Dioscorides held that…"); never claim to treat or cure anything. Never use rue, pennyroyal, wormwood, hemlock, mandrake, poppy, hellebore, henbane or minerals.';
function cuisineDirective(q) { const other = (q.cuisines || []).filter(c => !isMedicinalCuisine(c)); return `Medicinal (Dioscorides)${other.length ? ' fused with ' + other.join(' + ') : ''}. ${RULE}${other.length ? ` Genuinely fuse with ${other.join(', ')} flavours and techniques.` : ''}`; }
function list(qs = {}) {
  const q = String(qs.q || '').toLowerCase().slice(0, 60), cat = String(qs.cat || '');
  const rows = ENTRIES.filter(e => (!cat || e.category === cat) && (!q || (e.name + ' ' + e.greek + ' ' + e.keywords.join(' ') + ' ' + e.excerpt).toLowerCase().includes(q)));
  return { attribution: ATTRIBUTION, disclaimer: DISCLAIMER, count: rows.length, categories: [...new Set(ENTRIES.map(e => e.category))], entries: rows.map(e => ({ id: e.id, ref: e.ref, name: e.name, greek: e.greek, category: e.category, botanical: e.botanical, recipeSafe: e.recipeSafe, caution: e.caution, note: (e.uses || [])[0] || null })) };
}
module.exports = { TOPIC_Q, topicEntries, findNames, CAT, ENTRIES, SAFE, BY_ID, ATTRIBUTION, DISCLAIMER, EXCLUDED, INTENTS, active, intents, references, cite, unsafe, banned, label, cuisineDirective, isMedicinalCuisine, list, RULE };
// Cautious modern notes: well-known nutrition facts only, "may support" wording, no study claims. Keyed by entry id.
const MODERN = {
  'D2-182': 'Adds flavour without salt; contains sulphur compounds such as allicin. As part of a balanced diet it may support heart health.',
  'D2-181': 'A source of fibre (including prebiotic fructans) and flavonoids such as quercetin.', 'D2-179': 'Provides fibre, vitamin K and folate.',
  'D3-81': 'Fennel seed is traditionally used after meals; the bulb provides fibre, potassium and vitamin C.', 'D3-65': 'Aniseed adds sweetness of flavour; used in small culinary amounts.',
  'D3-69': 'Cumin is a flavourful source of iron in small amounts.', 'D3-66': 'Caraway is a traditional after-meal seed; used in small culinary amounts.',
  'D3-71': 'Fresh coriander leaf adds vitamin K and flavour; the seed is a classic warm spice.', 'D3-67': 'Dill adds flavour and small amounts of vitamin C.',
  'D3-41': 'Mint is refreshing; peppermint is widely used for digestive comfort, though it can worsen reflux in some people.',
  'D2-190': 'Ginger is widely used for nausea and may support digestive comfort.', 'D2-189': 'Black pepper contains piperine and adds heat without salt.',
  'D1-13': 'Adds sweetness of flavour without sugar. Use Ceylon cinnamon for regular use: cassia is high in coumarin.', 'D1-12': 'High in coumarin, so keep to culinary amounts.',
  'D1-25': 'A very small amount gives colour and aroma.', 'D2-184': 'Mustard seed adds heat and flavour for very few calories.',
  'D3-44': 'Thyme is aromatic and adds flavour without salt.', 'D3-32': 'Oregano adds flavour and antioxidant compounds in small amounts.', 'D3-40': 'Sage adds flavour; use culinary amounts.',
  'D2-171': 'Basil provides vitamin K and aroma.', 'D3-77': 'Parsley is a good source of vitamins K and C.', 'D3-74': 'Celery provides fibre and potassium and is mostly water.',
  'D1-30': 'Rich in monounsaturated fat. Extra-virgin olive oil also contains polyphenols, and as part of a Mediterranean-style diet it may support heart health.',
  'D1-29': 'Extra-virgin oil is the richest in polyphenols.', 'D1-138': 'Olives provide monounsaturated fat and vitamin E. Brined olives are high in salt.',
  'D2-101': 'Mostly natural sugars. A spoonful in warm water is a traditional comfort for a sore throat; count it as free sugar.',
  'D2-129': 'Lentils are an excellent source of plant protein, fibre, folate and iron, and they may support steady energy and gut health.',
  'D2-126': 'Chickpeas provide plant protein, fibre, folate and iron.', 'D2-127': 'Broad beans provide protein, fibre and folate.', 'D2-130': 'Beans provide protein, fibre and potassium.',
  'D2-108': 'Barley contains beta-glucan fibre, which may support healthy cholesterol levels as part of a balanced diet.', 'D2-107': 'Wholegrain wheat provides fibre and B vitamins.',
  'D2-111': 'Spelt is a wholegrain with fibre and protein. It still contains gluten.', 'D2-117': 'Rice provides easily digested carbohydrate; brown rice adds fibre.', 'D2-119': 'Millet is a gluten-free wholegrain.',
  'D2-121': 'Sesame provides calcium, healthy fats and protein.', 'D1-176': 'Almonds provide vitamin E, magnesium and healthy fats.', 'D1-178': 'Walnuts provide plant omega-3 (ALA).',
  'D1-177': 'Pistachios provide protein, fibre and potassium.', 'D1-179': 'Hazelnuts provide vitamin E and healthy fats.',
  'D1-183': 'Figs provide fibre, potassium and calcium. Dried figs are high in natural sugar.', 'D1-148': 'Dates provide fibre and potassium and are high in natural sugar.',
  'D1-151': 'Pomegranate provides vitamin C and polyphenols.', 'D1-160': 'Quince provides fibre (pectin) and vitamin C when cooked.', 'D1-159': 'Apples provide fibre (pectin) and vitamin C.',
  'D1-167': 'Pears provide fibre.', 'D1-166': 'Citrus provides vitamin C.', 'D5-3': 'Grapes provide hydration and polyphenols.', 'D5-4': 'Raisins provide fibre and iron and are high in natural sugar.',
  'D2-146': 'Cabbage provides vitamins C and K and fibre.', 'D2-149': 'Beetroot provides folate and dietary nitrate.', 'D2-163': 'Cucumber is mostly water and hydrating.',
  'D2-165': 'Lettuce is mostly water and provides folate and vitamin K.', 'D2-150': 'Purslane provides plant omega-3 (ALA) and vitamin C.', 'D2-152': 'Asparagus provides folate and fibre.',
  'D2-137': 'Radishes provide vitamin C.', 'D2-134': 'Turnips provide vitamin C and fibre.', 'D3-83': 'Carrots provide beta-carotene (vitamin A).', 'D2-162': 'Squash and courgettes provide fibre and vitamin C.',
  'D2-144': 'Mallow leaves are edible greens with a soothing, mucilaginous texture.', 'D3-154': 'Chamomile tea is a popular caffeine-free evening drink.',
  'D2-54': 'Eggs provide high-quality protein, vitamin B12 and choline.', 'D2-75': 'Milk provides calcium, protein and iodine.', 'D2-79': 'Cheese provides protein and calcium and can be high in salt.',
  'D2-81': 'Butter is high in saturated fat, so use it in moderation.', 'D2-52': 'Chicken provides lean protein, and a warm broth is a traditional comfort food.', 'D2-35': 'Fish provides protein, and oily fish adds omega-3.',
  'D5-21': 'Vinegar adds sharpness without salt.', 'D5-7': 'Alcohol is not a health food. If you drink, keep within the UK guideline of 14 units a week, and cook it off where possible.', 'D5-11': 'Alcohol is not a health food. If you drink, keep within the UK guideline of 14 units a week.',
  'D5-126': 'Salt is needed only in small amounts. UK adults should keep to under 6 g a day.', 'D3-7': 'A liquorice flavour is fine in small amounts. Large amounts of real liquorice can raise blood pressure.'
};
const INTERACT = { 'D2-182': 'Large amounts of garlic may add to the effect of blood-thinning medicines.', 'D2-190': 'High doses of ginger may interact with blood thinners.', 'D3-7': 'Liquorice can interact with blood-pressure medicines, diuretics and digoxin, and is unsafe in pregnancy in quantity.', 'D1-12': 'Large amounts of cassia (coumarin) are unsuitable for people with liver problems.', 'D1-13': 'Large amounts of cassia-type cinnamon are unsuitable for people with liver problems.', 'D3-77': 'Large amounts of parsley are unsuitable in pregnancy and with warfarin (vitamin K).', 'D2-146': 'People on warfarin should keep intake of vitamin-K-rich greens consistent.', 'D5-7': 'Alcohol interacts with many medicines and is unsafe in pregnancy.', 'D5-11': 'Alcohol interacts with many medicines and is unsafe in pregnancy.' };
const HB_DISCLAIMER = 'Historical uses, not medical advice. These dishes do not diagnose, treat, cure or prevent any condition. For any health condition, pregnancy or medication, see a doctor or pharmacist first.';
function healthBenefits(recipe) {
  const items = cite(recipe).map(c => { const e = BY_ID[c.id];
    return { name: e.name, ref: e.ref, url: c.url, dioscorides: (e.uses || []).slice(0, 3), modern: MODERN[e.id] || 'In normal food amounts it adds flavour and variety to a balanced diet.', cautions: [e.caution, INTERACT[e.id]].filter(Boolean) }; });
  return items.length ? { title: 'Health Benefits (historical & modern)', items, disclaimer: HB_DISCLAIMER } : null;
}
module.exports.healthBenefits = healthBenefits; module.exports.MODERN = MODERN; module.exports.HB_DISCLAIMER = HB_DISCLAIMER;
