'use strict';
const test = require('node:test'); const assert = require('node:assert'); const path = require('path');
// Minimal fake D1 so the Worker's middleware can run in Node.
const stmt = () => { const s = { bind: () => s, first: async () => null, run: async () => ({ meta: { changes: 0 } }), all: async () => ({ results: [] }) }; return s; };
const DB = { prepare: stmt, batch: async () => [] };
test('Worker security headers: CSP object-src none, Permissions-Policy, COOP, HSTS, no-store on API', async () => {
  const mod = await import(path.join(__dirname, '..', 'worker', 'src', 'index.js'));
  const app = mod.default; const env = { DB, IMAGES: { get: async () => null, put: async () => {}, delete: async () => {} } };
  const r = await app.fetch(new Request('https://aichef.food/api/health'), env, { waitUntil() {} });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /object-src 'none'/); assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('permissions-policy'), /geolocation=\(\)/); assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.match(r.headers.get('strict-transport-security'), /max-age=31536000; includeSubDomains/); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const w = await app.fetch(new Request('https://aichef.food/api/memory', { method: 'DELETE' }), env, { waitUntil() {} }); assert.equal(w.status, 403); // CSRF enforced
});
