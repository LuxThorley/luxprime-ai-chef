// Lux Prime Kitchen AI Chef — Cloudflare Worker (Hono + D1 + Workers Assets). Mirrors src/server.js API.
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import ai from '../../src/ai.js';
import safety from '../../src/safety.js';
import plansMod from '../../src/plans.js';
import recipesMod from '../../src/recipes.js';
import imagesMod from '../../src/images.js';
import { hashPassword, verifyPassword, randomId, verifyStripeSignature, timingSafeEqualStr } from './crypto.js';
import { stripeApi } from './stripe.js';

const { safetyNotes, DISCLAIMER } = safety; const { plans, isPremium } = plansMod; const { UK14, RECIPES } = recipesMod;
const DIETS = ['vegetarian','vegan','gluten-free','dairy-free','nut-free','halal'];
const tag = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} '\-&]+$/u, 'letters, numbers, spaces only');
const SearchSchema = z.object({
  include: z.array(tag).max(20).default([]), exclude: z.array(tag).max(20).default([]),
  dish: z.string().trim().max(200).optional().default(''), maxMinutes: z.coerce.number().int().min(5).max(480).default(60),
  difficulty: z.enum(['easy','medium','hard','any']).default('any'), servings: z.coerce.number().int().min(1).max(12).default(2),
  diets: z.array(z.enum(DIETS)).max(6).default([]), excludeAllergens: z.array(z.enum(UK14)).max(14).default([]),
  cuisine: z.string().trim().max(40).default('any'), kidsMode: z.boolean().default(false)
}).refine(q => q.include.length || q.dish, { message: 'Add at least one ingredient or describe a dish' });
const AuthSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(8).max(200), name: z.string().trim().max(80).optional() });
const RecipeBlob = z.object({ id: z.string().max(120), title: z.string().max(140) }).passthrough();
const SESSION_DAYS = 30;

const app = new Hono();
const appUrl = c => (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/$/, '');
const db = c => c.env.DB;
const publicUser = u => u && ({ id: u.id, email: u.email, name: u.name, plan: u.plan, subStatus: u.sub_status, premium: isPremium(u), searchesUsed: u.searches_used, searchesLeft: isPremium(u) ? null : Math.max(0, plans().free.searches - u.searches_used) });
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
  const priceToPlan = pid => pid === E.STRIPE_PRICE_FAMILY ? 'family' : pid === E.STRIPE_PRICE_MONTHLY ? 'monthly' : null;
  if (event.type === 'checkout.session.completed' && o.mode === 'subscription') {
    const plan = (o.metadata && o.metadata.plan) || 'monthly';
    await db(c).batch([
      db(c).prepare('UPDATE users SET stripe_customer_id=?, stripe_subscription_id=?, plan=?, sub_status=? WHERE id=?').bind(o.customer, o.subscription, plan, 'active', +o.client_reference_id),
      db(c).prepare('INSERT OR REPLACE INTO subscriptions(id,user_id,customer_id,plan,status,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)').bind(o.subscription, +o.client_reference_id, o.customer, plan, 'active')]);
  } else if (['customer.subscription.updated','customer.subscription.created','customer.subscription.deleted'].includes(event.type)) {
    const del = event.type.endsWith('deleted');
    const plan = del ? 'free' : (priceToPlan(o.items && o.items.data[0] && o.items.data[0].price.id) || 'monthly'); const status = del ? 'canceled' : o.status;
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
    if (u) c.set('user', u);
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
  const p = AuthSchema.safeParse(await body(c)); if (!p.success) return bad(c, p.error);
  if (await db(c).prepare('SELECT 1 FROM users WHERE email=?').bind(p.data.email).first()) return c.json({ error: 'An account with that email already exists' }, 409);
  const hash = await hashPassword(p.data.password);
  const u = await db(c).prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?) RETURNING *').bind(p.data.email, hash, p.data.name || null).first();
  await startSession(c, u); return c.json({ user: publicUser(u) }, 201);
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
app.delete('/api/me', needAuth, async c => { await db(c).prepare('DELETE FROM users WHERE id=?').bind(c.get('user').id).run(); deleteCookie(c, 'lp_session', { path: '/' }); return c.json({ ok: true }); });
app.get('/api/health', c => c.json({ ok: true, runtime: 'cloudflare-workers', ai: ai.config().provider, aiEnabled: ai.aiEnabled(), stripe: !!c.env.STRIPE_SECRET_KEY }));
app.get('/api/plans', c => { const s = !!c.env.STRIPE_SECRET_KEY; return c.json({ plans: Object.values(plans()).map(({ priceId, ...p }) => ({ ...p, searches: p.searches === Infinity ? 'unlimited' : p.searches, available: p.id === 'free' || !!(s && priceId) })) }); });
app.get('/api/options', c => c.json({ diets: DIETS, allergens: UK14, cuisines: ['any', ...new Set(RECIPES.map(r => r.cuisine))].sort() }));

