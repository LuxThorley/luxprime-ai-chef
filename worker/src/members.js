// Gastronomique household seats. An associate's effective plan is derived at request time from the owner's live subscription.
import plansMod from '../../src/plans.js';
import giftMod from '../../src/gift.js';
import { randomId } from './crypto.js';
const { canOwnSeats, isPremium, seatCap } = plansMod;

// Returns the user with an in-memory Gastronomique plan if they are an active associate of an entitled owner (never written to D1).
export async function effectiveUser(DB, u0, KV) {
  // Prepaid gift grants (KV) apply first, then the site trial, then household seats.
  if (!u0) return u0; const u = plansMod.withTrial(KV ? await giftMod.grantFor(KV, u0).catch(() => u0) : u0);
  const m = await DB.prepare("SELECT o.* , m.id AS member_id FROM plan_members m JOIN users o ON o.id=m.owner_id WHERE m.user_id=? AND m.status='active'").bind(u.id).first();
  if (!m || !canOwnSeats(m)) return u;
  const own = isPremium(u) && !u._trial && ['gastronomique', 'family', 'head', 'restaurant'].includes(u.plan);
  return own ? { ...u, _associateOf: m.id, _ownerName: m.name || m.email } : { ...u, plan: 'gastronomique', sub_status: 'active', _associateOf: m.id, _ownerName: m.name || m.email, _ownPlan: u.plan };
}
export async function listMembers(DB, owner) {
  const { results } = await DB.prepare('SELECT m.id, m.email, m.status, m.created_at, m.joined_at, u.name FROM plan_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.owner_id=? ORDER BY m.id').bind(owner.id).all();
  return { seats: seatCap(), used: 1 + results.length, members: results };
}
export async function invite(DB, owner, email) {
  if (!canOwnSeats(owner)) return { error: 'Household seats come with Gastronomique', status: 402 };
  if (email === String(owner.email).toLowerCase()) return { error: 'You already hold the owner seat', status: 400 };
  const { used } = await listMembers(DB, owner); if (used >= seatCap()) return { error: `All ${seatCap()} seats are in use — remove someone first`, status: 409 };
  const token = randomId(24);
  const r = await DB.prepare("INSERT INTO plan_members(owner_id,email,token) VALUES(?,?,?) ON CONFLICT(owner_id,email) DO NOTHING").bind(owner.id, email, token).run();
  if (!r.meta.changes) return { error: 'That person is already invited', status: 409 };
  return { token };
}
export async function accept(DB, u, token) {
  const m = await DB.prepare('SELECT m.*, o.email AS owner_email FROM plan_members m JOIN users o ON o.id=m.owner_id WHERE m.token=?').bind(token).first();
  if (!m) return { error: 'This invite is no longer valid', status: 404 };
  if (m.owner_id === u.id) return { error: 'This is your own invite link', status: 400 };
  if (String(u.email).toLowerCase() !== m.email) return { error: `This invite was sent to ${m.email} — sign in with that address to accept`, status: 403 };
  if (m.status === 'active') return { ok: true, already: true };
  const other = await DB.prepare("SELECT 1 FROM plan_members WHERE user_id=? AND status='active'").bind(u.id).first(); if (other) return { error: 'You are already a member of another household — leave it first', status: 409 };
  await DB.prepare("UPDATE plan_members SET user_id=?, status='active', joined_at=CURRENT_TIMESTAMP WHERE id=?").bind(u.id, m.id).run();
  return { ok: true };
}
export const remove = (DB, owner, id) => DB.prepare('DELETE FROM plan_members WHERE id=? AND owner_id=?').bind(id, owner.id).run();
export const leave = (DB, u) => DB.prepare('DELETE FROM plan_members WHERE user_id=?').bind(u.id).run();
