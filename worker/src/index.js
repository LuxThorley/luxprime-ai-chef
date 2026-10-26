// AIchef.food — Cloudflare Worker (Hono + D1 + Workers Assets). Mirrors src/server.js API.
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import ai from '../../src/ai.js';
import safety from '../../src/safety.js';
import plansMod from '../../src/plans.js';
import recipesMod from '../../src/recipes.js';
import imagesMod from '../../src/images.js';
import escoffier from '../../src/escoffier.js';
import dishimage from '../../src/dishimage.js';
import { hashPassword, verifyPassword, randomId, verifyStripeSignature, timingSafeEqualStr } from './crypto.js';
import { stripeApi } from './stripe.js';
import * as magW from './magazine.js';
import * as members from './members.js';
import community from '../../src/community.js';
import CRmod from '../../src/community-routes.js';
const CR = CRmod;
import briefMod from '../../src/brief.js';
import chat from '../../src/chat.js';
import dioscorides from '../../src/dioscorides.js';
import verifyMod from '../../src/verify.js';
import mailer from '../../src/mailer.js';
import restaurant from '../../src/restaurant.js';
import kwMod from '../../src/keywords.js';

const { safetyNotes, DISCLAIMER } = safety; const { plans, isPremium, isAdmin, isTester } = plansMod; const { UK14, RECIPES } = recipesMod;
const DIETS = ['vegetarian','vegan','gluten-free','dairy-free','nut-free','halal','slimming'];
const tag = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} '\-&]+$/u, 'letters, numbers, spaces only');
const SearchSchema = z.object({
  include: z.array(tag).max(20).default([]), exclude: z.array(tag).max(20).default([]),
  dish: z.string().trim().max(1000).optional().default(''), inspirationMode: z.enum(['escoffier','blend','malcolm','dioscorides']).default('blend'), briefIgnore: z.array(z.string().max(20)).max(12).default([]), skipClarify: z.boolean().optional(), maxMinutes: z.coerce.number().int().min(5).max(480).default(60),
  difficulty: z.enum(['easy','medium','hard','any']).default('any'), servings: z.coerce.number().int().min(1).max(12).default(2),
  diets: z.array(z.enum(DIETS)).max(7).default([]), keywords: z.union([z.string().max(400), z.array(z.string().max(40)).max(20)]).optional().default(''), excludeAllergens: z.array(z.enum(UK14)).max(14).default([]),
  cuisine: z.string().trim().max(40).default('any'), cuisines: z.array(z.string().trim().min(1).max(40).regex(/^[\p{L} '\-&()]+$/u)).max(8).default([]), kidsMode: z.boolean().default(false), useRestaurant: z.boolean().optional(),
  escoffier: z.string().regex(/^\d{1,4}[a-z]?$/).optional()
}).refine(q => q.include.length || q.dish, { message: 'Add at least one ingredient or describe a dish' });
const AuthSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(8).max(200), name: z.string().trim().max(80).optional() });
const RegisterSchema = AuthSchema.extend({ confirmPassword: z.string().max(200).optional() }).refine(d => d.confirmPassword === undefined || d.confirmPassword === d.password, { message: 'Passwords don’t match', path: ['confirmPassword'] });
const RecipeBlob = z.object({ id: z.string().max(120), title: z.string().max(140) }).passthrough();
const SESSION_DAYS = 30;

const app = new Hono();
const appUrl = c => (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/$/, '');
const db = c => c.env.DB;
const publicUser = u => u && ({ id: u.id, email: u.email, name: u.name, emailVerified: verifyMod.isVerified(u), plan: isAdmin(u) ? 'admin' : isTester(u) ? 'tester' : u.plan, planName: plansMod.planName(u), magazineIncluded: plansMod.magazineIncluded(u), restaurateur: plansMod.isRestaurateur(u), trial: u._trial ? { endsAt: new Date(+u.trial_ends_at).toISOString(), daysLeft: Math.max(1, Math.ceil((+u.trial_ends_at - Date.now()) / 864e5)) } : null, household: u._associateOf ? { role: 'member', owner: u._ownerName } : plansMod.canOwnSeats(u) ? { role: 'owner', seats: plansMod.seatCap() } : null, admin: isAdmin(u), tester: isTester(u), subStatus: u.sub_status, premium: isPremium(u), searchesUsed: u.searches_used, searchesLeft: isPremium(u) ? null : Math.max(0, plans().free.searches - u.searches_used) });
const bad = (c, e) => c.json({ error: (e.issues && e.issues[0] && e.issues[0].message) || 'Invalid input' }, 400);

// Expose string bindings to the shared Node modules (ai.js / plans.js read process.env).
app.use('*', async (c, next) => {
  globalThis.process = globalThis.process || { env: {} }; process.env = process.env || {};
  for (const [k, v] of Object.entries(c.env)) if (typeof v === 'string') process.env[k] = v;
  await next();
  const h = c.res.headers;
  h.set('X-Content-Type-Options', 'nosniff'); h.set('Referrer-Policy', 'strict-origin-when-cross-origin'); h.set('X-Frame-Options', 'SAMEORIGIN');
  h.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  if ((h.get('content-type') || '').includes('text/html') || c.req.path.startsWith('/api/'))
    h.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'self'; base-uri 'self'");
});

// Simple D1-backed fixed-window rate limiter.
async function limited(c, bucket, limit, windowSec) {
  const ip = c.req.header('cf-connecting-ip') || 'anon'; const k = `${bucket}:${ip}`; const now = Math.floor(Date.now() / 1000);
  const row = await db(c).prepare('SELECT n, reset_at FROM rate_limits WHERE k=?').bind(k).first();
  if (!row || row.reset_at <= now) { await db(c).prepare('INSERT OR REPLACE INTO rate_limits(k,n,reset_at) VALUES(?,?,?)').bind(k, 1, now + windowSec).run(); return false; }
  if (row.n >= limit) return true;
  await db(c).prepare('UPDATE rate_limits SET n=n+1 WHERE k=?').bind(k).run(); return false;
}
const rl = (bucket, limit, windowSec) => async (c, next) => (await limited(c, bucket, limit, windowSec)) ? c.json({ error: 'Too many requests — try again shortly' }, 429) : next();

// Stripe webhook first (raw body, no CSRF).
app.post('/api/billing/webhook', async c => {
  if (!c.env.STRIPE_SECRET_KEY || !c.env.STRIPE_WEBHOOK_SECRET) return c.json({ error: 'Stripe not configured' }, 503);
  const raw = await c.req.text();
  if (!(await verifyStripeSignature(raw, c.req.header('stripe-signature'), c.env.STRIPE_WEBHOOK_SECRET))) return c.text('Webhook signature error', 400);
  const event = JSON.parse(raw);
  if (await db(c).prepare('SELECT 1 FROM stripe_events WHERE id=?').bind(event.id).first()) return c.json({ received: true, duplicate: true });
  await db(c).prepare('INSERT INTO stripe_events(id) VALUES(?)').bind(event.id).run();
  const o = event.data.object; const E = c.env;
  const priceToPlan = plansMod.planFromPrice;
  const isMag = plansMod.isMagazinePrice;
  const magUpsert = (uidSql, uidVal, status, subId, itemId) => db(c).prepare(`INSERT INTO magazine_subs(user_id,status,stripe_subscription_id,stripe_item_id,unsub_token,updated_at) SELECT u.id,?,?,?,?,CURRENT_TIMESTAMP FROM users u WHERE u.id=(${uidSql}) ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, stripe_subscription_id=excluded.stripe_subscription_id, stripe_item_id=COALESCE(excluded.stripe_item_id, stripe_item_id), updated_at=CURRENT_TIMESTAMP`).bind(status, subId, itemId || null, magW.newUnsubToken(), uidVal);
  // Magazine add-on: standalone subscription (any tier, incl. free) or an extra line item on a membership subscription.
  if (event.type === 'checkout.session.completed' && o.mode === 'subscription' && o.metadata && o.metadata.plan === 'magazine') {
    await db(c).batch([db(c).prepare('UPDATE users SET stripe_customer_id=COALESCE(stripe_customer_id, ?) WHERE id=?').bind(o.customer, +o.client_reference_id), magUpsert('?', +o.client_reference_id, 'active', o.subscription)]);
    return c.json({ received: true });
  }
  const items = (o.object === 'subscription' && o.items && o.items.data) || [];
  const magItem = items.find(i => i.price && isMag(i.price.id));
  if (magItem || (o.object === 'subscription' && o.metadata && o.metadata.plan === 'magazine')) {
    const del = event.type.endsWith('deleted'); const mStatus = del ? 'canceled' : o.status;
    await magUpsert('SELECT id FROM users WHERE stripe_customer_id=?', o.customer, mStatus, o.id, magItem && magItem.id).run();
    if (!items.some(i => i.price && !isMag(i.price.id))) return c.json({ received: true }); // standalone magazine sub: membership untouched
  } else if (o.object === 'subscription' && event.type !== 'customer.subscription.created') {
    // Membership sub without the magazine item: if the add-on lived on this sub, it has been removed.
    await db(c).prepare("UPDATE magazine_subs SET status='canceled', updated_at=CURRENT_TIMESTAMP WHERE stripe_subscription_id=? AND stripe_item_id IS NOT NULL").bind(o.id).run();
  }
  if (event.type === 'checkout.session.completed' && o.mode === 'subscription') {
    const plan = (o.metadata && o.metadata.plan) || 'monthly';
    await db(c).batch([
      db(c).prepare('UPDATE users SET stripe_customer_id=?, stripe_subscription_id=?, plan=?, sub_status=? WHERE id=?').bind(o.customer, o.subscription, plan, 'active', +o.client_reference_id),
      db(c).prepare('INSERT OR REPLACE INTO subscriptions(id,user_id,customer_id,plan,status,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)').bind(o.subscription, +o.client_reference_id, o.customer, plan, 'active')]);
  } else if (['customer.subscription.updated','customer.subscription.created','customer.subscription.deleted'].includes(event.type)) {
    const del = event.type.endsWith('deleted');
    const main = items.find(i => i.price && !isMag(i.price.id)); const plan = del ? 'free' : (priceToPlan(main && main.price.id) || 'monthly'); const status = del ? 'canceled' : o.status;
    await db(c).batch([
      db(c).prepare('UPDATE users SET plan=?, sub_status=?, stripe_subscription_id=? WHERE stripe_customer_id=?').bind(plan, status, o.id, o.customer),
      db(c).prepare('INSERT OR REPLACE INTO subscriptions(id,user_id,customer_id,plan,status,current_period_end,updated_at) VALUES(?,(SELECT id FROM users WHERE stripe_customer_id=?),?,?,?,?,CURRENT_TIMESTAMP)').bind(o.id, o.customer, o.customer, plan, status, o.current_period_end || null)]);
  }
  return c.json({ received: true });
});

// CSRF double-submit + session lookup for /api/*
app.use('/api/*', rl('api', 120, 60));
app.use('/api/*', async (c, next) => {
  const secure = new URL(c.req.url).protocol === 'https:';
  let t = getCookie(c, 'lp_csrf');
  if (!t) { t = randomId(24); setCookie(c, 'lp_csrf', t, { sameSite: 'Strict', secure, path: '/' }); }
  c.set('csrf', t);
  if (['POST','PUT','PATCH','DELETE'].includes(c.req.method)) {
    const h = c.req.header('x-csrf-token'); const ck = getCookie(c, 'lp_csrf');
    if (!h || !ck || !timingSafeEqualStr(h, ck)) return c.json({ error: 'Invalid CSRF token — refresh the page' }, 403);
  }
  const sid = getCookie(c, 'lp_session');
  if (sid) {
    const u = await db(c).prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?').bind(sid, Date.now()).first();
    if (u) c.set('user', await members.effectiveUser(db(c), u));
  }
  await next();
});
const needAuth = async (c, next) => c.get('user') ? next() : c.json({ error: 'Please sign in' }, 401);
const needPremium = async (c, next) => isPremium(c.get('user')) ? next() : c.json({ error: 'This is a premium feature — upgrade to unlock', upgrade: '/pricing.html' }, 402);
async function startSession(c, u) {
  const id = randomId(32); await db(c).prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').bind(id, u.id, Date.now() + SESSION_DAYS * 864e5).run();
  setCookie(c, 'lp_session', id, { httpOnly: true, sameSite: 'Lax', secure: new URL(c.req.url).protocol === 'https:', maxAge: SESSION_DAYS * 86400, path: '/' });
}
const body = async c => { try { return await c.req.json(); } catch { return {}; } };

app.get('/api/csrf', c => c.json({ csrfToken: c.get('csrf') }));
app.post('/api/auth/register', rl('auth', 20, 900), async c => {
  const p = RegisterSchema.safeParse(await body(c)); if (!p.success) return bad(c, p.error);
  if (await db(c).prepare('SELECT 1 FROM users WHERE email=?').bind(p.data.email).first()) return c.json({ error: 'An account with that email already exists' }, 409);
  const hash = await hashPassword(p.data.password);
  const u = await db(c).prepare('INSERT INTO users(email,password_hash,name,trial_ends_at) VALUES(?,?,?,?) RETURNING *').bind(p.data.email, hash, p.data.name || null, Date.now() + plansMod.TRIAL_DAYS * 864e5).first();
  await startSession(c, u); let verification = 'pending';
  try { const r = await verifyMod.sendVerification(cq(c), c.env, u, appUrl(c)); if (r.sent) verification = 'sent'; } catch (e) { console.error('verify email', e && e.message); }
  return c.json({ user: publicUser(await members.effectiveUser(db(c), u)), verification }, 201);
});
app.post('/api/auth/verify', rl('verify', 30, 3600), async c => {
  const r = await verifyMod.consume(cq(c), String((await body(c)).token || '')); if (!r.ok) return c.json({ error: r.error, expired: !!r.expired }, 400);
  const u = await db(c).prepare('SELECT * FROM users WHERE id=?').bind(r.userId).first(); return c.json({ ok: true, user: publicUser(u) });
});
app.post('/api/auth/verify/resend', rl('verify-resend', 5, 3600), needAuth, async c => {
  const u = c.get('user'); if (verifyMod.isVerified(u)) return c.json({ ok: true, verified: true });
  if (!mailer.ready(c.env)) return c.json({ ok: false, pending: true, reason: 'email-not-configured', error: 'Verification emails aren’t switched on yet — your account works fully meanwhile, and we’ll ask you to confirm once they are.' }, 503);
  try { await verifyMod.sendVerification(cq(c), c.env, u, appUrl(c)); return c.json({ ok: true, sent: true }); } catch (e) { console.error('verify resend', e && e.message); return c.json({ error: 'Couldn’t send the email just now — please try again shortly' }, 502); }
});
app.post('/api/auth/login', rl('auth', 20, 900), async c => {
  const p = AuthSchema.safeParse(await body(c)); if (!p.success) return c.json({ error: 'Incorrect email or password' }, 401);
  const u = await db(c).prepare('SELECT * FROM users WHERE email=?').bind(p.data.email).first();
  const ok = await verifyPassword(p.data.password, u ? u.password_hash : null);
  if (!u || !ok) return c.json({ error: 'Incorrect email or password' }, 401);
  await startSession(c, u); return c.json({ user: publicUser(u) });
});
app.post('/api/auth/logout', async c => { const sid = getCookie(c, 'lp_session'); if (sid) await db(c).prepare('DELETE FROM sessions WHERE id=?').bind(sid).run(); deleteCookie(c, 'lp_session', { path: '/' }); return c.json({ ok: true }); });
app.get('/api/me', c => c.json({ user: publicUser(c.get('user')) || null }));
const PwSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8, 'New password must be at least 8 characters').max(200), confirmPassword: z.string().max(200).optional() }).refine(d => d.confirmPassword === undefined || d.confirmPassword === d.newPassword, { message: 'New passwords don’t match', path: ['confirmPassword'] });
app.post('/api/auth/password', rl('auth', 20, 900), needAuth, async c => {
  const p = PwSchema.safeParse(await body(c)); if (!p.success) return bad(c, p.error);
  const u = c.get('user'); if (!(await verifyPassword(p.data.currentPassword, u.password_hash))) return c.json({ error: 'Current password is incorrect' }, 401);
  if (p.data.newPassword === p.data.currentPassword) return c.json({ error: 'Choose a different new password' }, 400);
  const sid = getCookie(c, 'lp_session');
  await db(c).batch([db(c).prepare('UPDATE users SET password_hash=? WHERE id=?').bind(await hashPassword(p.data.newPassword), u.id),
    db(c).prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').bind(u.id, sid || '')]); // sign out every other device
  return c.json({ ok: true });
});
app.delete('/api/me', needAuth, async c => { if (isTester(c.get('user'))) return c.json({ error: 'The shared test account can’t be deleted from the site' }, 403); await db(c).prepare('DELETE FROM users WHERE id=?').bind(c.get('user').id).run(); deleteCookie(c, 'lp_session', { path: '/' }); return c.json({ ok: true }); });
app.get('/api/health', c => c.json({ ok: true, runtime: 'cloudflare-workers', ai: ai.config().provider, aiEnabled: ai.aiEnabled(), stripe: !!c.env.STRIPE_SECRET_KEY }));
app.get('/api/plans', c => { const s = !!c.env.STRIPE_SECRET_KEY; const m = plansMod.magazine(); return c.json({ plans: Object.values(plans()).map(({ priceId, annualPriceId, ...p }) => ({ ...p, searches: p.searches === Infinity ? 'unlimited' : p.searches, available: p.id === 'free' || !!(s && priceId), availableAnnual: p.id === 'free' || !!(s && annualPriceId) })), magazine: { price: m.price, annualPrice: m.annualPrice, savePct: m.savePct } }); });
app.get('/api/options', c => c.json({ diets: DIETS, allergens: UK14, cuisines: ['any', ...[...new Set([...RECIPES.map(r => r.cuisine), ...community.FUSION_CUISINES, 'Medicinal', ...Object.keys(kwMod.STYLE_CUISINES)])].sort()] }));

// Core search, shared by /api/search and Ask Malcolm regenerations. Returns [status, payload].
async function doSearch(c, u, data) {
  const prem = isPremium(u), pl = plans();
  if (!prem && u.searches_used >= pl.free.searches) return [402, { error: `You've used your ${pl.free.searches} free searches — choose a plan to keep cooking`, upgrade: '/pricing.html' }];
  const cuisines = community.normCuisines(data.cuisines, data.cuisine);
  const q = { ...data, cuisines, cuisine: cuisines.length > 1 ? cuisines.join(' + ') + ' fusion' : (cuisines[0] || 'any'), difficulty: data.difficulty === 'any' ? null : data.difficulty, limit: prem ? 5 : pl.free.results, keywords: kwMod.parseKeywords(data.keywords) };
  const brief = briefMod.without(briefMod.parseBrief(data.dish), data.briefIgnore); Object.assign(q, briefMod.applyHints(q, brief)); q.brief = { raw: brief.raw, constraints: Object.fromEntries(Object.entries(brief.hints).map(([k, v]) => [k, v.value])), question: brief.question };
  let restoUsed = null; // Restauranteur: blend the linked restaurant profile when the member's toggle is on (default off)
  if (plansMod.isRestaurateur(u) && c.env.IMAGES) { try { const prof = await kvJ(c, RK.profile(u)); const want = data.useRestaurant ?? !!(prof && prof.useInSearch); const ctx = want && prof ? restaurant.searchContext({ ...prof, useInSearch: true }) : null; if (ctx) { Object.assign(q, restaurant.applySearchContext(q, ctx)); restoUsed = ctx.name; } } catch (e) { console.error('resto ctx', e && e.message); } }
  const cl = data.skipClarify ? null : chat.clarify(q); if (cl) return [200, { clarify: cl, recipes: [], inspirationMode: q.inspirationMode, understood: [], user: publicUser(u) }];
  try { q.inspiration = await community.inspiration(cq(c), u.id); } catch {}
  // Same-account workers.dev subrequests are blocked, so reach the Malcolm worker through its service binding.
  const mBase = String(c.env.MALCOLM_AI_URL || '').replace(/\/+$/, '');
  const fetchImpl = (url, opts) => (c.env.MALCOLM && mBase && String(url).startsWith(mBase)) ? c.env.MALCOLM.fetch(new Request(url, opts)) : fetch(url, opts);
  let references = []; try { references = await ((q.inspirationMode === 'malcolm' || q.inspirationMode === 'dioscorides') && !q.escoffier ? [] : escoffier.references(d1all(c), q, { pinned: q.escoffier, ...(q.inspirationMode === 'escoffier' ? { top: 5 } : {}) })); } catch (e) { console.error('escoffier', e && e.message); }
  const [out, answer] = await Promise.all([ai.generate(q, { fetchImpl, retries: +(c.env.AI_RETRIES ?? 1), references }), chat.answerBrief(q.brief, q, { llm: chat.malcolmLlm(c.env, fetchImpl) }).catch(() => null)]);
  let recipes = out.recipes.map(r => ({ ...r, image: imagesMod.curatedImage(r), safetyNotes: safetyNotes(r, q) }));
  // AI dishes get an AI photo, generated lazily by GET /api/dish-image/:key (never blocks the recipe text).
  if (out.source !== 'offline' && c.env.IMAGES && c.env.AI) {
    try {
      recipes = await Promise.all(recipes.map(async r => {
        const key = await dishimage.imageKey(r); const fb = r.image; const alt = dishimage.altText(r);
        await db(c).prepare('INSERT OR IGNORE INTO dish_images(key,title,prompt,alt) VALUES(?,?,?,?)').bind(key, String(r.title).slice(0, 140), dishimage.buildPrompt(r), alt).run();
        return { ...r, image: { src: `/api/dish-image/${key}`, large: `/api/dish-image/${key}`, og: fb.og, alt, ai: true, key, fallback: fb.large } };
      }));
    } catch (e) { console.error('dish-image prep', e && e.message); }
  }
  await db(c).batch([
    db(c).prepare('UPDATE users SET searches_used = searches_used + ? WHERE id=?').bind(prem ? 0 : 1, u.id), // Commis Chef allowance only counts non-paid, non-trial searches
    db(c).prepare('INSERT INTO history(user_id,query_json,titles) VALUES(?,?,?)').bind(u.id, JSON.stringify(data), recipes.map(r => r.title).join(' · '))]);
  const fresh = await members.effectiveUser(db(c), await db(c).prepare('SELECT * FROM users WHERE id=?').bind(u.id).first());
  return [200, { source: out.source, answer: answer || out.answer || null, aiBusy: !!out.fallbackReason, ...(out.fallbackReason && isAdmin(u) ? { fallbackReason: out.fallbackReason } : {}), disclaimer: DISCLAIMER, inspirationMode: q.inspirationMode, restaurantContext: restoUsed, keywords: q.keywords, ...(q.diets.includes('slimming') ? { slimmingNote: kwMod.SLIMMING_NOTE } : {}), understood: briefMod.summary(brief), question: brief.question, recipes, blessing: out.blessing || null, closing: out.closing || null, ...(isAdmin(u) && out.meta ? { meta: out.meta } : {}), user: publicUser(fresh) }];
}
app.post('/api/chat', rl('chat-ip', 30, 300), needAuth, async c => {
  const p = chat.ChatRequest.safeParse(await body(c)); if (!p.success) return bad(c, p.error); const u = c.get('user'); const req = p.data;
  const lim = await chat.allow(cq(c), `chat:u${u.id}`, isPremium(u) ? chat.LIMITS.paid : chat.LIMITS.free);
  if (!lim.ok) return c.json({ error: `Malcolm needs a breather — you've reached this hour's chat limit${isPremium(u) ? '' : ' (upgrade for more)'}. Try again in ${Math.ceil(lim.retryAfter / 60)} min.`, retryAfter: lim.retryAfter, ...(isPremium(u) ? {} : { upgrade: '/pricing.html' }) }, 429);
  const mB = String(c.env.MALCOLM_AI_URL || '').replace(/\/+$/, '');
  const fImpl = (url, opts) => (c.env.MALCOLM && mB && String(url).startsWith(mB)) ? c.env.MALCOLM.fetch(new Request(url, opts)) : fetch(url, opts);
  const out = await chat.respond(req, { llm: chat.malcolmLlm(c.env, fImpl) });
  const base = { reply: out.reply, action: out.action, suggestions: out.suggestions, chatLeft: lim.left };
  if (out.action !== 'regenerate' || req.recipe) return c.json({ ...base, action: out.action === 'regenerate' ? 'answer' : out.action, context: req.context });
  const s = SearchSchema.safeParse({ ...chat.applyChanges(req.context, out.changes), skipClarify: true });
  if (!s.success) return c.json({ ...base, action: 'answer', context: req.context });
  const [st, payload] = await doSearch(c, u, s.data);
  if (st !== 200) return c.json({ ...base, action: 'answer', reply: payload.error || out.reply, upgrade: payload.upgrade, context: req.context });
  return c.json({ ...base, context: s.data, search: payload });
});
app.post('/api/search', rl('search', 20, 60), needAuth, async c => {
  const p = SearchSchema.safeParse(await body(c)); if (!p.success) return bad(c, p.error);
  const [st, payload] = await doSearch(c, c.get('user'), p.data); return c.json(payload, st);
});

// Escoffier Classics (public domain, 1907) — browse/search + single entry.
const d1all = c => async (sql, params) => (await db(c).prepare(sql).bind(...params).all()).results;
app.get('/api/dioscorides', c => { const r = c.json(dioscorides.list(c.req.query())); r.headers.set('Cache-Control', 'public, max-age=300'); return r; });
app.get('/api/escoffier', async c => { const r = c.json(await escoffier.list(d1all(c), c.req.query())); r.headers.set('Cache-Control', 'public, max-age=300'); return r; });
app.get('/api/escoffier/:no', async c => { const r = await escoffier.one(d1all(c), c.req.param('no')); return r ? c.json(r) : c.json({ error: 'Not found' }, 404); });

// Community adapter (shared with src/server.js): ratings, top-rated, events, favourites, synced prefs.
const cq = c => ({ all: async (sql, p) => (await db(c).prepare(sql).bind(...p).all()).results, get: async (sql, p) => (await db(c).prepare(sql).bind(...p).first()) || null, run: async (sql, p) => db(c).prepare(sql).bind(...p).run() });
const cctx = async (c, withBody) => ({ q: cq(c), user: c.get('user') || null, params: c.req.param(), query: c.req.query(), body: withBody ? await body(c) : {}, library: RECIPES,
  actor: c.get('user') ? 'u:' + c.get('user').id : 'ip:' + community.fnv(c.req.header('cf-connecting-ip') || 'anon'), escOne: no => escoffier.one(d1all(c), no) });
const send = (c, r) => c.json(r.json, r.status);
app.get('/api/favourites', needAuth, needPremium, async c => send(c, await CR.H.favList(await cctx(c))));
app.post('/api/favourites', needAuth, needPremium, async c => {
  const b = await body(c); const p = RecipeBlob.safeParse(b && b.recipe); if (!p.success) return bad(c, p.error);
  const json = JSON.stringify(p.data); if (json.length > 60000) return c.json({ error: 'Recipe too large' }, 413);
  const x = await cctx(c); x.body = { recipe: p.data };
  return send(c, await CR.H.favAdd(x, async r => db(c).prepare('INSERT INTO favourites(user_id,recipe_id,recipe_json) VALUES(?,?,?) ON CONFLICT(user_id,recipe_id) DO UPDATE SET recipe_json=excluded.recipe_json').bind(c.get('user').id, r.id, JSON.stringify(r)).run()));
});
app.delete('/api/favourites/:id', needAuth, needPremium, async c => { await db(c).prepare('DELETE FROM favourites WHERE user_id=? AND recipe_id=?').bind(c.get('user').id, c.req.param('id').slice(0, 120)).run(); CR.bust(); return c.json({ ok: true }); });
app.get('/api/recipes/stats', async c => send(c, await CR.H.stats(await cctx(c))));
app.get('/api/recipes/top', async c => send(c, await CR.H.top(await cctx(c))));
app.get('/api/recipes/:id', async c => send(c, await CR.H.one(await cctx(c))));
app.put('/api/recipes/:id/rating', rl('rate', 30, 60), async c => send(c, await CR.H.rate(await cctx(c, true))));
app.delete('/api/recipes/:id/rating', rl('rate', 30, 60), async c => send(c, await CR.H.unrate(await cctx(c))));
app.post('/api/recipes/:id/event', rl('event', 60, 60), async c => send(c, await CR.H.event(await cctx(c, true))));
app.post('/api/brief', async c => { const b = briefMod.parseBrief(String(((await body(c)) || {}).text || '')); return c.json({ understood: briefMod.summary(b), question: b.question }); });
app.get('/api/prefs', async c => send(c, await CR.H.prefsGet(await cctx(c))));
app.put('/api/prefs', async c => send(c, await CR.H.prefsPut(await cctx(c, true))));
app.get('/api/history', needAuth, needPremium, async c => { const { results } = await db(c).prepare('SELECT id,query_json,titles,created_at FROM history WHERE user_id=? ORDER BY id DESC LIMIT 50').bind(c.get('user').id).all(); return c.json({ history: results.map(h => ({ id: h.id, titles: h.titles, created_at: h.created_at, query: JSON.parse(h.query_json) })) }); });

app.post('/api/share', needAuth, async c => {
  const b = await body(c); const p = RecipeBlob.safeParse(b && b.recipe); if (!p.success) return bad(c, p.error);
  const json = JSON.stringify(p.data); if (json.length > 60000) return c.json({ error: 'Recipe too large' }, 413);
  const id = randomId(6, 'base64url'); await db(c).prepare('INSERT INTO shares(id,recipe_json) VALUES(?,?)').bind(id, json).run();
  return c.json({ id, url: `${appUrl(c)}/r/${id}` }, 201);
});
app.get('/api/share/:id', async c => { const r = await db(c).prepare('SELECT recipe_json FROM shares WHERE id=?').bind(c.req.param('id').slice(0, 20)).first(); return r ? c.json({ recipe: JSON.parse(r.recipe_json) }) : c.json({ error: 'Not found' }, 404); });
// ---- AI dish photos (KV-cached in IMAGES; generation needs a signed-in user within daily caps) ----
const IMG_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const imgInflight = new Map();
const imgFallback = (c, row) => { const r = c.redirect(imagesMod.curatedImage({ title: row ? row.title : '' }).large, 302); r.headers.set('Cache-Control', 'no-store'); return r; };
// Malcolm AI Image Engine first (MALCOLM binding -> POST /v1/images, preset photoreal-food), then direct Workers AI FLUX schnell.
async function malcolmImage(env, prompt) {
  const base = String(env.MALCOLM_AI_URL || '').replace(/\/+$/, ''); if (!env.MALCOLM || !base || !env.MALCOLM_AI_KEY || env.IMAGE_ENGINE === 'direct') throw new Error('malcolm image engine not configured');
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), +env.IMAGE_TIMEOUT_MS || 45000);
  try {
    const r = await env.MALCOLM.fetch(new Request(`${base}/v1/images`, { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MALCOLM_AI_KEY}` },
      body: JSON.stringify({ prompt, preset: 'photoreal-food', width: 1024, height: 1024, quality: env.IMAGE_QUALITY || 'standard', n: 1, enhance: false, format: 'bytes', timeout_ms: 40000 }) }));
    if (!r.ok) throw new Error(`malcolm images HTTP ${r.status}`);
    const ct = r.headers.get('content-type') || ''; if (!ct.startsWith('image/')) throw new Error('malcolm images non-image');
    return { bytes: new Uint8Array(await r.arrayBuffer()), provider: `malcolm/${r.headers.get('x-malcolm-model') || 'image'}` };
  } finally { clearTimeout(t); }
}
async function makeDishImage(env, row) {
  const t0 = Date.now(); let bytes, provider;
  try { ({ bytes, provider } = await malcolmImage(env, row.prompt)); if (bytes.length < 2000 || bytes.length > 6e6) throw new Error('bad image size'); }
  catch (e) {
    console.error('malcolm image -> direct fallback', e && e.message);
    if (!env.AI) throw e;
    const out = await env.AI.run(IMG_MODEL, { prompt: row.prompt, steps: +env.IMAGE_STEPS || 6 });
    const b64 = out && out.image; if (!b64) throw new Error('no image');
    bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)); provider = 'workers-ai/flux-1-schnell';
  }
  if (bytes.length < 2000 || bytes.length > 6e6) throw new Error('bad image size');
  await env.IMAGES.put(`dish/${row.key}.jpg`, bytes, { metadata: { provider, title: String(row.title || '').slice(0, 120) } }); // KV (R2 not enabled on the account)
  await env.DB.prepare("UPDATE dish_images SET status='done', provider=?, ms=?, error=NULL, updated_at=CURRENT_TIMESTAMP WHERE key=?").bind(provider, Date.now() - t0, row.key).run();
  return bytes;
}
app.get('/api/dish-image/:key', async c => {
  const key = c.req.param('key'); if (!/^[0-9a-f]{32}$/.test(key)) return c.json({ error: 'Not found' }, 404);
  const serve = (body, extra = {}) => new Response(body, { headers: { 'Content-Type': new Uint8Array(body.buffer || body, body.byteOffset || 0, 1)[0] === 0x89 ? 'image/png' : 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ...extra } });
  if (!c.env.IMAGES) return imgFallback(c, null);
  const hit = await c.env.IMAGES.get(`dish/${key}.jpg`, 'arrayBuffer'); if (hit) return serve(hit);
  const row = await db(c).prepare('SELECT * FROM dish_images WHERE key=?').bind(key).first(); if (!row) return imgFallback(c, null);
  const u = c.get('user'); if (!u || !(c.env.AI || c.env.MALCOLM)) return imgFallback(c, row);
  if (await limited(c, 'img', 15, 60)) return imgFallback(c, row);
  const tier = isAdmin(u) ? 'admin' : isTester(u) ? 'tester' : isPremium(u) ? 'member' : 'free'; const cap = dishimage.DAILY_CAPS[tier]; const day = new Date().toISOString().slice(0, 10);
  const used = await db(c).prepare('SELECT n FROM image_usage WHERE user_id=? AND day=?').bind(u.id, day).first();
  if (!imgInflight.has(key) && used && used.n >= cap) return imgFallback(c, row);
  try {
    let p = imgInflight.get(key);
    if (!p) { p = makeDishImage(c.env, row).finally(() => imgInflight.delete(key)); imgInflight.set(key, p);
      await db(c).prepare('INSERT INTO image_usage(user_id,day,n) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET n=n+1').bind(u.id, day).run(); }
    return serve(await p);
  } catch (e) {
    console.error('dish-image', e && e.message);
    await db(c).prepare("UPDATE dish_images SET status='failed', error=?, updated_at=CURRENT_TIMESTAMP WHERE key=?").bind(String(e && e.message || e).slice(0, 200), key).run();
    return imgFallback(c, row);
  }
});
app.get('/api/dish-image', c => c.redirect(imagesMod.curatedImage({ title: String(c.req.query('title') || '').slice(0, 120) }).large, 302));

const escH = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
app.get('/r/:id', async c => {
  const tpl = await (await c.env.ASSETS.fetch(new URL('/share.html', c.req.url))).text();
  const id = c.req.param('id').slice(0, 20); const row = await db(c).prepare('SELECT recipe_json FROM shares WHERE id=?').bind(id).first();
  if (!row) return c.html(tpl.replace('<!--OG-->', '<meta name="robots" content="noindex">'), 404);
  const r = JSON.parse(row.recipe_json); const base = appUrl(c); const url = `${base}/r/${id}`;
  const img = r.image && r.image.og ? base + r.image.og : `${base}/img/brand/og.png`;
  const desc = `${r.cuisine || ''} · ${r.totalMinutes || '?'} min · ${r.difficulty || ''} — an AIchef.food recipe by Malcolm, your AI chef.`;
  const og = [['og:type','article'],['og:site_name','AIchef.food'],['og:title',r.title],['og:description',desc],['og:url',url],['og:image',img]].map(([p, v]) => `<meta property="${p}" content="${escH(v)}">`).join('')
    + [['twitter:card','summary_large_image'],['twitter:title',r.title],['twitter:description',desc],['twitter:image',img]].map(([n, v]) => `<meta name="${n}" content="${escH(v)}">`).join('') + `<link rel="canonical" href="${escH(url)}">`;
  return c.html(tpl.replace('<!--OG-->', og).replace(/<title>[^<]*<\/title>/, `<title>${escH(r.title)} · AIchef.food</title>`).replace('data-share-id=""', `data-share-id="${escH(id)}"`));
});

// ---- Gastronomique household seats ----
const EmailOnly = z.object({ email: z.string().trim().toLowerCase().email().max(200) });
app.get('/api/members', needAuth, async c => { const u = c.get('user'); if (!plansMod.canOwnSeats(u)) return c.json({ owner: false, seats: plansMod.seatCap() }); return c.json({ owner: true, ...(await members.listMembers(db(c), u)) }); });
app.post('/api/members/invite', rl('invite', 20, 3600), needAuth, async c => {
  const p = EmailOnly.safeParse(await body(c)); if (!p.success) return bad(c, p.error); const u = c.get('user');
  if (!verifyMod.isVerified(u)) return c.json({ error: 'Please confirm your email address before inviting household members', verify: true }, 403);
  const r = await members.invite(db(c), u, p.data.email); if (r.error) return c.json({ error: r.error }, r.status);
  const link = `${appUrl(c)}/account.html?invite=${r.token}`; let emailed = false;
  if (magW.emailReady(c.env)) { try {
    const who = u.name || u.email; const res = await mailer.send(c.env, { to: p.data.email, subject: `${who} invited you to their AIchef.food Gastronomique plan`,
      text: `${who} has invited you to join their AIchef.food Gastronomique · Lux Prime household: unlimited AI chef recipes and your own personalised monthly magazine.\n\nAccept (sign in or create a free account with this email address): ${link}\n\nIf you weren't expecting this, just ignore this email.` }); emailed = !!res.sent; } catch (e) { console.error('invite email', e && e.message); } }
  return c.json({ ok: true, emailed, link });
});
app.delete('/api/members/me', needAuth, async c => { await members.leave(db(c), c.get('user')); return c.json({ ok: true }); });
app.delete('/api/members/:id', needAuth, async c => { const r = await members.remove(db(c), c.get('user'), +c.req.param('id') || 0); return c.json({ ok: !!r.meta.changes }); });
app.post('/api/members/accept', rl('accept', 20, 3600), needAuth, async c => {
  const t = String((await body(c)).token || ''); if (!/^[0-9a-f]{48}$/.test(t)) return c.json({ error: 'Invalid invite link' }, 400);
  if (!verifyMod.isVerified(c.get('user'))) return c.json({ error: 'Please confirm your email address first, then accept the invite', verify: true }, 403);
  const raw = await db(c).prepare('SELECT * FROM users WHERE id=?').bind(c.get('user').id).first();
  const r = await members.accept(db(c), raw, t); if (r.error) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true, user: publicUser(await members.effectiveUser(db(c), raw)) });
});

