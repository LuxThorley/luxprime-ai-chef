'use strict';
require('dotenv').config();
const path = require('path'); const crypto = require('crypto');
const express = require('express'); const helmet = require('helmet'); const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser'); const bcrypt = require('bcryptjs'); const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { open } = require('./db'); const ai = require('./ai'); const { safetyNotes, DISCLAIMER } = require('./safety');
const { plans, isPremium, isAdmin, isTester } = require('./plans'); const images = require('./images');
const escoffier = require('./escoffier'); const fsx = require('fs'); const { UK14 } = require('./recipes');

const DIETS = ['vegetarian','vegan','gluten-free','dairy-free','nut-free','halal'];
const tag = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} '\-&]+$/u, 'letters, numbers, spaces only');
const SearchSchema = z.object({
  include: z.array(tag).max(20).default([]), exclude: z.array(tag).max(20).default([]),
  dish: z.string().trim().max(200).optional().default(''),
  maxMinutes: z.coerce.number().int().min(5).max(480).default(60),
  difficulty: z.enum(['easy','medium','hard','any']).default('any'),
  servings: z.coerce.number().int().min(1).max(12).default(2),
  diets: z.array(z.enum(DIETS)).max(6).default([]),
  excludeAllergens: z.array(z.enum(UK14)).max(14).default([]),
  cuisine: z.string().trim().max(40).default('any'), kidsMode: z.boolean().default(false),
  escoffier: z.string().regex(/^\d{1,4}[a-z]?$/).optional()
}).refine(q => q.include.length || q.dish, { message: 'Add at least one ingredient or describe a dish' });
const AuthSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(8).max(200), name: z.string().trim().max(80).optional() });

