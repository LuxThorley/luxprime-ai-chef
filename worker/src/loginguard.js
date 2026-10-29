// Per-account sign-in throttle: complements the per-IP limits. Keyed by SHA-256 of the lower-cased email, so no address is stored.
// Generous by design: FREE_FAILS wrong passwords cost nothing; the count resets after WINDOW_MS with no failures; after that each further failure
// locks that email for an exponentially growing time (BASE_LOCK_MS doubling, capped at MAX_LOCK_MS). A correct password clears it.
import { sha256Hex } from './crypto.js';
export const FREE_FAILS = 10, WINDOW_MS = 60 * 60e3, BASE_LOCK_MS = 60e3, MAX_LOCK_MS = 15 * 60e3;
export const keyFor = email => sha256Hex('login:' + String(email || '').trim().toLowerCase());
export function lockFor(fails) { return fails <= FREE_FAILS ? 0 : Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (fails - FREE_FAILS - 1)); }
export async function check(DB, email, now = Date.now()) {
  const row = await DB.prepare('SELECT fails, last_at, locked_until FROM login_failures WHERE k=?').bind(await keyFor(email)).first();
  if (row && row.locked_until > now) return { locked: true, retryAfterSec: Math.ceil((row.locked_until - now) / 1000) };
  return { locked: false };
}
export async function fail(DB, email, now = Date.now()) {
  const k = await keyFor(email); const row = await DB.prepare('SELECT fails, last_at FROM login_failures WHERE k=?').bind(k).first();
  const fails = !row || now - row.last_at > WINDOW_MS ? 1 : row.fails + 1; const lock = lockFor(fails);
  await DB.prepare('INSERT OR REPLACE INTO login_failures(k, fails, last_at, locked_until) VALUES(?,?,?,?)').bind(k, fails, now, lock ? now + lock : 0).run();
  return { fails, lockedMs: lock };
}
export async function clear(DB, email) { await DB.prepare('DELETE FROM login_failures WHERE k=?').bind(await keyFor(email)).run(); }
