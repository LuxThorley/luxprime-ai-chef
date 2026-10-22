'use strict';
// Plan placeholders — edit prices in Stripe and labels in .env
// Tiers (Oct 2026): Commis Chef (free) · Chef de Partie £4.99/mo or £49/yr · Head Chef £7.99/mo or £79/yr (magazine included, 7-day
// site-side trial for new sign-ups) · Gastronomique £11.99/mo or £119/yr (household seats). Magazine add-on £3.49/mo or £34.90/yr.
// Internal ids stay 'free' / 'monthly'; legacy 'family' maps to Gastronomique.
const PRICES = { monthly: [4.99, 49], head: [7.99, 79], gastronomique: [11.99, 119], magazine: [3.49, 34.90] };
const gbp = n => '£' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
// Annual saving vs 12 × monthly, rounded down so we never overstate it.
const savePct = id => { const [m, y] = PRICES[id]; return Math.floor((1 - y / (12 * m)) * 100); };
const TRIAL_DAYS = 7;
function plans() {
  const E = process.env;
  const tier = (id, envKey, legacyM, legacyY, extra) => ({ id, price: gbp(PRICES[id][0]), annualPrice: gbp(PRICES[id][1]), savePct: savePct(id),
    priceId: E[`STRIPE_PRICE_${envKey}`] || (legacyM && E[legacyM]), annualPriceId: E[`STRIPE_PRICE_${envKey}_ANNUAL`] || (legacyY && E[legacyY]), searches: Infinity, results: 5, ...extra });
  return {
    free: { id: 'free', name: 'Commis Chef', price: '£0', searches: +(E.FREE_SEARCHES || 3), results: 3, features: [`${+(E.FREE_SEARCHES || 3)} recipe searches`, 'Up to 3 recipes per search', 'Print & share', `Magazine available as a ${gbp(PRICES.magazine[0])} add-on`] },
    monthly: tier('monthly', 'CHEF_DE_PARTIE', 'STRIPE_PRICE_MONTHLY', null, { name: 'Chef de Partie', features: ['Unlimited AI chef searches', 'Up to 5 ranked recipes', 'Favourites & history', 'Shopping lists', 'Kids mode', `Magazine available as a ${gbp(PRICES.magazine[0])} add-on`] }),
    head: tier('head', 'HEAD_CHEF', null, null, { name: 'Head Chef', popular: true, trialDays: TRIAL_DAYS, features: ['Everything in Chef de Partie', 'Lux Prime Kitchen Magazine included', 'Priority Malcolm AI', 'Monthly issue emailed to you (opt-in)', `Try it free for ${TRIAL_DAYS} days when you sign up`] }),
    gastronomique: tier('gastronomique', 'GASTRONOMIQUE', 'STRIPE_PRICE_FAMILY', null, { name: 'Gastronomique', seats: seatCap(), features: ['Everything in Head Chef', `Up to ${seatCap()} members in your household (you + ${seatCap() - 1} invited)`, 'Every member gets their own personalised magazine', 'Kids mode & family-friendly menus', 'Priority Malcolm AI'] })
  };
}
const magazine = () => { const E = process.env; return { price: gbp(PRICES.magazine[0]), annualPrice: gbp(PRICES.magazine[1]), savePct: savePct('magazine'), priceId: E.STRIPE_PRICE_MAGAZINE, annualPriceId: E.STRIPE_PRICE_MAGAZINE_ANNUAL }; };
const isMagazinePrice = pid => !!pid && [process.env.STRIPE_PRICE_MAGAZINE, process.env.STRIPE_PRICE_MAGAZINE_ANNUAL].filter(Boolean).includes(pid);
// Gastronomique seats: the old Family plan promised “up to 5 family members” (never built) — 5 seats including the owner.
function seatCap() { return Math.max(2, Math.min(10, +(process.env.GASTRONOMIQUE_SEATS || 5))); }
const magazinePrice = () => magazine().price;
const planFromPrice = pid => { if (!pid) return null; for (const p of Object.values(plans())) if (p.priceId === pid || p.annualPriceId === pid) return p.id; return null; };
// Admin = an account whose email is listed in the server-side ADMIN_EMAILS var (comma-separated). Never client-controlled.
const adminEmails = () => String(process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const isAdmin = u => !!u && !!u.email && adminEmails().includes(String(u.email).trim().toLowerCase());
// Testers = shared friends-and-family account(s) listed in server-side TESTER_EMAILS: all member features, never admin.
const testerEmails = () => String(process.env.TESTER_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const isTester = u => !!u && !!u.email && !isAdmin(u) && testerEmails().includes(String(u.email).trim().toLowerCase());
const isPremium = u => !!u && (isAdmin(u) || isTester(u) || (u.plan !== 'free' && ['active', 'trialing'].includes(u.sub_status)));
// Head Chef (and legacy Family) includes the magazine while the subscription is active.
const magazineIncluded = u => !!u && (isAdmin(u) || isTester(u) || (['head', 'gastronomique', 'family'].includes(u.plan) && ['active', 'trialing'].includes(u.sub_status)));
const planName = u => isAdmin(u) ? 'Admin' : isTester(u) ? 'Tester' : !isPremium(u) ? plans().free.name : ['gastronomique', 'family'].includes(u.plan) ? 'Gastronomique' : u.plan === 'head' ? (u._trial ? 'Head Chef (trial)' : 'Head Chef') : 'Chef de Partie';
// Gastronomique owners (and admin/tester, for testing) can invite household members.
const canOwnSeats = u => !!u && !u._associateOf && (isAdmin(u) || isTester(u) || (['gastronomique', 'family'].includes(u.plan) && ['active', 'trialing'].includes(u.sub_status)));
// Site-side 7-day Head Chef trial for new sign-ups (Stripe inactive): applied in memory while trial_ends_at is in the future.
const trialActive = u => !!u && !!u.trial_ends_at && +u.trial_ends_at > Date.now();
const withTrial = u => (!u || isPremium(u) || !trialActive(u)) ? u : { ...u, plan: 'head', sub_status: 'trialing', _trial: true };
module.exports = { TRIAL_DAYS, PRICES, savePct, magazine, isMagazinePrice, trialActive, withTrial, seatCap, canOwnSeats, plans, isPremium, isAdmin, isTester, magazineIncluded, magazinePrice, planFromPrice, planName };
