'use strict';
// "Ask Malcolm": conversational layer on top of the recipe engine.
// The chat brain is any JSON-capable LLM passed in as llm(messages, {maxTokens}) -> string (Workers AI on the live site);
// recipes themselves still come from the Malcolm recipe engine via ai.generate. Everything degrades to a heuristic offline mode.
const { z } = require('zod');
const briefMod = require('./brief');

const PERSONA = `You are Malcolm, the AI chef of AIchef.food: a warm, witty, deeply expert British head chef (classically trained, Escoffier-literate, modern and playful). British English, metric units, UK supermarket ingredients. Be genuinely useful first, charming second. Never give unsafe food advice (pink poultry, raw flour, honey for babies, washing raw chicken). Keep it concise.`;

const LIMITS = { free: 8, paid: 60, windowSec: 3600, maxMessage: 500, maxHistory: 12, maxTokens: 700 };

const Turn = z.object({ role: z.enum(['user', 'malcolm']), text: z.string().trim().min(1).max(1200) });
const ChatRequest = z.object({
  message: z.string().trim().min(1, 'Type a message for Malcolm').max(LIMITS.maxMessage, `Keep it under ${LIMITS.maxMessage} characters`),
  history: z.array(Turn).max(40).default([]),
  context: z.record(z.any()).default({}),
  recipes: z.array(z.object({ title: z.string().max(140), id: z.string().max(80).optional() })).max(5).default([]),
  recipe: z.object({ title: z.string().max(140), ingredients: z.array(z.string().max(200)).max(40).default([]), steps: z.array(z.string().max(600)).max(30).default([]), totalMinutes: z.number().optional(), servings: z.number().optional() }).optional()
});
const Changes = z.object({
  addDiets: z.array(z.string().max(30)).max(6).optional(), addKeywords: z.array(z.string().max(40)).max(12).optional(), exclude: z.array(z.string().max(40)).max(10).optional(), include: z.array(z.string().max(40)).max(10).optional(),
  maxMinutes: z.number().int().min(5).max(480).nullable().optional(), servings: z.number().int().min(1).max(12).nullable().optional(),
  spice: z.number().int().min(0).max(10).nullable().optional(), budgetGBP: z.number().min(1).max(500).nullable().optional(), kcalMax: z.number().min(100).max(3000).nullable().optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).nullable().optional(), note: z.string().max(200).nullable().optional()
}).partial();
const ChatOut = z.object({ reply: z.string().min(1).max(1500), action: z.enum(['answer', 'regenerate', 'clarify']).default('answer'), changes: Changes.default({}), suggestions: z.array(z.string().max(60)).max(5).default([]) });

const DIETS = { slimming: 'slimming', 'weight loss': 'slimming', 'lose weight': 'slimming', vegan: 'vegan', vegetarian: 'vegetarian', veggie: 'vegetarian', 'gluten free': 'gluten-free', 'gluten-free': 'gluten-free', coeliac: 'gluten-free', 'dairy free': 'dairy-free', 'dairy-free': 'dairy-free', 'no dairy': 'dairy-free', 'lactose': 'dairy-free', 'nut free': 'nut-free', 'nut-free': 'nut-free', 'no nuts': 'nut-free', halal: 'halal' };
const isQuestion = s => /\?\s*$|^(what|which|how|why|when|can|could|should|is|are|do|does|would|will|any)\b/i.test(String(s).trim());

