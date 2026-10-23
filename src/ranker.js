'use strict';
// Deterministic offline ranking engine: ingredient overlap, dish text match, time, difficulty, diet, cuisine, kids.
const { RECIPES, scale } = require('./recipes');
const DIFF = { easy: 1, medium: 2, hard: 3 };
const PANTRY = ['salt','pepper','water','olive oil','vegetable oil','sugar'];
const norm = s => String(s || '').toLowerCase().trim().replace(/s\b/g, '');
const words = s => norm(s).split(/[^a-z]+/).filter(w => w.length > 2);

function ingMatch(want, ingName) {
  const a = norm(want), b = norm(ingName);
  return b.includes(a) || a.includes(b) || words(a).some(w => words(b).includes(w));
}
function shoppingList(recipe, have) {
  return recipe.ingredients.filter(i => !PANTRY.some(p => norm(i.name) === norm(p)) && !have.some(h => ingMatch(h, i.name))).map(i => i.display || i.name);
}

function rank(q, { limit = 5, pool = RECIPES } = {}) {
  const include = (q.include || []).map(String), exclude = (q.exclude || []).map(String);
  const diets = q.diets || [], maxTime = q.maxMinutes || 999, diff = q.difficulty;
  const dishWords = words(q.dish);
  const results = [];
  for (const r of pool) {
    // hard filters
    if (diets.some(d => !r.diet[d])) continue;
    if (exclude.some(x => r.ingredients.some(i => ingMatch(x, i.name)))) continue;
    if (q.excludeAllergens && q.excludeAllergens.some(a => r.allergens.includes(a))) continue;
    if (r.totalMinutes > maxTime * 1.25) continue;
    let score = 0; const why = [];
    // ingredient overlap (0-45)
    if (include.length) {
      const hits = include.filter(x => r.ingredients.some(i => ingMatch(x, i.name)));
      if (!hits.length && !dishWords.length) continue;
      score += 45 * hits.length / include.length;
      if (hits.length) why.push(`uses ${hits.length}/${include.length} of your ingredients (${hits.join(', ')})`);
    } else score += 20;
    // dish text (0-30)
    if (dishWords.length) {
      const hay = words([r.title, r.cuisine, r.tags.join(' '), r.ingredients.map(i => i.name).join(' ')].join(' '));
      const titleW = words(r.title);
      const hit = dishWords.filter(w => hay.includes(w)).length, th = dishWords.filter(w => titleW.includes(w)).length;
      const s = 30 * Math.min(1, (hit + th) / (dishWords.length * 1.5));
      if (!hit && !include.length) continue;
      score += s; if (hit) why.push(`matches “${q.dish}”`);
    } else score += 10;
    // time (0-12)
    if (r.totalMinutes <= maxTime) { score += 12; if (q.maxMinutes) why.push(`ready in ${r.totalMinutes} min (within your ${maxTime})`); }
    else score += 12 * (1 - (r.totalMinutes - maxTime) / (maxTime * 0.25));
    // difficulty (0-8)
    if (diff) { const d = Math.abs(DIFF[r.difficulty] - DIFF[diff]); score += [8, 3, 0][d]; if (!d) why.push(`${r.difficulty} difficulty as requested`); } else score += 5;
    // cuisine (0-5)
    { const cs = (q.cuisines && q.cuisines.length ? q.cuisines : (q.cuisine && q.cuisine !== 'any' ? [q.cuisine] : [])).map(norm); if (cs.length && cs.includes(norm(r.cuisine))) { score += 5; why.push(`${r.cuisine} cuisine`); } }
    // kids (0-5)
    if (q.kidsMode) { if (r.kidFriendly) { score += 5; why.push('kid-friendly'); } else score -= 5; }
    if (diets.length) why.push(`suits ${diets.join(', ')}`);
    results.push({ r, score: Math.max(0, Math.min(100, Math.round(score))), why });
  }
  results.sort((a, b) => b.score - a.score || a.r.totalMinutes - b.r.totalMinutes || a.r.title.localeCompare(b.r.title));
  return results.slice(0, limit).map(({ r, score, why }) => {
    const s = scale(r, q.servings || r.baseServings);
    return { ...s, matchScore: score, whyItFits: why.join('; ') || 'a well-balanced all-rounder', shoppingList: shoppingList(s, include) };
  });
}
module.exports = { rank, shoppingList, ingMatch };
