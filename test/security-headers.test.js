'use strict';
// Guards the CSP hardening: static _headers and the Worker share one policy, and no page relies on inline script.
const test = require('node:test'); const assert = require('node:assert'); const fs = require('fs'); const path = require('path');
const PUB = path.join(__dirname, '../public');
const hdrs = Object.fromEntries(fs.readFileSync(path.join(PUB, '_headers'), 'utf8').split('\n').filter(l => /^\s+\S+:/.test(l)).map(l => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const worker = fs.readFileSync(path.join(__dirname, '../worker/src/index.js'), 'utf8');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

test('_headers sets the full security header set', () => {
  for (const k of ['Content-Security-Policy', 'X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'Strict-Transport-Security']) assert.ok(hdrs[k], k);
  assert.equal(hdrs['X-Frame-Options'], 'DENY');
  assert.equal(hdrs['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  assert.match(hdrs['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(hdrs['Content-Security-Policy'], /script-src 'self';/);
});
test('Worker uses the same CSP, HSTS and Permissions-Policy as _headers', () => {
  assert.ok(worker.includes(`const CSP = "${hdrs['Content-Security-Policy']}"`));
  assert.ok(worker.includes(`'Strict-Transport-Security': '${hdrs['Strict-Transport-Security']}'`));
  assert.ok(worker.includes(`'Permissions-Policy': '${hdrs['Permissions-Policy']}'`));
});
test('no inline <script> blocks or inline event handlers in public HTML/JS', () => {
  for (const f of walk(PUB).filter(f => /\.(html|js)$/.test(f) && !f.includes('vendor'))) {
    const s = fs.readFileSync(f, 'utf8');
    if (f.endsWith('.html')) assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(s), `inline script in ${f}`);
    assert.ok(!/<[a-z][^>]*\son(click|load|error|change|submit|input|keyup|keydown|mouseover)=/i.test(s), `inline handler in ${f}`);
  }
});