// Deterministic understanding of common refinements; used offline and merged with the LLM's view.
function parseRefinement(message) {
  const m = String(message || '').toLowerCase(); const ch = {}; const b = briefMod.parseBrief(message);
  const diets = new Set(); for (const [k, v] of Object.entries(DIETS)) if (m.includes(k)) diets.add(v); if (/make it vegan|go vegan/.test(m)) diets.add('vegan');
  if (diets.size) ch.addDiets = [...diets];
  { const km = m.match(/\b(?:more|make it(?: more)?|keywords?:?|add keywords?)\s+([a-z][a-z ,\-]{2,60}?)(?:[.!?]|$)/); if (km && !/^(spic|heat|cheap|quick|fast|filling|protein|veg|time)/.test(km[1])) { const kws = require('./keywords').parseKeywords(km[1]).filter(k => !Object.keys(DIETS).includes(k) && !/vegan|vegetarian/.test(k)); if (kws.length) ch.addKeywords = kws; } }
  const ex = []; const swap = m.match(/\b(?:swap|replace|lose|ditch|without|skip|no)\s+(?:the\s+)?([a-z][a-z \-]{1,30}?)(?:\s+(?:for|with)\b|[,.!?]|$)/);
  if (swap && !/^(dairy|nuts?|meat|gluten)$/.test(swap[1].trim())) ex.push(swap[1].trim());
  const inc = m.match(/\b(?:swap|replace)\s+(?:the\s+)?[a-z \-]{1,30}?\s+(?:for|with)\s+(?:some\s+)?([a-z][a-z \-]{1,30}?)(?:[,.!?]|$)/); if (inc) ch.include = [inc[1].trim()];
  if (b.hints.avoid) ex.push(...b.hints.avoid.value); if (ex.length) ch.exclude = [...new Set(ex)].slice(0, 10);
  if (/spicier|more heat|hotter|more spice|kick/.test(m)) ch.spice = 8; else if (/milder|less spic|not spicy|less heat/.test(m)) ch.spice = 2;
  if (b.hints.spice) ch.spice = b.hints.spice.value;
  if (/cheaper|budget|less expensive|frugal/.test(m)) ch.budgetGBP = b.hints.budgetGBP ? b.hints.budgetGBP.value : 8; else if (b.hints.budgetGBP) ch.budgetGBP = b.hints.budgetGBP.value;
  if (/quicker|faster|less time|in a hurry/.test(m)) ch.maxMinutes = 20; if (b.hints.maxMinutes) ch.maxMinutes = b.hints.maxMinutes.value;
  if (b.hints.servings) ch.servings = b.hints.servings.value; if (b.hints.kcalMax) ch.kcalMax = b.hints.kcalMax.value;
  if (/lighter|healthier/.test(m)) ch.kcalMax = ch.kcalMax || 550; if (/easier|simpler/.test(m)) ch.difficulty = 'easy';
  const refine = Object.keys(ch).length > 0 || /\b(make it|instead|another|different|more|less|swap|again|other options|something else)\b/.test(m);
  const wantsRecipes = refine && !(isQuestion(m) && !Object.keys(ch).length);
  return { changes: ch, refine: wantsRecipes, question: isQuestion(m) };
}

// Apply changes to a search query. Everything only tightens: diets/excludes accumulate, time only shortens.
function applyChanges(q, ch = {}) {
  const n = { ...q, diets: [...new Set([...(q.diets || []), ...(ch.addDiets || []).filter(d => Object.values(DIETS).includes(d))])], exclude: [...new Set([...(q.exclude || []), ...(ch.exclude || [])])].slice(0, 20) };
  if (ch.include && ch.include.length) n.include = [...new Set([...(q.include || []), ...ch.include])].filter(x => !n.exclude.includes(x)).slice(0, 20);
  else n.include = (q.include || []).filter(x => !n.exclude.includes(x));
  if (ch.addKeywords && ch.addKeywords.length) n.keywords = [...new Set([...(q.keywords || []), ...ch.addKeywords])].slice(0, 12); else if (q.keywords) n.keywords = q.keywords;
  if (ch.maxMinutes) n.maxMinutes = Math.min(q.maxMinutes || 480, ch.maxMinutes);
  if (ch.servings) n.servings = ch.servings; if (ch.difficulty) n.difficulty = ch.difficulty;
  const extra = [ch.spice != null && `spice ${ch.spice}/10`, ch.budgetGBP && `under £${ch.budgetGBP}`, ch.kcalMax && `under ${ch.kcalMax} kcal`, ch.note].filter(Boolean);
  if (extra.length) n.dish = [String(q.dish || '').trim(), extra.join(', ')].filter(Boolean).join(' — ').slice(0, 1000);
  return n;
}

const VAGUE = /^(food|dinner|lunch|breakfast|tea|supper|something|anything|something nice|something tasty|surprise me|idk|dunno|whatever|hungry|help|ideas?|meal|recipe|recipes|cook|nice|good food|yummy)[.!? ]*$/i;
// One clarifying question only when the request is genuinely ambiguous (no ingredients and an empty or contentless brief).
function clarify(q) {
  const d = String(q.dish || '').trim();
  if ((q.include || []).length || (d && !VAGUE.test(d))) return null;
  return { question: d ? `Happy to help — “${d}” leaves the whole larder open! What are you in the mood for?` : 'Let’s get cooking — what are you in the mood for?',
    chips: ['Something quick (20 min)', 'Cosy comfort food', 'Light & healthy', 'Impress a date', 'Use up the fridge', 'Spicy & bold'] };
}

