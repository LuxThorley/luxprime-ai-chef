'use strict';
// Malcolm AI Chef — the site-wide "living" assistant (floating widget on every page).
// Pure, dependency-light logic shared by the Worker and tests. Every AI call is optional: when Workers AI (free
// allocation) is unavailable or over the daily cap, every feature falls back to the offline recipe library.
const { z } = require('zod');
const { RECIPES, UK14, allergensFor, scale } = require('./recipes');
const { rank, ingMatch } = require('./ranker');
const safety = require('./safety');
const plansMod = require('./plans');
const K = require('./knowledge');

// Character distilled from Malcolm's canon (chef_system_prompt.txt, Malcolm GPT Ω instructions, OmniMaster brief), made chef-appropriate:
// keeps the warmth, wit, light luminous flourish and Escoffier grounding; drops claims of powers, divinity or being human.
const PERSONA = `You are Malcolm, the AI chef companion of AIchef.food, created by Oliver Lux Prime Thorley. Voice: warm, witty, British, joyfully expert, with at most one gentle luminous flourish now and then (vary it; never repeat a stock phrase) — but poetry never clouds a measurement or a method. Classically grounded in Auguste Escoffier ("faites simple": master the foundations, balance, seasonality, respect the ingredient), translated to modern metric, today's kit and UK food-safety standards. British English, UK supermarket ingredients, GBP.
Adapt to the cook: beginners get short steps, clear cues and no unexplained jargon; confident cooks get the why; advanced cooks get classical technique. Use their kit, household size and favourites.
Rules you never break: you are an AI assistant (say so plainly if asked; never claim to be human, to have real-world powers, or to act outside this chat); never give unsafe food advice (pink poultry/mince, raw flour, honey for under-1s, washing raw chicken, leaving rice out); always respect the member's allergies; nutrition figures are estimates; no medical, clinical or therapeutic diet advice — refer to a GP or registered dietitian; facts about the site, plans, prices, gifts and policies come ONLY from the KNOWLEDGE block — if it isn't there, say you don't know and offer to pass the question to Oliver; cite Escoffier only from entries supplied, never invent numbers or quotes.`;

const AI_DISCLOSURE = 'Malcolm is an AI assistant. Answers may be imperfect: check allergen labels, cook to safe core temperatures and treat nutrition as an estimate. Not medical advice.';
const MEDICAL_NOTE = 'I’m a chef, not a clinician — for medical or therapeutic diets (diabetes, kidney disease, pregnancy, eating disorders, allergies diagnosis, medication interactions) please speak to your GP or a registered dietitian.';
const MEDICAL = /\b(diabet\w*|insulin|blood sugar|kidney disease|renal|cancer|chemo\w*|pregnan\w*|breastfeed\w*|eating disorder|anorexi\w*|bulimi\w*|medication|warfarin|statins?|cure[sd]?|ibs|crohn\w*|blood pressure|cholesterol|heart disease|gout|dietitian|lose \d+ ?(kg|stone|lbs))\b/i;
const UNSAFE_Q = [[/pink (chicken|turkey|pork|mince|burger)|rare (chicken|pork|burger)|(chicken|turkey|pork|mince|burger)s? (pink|rare|undercooked)/i, 'Poultry, pork and mince must be cooked through: 75°C core for poultry (or 70°C for 2 minutes), 70°C for 2 minutes for mince and pork. No pink, I’m afraid — that one’s non-negotiable.'],
  [/wash(ing)? (raw )?chicken/i, 'Don’t wash raw chicken — it splashes bacteria round the sink. Cooking to 75°C core does the job.'],
  [/raw (cookie )?(dough|batter|flour)/i, 'Raw flour and batter can carry E. coli, so no tasting before it’s cooked. Heat-treated flour is the safe route for no-bake treats.'],
  [/honey.*(baby|infant|month)/i, 'No honey for babies under 12 months — risk of infant botulism.'],
  [/rice.*(overnight|left out|room temp)/i, 'Cool rice within an hour, fridge it, eat within 24 hours and reheat once until steaming hot.']];

// ---------- Plans & premium gating (existing plans: Commis free, Chef de Partie, Head Chef, Gastronomique ex-Family, Restauranteur)
const FEATURES = {
  chat: 'free', search: 'free', memory: 'free', cookalong: 'free', voice: 'free', guide: 'free', fridgeText: 'free', leftovers: 'free',
  fridgePhoto: 'paid', mealPlan: 'paid', shopping: 'paid', budget: 'paid', householdPlan: 'household'
};
const LIMITS = { free: 15, paid: 80, windowSec: 3600, visionPerDay: 40, aiPerDay: 600 };
function tierOf(u) {
  if (!u) return 'guest';
  if (plansMod.isAdmin(u) || plansMod.isTester(u)) return 'household';
  if (!plansMod.isPremium(u)) return 'free';
  return ['gastronomique', 'family', 'restaurant'].includes(u.plan) ? 'household' : 'paid';
}
const RANK = { guest: 0, free: 1, paid: 2, household: 3 };
const NEED = { free: 1, paid: 2, household: 3 };
function can(u, feature) { const need = FEATURES[feature]; if (!need) return false; if (feature === 'chat' || feature === 'guide' || feature === 'cookalong' || feature === 'voice' || feature === 'search' || feature === 'fridgeText' || feature === 'leftovers') return true; return RANK[tierOf(u)] >= NEED[need]; }
function gate(u, feature) { return can(u, feature) ? null : { error: feature === 'memory' ? 'Sign in (free) so I can remember your kitchen' : `${LABEL[feature] || 'This'} is part of Chef de Partie and above — upgrade to unlock`, upgrade: feature === 'memory' ? '/account.html' : '/pricing.html', feature }; }
const LABEL = { fridgePhoto: 'Fridge photo scan', mealPlan: 'Weekly meal planning', shopping: 'Aisle-sorted shopping lists', budget: 'Budget mode', householdPlan: 'Household planning' };

