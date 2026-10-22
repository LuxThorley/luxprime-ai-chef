'use strict';
// Plan placeholders — edit prices in Stripe and labels in .env
// Tiers (Oct 2026): Commis Chef (free) · Chef de Partie £6.99 · Head Chef £9.99 (magazine included). Magazine add-on £3.99.
// Internal ids stay 'free' / 'monthly' so existing accounts keep working; the old 'family' plan is folded into Head Chef ('head').
function plans() {
  const E = process.env;
  return {
    free: { id: 'free', name: 'Commis Chef', price: '£0', searches: +(E.FREE_SEARCHES || 3), results: 3, features: ['3 recipe searches', 'Up to 3 recipes per search', 'Print & share', 'Magazine available as a £3.99 add-on'] },
    monthly: { id: 'monthly', name: 'Chef de Partie', price: E.PRICE_CHEF_DE_PARTIE_LABEL || '£6.99', priceId: E.STRIPE_PRICE_CHEF_DE_PARTIE || E.STRIPE_PRICE_MONTHLY, searches: Infinity, results: 5, features: ['Unlimited AI chef searches', 'Up to 5 ranked recipes', 'Favourites & history', 'Shopping lists', 'Kids mode', 'Magazine available as a £3.99 add-on'] },
    head: { id: 'head', name: 'Head Chef', price: E.PRICE_HEAD_CHEF_LABEL || '£9.99', priceId: E.STRIPE_PRICE_HEAD_CHEF || E.STRIPE_PRICE_FAMILY, searches: Infinity, results: 5, features: ['Everything in Chef de Partie', 'Lux Prime Kitchen Magazine included', 'Priority Malcolm AI', 'Monthly issue emailed to you (opt-in)'] }
  };
}
const magazinePrice = () => process.env.PRICE_MAGAZINE_LABEL || '£3.99';
const planFromPrice = pid => { const E = process.env; if (!pid) return null; if (pid === E.STRIPE_PRICE_HEAD_CHEF || pid === E.STRIPE_PRICE_FAMILY) return 'head'; if (pid === E.STRIPE_PRICE_CHEF_DE_PARTIE || pid === E.STRIPE_PRICE_MONTHLY) return 'monthly'; return null; };
// Admin = an account whose email is listed in the server-side ADMIN_EMAILS var (comma-separated). Never client-controlled.
const adminEmails = () => String(process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const isAdmin = u => !!u && !!u.email && adminEmails().includes(String(u.email).trim().toLowerCase());
// Testers = shared friends-and-family account(s) listed in server-side TESTER_EMAILS: all member features, never admin.
const testerEmails = () => String(process.env.TESTER_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const isTester = u => !!u && !!u.email && !isAdmin(u) && testerEmails().includes(String(u.email).trim().toLowerCase());
const isPremium = u => !!u && (isAdmin(u) || isTester(u) || (u.plan !== 'free' && ['active', 'trialing'].includes(u.sub_status)));
// Head Chef (and legacy Family) includes the magazine while the subscription is active.
const magazineIncluded = u => !!u && (isAdmin(u) || isTester(u) || (['head', 'family'].includes(u.plan) && ['active', 'trialing'].includes(u.sub_status)));
const planName = u => isAdmin(u) ? 'Admin' : isTester(u) ? 'Tester' : !isPremium(u) ? plans().free.name : ['head', 'family'].includes(u.plan) ? 'Head Chef' : 'Chef de Partie';
module.exports = { plans, isPremium, isAdmin, isTester, magazineIncluded, magazinePrice, planFromPrice, planName };
