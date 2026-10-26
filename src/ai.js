'use strict';
const K = require('./keywords');
// Provider-agnostic AI chef layer with strict JSON schema validation, retry and offline fallback.
const { z } = require('zod');
const { rank, shoppingList } = require('./ranker');
const { UK14 } = require('./recipes');
const { isUnsafe, enforceAllergens } = require('./safety');
const escoffier = require('./escoffier');
const dioscorides = require('./dioscorides');

const Ingredient = z.object({ name: z.string().min(1).max(120), qty: z.number().nonnegative().nullable(), unit: z.enum(['g','ml','tsp','tbsp','x','pinch','']) });
const Recipe = z.object({
  title: z.string().min(2).max(120), cuisine: z.string().max(40), difficulty: z.enum(['easy','medium','hard']),
  totalMinutes: z.number().int().positive().max(600), servings: z.number().int().min(1).max(20),
  matchScore: z.number().min(0).max(100), whyItFits: z.string().max(400),
  ingredients: z.array(Ingredient).min(2).max(30),
  steps: z.array(z.object({ text: z.string().min(3).max(500), timerMinutes: z.number().int().positive().max(600).nullable() })).min(2).max(25),
  allergens: z.array(z.enum(UK14)),
  nutritionPerServing: z.object({ kcal: z.number(), proteinG: z.number(), carbsG: z.number(), fatG: z.number() }),
  substitutions: z.array(z.object({ ingredient: z.string(), swap: z.string() })).max(15),
  tips: z.array(z.string().max(300)).max(10).optional(),
  inspiredBy: z.union([z.string().max(40), z.number()]).nullable().optional(),
  tagline: z.string().max(200).optional(), chefSecret: z.string().max(400).optional(), pairing: z.string().max(300).optional(), nutritionPartial: z.boolean().optional()
});
const ResponseSchema = z.object({ recipes: z.array(Recipe).min(1).max(5), answer: z.string().max(1200).nullable().optional(), blessing: z.string().max(600).nullable().optional(), closing: z.string().max(600).nullable().optional(), provider: z.string().max(40).optional(), model: z.string().max(80).optional(), failovers: z.array(z.any()).optional() });

function config() {
  const p = (process.env.AI_PROVIDER || 'none').toLowerCase();
  if (p === 'malcolm') return {
    provider: 'malcolm', url: process.env.MALCOLM_AI_URL, key: process.env.MALCOLM_AI_KEY,
    model: process.env.MALCOLM_AI_MODEL || 'malcolm-chef', mode: process.env.MALCOLM_AI_MODE || 'openai'
  };
  if (p === 'openai') return {
    provider: 'openai', url: (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '') + '/chat/completions',
    key: process.env.AI_API_KEY, model: process.env.AI_MODEL || 'gpt-4o-mini', mode: 'openai'
  };
  return { provider: 'none' };
}
function aiEnabled() { const c = config(); return c.provider !== 'none' && !!c.url; }

const SYSTEM = `You are Malcolm, the AI chef of AIchef.food. Return ONLY JSON matching:
{"recipes":[{"title","cuisine","difficulty":"easy|medium|hard","totalMinutes":int,"servings":int,"matchScore":0-100,"whyItFits",
"ingredients":[{"name","qty":number|null,"unit":"g|ml|tsp|tbsp|x|pinch|"}],"steps":[{"text","timerMinutes":int|null}],
"allergens":[UK 14 allergen names: ${UK14.join(', ')}],"nutritionPerServing":{"kcal","proteinG","carbsG","fatG"},
"substitutions":[{"ingredient","swap"}],"tips":[string]}]}
Rules: 3-5 real, tested-style recipes ranked best first; UK metric quantities scaled to the requested servings; British English;
respect ALL dietary filters and exclusions strictly; never exceed the time budget by more than 10%; include safe cooking temperatures
for meat/fish/eggs; never suggest unsafe practices (raw flour, pink poultry, honey for babies, wild foraging, washing raw chicken);
nutrition is an estimate. If kids mode, keep steps simple and mark adult-only steps with "(grown-up job)".`;

