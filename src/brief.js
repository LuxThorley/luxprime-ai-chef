'use strict';
// Free-text brief → structured hints. Deterministic and conservative: only extracts what is clearly stated.
// Returns { raw, hints: { key: { value, label } }, question }. Users can drop any hint by key (ignore list).
const DIET_WORDS = { vegetarian: /\bveggie|vegetarian\b/i, vegan: /\bvegan|plant[- ]based\b/i, 'gluten-free': /\bgluten[- ]?free|coeliac|celiac\b/i, 'dairy-free': /\bdairy[- ]?free|lactose[- ]?free|no dairy\b/i, 'nut-free': /\bnut[- ]?free|no nuts?\b/i, halal: /\bhalal\b/i };
const NUM = '(\\d+(?:\\.\\d+)?)';
const MOODS = ['cosy', 'comforting', 'romantic', 'light', 'hearty', 'fresh', 'indulgent', 'healthy', 'impressive', 'celebration', 'date night', 'party', 'picnic', 'lazy', 'quick', 'summery', 'wintry', 'festive', 'spicy', 'smoky', 'sticky', 'sharp', 'crispy', 'crunchy', 'creamy', 'zesty', 'tangy', 'rich', 'silky', 'charred', 'sweet', 'savoury', 'umami', 'herby', 'fiery'];
function parseBrief(input) {
  const raw = String(input || '').slice(0, 1000); const t = raw.toLowerCase(); const h = {};
  const set = (k, value, label) => { h[k] = { value, label }; };
  let m;
  if ((m = t.match(new RegExp(`(?:under|below|less than|max(?:imum)?|no more than|<)\\s*${NUM}\\s*(?:k?cal|calories)`))) || (m = t.match(new RegExp(`${NUM}\\s*(?:k?cal|calories)\\s*(?:or less|max|maximum)?`)))) set('kcalMax', Math.round(+m[1]), `≤ ${Math.round(+m[1])} kcal`);
  if ((m = t.match(new RegExp(`(?:at least|min(?:imum)?|over|more than|>)?\\s*${NUM}\\s*g(?:rams?)?\\s*(?:of\\s*)?protein`))) || (m = t.match(new RegExp(`protein\\s*(?:of\\s*)?(?:at least\\s*)?${NUM}\\s*g`)))) set('proteinMin', Math.round(+m[1]), `≥ ${Math.round(+m[1])} g protein`);
  if ((m = t.match(new RegExp(`£\\s*${NUM}`))) || (m = t.match(new RegExp(`${NUM}\\s*(?:pounds|quid|gbp)\\b`)))) set('budgetGBP', +(+m[1]).toFixed(2), `budget £${+(+m[1]).toFixed(2)}${/per (head|person|portion)/.test(t) ? ' pp' : ''}`);
  if ((m = t.match(new RegExp(`${NUM}\\s*(?:-|to)?\\s*(?:hours?|hrs?)\\b`)))) set('maxMinutes', Math.round(+m[1] * 60), `≤ ${+m[1]} h`);
  else if ((m = t.match(new RegExp(`${NUM}\\s*(?:minutes?|mins?|m)\\b`)))) set('maxMinutes', Math.round(+m[1]), `≤ ${Math.round(+m[1])} min`);
  else if (/\b(quick|fast|speedy|in a hurry|weeknight)\b/.test(t)) set('maxMinutes', 30, '≤ 30 min (quick)');
  if ((m = t.match(new RegExp(`(?:for|serves?|feeds?)\\s*${NUM}\\s*(?:people|persons|guests|of us|adults|kids)?`))) && +m[1] >= 1 && +m[1] <= 12 && !/min|hour|kcal|cal|£/.test(t.slice(m.index, m.index + m[0].length + 4))) set('servings', +m[1], `serves ${+m[1]}`);
  if ((m = t.match(/spice(?:\s*level)?\s*(?:of\s*)?(\d{1,2})\s*(?:\/\s*10|out of 10)?/)) || (m = t.match(/(\d{1,2})\s*(?:\/\s*10|out of 10)\s*(?:spic|heat|hot)/))) { const v = Math.max(0, Math.min(10, +m[1])); set('spice', v, `spice ${v}/10`); }
  else if (/\b(mild|not spicy|no chilli|no chili)\b/.test(t)) set('spice', 2, 'mild'); else if (/\b(very spicy|fiery|blow my head off|extra hot)\b/.test(t)) set('spice', 8, 'very spicy');
  const diets = Object.entries(DIET_WORDS).filter(([, re]) => re.test(t)).map(([d]) => d); if (diets.length) set('diets', diets, diets.join(', '));
  const avoid = []; const re = /\b(?:no|without|avoid(?:ing)?|hate|allergic to|can't eat|cannot eat|not)\s+([a-z][a-z ]{1,24}?)(?=[,.;!?]|\s+(?:and|or|but|please|for|in|with)\b|$)/g;
  while ((m = re.exec(t))) { const w = m[1].trim(); if (!/^(more|too|very|spicy|dairy|nuts?|gluten|a|the|much|long|fuss|time|fussy)$/.test(w) && !/^(more|than)\b/.test(w)) avoid.push(w); }
  if (avoid.length) set('avoid', [...new Set(avoid)].slice(0, 8), 'avoid ' + [...new Set(avoid)].slice(0, 8).join(', '));
  const moods = MOODS.filter(w => new RegExp(`\\b${w}\\b`).test(t)); if (moods.length) set('moods', moods.slice(0, 6), moods.slice(0, 6).join(' · '));
  if ((m = t.match(/(?:\b(?:like|reminds? me of|just like)\s+|^)((?:my|that|the) [a-z' ]{3,50}?)(?=\s*(?:[,.;!?]|\bbut\b|\band\b|\bwith\b|$))/)) && /\b(my|that)\b/.test(m[1])) set('memory', m[1].trim(), `memory: ${m[1].trim()}`);
  const question = /\?\s*$|^(what|how|can|could|which|why|is|should|do|does|any)\b/.test(t.trim());
  return { raw, hints: h, question };
}
const without = (b, ignore = []) => ({ ...b, hints: Object.fromEntries(Object.entries(b.hints).filter(([k]) => !ignore.includes(k))) });
// Merge extracted hints into the structured query: only ever tighten (shorter time, union of diets/excludes).
function applyHints(q, b) {
  const h = b.hints; const out = { ...q };
  if (h.maxMinutes) out.maxMinutes = Math.max(5, Math.min(out.maxMinutes || 480, h.maxMinutes.value));
  if (h.servings) out.servings = h.servings.value;
  if (h.diets) out.diets = [...new Set([...(out.diets || []), ...h.diets.value])];
  if (h.avoid) out.exclude = [...new Set([...(out.exclude || []), ...h.avoid.value])].slice(0, 20);
  return out;
}
const summary = b => Object.entries(b.hints).map(([key, v]) => ({ key, label: v.label }));
module.exports = { parseBrief, without, applyHints, summary };
