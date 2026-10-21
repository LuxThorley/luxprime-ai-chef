// WebCrypto helpers: PBKDF2 password hashing, random ids, Stripe webhook signature verification.
const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export function timingSafeEqualStr(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
export function randomId(bytes = 24, fmt = 'hex') { const a = crypto.getRandomValues(new Uint8Array(bytes)); return fmt === 'hex' ? hex(a) : b64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
const ITER = 100000; // Workers caps PBKDF2 at 100k iterations
async function derive(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}
export async function hashPassword(password) { const salt = crypto.getRandomValues(new Uint8Array(16)); return `pbkdf2$sha256$${ITER}$${b64(salt)}$${b64(await derive(password, salt, ITER))}`; }
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') { await derive(password, new Uint8Array(16), ITER); return false; }
  const got = b64(await derive(password, unb64(parts[3]), +parts[2])); return timingSafeEqualStr(got, parts[4]);
}
export async function verifyStripeSignature(payload, header, secret, toleranceSec = 300) {
  if (!header) return false; const items = header.split(',').map(x => x.split('=')); const t = (items.find(([k]) => k === 't') || [])[1];
  const sigs = items.filter(([k]) => k === 'v1').map(([, v]) => v); if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - +t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
  return sigs.some(s => timingSafeEqualStr(s, expected));
}