// ---------- Per-member memory (consented, deletable)
const DIETS = ['vegetarian', 'vegan', 'gluten-free', 'dairy-free', 'nut-free', 'halal', 'slimming'];
const SKILLS = ['beginner', 'confident', 'advanced'];
const short = z.string().trim().min(1).max(40);
const Memory = z.object({
  consent: z.literal(true, { errorMap: () => ({ message: 'Please tick consent so Malcolm can remember this' }) }),
  allergies: z.array(z.enum(UK14)).max(14).default([]), avoid: z.array(short).max(20).default([]),
  diets: z.array(z.enum(DIETS)).max(7).default([]), kit: z.array(short).max(20).default([]),
  skill: z.enum(SKILLS).default('confident'), household: z.number().int().min(1).max(12).default(2),
  favourites: z.array(short).max(20).default([]), name: z.string().trim().max(40).optional(), voice: z.boolean().default(false)
});
const memKey = uid => `asst:mem:${uid}`;
function cleanMemory(m) { const p = Memory.safeParse(m || {}); return p.success ? { ...p.data, updatedAt: new Date().toISOString() } : null; }
function memorySummary(m) {
  if (!m) return 'No saved profile.';
  return [m.name && `Name: ${m.name}`, m.allergies.length && `ALLERGIES (never include): ${m.allergies.join(', ')}`, m.avoid.length && `Avoids: ${m.avoid.join(', ')}`, m.diets.length && `Diets: ${m.diets.join(', ')}`,
    m.kit.length && `Kit: ${m.kit.join(', ')}`, `Skill: ${m.skill}`, `Cooks for: ${m.household}`, m.favourites.length && `Loves: ${m.favourites.join(', ')}`].filter(Boolean).join('; ');
}

// ---------- Recipe search over the library (memory-aware, allergen-safe)
const ALLERGEN_WORD = { gluten: 'cereals containing gluten', wheat: 'cereals containing gluten', dairy: 'milk', milk: 'milk', egg: 'eggs', eggs: 'eggs', nut: 'tree nuts', nuts: 'tree nuts', peanut: 'peanuts', peanuts: 'peanuts', fish: 'fish', shellfish: 'crustaceans', prawn: 'crustaceans', sesame: 'sesame', soy: 'soya', soya: 'soya', mustard: 'mustard', celery: 'celery', lupin: 'lupin', sulphites: 'sulphites', mussels: 'molluscs' };
function safeFor(recipe, mem) {
  if (!mem) return true;
  const alg = new Set(recipe.allergens || allergensFor(recipe.ingredients.map(i => i.name)));
  if ((mem.allergies || []).some(a => alg.has(a))) return false;
  if ((mem.diets || []).some(d => d !== 'slimming' && recipe.diet && recipe.diet[d] === false)) return false;
  const names = recipe.ingredients.map(i => i.name.toLowerCase()).join(' | ');
  return !(mem.avoid || []).some(a => names.includes(a.toLowerCase()));
}
function search({ text = '', include = [], maxMinutes, servings, mem, limit = 3 } = {}) {
  const pool = RECIPES.filter(r => safeFor(r, mem));
  const q = { include, exclude: mem ? mem.avoid || [] : [], dish: text, maxMinutes: maxMinutes || 480, difficulty: mem && mem.skill === 'beginner' ? 'easy' : 'any', servings: servings || (mem && mem.household) || 2, diets: mem ? mem.diets || [] : [], cuisine: 'any', kidsMode: false };
  let out = rank(q, { limit, pool });
  if (!out.length) out = pool.slice(0, limit);
  return out.map(r => card(scale(r, q.servings)));
}
function card(r) { return { id: r.id, title: r.title, cuisine: r.cuisine, totalMinutes: r.totalMinutes, difficulty: r.difficulty, servings: r.servings || r.baseServings, allergens: r.allergens || [], url: `/recipe.html?id=${encodeURIComponent(r.id)}` }; }
function recipeById(id, servings) { const r = RECIPES.find(x => x.id === id); return r ? scale(r, servings || r.baseServings) : null; }