app.post('/api/search', rl('search', 20, 60), needAuth, async c => {
  const p = SearchSchema.safeParse(await body(c)); if (!p.success) return bad(c, p.error);
  const u = c.get('user'), prem = isPremium(u), pl = plans();
  if (!prem && u.searches_used >= pl.free.searches) return c.json({ error: `You've used your ${pl.free.searches} free searches — choose a plan to keep cooking`, upgrade: '/pricing.html' }, 402);
  const q = { ...p.data, difficulty: p.data.difficulty === 'any' ? null : p.data.difficulty, limit: prem ? 5 : pl.free.results };
  // Same-account workers.dev subrequests are blocked, so reach the Malcolm worker through its service binding.
  const mBase = String(c.env.MALCOLM_AI_URL || '').replace(/\/+$/, '');
  const fetchImpl = (url, opts) => (c.env.MALCOLM && mBase && String(url).startsWith(mBase)) ? c.env.MALCOLM.fetch(new Request(url, opts)) : fetch(url, opts);
  const out = await ai.generate(q, { fetchImpl, retries: +(c.env.AI_RETRIES ?? 1) });
  const recipes = out.recipes.map(r => ({ ...r, image: imagesMod.curatedImage(r), safetyNotes: safetyNotes(r, q) }));
  await db(c).batch([
    db(c).prepare('UPDATE users SET searches_used = searches_used + 1 WHERE id=?').bind(u.id),
    db(c).prepare('INSERT INTO history(user_id,query_json,titles) VALUES(?,?,?)').bind(u.id, JSON.stringify(p.data), recipes.map(r => r.title).join(' · '))]);
  const fresh = await db(c).prepare('SELECT * FROM users WHERE id=?').bind(u.id).first();
  return c.json({ source: out.source, fallbackReason: out.fallbackReason, disclaimer: DISCLAIMER, recipes, user: publicUser(fresh) });
});

app.get('/api/favourites', needAuth, needPremium, async c => { const { results } = await db(c).prepare('SELECT recipe_json FROM favourites WHERE user_id=? ORDER BY id DESC').bind(c.get('user').id).all(); return c.json({ favourites: results.map(r => JSON.parse(r.recipe_json)) }); });
app.post('/api/favourites', needAuth, needPremium, async c => {
  const b = await body(c); const p = RecipeBlob.safeParse(b && b.recipe); if (!p.success) return bad(c, p.error);
  const json = JSON.stringify(p.data); if (json.length > 60000) return c.json({ error: 'Recipe too large' }, 413);
  await db(c).prepare('INSERT OR REPLACE INTO favourites(user_id,recipe_id,recipe_json) VALUES(?,?,?)').bind(c.get('user').id, p.data.id, json).run(); return c.json({ ok: true }, 201);
});
app.delete('/api/favourites/:id', needAuth, needPremium, async c => { await db(c).prepare('DELETE FROM favourites WHERE user_id=? AND recipe_id=?').bind(c.get('user').id, c.req.param('id').slice(0, 120)).run(); return c.json({ ok: true }); });
app.get('/api/history', needAuth, needPremium, async c => { const { results } = await db(c).prepare('SELECT id,query_json,titles,created_at FROM history WHERE user_id=? ORDER BY id DESC LIMIT 50').bind(c.get('user').id).all(); return c.json({ history: results.map(h => ({ id: h.id, titles: h.titles, created_at: h.created_at, query: JSON.parse(h.query_json) })) }); });