// ---- AIchef.food Magazine ----
const malcolmFetch = env => { const mBase = String(env.MALCOLM_AI_URL || '').replace(/\/+$/, ''); return (url, opts) => (env.MALCOLM && mBase && String(url).startsWith(mBase)) ? env.MALCOLM.fetch(new Request(url, opts)) : fetch(url, opts); };
const magTier = (u, row) => isAdmin(u) ? 'admin' : isTester(u) ? 'tester' : u._trial ? 'trial' : magW.entitled(u, row) ? 'subscriber' : isPremium(u) ? 'member' : 'free';
async function previewsToday(c, uid) { return ((await db(c).prepare("SELECT COUNT(*) n FROM magazine_issues WHERE user_id=? AND kind='preview' AND created_at>=date('now')").bind(uid).first()) || {}).n || 0; }
app.get('/api/magazine', async c => {
  const E = c.env; const u = c.get('user'); const mg = plansMod.magazine(); const base = { price: mg.price, annualPrice: mg.annualPrice, savePct: mg.savePct, included: 'head', headChefPrice: plans().head.price, available: !!(E.STRIPE_SECRET_KEY && E.STRIPE_PRICE_MAGAZINE), availableAnnual: !!(E.STRIPE_SECRET_KEY && E.STRIPE_PRICE_MAGAZINE_ANNUAL), emailReady: magW.emailReady(E), sample: '/mag/sample.pdf', cover: '/mag/sample-cover.jpg' };
  if (!u) return c.json(base);
  const row = await magW.magRow(E, u.id); const tier = magTier(u, row); const last = await db(c).prepare("SELECT month,status,token,sent_at FROM magazine_issues WHERE user_id=? AND kind='monthly' AND token IS NOT NULL ORDER BY id DESC LIMIT 1").bind(u.id).first();
  return c.json({ ...base, entitled: magW.entitled(u, row), free: isAdmin(u) || isTester(u), viaPlan: !isAdmin(u) && !isTester(u) && plansMod.magazineIncluded(u), planName: plansMod.planName(u), household: !!u._associateOf, status: row ? row.status : 'none', optIn: !!(row && row.opt_in), canAdd: !!(u.stripe_subscription_id && ['active', 'trialing'].includes(u.sub_status)),
    previewsLeft: Math.max(0, magW.PREVIEW_CAPS[tier] - await previewsToday(c, u.id)), latest: last ? { month: last.month, url: `/m/issue/${last.token}` } : null });
});
app.post('/api/magazine/optin', needAuth, async c => {
  const u = c.get('user'); const on = !!(await body(c)).optIn; const row = await magW.magRow(c.env, u.id);
  if (on && !verifyMod.isVerified(u)) return c.json({ error: 'Please confirm your email address first — we only send the magazine to verified emails', verify: true }, 403);
  if (on && !magW.entitled(u, row)) return c.json({ error: 'Add the magazine first to receive it by email', upgrade: '/pricing.html#magazine' }, 402);
  await db(c).prepare(`INSERT INTO magazine_subs(user_id,opt_in,${on ? 'opt_in_at' : 'opt_out_at'},unsub_token) VALUES(?,?,CURRENT_TIMESTAMP,?) ON CONFLICT(user_id) DO UPDATE SET opt_in=excluded.opt_in, ${on ? 'opt_in_at' : 'opt_out_at'}=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`).bind(u.id, on ? 1 : 0, magW.newUnsubToken()).run();
  return c.json({ ok: true, optIn: on });
});
// Personal preview, generated on demand (Malcolm + FLUX + PDF, ~20-60 s). Entitled readers and paying members; per-day caps + IP rate limit.
app.get('/api/magazine/preview', rl('magpv', 4, 600), needAuth, async c => {
  const u = c.get('user'); const row = await magW.magRow(c.env, u.id); const tier = magTier(u, row);
  if (tier === 'free') return c.json({ error: 'Personal previews come with the magazine add-on — see the free sample instead', sample: '/mag/sample.pdf' }, 402);
  if (await previewsToday(c, u.id) >= magW.PREVIEW_CAPS[tier]) return c.json({ error: 'You’ve reached today’s preview limit — try again tomorrow' }, 429);
  const ins = await db(c).prepare("INSERT INTO magazine_issues(user_id,month,kind,status,attempts) VALUES(?,?,'preview','working',1)").bind(u.id, new Date().toISOString()).run(); const id = ins.meta.last_row_id;
  try {
    const iss = await magW.buildIssue(c.env, u, { fetchImpl: malcolmFetch(c.env), manageUrl: `${appUrl(c)}/account.html#magazine`, issueNo: 'Preview' });
    await db(c).prepare("UPDATE magazine_issues SET status='done', bytes=?, ms=? WHERE id=?").bind(iss.pdf.length, iss.ms, id).run();
    return new Response(iss.pdf, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Lux-Prime-Kitchen-Magazine-${iss.profile.month}-${iss.profile.year}.pdf"`, 'Cache-Control': 'no-store', 'X-Magazine-Ms': String(iss.ms) } });
  } catch (e) {
    console.error('magazine preview', e && e.message);
    await db(c).prepare("UPDATE magazine_issues SET status='failed', error=? WHERE id=?").bind(String(e && e.message || e).slice(0, 200), id).run();
    return c.json({ error: e && e.message === 'AI_BUSY' ? 'Malcolm is busy composing — please try again in a minute' : 'We couldn’t compose your magazine just now — please try again shortly' }, 503);
  }
});
app.get('/m/issue/:token', async c => {
  const t = c.req.param('token'); if (!/^[0-9a-f]{48}$/.test(t)) return c.text('Not found', 404);
  const pdf = await c.env.IMAGES.get(`mag/${t}.pdf`, 'arrayBuffer'); if (!pdf) return c.text('This issue has expired', 404);
  return new Response(pdf, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="Lux-Prime-Kitchen-Magazine.pdf"', 'Cache-Control': 'private, max-age=3600', 'X-Robots-Tag': 'noindex' } });
});
const unsubPage = (msg, form = '') => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Magazine emails · AIchef.food</title><link rel="stylesheet" href="/css/styles.css"></head><body><main class="wrap" style="max-width:560px;padding:64px 20px"><span class="eyebrow">AIchef.food Magazine</span><h1 style="font-family:var(--serif)">Email preferences</h1><p>${msg}</p>${form}<p class="muted" style="font-size:.9rem">To cancel the magazine add-on itself, use <a href="/account.html#magazine">your account</a> (Manage billing).</p></main></body></html>`;
app.get('/m/unsubscribe', async c => {
  const t = String(c.req.query('t') || ''); if (!/^[0-9a-f]{48}$/.test(t)) return c.html(unsubPage('This link isn’t valid. You can manage emails from your account.'), 400);
  return c.html(unsubPage('Stop receiving the monthly magazine by email?', `<form method="post" action="/m/unsubscribe?t=${t}"><button class="btn">Unsubscribe</button></form>`));
});
app.post('/m/unsubscribe', async c => { // also the RFC 8058 one-click target
  const t = String(c.req.query('t') || ''); if (!/^[0-9a-f]{48}$/.test(t)) return c.html(unsubPage('This link isn’t valid.'), 400);
  const r = await db(c).prepare('UPDATE magazine_subs SET opt_in=0, opt_out_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE unsub_token=?').bind(t).run();
  return c.html(unsubPage(r.meta.changes ? 'Done — you won’t receive magazine emails any more. You can opt back in from your account at any time.' : 'We couldn’t find that subscription.'));
});

// ---- Restauranteur: restaurant website analysis + Menu Builder (KV-backed; gated to the Restauranteur plan) ----
const needResto = async (c, next) => plansMod.isRestaurateur(c.get('user')) ? next() : c.json({ error: 'The Menu Builder and restaurant tools come with the Restauranteur plan', upgrade: '/pricing.html#restaurant' }, 402);
const kvJ = async (c, k) => { const v = await c.env.IMAGES.get(k); try { return v ? JSON.parse(v) : null; } catch { return null; } };
const kvPut = (c, k, v) => c.env.IMAGES.put(k, JSON.stringify(v));
const RK = { profile: u => `rest/${u.id}/profile`, index: u => `rest/${u.id}/menus`, menu: id => `rest/menu/${id}`, share: t => `rest/share/${t}`, book: (u, id) => `rest/${u.id}/book/${id}` };
const ProfileSchema = z.object({ venueType: z.enum(Object.keys(restaurant.VENUE_TYPES)).default('restaurant'), name: z.string().trim().max(80).default(''), url: z.string().trim().max(400).default(''), description: z.string().trim().max(1500).default(''), priceBand: z.string().trim().max(40).default('') });
const inflate = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
const restoLlm = c => chat.malcolmLlm(c.env, malcolmFetch(c.env));
let menuFonts = null;
const loadMenuFonts = async c => menuFonts || (menuFonts = Object.fromEntries(await Promise.all(['serif', 'serifI', 'serifB', 'sans', 'sansB'].map(async k => [k, new Uint8Array(await (await c.env.ASSETS.fetch(new URL(`/mag/${k}.bin`, c.req.url))).arrayBuffer())]))));
const pdfName = m => `${String(m.restaurantName || 'Menu').replace(/[^\w]+/g, '-')}-${String(m.title).replace(/[^\w]+/g, '-')}`.replace(/-+/g, '-').slice(0, 90) + '.pdf';
app.get('/api/restaurant', needAuth, async c => {
  const u = c.get('user'); const ok = plansMod.isRestaurateur(u); const pl = plans().restaurant;
  const base = { entitled: ok, price: pl.price, annualPrice: pl.annualPrice, menuTypes: restaurant.MENU_TYPES, venueTypes: restaurant.VENUE_TYPES, designs: restaurant.DESIGNS, diets: restaurant.DIET_TAGS };
  if (!ok) return c.json(base);
  const prof = await getProfile(c, u); return c.json({ ...base, profile: { ...prof, sources: prof.sources.map(srcView) }, menus: (await kvJ(c, RK.index(u))) || [] });
});
app.put('/api/restaurant/profile', needAuth, needResto, async c => {
  const p = ProfileSchema.safeParse(await body(c)); if (!p.success) return bad(c, p.error); const u = c.get('user');
  if (p.data.url) { const chk = restaurant.checkUrl(p.data.url); if (!chk.ok) return c.json({ error: chk.error }, 400); p.data.url = chk.url; }
  const prev = await getProfile(c, u); const { url, ...rest } = p.data; const next = { ...prev, ...rest, updatedAt: new Date().toISOString() };
  if (url && !next.sources.some(s => s.url === url)) next.sources.push({ id: randomId(6, 'base64url'), kind: 'mine', name: rest.name, url, analysis: null, websiteMenu: '', useInSearch: true, at: new Date().toISOString() });
  await kvPut(c, RK.profile(u), next); return c.json({ profile: { ...next, sources: next.sources.map(srcView) } });
});
app.put('/api/restaurant/search-pref', needAuth, needResto, async c => {
  const on = (await body(c)).on === true; const u = c.get('user'); const prof = (await kvJ(c, RK.profile(u))) || {};
  await kvPut(c, RK.profile(u), { ...prof, useInSearch: on, updatedAt: new Date().toISOString() }); return c.json({ ok: true, useInSearch: on, linked: restaurant.sourcesOf(prof).length > 0 || !!prof.description });
});
// Linked sources (max 8): the member's own restaurant(s) and external benchmarks (competitors / inspiration).
const SourceSchema = z.object({ kind: z.enum(['mine', 'benchmark']).default('mine'), name: z.string().trim().max(80).default(''), url: z.string().trim().max(400).default(''), menuText: z.string().max(12000).default(''), useInSearch: z.boolean().optional() });
const getProfile = async (c, u) => { const p = (await kvJ(c, RK.profile(u))) || {}; if (!Array.isArray(p.sources)) { p.sources = restaurant.sourcesOf(p); delete p.url; delete p.analysis; delete p.websiteMenu; } return p; };
const srcView = s => ({ ...s, websiteMenu: undefined, hasMenu: !!s.websiteMenu, dishCount: s.dishCount || 0 });
app.post('/api/restaurant/sources', rl('resto-src', 30, 600), needAuth, needResto, async c => {
  const p = SourceSchema.safeParse(await body(c)); if (!p.success) return bad(c, p.error); const u = c.get('user'); const prof = await getProfile(c, u);
  if (prof.sources.length >= 8) return c.json({ error: 'Up to 8 linked sources — remove one first' }, 400);
  if (!p.data.url && !p.data.menuText) return c.json({ error: 'Add a website address or a menu' }, 400);
  let url = ''; if (p.data.url) { const chk = restaurant.checkUrl(p.data.url); if (!chk.ok) return c.json({ error: chk.error }, 400); url = chk.url; }
  const parsed = p.data.menuText ? restaurant.parseMenuText(p.data.menuText) : null;
  const src = { id: randomId(6, 'base64url'), kind: p.data.kind, name: p.data.name, url, analysis: null, websiteMenu: p.data.menuText || '', dishCount: parsed ? parsed.dishCount : 0, useInSearch: p.data.useInSearch ?? p.data.kind === 'mine', at: new Date().toISOString() };
  prof.sources.push(src); await kvPut(c, RK.profile(u), prof); return c.json({ source: srcView(src) }, 201);
});
app.patch('/api/restaurant/sources/:sid', needAuth, needResto, async c => {
  const p = SourceSchema.partial().safeParse(await body(c)); if (!p.success) return bad(c, p.error); const u = c.get('user'); const prof = await getProfile(c, u);
  const s = prof.sources.find(x => x.id === c.req.param('sid')); if (!s) return c.json({ error: 'Not found' }, 404);
  for (const k of ['kind', 'name', 'useInSearch']) if (p.data[k] !== undefined) s[k] = p.data[k];
  if (s.kind === 'cookbook' && p.data.kind && p.data.kind !== 'cookbook') return c.json({ error: 'Cookbook sources can’t change type' }, 400);
  await kvPut(c, RK.profile(u), prof); return c.json({ source: srcView(s) });
});
app.delete('/api/restaurant/sources/:sid', needAuth, needResto, async c => { const u = c.get('user'); const prof = await getProfile(c, u); await c.env.IMAGES.delete(RK.book(u, c.req.param('sid'))); prof.sources = prof.sources.filter(x => x.id !== c.req.param('sid')); await kvPut(c, RK.profile(u), prof); return c.json({ ok: true }); });
app.get('/api/restaurant/sources/:sid/menu', needAuth, needResto, async c => { const prof = await getProfile(c, c.get('user')); const s = prof.sources.find(x => x.id === c.req.param('sid')); if (s && s.kind === 'cookbook') return c.json({ error: 'Cookbook text stays private and is never shown or reused — Malcolm uses only its style' }, 403); return s ? c.json({ kind: s.kind, name: s.name, menu: s.websiteMenu || '' }) : c.json({ error: 'Not found' }, 404); });
// Cookbook benchmarks: private reference uploads (rights confirmed). Text is stored only under the member's own key, never returned, shared or used for anyone else.
const BOOK_MAX_BYTES = 8_000_000, BOOK_MAX_CHARS = 300_000;
app.post('/api/restaurant/cookbooks', rl('resto-book', 10, 3600), needAuth, needResto, async c => {
  if ((+c.req.header('content-length') || 0) > BOOK_MAX_BYTES * 1.4 + 4000) return c.json({ error: 'That file is too large (max 8 MB)' }, 413);
  const b = await body(c); const u = c.get('user'); const name = String(b.name || '').trim().slice(0, 120);
  if (b.rightsConfirmed !== true) return c.json({ error: 'Please confirm you own this book or have the right to use it for private reference' }, 400);
  if (!name) return c.json({ error: 'Add the book’s title' }, 400);
  const prof = await getProfile(c, u); if (prof.sources.length >= 8) return c.json({ error: 'Up to 8 linked sources — remove one first' }, 400);
  let text = '';
  try {
    if (b.kind === 'text') text = String(b.text || '');
    else if (b.kind === 'pdf') { const bytes = Uint8Array.from(atob(String(b.data || '')), ch => ch.charCodeAt(0)); if (bytes.length > BOOK_MAX_BYTES) return c.json({ error: 'That file is too large (max 8 MB)' }, 413); if (!(bytes[0] === 0x25 && bytes[1] === 0x50)) return c.json({ error: 'That isn’t a PDF file' }, 400); text = await restaurant.pdfText(bytes, inflate, BOOK_MAX_CHARS); }
    else return c.json({ error: 'Upload a text-based PDF or a text file' }, 400);
  } catch (e) { console.error('cookbook', e && e.message); return c.json({ error: 'We couldn’t read that file — try a text-based PDF or a .txt export' }, 422); }
  text = text.slice(0, BOOK_MAX_CHARS); if (text.replace(/\s/g, '').length < 500) return c.json({ error: 'We couldn’t find enough text in that file (scanned books have no text layer)' }, 422);
  const id = randomId(6, 'base64url'); await c.env.IMAGES.put(RK.book(u, id), text);
  const analysis = await restaurant.analyseCookbook(text, name, { llm: restoLlm(c), persona: chat.PERSONA });
  const src = { id, kind: 'cookbook', name, url: '', analysis: { ...analysis, at: new Date().toISOString() }, websiteMenu: '', private: true, rightsConfirmedAt: new Date().toISOString(), chars: text.length, useInSearch: false, at: new Date().toISOString() };
  prof.sources.push(src); await kvPut(c, RK.profile(u), prof); return c.json({ source: srcView(src) }, 201);
});
app.post('/api/restaurant/sources/:sid/analyse', rl('resto-analyse', 10, 600), needAuth, needResto, async c => {
  const u = c.get('user'); const prof = await getProfile(c, u); const src = prof.sources.find(x => x.id === c.req.param('sid')); if (!src) return c.json({ error: 'Not found' }, 404);
  if (src.kind === 'cookbook') { const text = (await c.env.IMAGES.get(RK.book(u, src.id))) || ''; src.analysis = { ...(await restaurant.analyseCookbook(text, src.name, { llm: restoLlm(c), persona: chat.PERSONA })), at: new Date().toISOString() }; await kvPut(c, RK.profile(u), prof); return c.json({ source: srcView(src), profile: { ...prof, sources: prof.sources.map(srcView) }, parsed: { dishCount: 0, sections: [] } }); }
  let site, parsed; const pagesRead = [];
  if (src.url) {
    let page; try { page = await restaurant.safeFetch(src.url); } catch (e) { return c.json({ error: e.message || 'We couldn’t read that website' }, 422); }
    site = restaurant.extractSite(page.html, page.url); parsed = site.ldMenu.length ? { sections: [{ name: 'Menu', dishes: site.ldMenu }], dishCount: site.ldMenu.length } : restaurant.parseMenuText(site.text); pagesRead.push(page.url);
    for (const link of site.menuLinks.slice(0, 2)) { if (parsed.dishCount >= 12) break; try { const mp = await restaurant.safeFetch(link); const ms = restaurant.extractSite(mp.html, mp.url); const mparsed = restaurant.parseMenuText(ms.text); pagesRead.push(mp.url); if (mparsed.dishCount > parsed.dishCount) { parsed = mparsed; site = { ...site, text: site.text.slice(0, 8000) + '\n' + ms.text.slice(0, 30000) }; } } catch {} }
  } else { parsed = restaurant.parseMenuText(src.websiteMenu); site = { url: '', title: src.name || 'Uploaded menu', siteName: src.name, description: '', headings: [], cuisines: [], priceRange: '', menuLinks: [], text: src.websiteMenu, ldMenu: [] }; }
  const mine = prof.sources.filter(s => s.kind === 'mine' && s.analysis).map(s => s.analysis.summary).concat(prof.description || []).join(' ');
  const analysis = await restaurant.analyse(site, parsed, { llm: restoLlm(c), persona: chat.PERSONA, kind: src.kind, mine: src.kind === 'benchmark' ? mine : null });
  if (src.url) src.websiteMenu = parsed.sections.map(s => `${s.name}\n${s.dishes.map(d => `${d.name}${d.price ? ' £' + d.price : ''}${d.description ? ' — ' + d.description : ''}`).join('\n')}`).join('\n\n').slice(0, 12000);
  src.analysis = { ...analysis, pagesRead, at: new Date().toISOString() }; src.dishCount = parsed.dishCount; src.name = src.name || analysis.name || '';
  if (src.kind === 'mine') { prof.name = prof.name || src.name; prof.priceBand = prof.priceBand || analysis.priceBand; }
  await kvPut(c, RK.profile(u), prof); return c.json({ source: srcView(src), profile: { ...prof, sources: prof.sources.map(srcView) }, parsed });
});
app.post('/api/restaurant/parse-menu', rl('resto-parse', 20, 600), needAuth, needResto, async c => {
  const len = +c.req.header('content-length') || 0; if (len > 6_000_000) return c.json({ error: 'That file is too large (max 4 MB)' }, 413);
  const b = await body(c); const kind = String(b.kind || ''); let text = '';
  try {
    if (kind === 'text') text = String(b.text || '').slice(0, 60000);
    else if (kind === 'pdf' || kind === 'image') {
      const bytes = Uint8Array.from(atob(String(b.data || '')), ch => ch.charCodeAt(0)); if (bytes.length > 4_200_000) return c.json({ error: 'That file is too large (max 4 MB)' }, 413);
      if (kind === 'pdf') { if (!(bytes[0] === 0x25 && bytes[1] === 0x50)) return c.json({ error: 'That isn’t a PDF file' }, 400); text = await restaurant.pdfText(bytes, inflate); }
      else { if (!c.env.AI) return c.json({ error: 'Image menus aren’t available right now — upload a PDF or text file instead' }, 503);
        const out = await c.env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', { image: [...bytes], prompt: 'Transcribe this restaurant menu exactly: section headings on their own lines, then one dish per line with its price.', max_tokens: 900 });
        text = String((out && (out.description || out.response)) || ''); }
    } else return c.json({ error: 'Unsupported file type' }, 400);
  } catch (e) { console.error('parse-menu', e && e.message); return c.json({ error: 'We couldn’t read that file — try a text-based PDF, a .txt export, or paste the menu' }, 422); }
  const parsed = restaurant.parseMenuText(text);
  return c.json({ text: text.slice(0, 12000), parsed, warning: parsed.dishCount ? null : 'We couldn’t find dishes in that file (scanned PDFs often have no text) — paste the menu text instead.' });
});
app.get('/api/restaurant/recipes', needAuth, needResto, async c => {
  const u = c.get('user'); const all = async (sql, p) => (await db(c).prepare(sql).bind(...p).all()).results;
  const [history, favourites] = await Promise.all([all('SELECT query_json,titles FROM history WHERE user_id=? ORDER BY id DESC LIMIT 200', [u.id]), all('SELECT recipe_json FROM favourites WHERE user_id=? ORDER BY id DESC LIMIT 100', [u.id])]);
  let res; try { res = restaurant.smartSearch(restaurant.historyItems({ history, favourites }), c.req.query()); } catch (e) { return bad(c, e); }
  return c.json({ results: res });
});
app.post('/api/restaurant/menus', rl('resto-menu', 12, 600), needAuth, needResto, async c => {
  const p = restaurant.MenuSpec.safeParse(await body(c)); if (!p.success) return bad(c, p.error); const u = c.get('user'); const spec = p.data;
  const prof = await getProfile(c, u); spec.restaurantName = spec.restaurantName || prof.name || ''; spec.description = spec.description || prof.description || '';
  const books = spec.useCookbooks ? prof.sources.filter(x => x.kind === 'cookbook' && x.analysis).slice(0, 3) : [];
  const cookbookText = books.length ? (await Promise.all(books.map(b => c.env.IMAGES.get(RK.book(u, b.id))))).filter(Boolean).join('\n').slice(0, 600000) : '';
  const menu = await restaurant.buildMenu(spec, { cookbooks: books.map(b => ({ ...b.analysis, title: b.name })), cookbookText, analysis: (prof.sources.find(x => x.kind === 'mine' && x.analysis) || {}).analysis, priceBand: prof.priceBand }, { llm: restoLlm(c), persona: chat.PERSONA });
  const id = randomId(9, 'base64url'); await kvPut(c, RK.menu(id), { uid: u.id, menu, spec });
  const idx = ((await kvJ(c, RK.index(u))) || []).filter(m => m.id !== id); idx.unshift({ id, title: menu.title, type: menu.menuTypeLabel, createdAt: menu.createdAt, source: menu.source });
  for (const old of idx.splice(60)) { await c.env.IMAGES.delete(RK.menu(old.id)); if (old.share) await c.env.IMAGES.delete(RK.share(old.share)); }
  await kvPut(c, RK.index(u), idx); return c.json({ id, menu }, 201);
});
// Full recipe for one menu dish (Malcolm), stored with the menu, in the shared recipe store (for /recipe.html) and in account history.
async function dishRecipe(c, u, rec, ci, di, { force = false } = {}) {
  const key = restaurant.dishKey(ci, di); rec.recipes = rec.recipes || {}; if (rec.recipes[key] && !force) return rec.recipes[key];
  const q = restaurant.dishQuery(rec.menu, ci, di); if (!q) return null;
  const books = (rec.spec && rec.spec.useCookbooks) ? ((await getProfile(c, u)).sources || []).filter(x => x.kind === 'cookbook') : [];
  const cookbookText = books.length ? (await Promise.all(books.map(b => c.env.IMAGES.get(RK.book(u, b.id))))).filter(Boolean).join('\n').slice(0, 600000) : '';
  let references = []; try { if (q.inspirationMode !== 'dioscorides') references = await escoffier.references(d1all(c), q, {}); } catch {}
  const out = await ai.generate(q, { fetchImpl: malcolmFetch(c.env), retries: 0, references });
  const r0 = out.recipes && out.recipes[0]; if (!r0) return null;
  let r = restaurant.finaliseDishRecipe({ ...r0, image: imagesMod.curatedImage(r0), safetyNotes: safetyNotes(r0, q) }, rec.menu, ci, di, { cookbookText, approximate: out.source === 'offline' || !!out.fallbackReason });
  r = { ...r, id: community.aiId(r) };
  try { await community.upsertRecipe(cq(c), r, u.id); } catch (e) { console.error('dish upsert', e && e.message); }
  try { await db(c).prepare('INSERT INTO history(user_id,query_json,titles) VALUES(?,?,?)').bind(u.id, JSON.stringify({ include: [], dish: `${rec.menu.title}: ${r.menuDish}`, menuBuilder: true }), `${r.menuDish} (menu: ${rec.menu.title})`).run(); } catch {}
  rec.recipes[key] = r; rec.menu.courses[ci].dishes[di].recipeId = r.id; return r;
}
const recipeLink = (c, rec) => key => { const r = rec.recipes && rec.recipes[key]; return r ? `${appUrl(c)}/recipe.html?id=${encodeURIComponent(r.id)}` : null; };
async function allRecipes(c, u, rec, max = 16) {
  const keys = rec.menu.courses.flatMap((co, ci) => co.dishes.map((_, di) => [ci, di])).slice(0, max).filter(([ci, di]) => !(rec.recipes || {})[restaurant.dishKey(ci, di)]);
  for (let i = 0; i < keys.length; i += 3) await Promise.all(keys.slice(i, i + 3).map(([ci, di]) => dishRecipe(c, u, rec, ci, di).catch(e => console.error('dish recipe', e && e.message))));
}
const ownMenu = async c => { const r = await kvJ(c, RK.menu(String(c.req.param('id')).slice(0, 20))); return r && r.uid === c.get('user').id ? r : null; };
app.get('/api/restaurant/menus/:id', needAuth, needResto, async c => { const r = await ownMenu(c); return r ? c.json({ id: c.req.param('id'), menu: r.menu, spec: r.spec, share: r.share || null, shareRecipes: r.shareRecipes !== false, recipes: Object.fromEntries(Object.entries(r.recipes || {}).map(([k, v]) => [k, { id: v.id, title: v.title, totalMinutes: v.totalMinutes, approximate: v.approximate }])) }) : c.json({ error: 'Not found' }, 404); });
app.post('/api/restaurant/menus/:id/dish/:ci/:di/recipe', rl('resto-dish', 40, 600), needAuth, needResto, async c => {
  const rec = await ownMenu(c); if (!rec) return c.json({ error: 'Not found' }, 404); const ci = +c.req.param('ci'), di = +c.req.param('di');
  if (!rec.menu.courses[ci] || !rec.menu.courses[ci].dishes[di]) return c.json({ error: 'Not found' }, 404);
  const r = await dishRecipe(c, c.get('user'), rec, ci, di, { force: !!(await body(c)).regenerate }); if (!r) return c.json({ error: 'Malcolm couldn’t write that recipe just now — try again' }, 503);
  await kvPut(c, RK.menu(c.req.param('id')), rec); return c.json({ recipe: r, url: `/recipe.html?id=${encodeURIComponent(r.id)}` });
});
app.post('/api/restaurant/menus/:id/recipes', rl('resto-dish-all', 6, 600), needAuth, needResto, async c => {
  const rec = await ownMenu(c); if (!rec) return c.json({ error: 'Not found' }, 404); await allRecipes(c, c.get('user'), rec); await kvPut(c, RK.menu(c.req.param('id')), rec);
  return c.json({ recipes: Object.fromEntries(Object.entries(rec.recipes || {}).map(([k, v]) => [k, { id: v.id, title: v.title, totalMinutes: v.totalMinutes, approximate: v.approximate }])) });
});
app.delete('/api/restaurant/menus/:id', needAuth, needResto, async c => {
  const r = await ownMenu(c); if (!r) return c.json({ error: 'Not found' }, 404); const id = c.req.param('id'); const u = c.get('user');
  await c.env.IMAGES.delete(RK.menu(id)); if (r.share) await c.env.IMAGES.delete(RK.share(r.share));
  await kvPut(c, RK.index(u), ((await kvJ(c, RK.index(u))) || []).filter(m => m.id !== id)); return c.json({ ok: true });
});
app.get('/api/restaurant/menus/:id/pdf', needAuth, needResto, async c => {
  const r = await ownMenu(c); if (!r) return c.json({ error: 'Not found' }, 404);
  const kitchen = c.req.query('kitchen') === '1'; if (kitchen) { await allRecipes(c, c.get('user'), r); await kvPut(c, RK.menu(c.req.param('id')), r); }
  const pdf = restaurant.menuPdf(r.menu, await loadMenuFonts(c), { recipes: r.recipes || {}, kitchen, linkFor: recipeLink(c, r) });
  return new Response(pdf, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${pdfName(r.menu).replace(/\.pdf$/, kitchen ? '-kitchen-pack.pdf' : '.pdf')}"`, 'Cache-Control': 'no-store' } });
});
app.post('/api/restaurant/menus/:id/share', needAuth, needResto, async c => {
  const r = await ownMenu(c); if (!r) return c.json({ error: 'Not found' }, 404); const id = c.req.param('id'); const u = c.get('user');
  const sb = await body(c); if (sb.recipes !== undefined) { r.shareRecipes = sb.recipes !== false; await kvPut(c, RK.menu(id), r); }
  if (!r.share) { r.share = randomId(12, 'base64url'); await c.env.IMAGES.put(RK.share(r.share), id); await kvPut(c, RK.menu(id), r);
    await kvPut(c, RK.index(u), ((await kvJ(c, RK.index(u))) || []).map(m => m.id === id ? { ...m, share: r.share } : m)); }
  return c.json({ url: `${appUrl(c)}/m/menu/${r.share}` });
});
app.delete('/api/restaurant/menus/:id/share', needAuth, needResto, async c => {
  const r = await ownMenu(c); if (!r) return c.json({ error: 'Not found' }, 404); const id = c.req.param('id'); const u = c.get('user');
  if (r.share) { await c.env.IMAGES.delete(RK.share(r.share)); delete r.share; await kvPut(c, RK.menu(id), r); await kvPut(c, RK.index(u), ((await kvJ(c, RK.index(u))) || []).map(m => m.id === id ? { ...m, share: null } : m)); }
  return c.json({ ok: true });
});
const sharedMenu = async c => { const t = String(c.req.param('tok')); if (!/^[A-Za-z0-9_-]{8,24}$/.test(t)) return null; const id = await c.env.IMAGES.get(RK.share(t)); if (!id) return null; const r = await kvJ(c, RK.menu(id)); return r && r.share === t ? r : null; };
app.get('/m/menu/:tok/pdf', async c => { const r = await sharedMenu(c); if (!r) return c.text('This menu is no longer shared', 404);
  return new Response(restaurant.menuPdf(r.menu, await loadMenuFonts(c), r.shareRecipes !== false ? { linkFor: recipeLink(c, r) } : {}), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${pdfName(r.menu)}"`, 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex' } }); });
app.get('/m/menu/:tok', async c => {
  const r = await sharedMenu(c); if (!r) return c.html(unsubPage('This menu is no longer shared.').replace('Email preferences', 'Menu not found').replace(/<p class="muted"[\s\S]*?<\/p>/, ''), 404);
  const m = r.menu; const tags = { vegetarian: 'V', vegan: 'VG', 'gluten-free': 'GF', 'dairy-free': 'DF', 'nut-free': 'NF', halal: 'H', slimming: 'SL' };
  const link = r.shareRecipes !== false ? recipeLink(c, r) : () => null;
  const courses = m.courses.map((co, ci) => `<section class="mc"><h2>${escH(co.name)}</h2>${co.dishes.map((d, di) => `<div class="md"><h3>${link(restaurant.dishKey(ci, di)) ? `<a href="${escH(link(restaurant.dishKey(ci, di)))}" style="color:inherit">${escH(d.name)}</a>` : escH(d.name)}${d.tags.length ? ` <small>${d.tags.map(t => tags[t]).join(' ')}</small>` : ''}${d.price != null ? `<span class="mp">${escH(d.price)}</span>` : ''}</h3>${d.description ? `<p>${escH(d.description)}</p>` : ''}${d.pairing ? `<p class="pair">To drink: ${escH(d.pairing)}</p>` : ''}</div>`).join('')}</section>`).join('');
  return c.html(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escH(m.title)} · ${escH(m.restaurantName || 'Menu')}</title><meta property="og:title" content="${escH((m.restaurantName ? m.restaurantName + ' — ' : '') + m.title)}"><meta property="og:description" content="${escH(m.intro || 'A menu composed with Malcolm on AIchef.food')}"><meta property="og:image" content="${escH(appUrl(c))}/img/brand/og.png"><link rel="stylesheet" href="/css/styles.css"></head>
<body class="menu-share"><main class="menu-card d-${escH(m.design || 'classic')}"><p class="mr">${escH((m.restaurantName || '').toUpperCase())}</p><h1>${escH(m.title)}</h1><p class="mt">${escH([m.venueType && m.venueType !== 'restaurant' ? m.venueLabel : '', m.menuTypeLabel, ...(m.cuisines || [])].filter(Boolean).join(' · '))}</p>${m.intro ? `<p class="mi">${escH(m.intro)}</p>` : ''}${courses}${m.inspiredBy && m.inspiredBy.length ? `<p class="mt">Inspired by the style of ${escH(m.inspiredBy.map(t => '“' + t + '”').join(', '))} · original dishes</p>` : ''}${m.chefNote ? `<p class="mi">${escH(m.chefNote)}</p>` : ''}
<p class="actions" style="justify-content:center;margin-top:28px"><a class="btn" href="/m/menu/${escH(c.req.param('tok'))}/pdf">Download PDF</a></p><p class="mfoot">Please tell your server about any allergies · Menu composed with Malcolm on <a href="/restauranteur.html">AIchef.food</a></p></main></body></html>`);
});

app.post('/api/billing/checkout', needAuth, async c => {
  const E = c.env; if (!E.STRIPE_SECRET_KEY) return c.json({ error: 'Payments are not configured yet' }, 503);
  const b = await body(c); const u = c.get('user'); const base = appUrl(c); const annual = b && b.interval === 'year';
  if (b && b.plan === 'magazine') {
    const magPrice = annual ? E.STRIPE_PRICE_MAGAZINE_ANNUAL : E.STRIPE_PRICE_MAGAZINE;
    if (!magPrice) return c.json({ error: `The ${annual ? 'annual ' : ''}magazine add-on is not on sale yet` }, 503);
    const row = await magW.magRow(c.env, u.id); if (magW.entitled(u, row)) return c.json({ error: 'You already have the magazine' }, 409);
    // Paying member: add a £3.49 line item to the existing subscription (prorated). Everyone else: standalone checkout.
    if (b.mode === 'add' && u.stripe_subscription_id && ['active', 'trialing'].includes(u.sub_status)) {
      const it = await stripeApi(E.STRIPE_SECRET_KEY, 'subscription_items', { subscription: u.stripe_subscription_id, price: magPrice, quantity: 1, proration_behavior: 'create_prorations', 'metadata[addon]': 'magazine' });
      await db(c).prepare("INSERT INTO magazine_subs(user_id,status,stripe_subscription_id,stripe_item_id,unsub_token) VALUES(?,'active',?,?,?) ON CONFLICT(user_id) DO UPDATE SET status='active', stripe_subscription_id=excluded.stripe_subscription_id, stripe_item_id=excluded.stripe_item_id, updated_at=CURRENT_TIMESTAMP").bind(u.id, u.stripe_subscription_id, it.id, magW.newUnsubToken()).run();
      return c.json({ added: true });
    }
    const s = await stripeApi(E.STRIPE_SECRET_KEY, 'checkout/sessions', {
      mode: 'subscription', 'line_items[0][price]': magPrice, 'line_items[0][quantity]': 1, client_reference_id: String(u.id),
      ...(u.stripe_customer_id ? { customer: u.stripe_customer_id } : { customer_email: u.email }),
      'metadata[plan]': 'magazine', 'subscription_data[metadata][plan]': 'magazine', 'subscription_data[metadata][user_id]': String(u.id),
      allow_promotion_codes: 'true', success_url: `${base}/account.html?checkout=magazine#magazine`, cancel_url: `${base}/pricing.html?checkout=cancelled#magazine` });
    return c.json({ url: s.url });
  }
  const plan = plans()[b && b.plan]; const priceId = plan && (annual ? plan.annualPriceId : plan.priceId); if (!plan || !priceId) return c.json({ error: plan ? `${annual ? 'Annual' : 'Monthly'} billing for ${plan.name} is not on sale yet` : 'Unknown plan' }, plan ? 503 : 400);
  const s = await stripeApi(E.STRIPE_SECRET_KEY, 'checkout/sessions', {
    mode: 'subscription', 'line_items[0][price]': priceId, 'line_items[0][quantity]': 1, client_reference_id: String(u.id),
    ...(u.stripe_customer_id ? { customer: u.stripe_customer_id } : { customer_email: u.email }),
    'metadata[plan]': plan.id, 'subscription_data[metadata][plan]': plan.id, 'subscription_data[metadata][user_id]': String(u.id),
    allow_promotion_codes: 'true', success_url: `${base}/${plan.id === 'restaurant' ? 'menu-builder.html' : 'account.html'}?checkout=success`, cancel_url: `${base}/pricing.html?checkout=cancelled` });
  return c.json({ url: s.url });
});
app.post('/api/billing/portal', needAuth, async c => {
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: 'Payments are not configured yet' }, 503);
  const u = c.get('user'); if (!u.stripe_customer_id) return c.json({ error: 'No subscription yet' }, 400);
  const s = await stripeApi(c.env.STRIPE_SECRET_KEY, 'billing_portal/sessions', { customer: u.stripe_customer_id, return_url: `${appUrl(c)}/account.html` });
  return c.json({ url: s.url });
});
app.all('/api/*', c => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => { console.error(err && err.stack || err); return c.json({ error: 'Something went wrong' }, 500); });
// Everything else: static assets (html_handling resolves /app -> app.html).
app.all('*', c => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  // Daily cleanup of expired sessions and rate-limit rows.
  async scheduled(e, env) {
    if (e.cron === '17 3 * * *') { await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()), env.DB.prepare('DELETE FROM rate_limits WHERE reset_at<?').bind(Math.floor(Date.now() / 1000))]); return; }
    // Magazine: every 20 min — enqueue on the 1st from 08:00 UK, then one issue per tick (keeps each run inside Workers/AI limits).
    globalThis.process = globalThis.process || { env: {} }; process.env = process.env || {}; for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v;
    const log = await magW.tick(env, { fetchImpl: malcolmFetch(env), base: (env.APP_URL || 'https://luxprime-ai-chef.oliverluxthorley.workers.dev').replace(/\/$/, ''), batch: +env.MAGAZINE_BATCH || 1 });
    if (log.enqueued || log.processed.length) console.log('magazine', JSON.stringify(log));
  }
};