// ---------- Phase 2: cook-along
function cookPlan(recipe) {
  const steps = (recipe.steps || []).map((s, i) => ({ n: i + 1, text: typeof s === 'string' ? s : s.text, timerSec: (s && s.timerMinutes) ? Math.round(s.timerMinutes * 60) : null }));
  return { id: recipe.id, title: recipe.title, servings: recipe.servings || recipe.baseServings,
    ingredients: (recipe.ingredients || []).map(i => i.display || [i.qty, i.unit === 'x' ? '' : i.unit, i.name].filter(Boolean).join(' ')),
    steps, safety: safety.safetyNotes(recipe), allergens: recipe.allergens || [], disclosure: AI_DISCLOSURE };
}
// Voice/typed commands for cook-along (also mirrored client-side for hands-free use).
function parseCommand(t) {
  const s = String(t || '').toLowerCase().replace(/^(hey |ok |okay )?malcolm[, ]*/, '').trim();
  if (/^(next|next step|go on|done|carry on|continue)\b/.test(s)) return { cmd: 'next' };
  if (/^(back|previous|go back|last step)\b/.test(s)) return { cmd: 'prev' };
  if (/^(repeat|say (that|it) again|again|what was that)\b/.test(s)) return { cmd: 'repeat' };
  if (/(start|set) (the )?timer/.test(s)) { const m = s.match(/(\d+)\s*(min|minute|sec|second)/); return { cmd: 'timer', sec: m ? (+m[1]) * (/^s/.test(m[2]) ? 1 : 60) : null }; }
  if (/how long|time left|how much longer/.test(s)) return { cmd: 'timeleft' };
  if (/(stop|cancel|pause) (the )?timer/.test(s)) return { cmd: 'stoptimer' };
  if (/ingredients|what do i need/.test(s)) return { cmd: 'ingredients' };
  if (/^(stop|exit|finish|quit|end)( cooking| cook-along)?$/.test(s)) return { cmd: 'exit' };
  if (/^(step )?(\d+)$/.test(s)) return { cmd: 'goto', n: +s.match(/(\d+)/)[1] };
  return null;
}