app.post('/api/share', needAuth, async c => {
  const b = await body(c); const p = RecipeBlob.safeParse(b && b.recipe); if (!p.success) return bad(c, p.error);
  const json = JSON.stringify(p.data); if (json.length > 60000) return c.json({ error: 'Recipe too large' }, 413);
  const id = randomId(6, 'base64url'); await db(c).prepare('INSERT INTO shares(id,recipe_json) VALUES(?,?)').bind(id, json).run();
  return c.json({ id, url: `${appUrl(c)}/r/${id}` }, 201);
});
app.get('/api/share/:id', async c => { const r = await db(c).prepare('SELECT recipe_json FROM shares WHERE id=?').bind(c.req.param('id').slice(0, 20)).first(); return r ? c.json({ recipe: JSON.parse(r.recipe_json) }) : c.json({ error: 'Not found' }, 404); });
app.get('/api/dish-image', c => c.redirect(imagesMod.curatedImage({ title: String(c.req.query('title') || '').slice(0, 120) }).large, 302));

const escH = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
app.get('/r/:id', async c => {
  const tpl = await (await c.env.ASSETS.fetch(new URL('/share.html', c.req.url))).text();
  const id = c.req.param('id').slice(0, 20); const row = await db(c).prepare('SELECT recipe_json FROM shares WHERE id=?').bind(id).first();
  if (!row) return c.html(tpl.replace('<!--OG-->', '<meta name="robots" content="noindex">'), 404);
  const r = JSON.parse(row.recipe_json); const base = appUrl(c); const url = `${base}/r/${id}`;
  const img = r.image && r.image.og ? base + r.image.og : `${base}/img/hero.jpg`;
  const desc = `${r.cuisine || ''} · ${r.totalMinutes || '?'} min · ${r.difficulty || ''} — a Lux Prime Kitchen AI Chef recipe, powered by Malcolm AI.`;
  const og = [['og:type','article'],['og:site_name','Lux Prime Kitchen'],['og:title',r.title],['og:description',desc],['og:url',url],['og:image',img]].map(([p, v]) => `<meta property="${p}" content="${escH(v)}">`).join('')
    + [['twitter:card','summary_large_image'],['twitter:title',r.title],['twitter:description',desc],['twitter:image',img]].map(([n, v]) => `<meta name="${n}" content="${escH(v)}">`).join('') + `<link rel="canonical" href="${escH(url)}">`;
  return c.html(tpl.replace('<!--OG-->', og).replace(/<title>[^<]*<\/title>/, `<title>${escH(r.title)} · Lux Prime Kitchen</title>`).replace('data-share-id=""', `data-share-id="${escH(id)}"`));
});

app.post('/api/billing/checkout', needAuth, async c => {
  const E = c.env; if (!E.STRIPE_SECRET_KEY) return c.json({ error: 'Payments are not configured yet' }, 503);
  const b = await body(c); const plan = plans()[b && b.plan]; if (!plan || !plan.priceId) return c.json({ error: 'Unknown plan' }, 400);
  const u = c.get('user'); const base = appUrl(c);
  const s = await stripeApi(E.STRIPE_SECRET_KEY, 'checkout/sessions', {
    mode: 'subscription', 'line_items[0][price]': plan.priceId, 'line_items[0][quantity]': 1, client_reference_id: String(u.id),
    ...(u.stripe_customer_id ? { customer: u.stripe_customer_id } : { customer_email: u.email }),
    'metadata[plan]': plan.id, 'subscription_data[metadata][plan]': plan.id, 'subscription_data[metadata][user_id]': String(u.id),
    allow_promotion_codes: 'true', success_url: `${base}/account.html?checkout=success`, cancel_url: `${base}/pricing.html?checkout=cancelled` });
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
  async scheduled(_e, env) { await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()), env.DB.prepare('DELETE FROM rate_limits WHERE reset_at<?').bind(Math.floor(Date.now() / 1000))]); }
};