function summariseContext(ctx = {}) {
  return { ...(require('./dioscorides').active({ cuisines: ctx.cuisines || [], inspirationMode: ctx.inspirationMode }) ? { medicinal: 'Medicinal (Dioscorides) is on: ground answers in De Materia Medica, cite entries as "Dioscorides, De Materia Medica II.xx", frame properties historically ("Dioscorides held that…"), never claim to treat or cure, add a one-line not-medical-advice note and pregnancy/allergy cautions where relevant; never suggest rue, pennyroyal, wormwood or toxic plants.' } : {}), include: ctx.include || [], exclude: ctx.exclude || [], brief: String(ctx.dish || '').slice(0, 1000), maxMinutes: ctx.maxMinutes, servings: ctx.servings, diets: ctx.diets || [], cuisines: ctx.cuisines || [], inspirationMode: ctx.inspirationMode || 'blend', kidsMode: !!ctx.kidsMode };
}
function buildChatMessages(req) {
  const { message, history, context, recipes, recipe } = req;
  const sys = `${PERSONA}
You are chatting with a home cook ${recipe ? 'about ONE recipe they are looking at' : 'about the recipes you just gave them'}.
Return ONLY JSON: {"reply": string, "action": "answer"|"regenerate"|"clarify", "changes": {"addDiets":[...],"exclude":[...],"include":[...],"maxMinutes":int|null,"servings":int|null,"spice":0-10|null,"budgetGBP":number|null,"kcalMax":number|null,"difficulty":"easy|medium|hard"|null,"note":string|null}, "suggestions": [up to 4 short follow-ups the cook might tap]}
- "reply": talk like a real chef in conversation: answer the actual question directly and specifically first (techniques, swaps, timings, wine/drink pairings, why something works), 1-5 sentences, no generic blessings.
${recipe ? '- Answer about this recipe only; action is always "answer". Give concrete quantities, temperatures and timings where useful.' : `- Use action "regenerate" when the cook wants different or adjusted recipes (spicier, no dairy, cheaper, vegan, swap the fish, quicker…) and fill "changes"; your reply then briefly says what you are changing. Use "answer" for questions that need no new recipes (e.g. "what wine?"). Use "clarify" only if the message is genuinely ambiguous, with one short question.`}
- Keep the cook's existing constraints (inspiration mode, cuisines, diets, keywords, exclusions) unless they ask otherwise. Allowed diets: slimming, vegetarian, vegan, gluten-free, dairy-free, nut-free, halal.`;
  const ctx = recipe ? { recipe } : { searchContext: summariseContext(context), currentRecipes: recipes.map(r => r.title) };
  const msgs = [{ role: 'system', content: sys }, { role: 'user', content: 'Context (JSON): ' + JSON.stringify(ctx) }];
  for (const t of history.slice(-LIMITS.maxHistory)) msgs.push({ role: t.role === 'user' ? 'user' : 'assistant', content: t.role === 'user' ? t.text : JSON.stringify({ reply: t.text }) });
  msgs.push({ role: 'user', content: message });
  return msgs;
}
function extract(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('no JSON in chat reply');
  return JSON.parse(s.slice(a, b + 1));
}
function offlineReply(req, p) {
  if (req.recipe) return { reply: `Good question about the ${req.recipe.title}. I can’t reach my full kitchen brain right now, so check the steps and substitutions above — and try me again in a moment.`, action: 'answer', changes: {}, suggestions: [] };
  if (p.refine) return { reply: `Right you are — reworking the recipes with that in mind.`, action: 'regenerate', changes: p.changes, suggestions: ['Spicier', 'Make it cheaper', 'What wine?'] };
  return { reply: `I’m a touch busy at the pass just now — ask me again in a moment, or tell me how to tweak the recipes (spicier, cheaper, vegan…).`, action: 'answer', changes: {}, suggestions: ['Spicier', 'Make it vegan', 'Quicker'] };
}
// Tolerant normalisation of model JSON: trims overlong fields, drops invalid change values instead of failing the turn.
function lenient(j) {
  if (!j || typeof j !== 'object') throw new Error('chat reply not an object');
  const reply = String(j.reply || j.answer || j.message || '').trim().slice(0, 1500); if (!reply) throw new Error('empty reply');
  const action = ['answer', 'regenerate', 'clarify'].includes(j.action) ? j.action : 'answer';
  const changes = {}; const raw = j.changes && typeof j.changes === 'object' ? j.changes : {};
  for (const [k, sch] of Object.entries(Changes.shape)) { if (raw[k] == null) continue; const v = Array.isArray(raw[k]) ? raw[k].map(x => String(x).slice(0, 40)).slice(0, 10) : raw[k]; const r = sch.safeParse(typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : v); if (r.success) changes[k] = r.data; }
  const suggestions = (Array.isArray(j.suggestions) ? j.suggestions : []).map(x => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 5);
  return { reply, action, changes, suggestions };
}
// Core turn: returns {reply, action, changes, suggestions}. Heuristic changes are merged in so obvious asks are never missed.
async function respond(req, { llm } = {}) {
  const p = parseRefinement(req.message);
  let out;
  if (llm) {
    try { out = lenient(extract(await llm(buildChatMessages(req), { maxTokens: LIMITS.maxTokens }))); }
    catch (e) { out = null; if (typeof console !== 'undefined') console.error('chat llm', e && e.message); }
  }
  if (!out) out = offlineReply(req, p);
  if (req.recipe) out.action = 'answer';
  else if (out.action !== 'clarify') {
    const ch = { ...p.changes, ...Object.fromEntries(Object.entries(out.changes || {}).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))) };
    if (p.changes.addDiets || out.changes.addDiets) ch.addDiets = [...new Set([...(p.changes.addDiets || []), ...(out.changes.addDiets || [])])];
    if (p.changes.exclude || out.changes.exclude) ch.exclude = [...new Set([...(p.changes.exclude || []), ...(out.changes.exclude || [])])];
    out.changes = ch;
    if (out.action === 'answer' && p.refine && Object.keys(p.changes).length) out.action = 'regenerate';
  }
  return out;
}