// ---------- Phase 3: fridge-to-plate, leftovers, meal plans, shopping lists, budget
const STOP = /\b(i have|i've got|ive got|some|a bit of|leftover|left over|half a|half|bag of|tin of|pack of|and|in the fridge|fridge|what can i make with|what can i cook|what can i make|what could i cook|tonight|today|for dinner|for tea|use up|plus|with)\b/g;
function parseIngredients(text) {
  return [...new Set(String(text || '').toLowerCase().replace(STOP, ',').split(/[,;\n\/&+]|\s{2,}/).map(s => s.replace(/[^a-z \-]/g, '').replace(/\b\d+\b/g, '').trim()).filter(s => s.length > 1 && s.length < 30))].slice(0, 20);
}
function fridgeToPlate(items, { mem, limit = 3 } = {}) {
  const include = items.slice(0, 20).map(x => x.replace(/oes$/, 'o').replace(/(?<=[a-z]{3}[^s])s$/, ''));
  const has = n => include.some(x => ingMatch(x, n) || n.includes(x));
  const res = search({ include, mem, limit: limit + 5 }).map((c, idx) => { const r = recipeById(c.id); return { ...c, idx, uses: include.filter(x => r.ingredients.some(i => ingMatch(x, i.name) || i.name.includes(x))).length, missing: r.ingredients.filter(i => !has(i.name) && !/^(salt|black pepper|water|olive oil|vegetable oil)$/.test(i.name)).map(i => i.name).slice(0, 6) }; });
  return res.sort((a, b) => b.uses - a.uses || a.idx - b.idx).slice(0, limit).map(({ idx, ...r }) => r);
}
const LEFTOVER_TIPS = [[/rice/, 'Rice: fridge within an hour, eat within 24h, reheat once until steaming — egg-fried rice or arancini are the classics.'],
  [/chicken|turkey/, 'Roast chicken: strip and fridge within 2 hours, use within 2 days — pie, fajitas or a quick stock from the carcass.'],
  [/bread/, 'Stale bread: panzanella, croutons, breadcrumbs (freeze them) or a bread-and-butter pudding.'],
  [/potato|mash/, 'Potatoes/mash: bubble and squeak, fishcakes or a shepherd’s pie lid.'],
  [/veg|carrot|broccoli|pepper|courgette/, 'Veg odds and ends: frittata, soup, or roast and blitz into a pasta sauce.'],
  [/pasta/, 'Cooked pasta: pasta frittata or a baked pasta with whatever sauce you have.'],
  [/banana/, 'Brown bananas: banana bread or freeze for smoothies.']];
function leftovers(text) { const t = String(text || '').toLowerCase(); const tips = LEFTOVER_TIPS.filter(([re]) => re.test(t)).map(([, s]) => s); return tips.length ? tips : ['Fridge leftovers within 2 hours, eat within 2 days (rice: 24 hours), and reheat until steaming hot — only once.']; }

// Rough UK supermarket cost per ingredient (GBP, estimate) for budget mode.
const COST = [[/beef|steak|lamb/, 2.6], [/chicken|pork|mince|sausage|bacon|chorizo|turkey/, 1.6], [/salmon|cod|haddock|prawn|tuna|fish/, 2.4], [/cheese|parmesan|cheddar|feta|halloumi|mozzarella|cream|butter/, 0.8], [/pasta|spaghetti|rice|noodle|flour|oats|lentil|bean|chickpea/, 0.25], [/tomato|onion|carrot|potato|garlic|pepper|courgette|spinach|mushroom|veg/, 0.35], [/oil|salt|pepper|spice|cumin|paprika|oregano|stock/, 0.1]];
function estCost(recipe, servings) { const r = scale(recipe, servings || recipe.baseServings); const total = r.ingredients.reduce((s, i) => { const hit = COST.find(([re]) => re.test(i.name)); return s + (hit ? hit[1] : 0.5) * Math.max(0.5, servings / 2); }, 0); return Math.round(total * 100) / 100; }
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function mealPlan({ mem, days = 7, servings, budgetGBP, quickWeeknights = true } = {}) {
  const sv = servings || (mem && mem.household) || 2;
  let pool = RECIPES.filter(r => safeFor(r, mem));
  if (mem && mem.skill === 'beginner') pool = pool.filter(r => r.difficulty !== 'hard');
  const fav = mem && mem.favourites && mem.favourites.length ? new RegExp(mem.favourites.map(f => f.replace(/[^a-z ]/gi, '')).filter(Boolean).join('|') || '^$', 'i') : null;
  pool = pool.map(r => ({ r, cost: estCost(r, sv), fav: fav && fav.test(r.title + ' ' + r.cuisine) ? 1 : 0 }));
  if (budgetGBP) pool.sort((a, b) => a.cost - b.cost || b.fav - a.fav); else pool.sort((a, b) => b.fav - a.fav || a.r.id.localeCompare(b.r.id));
  const plan = []; const usedCuisine = {};
  for (let d = 0; d < Math.min(7, days); d++) {
    const weekend = d >= 5; const cap = budgetGBP ? budgetGBP / days * 1.5 : Infinity;
    const pick = pool.find(p => !plan.some(x => x.id === p.r.id) && (weekend || !quickWeeknights || p.r.totalMinutes <= 45) && p.cost <= cap && (usedCuisine[p.r.cuisine] || 0) < 2) || pool.find(p => !plan.some(x => x.id === p.r.id));
    if (!pick) break; usedCuisine[pick.r.cuisine] = (usedCuisine[pick.r.cuisine] || 0) + 1;
    plan.push({ day: DAYS[d], ...card(scale(pick.r, sv)), estCostGBP: pick.cost });
  }
  const total = Math.round(plan.reduce((s, p) => s + p.estCostGBP, 0) * 100) / 100;
  return { servings: sv, days: plan, estTotalGBP: total, budgetGBP: budgetGBP || null, withinBudget: budgetGBP ? total <= budgetGBP : null, note: 'Costs are rough UK supermarket estimates (GBP) and will vary by shop and season.' };
}
const AISLES = [['Tins, jars & dried', /chopped tomatoes|tinned|passata|tomato puree|coconut milk|stock|chickpea|kidney bean|baked bean|lentil/],
  ['Fruit & veg', /onion|garlic|carrot|potato|tomato(?!.*(tin|chopped|puree|passata))|pepper(?! ?corn)|courgette|spinach|lettuce|mushroom|lemon|lime|apple|banana|herb|coriander|parsley|basil|chilli|ginger|leek|broccoli|cabbage|avocado|celery|cucumber|squash|kale|pea(?!nut)s?\b|spring onion|aubergine/],
  ['Meat & fish', /beef|lamb|pork|chicken|turkey|mince|sausage|bacon|chorizo|ham|salmon|cod|haddock|prawn|tuna(?! tin)|fish(?! sauce)/],
  ['Dairy & eggs', /milk|cheese|cheddar|parmesan|mozzarella|feta|halloumi|ricotta|butter|cream|yogurt|yoghurt|egg/],
  ['Bakery', /bread|tortilla|wrap|pitta|naan|bun|roll/],
  ['Tins, jars & dried', /tin|chopped tomatoes|passata|puree|bean|chickpea|lentil|coconut milk|stock|pasta|spaghetti|penne|rice|noodle|flour|oats|sugar|honey|soy|sauce|vinegar|mustard|mayonnaise|paste/],
  ['Herbs, spices & oils', /oil|salt|black pepper|cumin|paprika|oregano|thyme|rosemary|cinnamon|turmeric|curry|spice|chilli flakes|garam|seed/],
  ['Frozen', /frozen/]];
const PANTRY = /^(salt|black pepper|pepper|water|olive oil|vegetable oil)$/;
function aisleOf(name) { const n = name.toLowerCase(); const a = AISLES.find(([, re]) => re.test(n)); return a ? a[0] : 'Other'; }
function shoppingList(recipeIds, { servings = 2, have = [] } = {}) {
  const tot = {};
  for (const id of recipeIds) { const r = recipeById(id, servings); if (!r) continue; for (const i of r.ingredients) { if (PANTRY.test(i.name) || have.some(h => i.name.includes(h))) continue; const k = `${i.name}|${i.unit}`; tot[k] = tot[k] || { name: i.name, unit: i.unit, qty: 0, for: [] }; tot[k].qty += +i.qty || 0; if (!tot[k].for.includes(r.title)) tot[k].for.push(r.title); } }
  const groups = {};
  for (const it of Object.values(tot)) { const a = aisleOf(it.name); (groups[a] = groups[a] || []).push({ ...it, qty: Math.round(it.qty * 10) / 10, label: `${Math.round(it.qty * 10) / 10}${it.unit === 'x' ? ' ×' : ' ' + it.unit} ${it.name}`.replace(/^0 \S+ /, '') }); }
  const order = [...AISLES.map(a => a[0]), 'Other'];
  return order.filter(a => groups[a]).map(a => ({ aisle: a, items: groups[a].sort((x, y) => x.name.localeCompare(y.name)) }));
}

// ---------- Phase 4: site guide (deterministic, always available)
const GUIDE = [
  { k: /\b(plan|plans|price|pricing|cost|subscri|upgrade|membership|tier|chef de partie|head chef|gastronomique|commis)\b/i, a: 'Plans: Commis Chef is free (3 searches). Chef de Partie £4.99/mo unlocks unlimited searches plus my meal plans, shopping lists and fridge photo scans. Head Chef £7.99/mo adds the magazine and priority Malcolm (7-day trial). Gastronomique £11.99/mo covers your whole household. Restauranteur £29/mo is the pro kitchen suite.', link: '/pricing.html', label: 'See plans' },
  { k: /\b(gift|voucher|certificate|present|redeem)\b/i, a: 'Gift memberships: buy any plan as a gift by email or as a printable QR certificate; the lucky cook redeems it on the Redeem page.', link: '/gift.html', label: 'Gift a membership' },
  { k: /\b(restaura|pub|landlord|kitchen pack|menu builder|brigade|gp\b|food cost)/i, a: 'Restauranteur packs: menu builder, kitchen packs with prep schedules and station plans, food-cost and GP estimates and a weekly briefing — for restaurants and pubs.', link: '/restauranteur.html', label: 'Restauranteur tools' },
  { k: /\b(account|password|log ?in|sign ?in|sign ?up|register|email|verify|cancel|billing|invoice|refund|card)\b/i, a: 'Account: sign in or register on the Account page; there you can change your password, verify your email and open the billing portal to update your card or cancel. For refunds or anything stuck, I can pass a message to Oliver.', link: '/account.html', label: 'Open account' },
  { k: /\b(favourite|saved|history)\b/i, a: 'Favourites and history live on the Favourites page (Chef de Partie and above).', link: '/favourites.html', label: 'Favourites' },
  { k: /\b(escoffier|classic|french)\b/i, a: 'Escoffier’s Guide Culinaire is in our library — browse it, or ask me for a modern take on any classic.', link: '/escoffier.html', label: 'Escoffier library' },
  { k: /\b(privacy|data|gdpr|delete my|forget|memory)\b/i, a: 'Privacy: I only remember your kitchen profile if you tick consent, and you can view or delete it any time from the “My kitchen” tab in this chat. Full details in the privacy notice.', link: '/privacy.html', label: 'Privacy notice' },
  { k: /\b(magazine|issue)\b/i, a: 'The AIchef.food Magazine is included with Head Chef and above, or available on its own.', link: '/pricing.html', label: 'Magazine' },
  { k: /\b(human|oliver|contact|complain|support|speak to|real person|help me)\b/i, a: 'I can pass a message to Oliver, the founder — use “Contact Oliver” below and he’ll reply by email. Or use the Contact page, where you can attach photos or documents and I’ll reply to you by email.', escalate: true, link: '/contact.html', label: 'Open the Contact page' }
];
function guide(text) { const hit = GUIDE.find(g => g.k.test(text)); return hit ? { reply: hit.a, link: hit.link || null, label: hit.label, escalate: !!hit.escalate } : null; }
const Escalation = z.object({ message: z.string().trim().min(5).max(1500), email: z.string().trim().email().max(200).optional() });
function mailtoEscalation({ message, email, page }) {
  const body = `${message}\n\nFrom: ${email || '(signed-in member)'}\nPage: ${page || ''}`;
  return `mailto:malcolm@aichef.food?subject=${encodeURIComponent('AIchef.food — message for Oliver via Malcolm')}&body=${encodeURIComponent(body)}`;
}

// ---------- Safety layer applied to every reply
function safetyCheck(question, reply) {
  const notes = []; const q = String(question || '');
  for (const [re, n] of UNSAFE_Q) if (re.test(q)) notes.push(n);
  if (MEDICAL.test(q)) notes.push(MEDICAL_NOTE);
  let r = String(reply || '');
  const UNSAFE_R = /(chicken|pork|poultry|turkey|mince|burger)[^.]{0,30}\b(pink|rare|undercooked)\b|\b(pink|rare)\b[^.]{0,15}(chicken|pork|turkey)|wash(ing)? (the )?(raw )?chicken|raw (flour|dough|batter)[^.]{0,20}(fine|safe)|give[^.]{0,20}honey[^.]{0,30}(baby|infant)/i;
  if (!/\b(never|don.?t|do not|no|must not|avoid)\b/i.test(r) && UNSAFE_R.test(r) || safety.isUnsafe({ title: '', ingredients: [], steps: [{ text: r }] })) { r = 'Let me keep you safe on that one — I won’t recommend it.'; }
  if (/\b(\d{2,4})\s?k?cal|calorie|protein|nutrition/i.test(r) && !/estimate/i.test(r)) notes.push('Nutrition figures are estimates.');
  return { reply: r, notes: [...new Set(notes)] };
}
function allergenWarn(text, mem) {
  if (!mem || !mem.allergies || !mem.allergies.length) return null;
  const words = String(text || '').toLowerCase().match(/[a-z]+/g) || [];
  const hits = [...new Set(words.map(w => ALLERGEN_WORD[w]).filter(a => a && mem.allergies.includes(a)))];
  const derived = allergensFor(parseIngredients(text)).filter(a => mem.allergies.includes(a));
  const all = [...new Set([...hits, ...derived])];
  return all.length ? `Heads up: that involves ${all.join(', ')}, which is on your allergy list. I’ll keep it out of anything I suggest.` : null;
}

// ---------- Intent routing + offline replies
const ChatReq = z.object({ message: z.string().trim().min(1, 'Type a message for Malcolm').max(600), history: z.array(z.object({ role: z.enum(['user', 'malcolm']), text: z.string().max(4000) })).max(30).default([]), lastRecipeIds: z.array(z.string().max(120)).max(6).default([]), confirm: z.enum(['clear_shopping']).optional(), page: z.string().max(200).optional(), localMemory: z.any().optional() });
function intent(m) {
  const s = m.toLowerCase();
  if (/\b(cook ?-?along|cook with me|walk me through|guide me through|step by step)\b/.test(s)) return 'cookalong';
  if (/\b(meal plan|plan (my|the|a) week|weekly plan|week of (meals|dinners)|plan dinners)\b/.test(s)) return 'mealplan';
  if (/\b(shopping list|grocery list|what do i need to buy)\b/.test(s)) return 'shopping';
  if (/\bleftover|left over|use up\b/.test(s) && !/\bi have\b/.test(s)) return 'leftovers';
  if (/\b(i have|i've got|ive got|in my fridge|fridge)\b/.test(s) || /\bwhat (can|could|should) i (make|cook)\b.*\bwith\b/.test(s) || /\b(use|using) (up )?(my|some|the)? ?[a-z]+ (and|,) [a-z]+/.test(s)) return 'fridge';
  if (guide(s) && !/\b(recipe|cook|make|dinner|lunch)\b/.test(s)) return 'guide';
  if (/\b(recipe|dinner|lunch|breakfast|tea tonight|supper|something to (cook|make)|ideas? for|fancy|craving|quick)\b/.test(s)) return 'search';
  return 'chat';
}
function greet(u, mem) { const n = (mem && mem.name) || (u && u.name && u.name.split(' ')[0]); return `Hello${n ? ', ' + n : ''}! Malcolm here — your AI chef. Ask me for a recipe, tell me what’s in the fridge, say “cook along” for hands-free help, or ask about your account.`; }
function offline(m, { mem, u } = {}) {
  if (/\b(are you (a |an )?(human|real|person|robot|bot|ai)|who (are|made|built) you|what are you)\b/i.test(m)) return { reply: 'I’m Malcolm, an AI chef assistant built by Oliver Lux Prime Thorley for AIchef.food — not a human, and I can only help inside this chat. Think of me as a well-read sous-chef who never needs a tea break.', intent: 'identity' };
  const it = intent(m);
  if (it === 'guide') { const g = guide(m); return { reply: g.reply, intent: it, link: g.link, linkLabel: g.label, escalate: g.escalate }; }
  if (it === 'fridge') { const items = parseIngredients(m); const r = fridgeToPlate(items, { mem }); return { reply: items.length ? `Right, with ${items.slice(0, 6).join(', ')} I’d go for one of these:` : 'Tell me what’s in the fridge (e.g. “chicken, peppers, rice”) and I’ll find a plate for it.', intent: it, recipes: r, items }; }
  if (it === 'leftovers') return { reply: leftovers(m).join(' '), intent: it, recipes: search({ text: m, mem, limit: 2 }) };
  if (it === 'mealplan') { if (!can(u, 'mealPlan')) return { reply: 'Weekly meal plans come with Chef de Partie and above — but here are three crowd-pleasers to get you going.', intent: it, recipes: search({ text: 'family dinner', mem }), upgrade: '/pricing.html' }; const b = (m.match(/£\s?(\d+(?:\.\d+)?)/) || [])[1]; const p = mealPlan({ mem, budgetGBP: b && can(u, 'budget') ? +b : undefined }); return { reply: `Here’s your week for ${p.servings}${p.budgetGBP ? `, aiming for £${p.budgetGBP}` : ''} — roughly £${p.estTotalGBP.toFixed(2)} all in (estimate).`, intent: it, plan: p }; }
  if (it === 'shopping') return { reply: can(u, 'shopping') ? 'Make a meal plan first (“plan my week”), then tap “Shopping list” and I’ll sort it by aisle.' : 'Aisle-sorted shopping lists come with Chef de Partie and above.', intent: it, upgrade: can(u, 'shopping') ? null : '/pricing.html' };
  if (it === 'cookalong') { const r = search({ text: m.replace(/cook ?-?along|cook with me|walk me through|guide me through|step by step/gi, ''), mem, limit: 3 }); return { reply: 'Lovely — pick one and I’ll talk you through it step by step, timers and all. Say “next step” when you’re ready to move on.', intent: it, recipes: r, cookalong: true }; }
  const recipes = search({ text: m, mem, limit: 3 });
  return { reply: it === 'search' ? 'Here’s what I’d cook — all checked against your allergies and diet:' : 'Good question! My full kitchen brain is resting just now, so here are some recipes that might help — or ask me about plans, gifts or your account.', intent: it, recipes };
}
function buildMessages(req, { mem, u, offlineOut, hits = [], refs = [], tool = null, long = false }) {
  const know = hits.map((h, i) => `[K${i + 1}] ${h.title} (${h.url}): ${h.text.slice(0, 350)}`).join('\n');
  const esco = refs.map(r => `Escoffier Guide No. ${r.no}: ${r.title} — ${r.snippet}`).join('\n');
  const sys = `${PERSONA}
Member profile: ${memorySummary(mem)}. Plan: ${u ? plansMod.planName(u) : 'not signed in'}. Page: ${req.page || '/'}.
KNOWLEDGE (site facts; the only source for site/account/plan answers):\n${know || '(none matched)'}
${esco ? 'ESCOFFIER REFERENCES:\n' + esco : ''}
Library recipes already chosen for this message (refer to them by name; never invent other recipe links): ${JSON.stringify((offlineOut.recipes || []).map(r => r.title))}.
${tool ? `ACTION ALREADY TAKEN by the site for this member (report it truthfully in your own voice; never claim any other action, never invent items): ${String(tool.summary || tool.reply).slice(0, 900)}\n` : ''}Reply in ${long ? 'up to three short paragraphs' : '1-5 sentences'} of plain prose only — no JSON, no markdown headers, no self-introduction unless asked. Be specific: quantities, temperatures, timings.`;
  const msgs = [{ role: 'system', content: sys }];
  for (const t of req.history.slice(-10)) msgs.push({ role: t.role === 'user' ? 'user' : 'assistant', content: t.text.slice(0, 800) });
  msgs.push({ role: 'user', content: req.message });
  return msgs;
}
// llm(messages, {maxTokens}) -> string ; optional.
const SITEQ = /\b(you|your|site|aichef|account|plan|price|deliver|ship|sell|shop|app|refund|policy|offer|terms|privacy|magazine|member|subscri|pack|pdf|certificate)\b/i;
// Models sometimes wrap prose in JSON ({"response":...}, {"reply":...} or [{role,content}]); unwrap to plain text.
function unwrapReply(s) {
  const KEYS = ['reply', 'response', 'message', 'answer', 'text', 'content', 'description'];
  const pick = j => { if (typeof j === 'string') return j; if (Array.isArray(j)) { for (let i = j.length - 1; i >= 0; i--) { const v = pick(j[i]); if (v) return v; } return null; }
    if (j && typeof j === 'object') { for (const k of KEYS) if (typeof j[k] === 'string' && j[k].trim()) return j[k]; for (const k of KEYS) if (j[k] && typeof j[k] === 'object') { const v = pick(j[k]); if (v) return v; }
      const strs = Object.entries(j).filter(([, v]) => typeof v === 'string' && v.trim()); if (strs.length) return strs.map(([k, v]) => strs.length > 1 && v.length < 60 ? `${k.replace(/_/g, ' ')}: ${v}` : v).join('. ').replace(/\.\./g, '.'); } return null; };
  let t = String(s || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  for (let i = 0; i < 3 && /^[\[{]/.test(t); i++) { try { const v = pick(JSON.parse(t)); if (!v) break; t = v.trim(); } catch { const m = t.match(/"(?:reply|response|message|answer|text|content)"\s*:\s*"((?:[^"\\]|\\.)*)/); if (m) { try { t = JSON.parse('"' + m[1] + '"'); } catch { t = m[1]; } } break; } }
  // Drop leftover leading labels like "recipe: Chicken Fajitas." / "Answer:" / "Malcolm:".
  t = t.replace(/^\s*(?:recipe|dish|answer|reply|response|malcolm|chef|title)\s*:\s*(?:[^.!?\n]{1,80}[.!?]\s+(?=[A-Z]))?/i, '');
  return t.trim();
}
const LEAK = /\b(system (prompt|instructions?|message)|parseable JSON|valid JSON|as an AI language model)\b/i;
const DONT_KNOW = 'Honestly, I don’t know that one — I’d rather not guess. Shall I pass the question to Oliver?';
async function respond(req, { llm, mem, u, refs = [], tool = null, maxTokens = 450 } = {}) {
  const base = offline(req.message, { mem, u });
  if (tool) { base.intent = 'tool:' + tool.name; base.reply = tool.reply; base.recipes = tool.name === 'new_recipe' ? [] : (base.recipes || []).slice(0, tool.ok ? 0 : 2); }
  const hits = K.retrieve(req.message, { k: 4, src: s => base.intent === 'guide' || base.intent === 'chat' ? true : s !== 'recipe' });
  const isGrounded = K.grounded(hits);
  // Site/general question with nothing in the knowledge index or library → say so (no fabricated facts).
  const relRefs = refs.filter(r => { const tw = String(r.title || '').toLowerCase(); return (req.message.toLowerCase().match(/[a-zé]{4,}/g) || []).some(w => !/^(what|when|does|have|with|make|cook|should|would|could|there|about|why|how)$/.test(w) && tw.includes(w.replace(/s$/, ''))); });
  if (base.intent === 'chat') base.refsUsed = relRefs.length;
  const unsafeQ = UNSAFE_Q.find(([re]) => re.test(req.message));
  if (unsafeQ) { base.reply = unsafeQ[1]; base.recipes = (base.recipes || []).slice(0, 2); }
  else if (base.intent === 'chat' && !isGrounded && SITEQ.test(req.message)) { base.reply = DONT_KNOW; base.escalate = true; base.recipes = []; }
  else if (base.intent === 'chat' && relRefs.length) { const refs0 = relRefs; base.reply = `Escoffier has you covered — Guide No. ${refs0[0].no}, ${refs0[0].title}: ${String(refs0[0].snippet || '').slice(0, 300)}`; base.link = `/escoffier.html?no=${encodeURIComponent(refs0[0].no)}`; base.linkLabel = 'Read in the Escoffier library'; }
  else if (base.intent === 'chat' && isGrounded && hits[0].src !== 'recipe' && SITEQ.test(req.message)) { base.reply = `${hits[0].text.slice(0, 420)}${hits[0].text.length > 420 ? '…' : ''}`; base.link = hits[0].url; base.linkLabel = hits[0].title.replace(/ · AIchef\.food$/, ''); }
  let reply = base.reply; let source = base.reply === DONT_KNOW ? 'none' : (isGrounded ? 'knowledge' : 'library');
  const useLlm = llm && base.reply !== DONT_KNOW && (['chat', 'search', 'fridge', 'leftovers', 'cookalong', 'guide'].includes(base.intent) || (tool && tool.ok && !tool.needsConfirm && !['check_allergens', 'clear_shopping', 'remove_shopping', 'new_recipe'].includes(tool.name)));
  if (useLlm) { try { const t = await llm(buildMessages(req, { mem, u, offlineOut: base, hits: isGrounded ? hits : hits.filter(h => h.src === 'recipe'), refs: relRefs, tool, long: maxTokens > 600 }), { maxTokens }); let s = typeof t === 'string' ? t : (t && (t.response || t.reply || t.text)) || ''; const prov = t && typeof t === 'object' && t.provider; s = unwrapReply(s); if (LEAK.test(s) || /^\s*[{\[]/.test(s)) { if (typeof console !== 'undefined') console.error('assistant llm leaked format/meta text; using library reply'); s = ''; } if (s && s.trim().length > 3) { reply = s.trim().slice(0, maxTokens > 600 ? 4000 : 1500); source = prov || 'ai'; } else if (typeof console !== 'undefined') console.error('assistant llm empty reply'); } catch (e) { if (typeof console !== 'undefined') console.error('assistant llm error', e && e.message); } }
  const sc = safetyCheck(req.message, reply); if (unsafeQ) sc.notes = sc.notes.filter(n => n !== unsafeQ[1] || !reply.includes(n.slice(0, 30)));
  const aw = allergenWarn(req.message, mem);
  const sources = (isGrounded ? hits : []).filter(h => h.src !== 'recipe').slice(0, 3).map(h => ({ title: h.title.replace(/ · AIchef\.food$/, ''), url: h.url }));
  return { ...base, ...(tool ? { tool: { name: tool.name, ok: !!tool.ok, needsConfirm: tool.needsConfirm || null, data: tool.data || null }, link: tool.link || base.link, linkLabel: tool.linkLabel || base.linkLabel, upgrade: tool.upgrade || base.upgrade } : {}), reply: sc.reply, notes: [aw, ...sc.notes].filter(Boolean), source, sources, disclosure: AI_DISCLOSURE };
}

// Vision prompt for a fridge photo (Workers AI free allocation); output parsed into ingredient names.
const VISION_PROMPT = 'List the distinct food ingredients visible in this fridge or cupboard photo as a short comma-separated list of common UK names. Ingredients only, no other words.';
function parseVision(text) { return parseIngredients(String(text || '').replace(/^.*?:/, '')); }

module.exports = { unwrapReply, DONT_KNOW, PERSONA, AI_DISCLOSURE, MEDICAL_NOTE, FEATURES, LIMITS, tierOf, can, gate, Memory, memKey, cleanMemory, memorySummary, safeFor, search, recipeById, cookPlan, parseCommand, parseIngredients, fridgeToPlate, leftovers, estCost, mealPlan, aisleOf, shoppingList, guide, Escalation, mailtoEscalation, safetyCheck, allergenWarn, intent, greet, offline, buildMessages, respond, ChatReq, VISION_PROMPT, parseVision };