const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function createApp({ db = open(), stripe } = {}) {
  const SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'dev-only-secret');
  if (!SECRET || (process.env.NODE_ENV === 'production' && SECRET === 'change-me')) throw new Error('Set a strong JWT_SECRET');
  if (stripe === undefined) stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
  const APP_URL = process.env.APP_URL || 'http://localhost:3000';
  const prod = process.env.NODE_ENV === 'production';
  const app = express();
  app.set('trust proxy', 1); app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'"], formAction: ["'self'", 'https://checkout.stripe.com'] } } }));
  app.use(cookieParser());

  // ---- Stripe webhook (raw body, before JSON parser) ----
  app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Stripe not configured' });
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
    catch (e) { return res.status(400).send(`Webhook signature error`); }
    if (db.prepare('SELECT 1 FROM stripe_events WHERE id=?').get(event.id)) return res.json({ received: true, duplicate: true });
    db.prepare('INSERT INTO stripe_events(id) VALUES(?)').run(event.id);
    const o = event.data.object;
    const priceToPlan = pid => pid === process.env.STRIPE_PRICE_FAMILY ? 'family' : pid === process.env.STRIPE_PRICE_MONTHLY ? 'monthly' : null;
    if (event.type === 'checkout.session.completed' && o.mode === 'subscription') {
      db.prepare('UPDATE users SET stripe_customer_id=?, stripe_subscription_id=?, plan=?, sub_status=? WHERE id=?')
        .run(o.customer, o.subscription, (o.metadata && o.metadata.plan) || 'monthly', 'active', +o.client_reference_id);
    } else if (['customer.subscription.updated','customer.subscription.created','customer.subscription.deleted'].includes(event.type)) {
      const plan = event.type.endsWith('deleted') ? 'free' : (priceToPlan(o.items && o.items.data[0] && o.items.data[0].price.id) || 'monthly');
      db.prepare('UPDATE users SET plan=?, sub_status=?, stripe_subscription_id=? WHERE stripe_customer_id=?')
        .run(plan, event.type.endsWith('deleted') ? 'canceled' : o.status, o.id, o.customer);
    }
    res.json({ received: true });
  });

  app.use(express.json({ limit: '100kb' }));
  app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
  const searchLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

  // ---- CSRF: double-submit cookie ----
  app.use((req, res, next) => {
    let t = req.cookies.lp_csrf;
    if (!t) { t = crypto.randomBytes(24).toString('hex'); res.cookie('lp_csrf', t, { sameSite: 'strict', secure: prod, path: '/' }); }
    req.csrfToken = t;
    if (['POST','PUT','PATCH','DELETE'].includes(req.method) && req.path.startsWith('/api/')) {
      const h = req.get('x-csrf-token');
      if (!h || !req.cookies.lp_csrf || h.length !== req.cookies.lp_csrf.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(req.cookies.lp_csrf)))
        return res.status(403).json({ error: 'Invalid CSRF token — refresh the page' });
    }
    next();
  });
  app.get('/api/csrf', (req, res) => res.json({ csrfToken: req.csrfToken }));

  // ---- Auth ----
  const setSession = (res, u) => res.cookie('lp_session', jwt.sign({ uid: u.id }, SECRET, { expiresIn: '30d' }), { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: 30 * 864e5, path: '/' });
  app.use((req, res, next) => {
    const t = req.cookies.lp_session;
    if (t) try { const { uid } = jwt.verify(t, SECRET); req.user = db.prepare('SELECT * FROM users WHERE id=?').get(uid); } catch {}
    next();
  });
  const needAuth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Please sign in' });
  const needPremium = (req, res, next) => isPremium(req.user) ? next() : res.status(402).json({ error: 'This is a premium feature — upgrade to unlock', upgrade: '/pricing.html' });
  const publicUser = u => u && ({ id: u.id, email: u.email, name: u.name, plan: isAdmin(u) ? 'admin' : isTester(u) ? 'tester' : u.plan, admin: isAdmin(u), tester: isTester(u), subStatus: u.sub_status, premium: isPremium(u), searchesUsed: u.searches_used, searchesLeft: isPremium(u) ? null : Math.max(0, plans().free.searches - u.searches_used) });
  const bad = (res, e) => res.status(400).json({ error: (e.issues && e.issues[0] && e.issues[0].message) || 'Invalid input' });

  app.post('/api/auth/register', authLimiter, a(async (req, res) => {
    const p = AuthSchema.safeParse(req.body); if (!p.success) return bad(res, p.error);
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(p.data.email)) return res.status(409).json({ error: 'An account with that email already exists' });
    const hash = await bcrypt.hash(p.data.password, 12);
    const info = db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)').run(p.data.email, hash, p.data.name || null);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid); setSession(res, u); res.status(201).json({ user: publicUser(u) });
  }));
  app.post('/api/auth/login', authLimiter, a(async (req, res) => {
    const p = AuthSchema.safeParse(req.body); if (!p.success) return res.status(401).json({ error: 'Incorrect email or password' });
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(p.data.email);
    const ok = await bcrypt.compare(p.data.password, u ? u.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
    if (!u || !ok) return res.status(401).json({ error: 'Incorrect email or password' });
    setSession(res, u); res.json({ user: publicUser(u) });
  }));
  app.post('/api/auth/logout', (req, res) => { res.clearCookie('lp_session', { path: '/' }); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) || null }));
  const PwSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8, 'New password must be at least 8 characters').max(200) });
  app.post('/api/auth/password', authLimiter, needAuth, a(async (req, res) => {
    const p = PwSchema.safeParse(req.body); if (!p.success) return bad(res, p.error);
    if (!(await bcrypt.compare(p.data.currentPassword, req.user.password_hash))) return res.status(401).json({ error: 'Current password is incorrect' });
    if (p.data.newPassword === p.data.currentPassword) return res.status(400).json({ error: 'Choose a different new password' });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await bcrypt.hash(p.data.newPassword, 12), req.user.id); res.json({ ok: true });
  }));
  app.delete('/api/me', needAuth, (req, res) => { if (isTester(req.user)) return res.status(403).json({ error: 'The shared test account can’t be deleted from the site' }); db.prepare('DELETE FROM users WHERE id=?').run(req.user.id); res.clearCookie('lp_session', { path: '/' }); res.json({ ok: true }); });

  // ---- Config / health ----
  app.get('/api/health', (req, res) => res.json({ ok: true, ai: ai.config().provider, aiEnabled: ai.aiEnabled(), stripe: !!stripe }));
  app.get('/api/plans', (req, res) => res.json({ plans: Object.values(plans()).map(({ priceId, ...p }) => ({ ...p, searches: p.searches === Infinity ? 'unlimited' : p.searches, available: p.id === 'free' || !!(stripe && priceId) })) }));
  app.get('/api/options', (req, res) => res.json({ diets: DIETS, allergens: UK14, cuisines: ['any', ...new Set(require('./recipes').RECIPES.map(r => r.cuisine))].sort() }));

  // ---- Search ----
  app.post('/api/search', searchLimiter, needAuth, a(async (req, res) => {
    const p = SearchSchema.safeParse(req.body); if (!p.success) return bad(res, p.error);
    const u = req.user, prem = isPremium(u), pl = plans();
    if (!prem && u.searches_used >= pl.free.searches) return res.status(402).json({ error: `You've used your ${pl.free.searches} free searches — choose a plan to keep cooking`, upgrade: '/pricing.html' });
    const q = { ...p.data, difficulty: p.data.difficulty === 'any' ? null : p.data.difficulty, limit: prem ? 5 : pl.free.results };
    if (q.kidsMode && !prem) q.kidsMode = true; // kids mode allowed in trial so families can try it
    const all = (sql, params) => db.prepare(sql).all(...params);
    let references = []; try { references = await escoffier.references(all, q, { pinned: q.escoffier }); } catch (e) { console.error('escoffier', e.message); }
    const out = await ai.generate(q, { references });
    const recipes = out.recipes.map(r => {
      const img = images.curatedImage(r);
      if (out.source !== 'offline' && images.imageEnabled()) { img.src = img.large = `/api/dish-image?title=${encodeURIComponent(r.title)}`; img.generated = true; img.fallback = images.curatedImage(r).src; }
      return { ...r, image: img, safetyNotes: safetyNotes(r, q) };
    });
    db.prepare('UPDATE users SET searches_used = searches_used + 1 WHERE id=?').run(u.id);
    db.prepare('INSERT INTO history(user_id,query_json,titles) VALUES(?,?,?)').run(u.id, JSON.stringify(p.data), recipes.map(r => r.title).join(' · '));
    const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
    res.json({ source: out.source, fallbackReason: out.fallbackReason, disclaimer: DISCLAIMER, recipes, user: publicUser(fresh) });
  }));

  // ---- Escoffier Classics (public domain, 1907) ----
  const escAll = (sql, params) => db.prepare(sql).all(...params);
  app.get('/api/escoffier', a(async (req, res) => res.json(await escoffier.list(escAll, req.query))));
  app.get('/api/escoffier/:no', a(async (req, res) => { const r = await escoffier.one(escAll, req.params.no); r ? res.json(r) : res.status(404).json({ error: 'Not found' }); }));

  // ---- Favourites / history (premium) ----
  const RecipeBlob = z.object({ id: z.string().max(120), title: z.string().max(140) }).passthrough();
  app.get('/api/favourites', needAuth, needPremium, (req, res) => res.json({ favourites: db.prepare('SELECT recipe_json FROM favourites WHERE user_id=? ORDER BY id DESC').all(req.user.id).map(r => JSON.parse(r.recipe_json)) }));
  app.post('/api/favourites', needAuth, needPremium, (req, res) => {
    const p = RecipeBlob.safeParse(req.body && req.body.recipe); if (!p.success) return bad(res, p.error);
    const json = JSON.stringify(p.data); if (json.length > 60000) return res.status(413).json({ error: 'Recipe too large' });
    db.prepare('INSERT OR REPLACE INTO favourites(user_id,recipe_id,recipe_json) VALUES(?,?,?)').run(req.user.id, p.data.id, json); res.status(201).json({ ok: true });
  });
  app.delete('/api/favourites/:id', needAuth, needPremium, (req, res) => { db.prepare('DELETE FROM favourites WHERE user_id=? AND recipe_id=?').run(req.user.id, String(req.params.id).slice(0, 120)); res.json({ ok: true }); });
  app.get('/api/history', needAuth, needPremium, (req, res) => res.json({ history: db.prepare('SELECT id,query_json,titles,created_at FROM history WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id).map(h => ({ ...h, query: JSON.parse(h.query_json), query_json: undefined })) }));

  // ---- Share ----
  app.post('/api/share', needAuth, (req, res) => {
    const p = RecipeBlob.safeParse(req.body && req.body.recipe); if (!p.success) return bad(res, p.error);
    const json = JSON.stringify(p.data); if (json.length > 60000) return res.status(413).json({ error: 'Recipe too large' });
    const id = crypto.randomBytes(6).toString('base64url'); db.prepare('INSERT INTO shares(id,recipe_json) VALUES(?,?)').run(id, json);
    res.status(201).json({ id, url: `${APP_URL}/r/${id}` });
  });
  app.get('/api/share/:id', (req, res) => { const r = db.prepare('SELECT recipe_json FROM shares WHERE id=?').get(String(req.params.id).slice(0, 20)); r ? res.json({ recipe: JSON.parse(r.recipe_json) }) : res.status(404).json({ error: 'Not found' }); });

  // ---- AI dish images (cached; falls back to curated photo) ----
  const imgLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
  app.get('/api/dish-image', imgLimiter, a(async (req, res) => {
    const title = String(req.query.title || '').slice(0, 120);
    const fallback = images.curatedImage({ title }).large;
    if (!title) return res.redirect(302, fallback);
    try { const f = await images.generateDishImage(title); if (f) { res.set('Cache-Control', 'public, max-age=604800'); return res.type('png').send(fsx.readFileSync(f)); } }
    catch (e) { console.warn('image gen failed:', e.message); }
    res.redirect(302, fallback);
  }));

  // ---- Public shareable recipe page with Open Graph / Twitter meta ----
  const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shareTpl = () => fsx.readFileSync(path.join(__dirname, '..', 'public', 'share.html'), 'utf8');
  app.get('/r/:id', (req, res) => {
    const row = db.prepare('SELECT recipe_json FROM shares WHERE id=?').get(String(req.params.id).slice(0, 20));
    if (!row) return res.status(404).send(shareTpl().replace('<!--OG-->', '<meta name="robots" content="noindex">'));
    const r = JSON.parse(row.recipe_json); const url = `${APP_URL}/r/${req.params.id}`;
    const img = r.image && r.image.og && !r.image.generated ? APP_URL + r.image.og : r.image && r.image.generated ? APP_URL + r.image.src : `${APP_URL}/img/hero.jpg`;
    const desc = `${r.whyItFits ? '' : ''}${r.cuisine || ''} · ${r.totalMinutes || '?'} min · ${r.difficulty || ''} — a Lux Prime Kitchen AI Chef recipe, powered by Malcolm AI.`;
    const og = [['og:type','article'],['og:site_name','Lux Prime Kitchen'],['og:title',r.title],['og:description',desc],['og:url',url],['og:image',img]].map(([p,c]) => `<meta property="${p}" content="${escH(c)}">`).join('')
      + [['twitter:card','summary_large_image'],['twitter:title',r.title],['twitter:description',desc],['twitter:image',img]].map(([n,c]) => `<meta name="${n}" content="${escH(c)}">`).join('')
      + `<link rel="canonical" href="${escH(url)}">`;
    res.send(shareTpl().replace('<!--OG-->', og).replace(/<title>[^<]*<\/title>/, `<title>${escH(r.title)} · Lux Prime Kitchen</title>`).replace('data-share-id=""', `data-share-id="${escH(req.params.id)}"`));
  });

  // ---- Billing ----
  app.post('/api/billing/checkout', needAuth, a(async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Payments are not configured yet (add Stripe keys to .env)' });
    const plan = plans()[req.body && req.body.plan]; if (!plan || !plan.priceId) return res.status(400).json({ error: 'Unknown plan' });
    const s = await stripe.checkout.sessions.create({
      mode: 'subscription', line_items: [{ price: plan.priceId, quantity: 1 }], client_reference_id: String(req.user.id),
      customer: req.user.stripe_customer_id || undefined, customer_email: req.user.stripe_customer_id ? undefined : req.user.email,
      metadata: { plan: plan.id }, subscription_data: { metadata: { plan: plan.id, user_id: String(req.user.id) } },
      allow_promotion_codes: true, success_url: `${APP_URL}/account.html?checkout=success`, cancel_url: `${APP_URL}/pricing.html?checkout=cancelled`
    });
    res.json({ url: s.url });
  }));
  app.post('/api/billing/portal', needAuth, a(async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Payments are not configured yet' });
    if (!req.user.stripe_customer_id) return res.status(400).json({ error: 'No subscription yet' });
    const s = await stripe.billingPortal.sessions.create({ customer: req.user.stripe_customer_id, return_url: `${APP_URL}/account.html` });
    res.json({ url: s.url });
  }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: prod ? '1h' : 0 }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong' }); });
  return app;
}

if (require.main === module) {
  const port = +process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`Lux Prime Kitchen AI Chef on http://localhost:${port} (AI: ${ai.config().provider})`));
}
module.exports = { createApp, SearchSchema };
