'use strict';
// Plan placeholders — edit prices in Stripe and labels in .env
// Tiers (Oct 2026): Commis Chef (free) · Chef de Partie £6.99 · Head Chef £9.99 (magazine included). Magazine add-on £3.99.
// Internal ids stay 'free' / 'monthly'; legacy 'family' maps to Gastronomique (£16.99, household seats).
function plans() {
  const E = process.env;
  return {
    free: { id: 'free', name: 'Commis Chef', price: '£0', searches: +(E.FREE_SEARCHES || 3), results: 3, features: ['3 recipe searches', 'Up to 3 recipes per search', 'Print & share', 'Magazine available as a £3.99 add-on'] },
    monthly: { id: 'monthly', name: 'Chef de Partie', price: E.PRICE_CHEF_DE_PARTIE_LABEL || '£6.99', priceId: E.STRIPE_PRICE_CHEF_DE_PARTIE || E.STRIPE_PRICE_MONTHLY, searches: Infinity, results: 5, features: ['Unlimited AI chef searches', 'Up to 5 ranked recipes', 'Favourites & history', 'Shopping lists', 'Kids mode', 'Magazine available as a £3.99 add-on'] },
    head: { id: 'head', name: 'Head Chef', price: E.PRICE_HEAD_CHEF_LABEL || '£9.99', priceId: E.STRIPE_PRICE_HEAD_CHEF, searches: Infinity, results: 5, features: ['Everything in Chef de Partie', 'Lux Prime Kitchen Magazine included', 'Priority Malcolm AI', 'Monthly issue emailed to you (opt-in)'] },
    gastronomique: { id: 'gastronomique', name: 'Gastronomique', price: E.PRICE_GASTRONOMIQUE_LABEL || '£16.99', priceId: E.STRIPE_PRICE_GASTRONOMIQUE || E.STRIPE_PRICE_FAMILY, searches: Infinity, results: 5, seats: seatCap(), features: ['Everything in Head Chef', `Up to ${seatCap()} members in your household (you + ${seatCap() - 1} invited)`, 'Every member gets their own personalised magazine', 'Kids mode & family-friendly menus', 'Priority Malcolm AI'] }
  };
}
// Gastronomique seats: the old Family plan promised “up to 5 family members” (never built) — 5 seats including the owner.
function seatCap() { return Math.max(2, Math.min(10, +(process.env.GASTRONOMIQUE_SEATS || 5))); }
const magazinePrice = () => process.env.PRICE_MAGAZINE_LABEL || '£3.99';
const planFromPrice = pid => { const E = process.env; if (!pid) return null; if (pid === E.STRIPE_PRICE_GASTRONOMIQUE || pid === E.STRIPE_PRICE_FAMILY) return 'gastronomique'; if (pid === E.STRIPE_PRICE_HEAD_CHEF) return 'head'; if (pid === E.STRIPE_PRICE_CHEF_DE_PARTIE || pid === E.STRIPE_PRICE_MONTHLY) return 'monthly'; return null; };
// Admin = an account whose email is listed in the server-side ADMIN_EMAILS var (comma-separated). Never client-controlled.
const adminEmails = () => String(process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const isAdmin = u => !!u && !!u.email && adminEmails().includes(String(u.email).trim().toLowerCase());
// Testers = shared friends-and-family account(s) listed in server-side TESTER_EMAILS: all member features, never admin.
const testerEmails = () => String(process.env.TESTER_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const isTester = u => !!u && !!u.email && !isAdmin(u) && testerEmails().includes(String(u.email).trim().toLowerCase());
const isPremium = u => !!u && (isAdmin(u) || isTester(u) || (u.plan !== 'free' && ['active', 'trialing'].includes(u.sub_status)));
// Head Chef (and legacy Family) includes the magazine while the subscription is active.
const magazineIncluded = u => !!u && (isAdmin(u) || isTester(u) || (['head', 'gastronomique', 'family'].includes(u.plan) && ['active', 'trialing'].includes(u.sub_status)));
const planName = u => isAdmin(u) ? 'Admin' : isTester(u) ? 'Tester' : !isPremium(u) ? plans().free.name : ['gastronomique', 'family'].includes(u.plan) ? 'Gastronomique' : u.plan === 'head' ? 'Head Chef' : 'Chef de Partie';
// Gastronomique owners (and admin/tester, for testing) can invite household members.
const canOwnSeats = u => !!u && !u._associateOf && (isAdmin(u) || isTester(u) || (['gastronomique', 'family'].includes(u.plan) && ['active', 'trialing'].includes(u.sub_status)));
module.exports = { seatCap, canOwnSeats, plans, isPremium, isAdmin, isTester, magazineIncluded, magazinePrice, planFromPrice, planName };