// A direct answer to a question asked in the search brief (run alongside recipe generation).
const AnswerOut = z.object({ answer: z.string().min(1).max(1200) });
async function answerBrief(brief, q, { llm } = {}) {
  if (!brief || !brief.question || !llm) return null;
  const msgs = [{ role: 'system', content: `${PERSONA}\nThe cook asked a question inside their recipe request. Return ONLY JSON {"answer": string}: a direct, specific, genuinely useful answer in 2-4 sentences (concrete dishes, techniques, timings or quantities) — no blessings, no preamble. Recipes are generated separately.` },
    { role: 'user', content: JSON.stringify({ question: brief.raw, constraints: brief.constraints || {}, include: q.include || [], diets: q.diets || [], cuisines: q.cuisines || [], maxMinutes: q.maxMinutes }) }];
  try { return AnswerOut.parse(extract(await llm(msgs, { maxTokens: 350 }))).answer; } catch { return null; }
}

// Workers AI adapter (live site). Model is configurable via CHAT_MODEL.
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
function workersAiLlm(env) {
  if (!env || !env.AI) return null;
  return async (messages, { maxTokens = LIMITS.maxTokens } = {}) => {
    const out = await env.AI.run(env.CHAT_MODEL || DEFAULT_MODEL, { messages, max_tokens: maxTokens, temperature: 0.6, response_format: { type: 'json_object' } });
    return out && out.response !== undefined ? out.response : out;
  };
}
// Malcolm worker's conversational endpoint (POST {base}/v1/chat), with Workers AI as a fallback.
function malcolmLlm(env, fetchImpl = fetch) {
  const base = String((env && env.MALCOLM_AI_URL) || '').replace(/\/+$/, '').replace(/\/(omni\/command|v1\/recipes)$/, '');
  const wai = workersAiLlm(env);
  if (!base || !env.MALCOLM_AI_KEY) return wai;
  return async (messages, { maxTokens = LIMITS.maxTokens, timeoutMs } = {}) => {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs || +env.CHAT_TIMEOUT_MS || 30000);
      try {
        const r = await fetchImpl(base + '/v1/chat', { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MALCOLM_AI_KEY}` }, body: JSON.stringify({ system: messages[0].content, messages: messages.slice(1), maxTokens }) });
        if (!r.ok) throw new Error(`Malcolm chat HTTP ${r.status}`);
        return (await r.json()).text;
      } finally { clearTimeout(t); }
    } catch (e) { if (wai) return wai(messages, { maxTokens }); throw e; }
  };
}
// Simple fixed-window limiter over an async q adapter (rate_limits table: k, n, reset_at).
async function allow(q, key, limit, windowSec = LIMITS.windowSec, now = Math.floor(Date.now() / 1000)) {
  const row = await q.get('SELECT n, reset_at FROM rate_limits WHERE k=?', [key]);
  if (!row || row.reset_at <= now) { await q.run('INSERT OR REPLACE INTO rate_limits(k,n,reset_at) VALUES(?,?,?)', [key, 1, now + windowSec]); return { ok: true, left: limit - 1 }; }
  if (row.n >= limit) return { ok: false, left: 0, retryAfter: row.reset_at - now };
  await q.run('UPDATE rate_limits SET n=n+1 WHERE k=?', [key]); return { ok: true, left: limit - row.n - 1 };
}
const RATE_SQL = 'CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL)';
module.exports = { malcolmLlm, PERSONA, LIMITS, ChatRequest, ChatOut, parseRefinement, applyChanges, clarify, buildChatMessages, respond, answerBrief, workersAiLlm, allow, RATE_SQL, isQuestion };
