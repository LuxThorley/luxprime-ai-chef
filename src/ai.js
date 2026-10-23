'use strict';
// Provider-agnostic AI chef layer with strict JSON schema validation, retry and offline fallback.
const { z } = require('zod');
const { rank, shoppingList } = require('./ranker');
const { UK14 } = require('./recipes');
const { isUnsafe, enforceAllergens } = require('./safety');
const escoffier = require('./escoffier');

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
const ResponseSchema = z.object({ recipes: z.array(Recipe).min(1).max(5), blessing: z.string().max(600).nullable().optional(), closing: z.string().max(600).nullable().optional(), provider: z.string().max(40).optional(), model: z.string().max(80).optional(), failovers: z.array(z.any()).optional() });

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
function buildUserPrompt(q, refs) {
  return JSON.stringify({ ...(refs && refs.length ? { references: refs.map(r => ({ no: r.no, title: r.title, role: r.role, text: r.text })) } : {}),
    include: q.include, exclude: q.exclude, dish: q.dish || null, maxMinutes: q.maxMinutes, difficulty: q.difficulty || 'any',
    servings: q.servings, diets: q.diets, cuisine: q.cuisine || 'any', kidsMode: !!q.kidsMode, count: q.limit || 4
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
  if (!aiEnabled()) return { source: 'offline', recipes: rank(q, { limit: q.limit || 4 }) };
  const messages = [{ role: 'system', content: SYSTEM + (references.length ? REF_RULE : '') }, { role: 'user', content: buildUserPrompt(q, references) }];
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await callProvider(c, messages, fetchImpl);
      const parsed = ResponseSchema.parse(extractJson(raw));
      const recipes = parsed.recipes.filter(r => !isUnsafe(r)).map((r, i) => {
        enforceAllergens(r);
        const ingredients = r.ingredients.map(x => ({ ...x, display: x.qty == null ? x.name : (x.unit === 'x' ? `${x.qty} ${x.name}` : `${x.qty} ${x.unit} ${x.name}`) }));
        const { inspiredBy, ...rest } = r; const esc = escoffier.cite(r, references);
        return {
          ...rest, ...(esc ? { escoffier: esc } : {}), id: `ai-${Date.now()}-${i}`, ingredients, baseServings: r.servings,
          steps: r.steps.map((s, n) => ({ n: n + 1, ...s })),
          nutritionPerServing: { ...r.nutritionPerServing, isEstimate: true },
          diet: Object.fromEntries((q.diets || []).map(d => [d, true])),
          shoppingList: shoppingList({ ingredients }, q.include || []), source: c.provider === 'malcolm' ? 'Malcolm AI' : 'AI chef'
        };
      });
      if (!recipes.length) throw new Error('All AI recipes failed safety checks');
      return { source: c.provider, recipes, blessing: parsed.blessing || null, closing: parsed.closing || null, meta: { provider: parsed.provider || null, model: parsed.model || null, failovers: (parsed.failovers || []).length } };
    } catch (e) {
      lastErr = e && e.name === 'AbortError' ? new Error(`AI timeout after ${+process.env.AI_TIMEOUT_MS || 60000} ms`) : e;
      messages.push({ role: 'user', content: `Your previous reply was invalid (${String(e.message).slice(0, 300)}). Reply again with ONLY valid JSON matching the schema.` });
    }
  }
  return { source: 'offline', fallbackReason: String(lastErr && lastErr.message), recipes: rank(q, { limit: q.limit || 4 }) };
}
module.exports = { generate, aiEnabled, config, ResponseSchema, extractJson };