const REF_RULE = `\n${escoffier.PRINCIPLES} Add "inspiredBy":"<Escoffier number>"|null to each recipe.`;
const MODE_RULE = {
  escoffier: `\nINSPIRATION MODE = ESCOFFIER (strictly classical): every recipe must be a faithful adaptation of the closest supplied Escoffier entry to the cook's ingredients and needs — keep his technique, sauce/fond logic and flavour structure; only modernise measures, timings and food safety. Set "inspiredBy" on every recipe. If fusion cuisines are requested, keep the classical base and bring the other cuisines through seasoning or garnish only.`,
  blend: `\nINSPIRATION MODE = MALCOLM & ESCOFFIER: blend Escoffier's techniques and themes with your own modern creativity and contemporary flavour combinations; cite an entry via "inspiredBy" only when a recipe genuinely draws on it.`,
  dioscorides: `\nINSPIRATION MODE = DIOSCORIDES: Pedanius Dioscorides (c. 40–90 AD) is your primary influence. ${dioscorides.RULE}`,
  malcolm: `\nINSPIRATION MODE = MALCOLM AI CHEF ONLY: free modern creativity with no Escoffier grounding; set "inspiredBy" to null.`
};
const BRIEF_RULE = `\nThe "brief" field is the cook's own words. Honour every explicit constraint in brief.constraints: kcalMax = max kcal per serving, proteinMin = min protein g per serving, budgetGBP = total ingredient budget in pounds, spice = heat 0-10, avoid = never use, moods = flavours/textures/occasion to deliver, memory = an experience to evoke. Treat the rest of brief.raw as creative direction. If brief.question is true, add a top-level "answer": a direct, specific, useful answer in 2-4 sentences (no blessing), then give the recipes.`;
function buildUserPrompt(q, refs) {
  const med = dioscorides.active(q);
  return JSON.stringify({ ...(refs && refs.length ? { references: refs.map(r => ({ no: r.no, title: r.title, role: r.role, text: r.text })) } : {}),
    include: q.include, exclude: q.exclude, dish: q.dish || null, maxMinutes: q.maxMinutes, difficulty: q.difficulty || 'any',
    servings: q.servings, diets: q.diets, cuisine: med ? dioscorides.cuisineDirective(q) : (q.cuisine || 'any'), ...(med ? { medicinal: { rule: dioscorides.RULE, disclaimer: dioscorides.DISCLAIMER } } : {}), kidsMode: !!q.kidsMode, count: q.limit || 4,
    ...(q.cuisines && q.cuisines.length > 1 ? { cuisines: q.cuisines, fusion: `Create fusion dishes that genuinely blend ${q.cuisines.join(', ')} techniques and flavours. Set "cuisine" to "${q.cuisines.join('–')} fusion" and let the title reflect the fusion where natural.` } : {}),
    ...(q.inspiration && (q.inspiration.topRated || []).length ? { communityFavourites: q.inspiration.topRated.map(t => `${t.title} (${t.cuisine || 'any'}, ${t.avg}★ from ${t.count})`), inspirationRule: 'Optional loose inspiration only: members rate these highly. Never copy them; the request above always wins.' } : {}),
    ...(q.inspiration && (q.inspiration.likes || []).length ? { memberLikes: q.inspiration.likes } : {}),
    inspirationMode: q.inspirationMode || 'blend',
    ...(q.keywords && q.keywords.length ? { keywords: q.keywords, keywordRule: K.promptRule(q.keywords) } : {}),
    ...(K.cuisineRules(q.cuisines).length ? { styleCuisines: K.cuisineRules(q.cuisines) } : {}),
    ...((q.diets || []).includes('slimming') ? { slimming: K.SLIMMING_RULE } : {}),
    ...(q.brief && q.brief.raw ? { brief: q.brief } : {})
  });
}
function extractJson(text) {
  if (typeof text !== 'string') return text;
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); const s = m ? m[1] : text;
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  return JSON.parse(s.slice(a, b + 1));
}
async function callProvider(c, messages, fetchImpl = fetch) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), +process.env.AI_TIMEOUT_MS || 60000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (c.key) headers.Authorization = `Bearer ${c.key}`;
    if (c.mode === 'lattice' || c.mode === 'recipes') {
      // Malcolm AI worker: POST {base}/v1/recipes with the structured query; returns {recipes:[...]} (Workers AI).
      const base = String(c.url).replace(/\/+$/, '').replace(/\/(omni\/command|v1\/recipes)$/, '');
      const query = JSON.parse(messages[1].content);
      const res = await fetchImpl(base + '/v1/recipes', { method: 'POST', headers, body: JSON.stringify(query), signal: ctrl.signal });
      if (!res.ok) { let d = ''; try { const j = await res.json(); d = (j && (j.detail || j.error)) || ''; } catch {} throw new Error(`AI HTTP ${res.status}${d ? ': ' + String(d).slice(0, 240) : ''}`); }
      return res.json();
    }
    const body = c.mode === 'native'
      ? { task: 'recipes', model: c.model, system: messages[0].content, query: JSON.parse(messages[1].content), history: messages.slice(2) }
      : { model: c.model, messages, temperature: 0.4, response_format: { type: 'json_object' } };
    const res = await fetchImpl(c.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
    const data = await res.json();
    if (c.mode === 'native') return data; // expects {recipes:[...]}
    return data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  } finally { clearTimeout(t); }
}

