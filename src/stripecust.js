'use strict';
// Ensure a user's stored Stripe customer exists in the current mode (live vs test). Stale ids (e.g. created in test mode
// before going live, or deleted) are replaced by a new customer; the old id is kept for reference via onReplace.
const STALE = /No such customer|similar object exists in (test|live) mode/i;
async function ensureCustomer(u, { key, get, create, onReplace }) {
  const live = /^sk_live_|^rk_live_/.test(String(key || ''));
  if (u.stripe_customer_id) {
    try { const cu = await get(`customers/${u.stripe_customer_id}`); if (cu && !cu.deleted && (cu.livemode === undefined || cu.livemode === live)) return { id: cu.id, replaced: false }; }
    catch (e) { if (!STALE.test(String(e && e.message))) throw e; }
  }
  const cu = await create('customers', { email: u.email, ...(u.name ? { name: u.name } : {}), 'metadata[user_id]': String(u.id), ...(u.stripe_customer_id ? { 'metadata[previous_customer_id]': u.stripe_customer_id } : {}) });
  await onReplace(cu.id, u.stripe_customer_id || null);
  return { id: cu.id, replaced: !!u.stripe_customer_id, previous: u.stripe_customer_id || null };
}
module.exports = { ensureCustomer, STALE };