async function generate(q, { fetchImpl, retries = 2, references = [] } = {}) {
  const c = config();
  if (!aiEnabled()) return { source: 'offline', recipes: offlineTag(q, rank(q, { limit: q.limit || 4 })) };
  const mode = MODE_RULE[q.inspirationMode] ? q.inspirationMode : 'blend';
  const med = dioscorides.active(q);
  if (med) { const dref = dioscorides.references(q); const esc = mode === 'malcolm' || mode === 'dioscorides' ? [] : references.filter(r => !String(r.no).startsWith('D')).slice(0, 2); references = [...dref.slice(0, 6 - esc.length), ...esc]; }
  const messages = [{ role: 'system', content: SYSTEM + (references.length && mode !== 'malcolm' && mode !== 'dioscorides' ? REF_RULE : '') + MODE_RULE[mode] + (med && mode !== 'dioscorides' ? '\n' + dioscorides.RULE : '') + (q.brief && q.brief.raw ? BRIEF_RULE : '') }, { role: 'user', content: buildUserPrompt(q, references) }];
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await callProvider(c, messages, fetchImpl);
      const j = extractJson(raw); if (j && Array.isArray(j.recipes)) j.recipes.forEach(r => { if (r && typeof r.cuisine === 'string' && r.cuisine.length > 40) r.cuisine = med ? (q.cuisines || []).length > 1 ? q.cuisines.join('–').slice(0, 33) + ' fusion' : 'Medicinal' : r.cuisine.slice(0, 40); });
      const parsed = ResponseSchema.parse(j);
      const recipes = parsed.recipes.filter(r => !isUnsafe(r) && !(med && dioscorides.unsafe(r))).map((r, i) => {
        enforceAllergens(r);
        const ingredients = r.ingredients.map(x => ({ ...x, display: x.qty == null ? x.name : (x.unit === 'x' ? `${x.qty} ${x.name}` : `${x.qty} ${x.unit} ${x.name}`) }));
        const { inspiredBy, ...rest } = r; const esc = mode === 'malcolm' || mode === 'dioscorides' || /^D/i.test(String(inspiredBy || '')) ? null : escoffier.cite(r, references);
        const dio = med || mode === 'dioscorides' ? dioscorides.cite(r) : null;
        return {
          ...rest, ...(esc ? { escoffier: esc } : {}), ...(dio ? { dioscorides: dio, medicinalNote: dioscorides.DISCLAIMER, healthBenefits: dioscorides.healthBenefits(r), cuisine: medCuisine(q) } : {}), id: require('./community').aiId(r), ingredients, baseServings: r.servings,
          steps: r.steps.map((s, n) => ({ n: n + 1, ...s })),
          nutritionPerServing: { ...r.nutritionPerServing, isEstimate: true },
          diet: Object.fromEntries((q.diets || []).map(d => [d, true])),
          shoppingList: shoppingList({ ingredients }, q.include || []), source: c.provider === 'malcolm' ? 'Malcolm AI' : 'AI chef'
        };
      });
      if (!recipes.length) throw new Error('All AI recipes failed safety checks');
      return { source: c.provider, recipes, answer: parsed.answer || null, blessing: parsed.blessing || null, closing: parsed.closing || null, meta: { provider: parsed.provider || null, model: parsed.model || null, failovers: (parsed.failovers || []).length } };
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? new Error(`AI timeout after ${+process.env.AI_TIMEOUT_MS || 60000} ms`) : e;
      messages.push({ role: 'user', content: `Your previous reply was invalid (${String(e.message).slice(0, 300)}). Reply again with ONLY valid JSON matching the schema.` });
    }
  }
  return { source: 'offline', fallbackReason: String(lastErr && lastErr.message), recipes: offlineTag(q, rank(q, { limit: q.limit || 4 })) };
}
const medCuisine = q => { const o = (q.cuisines || []).filter(c => !dioscorides.isMedicinalCuisine(c)); return o.length ? ('Medicinal–' + o.join('–')).slice(0, 33) + ' fusion' : 'Medicinal'; };
// Offline/fallback recipes still get Dioscorides citations + the historical note when Medicinal is on.
function offlineTag(q, recipes) {
  if (!dioscorides.active(q)) return recipes;
  return recipes.filter(r => !dioscorides.unsafe(r)).map(r => ({ ...r, dioscorides: dioscorides.cite(r), medicinalNote: dioscorides.DISCLAIMER, healthBenefits: dioscorides.healthBenefits(r) }));
}
module.exports = { generate, aiEnabled, config, ResponseSchema, extractJson, buildUserPrompt, MODE_RULE };
