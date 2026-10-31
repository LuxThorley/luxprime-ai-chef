'use strict';
// Contact form: validation, spam defences, attachment filters, rate limits and the hand-off to malcolm-mail (mocked).
const test = require('node:test'); const assert = require('node:assert'); const path = require('path'); const fs = require('fs');
const Database = require('better-sqlite3');
const W = path.join(__dirname, '..', 'worker');
const load = () => import(path.join(W, 'src', 'contact.js'));

function d1() {
  const db = new Database(':memory:');
  for (const f of fs.readdirSync(path.join(W, 'migrations')).sort()) db.exec(fs.readFileSync(path.join(W, 'migrations', f), 'utf8'));
  const prep = sql => { let args = []; const s = { bind: (...a) => { args = a; return s; }, first: async () => { const st = db.prepare(sql); return st.reader ? (st.get(...args) ?? null) : (st.run(...args), null); }, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; } }; return s; };
  return { raw: db, D: { prepare: prep, batch: async st => Promise.all(st.map(x => x.run())) } };
}
const KV = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async () => ({ keys: [] }) }; };
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF');
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);

// Fake malcolm-mail: records what it receives, answers like the real /contact.
function fakeMalcolmMail({ status = 200, reply = { subject: 'Re: Leftovers', text: 'Hello Sam,\n\nTry fried rice.\n\nWarm regards,\nMalcolm · AIChef.food' }, reason } = {}) {
  const calls = [];
  return { calls, async fetch(url, init) {
    const u = new URL(url); calls.push({ path: u.pathname, auth: init.headers.authorization, body: init.body });
    if (u.pathname === '/contact/delivered') return new Response(JSON.stringify({ ok: true }));
    if (status === 422) return new Response(JSON.stringify({ ok: false, error: 'attachment', file: 'menu.pdf', reason }), { status: 422 });
    if (status !== 200) return new Response('{}', { status });
    const files = init.body.getAll('file');
    return new Response(JSON.stringify({ ok: true, id: 'contact-11111111-2222-3333-4444-555555555555', category: 'enquiry', attachments: files.map(f => ({ name: f.name, read: true })), reply }));
  } };
}

async function setup(envOver = {}) {
  const mod = await import(path.join(W, 'src', 'index.js')); const app = mod.default; const C = await load(); const { raw, D } = d1();
  const MM = fakeMalcolmMail(envOver._mm || {}); delete envOver._mm;
  const env = { DB: D, IMAGES: KV(), JWT_SECRET: 'test-secret', APP_URL: 'https://aichef.food', CONTACT_TOKEN: 'shared-token', MALCOLM_MAIL: MM, RESEND_API_KEY: 'test-resend', ASSETS: { fetch: async () => new Response('') }, ...envOver };
  const token = await C.issueFormToken(env, Date.now() - 10000);
  let ipN = 0;
  const post = async (fields = {}, files = [], { ip = `198.51.100.${++ipN}`, sid } = {}) => {
    const fd = new FormData();
    const base = { name: 'Sam Jones', email: 'sam@example.com', topic: 'recipes', subject: 'Leftovers', message: 'What can I cook with leftover roast chicken?', consent: 'yes', formToken: token, website: '', ...fields };
    for (const [k, v] of Object.entries(base)) if (v !== undefined) fd.set(k, v);
    for (const [name, bytes] of files) fd.append('file', new File([bytes], name));
    const res = await app.fetch(new Request('https://aichef.food/api/contact', { method: 'POST', headers: { cookie: `lp_csrf=tok${sid ? '; lp_session=' + sid : ''}`, 'x-csrf-token': 'tok', 'cf-connecting-ip': ip }, body: fd }), env, { waitUntil() {} });
    return { status: res.status, j: await res.json() };
  };
  return { app, env, raw, MM, post, C };
}
function mockResend() { const sent = []; const orig = globalThis.fetch; globalThis.fetch = async (url, init) => { if (String(url).startsWith('https://api.resend.com')) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'em_1' })); } return orig(url, init); }; return { sent, restore: () => { globalThis.fetch = orig; } }; }

test('contact page: linked from the main nav and footer on every page, accessible form with attachments and consent', () => {
  const common = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'common.js'), 'utf8');
  assert.ok(common.includes("['/contact.html','Contact','/contact']"), 'header + mobile nav'); assert.ok(common.includes('<a href="/contact.html">Contact</a>'), 'footer');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'contact.html'), 'utf8');
  for (const id of ['cf-name', 'cf-email', 'cf-topic', 'cf-subject', 'cf-message', 'cf-file', 'cf-consent']) assert.match(html, new RegExp(`<label for="${id}"`), `label for ${id}`);
  assert.match(html, /name="website"[^>]*tabindex="-1"/); assert.match(html, /accept="\.jpg,\.jpeg,\.png,\.webp,\.pdf,\.txt,\.csv,\.docx"/);
  assert.doesNotMatch(html, /<script>(?!<\/script>)|on(click|submit|load)=/i, 'no inline scripts (CSP)');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'public')).filter(f => f.endsWith('.html'))) assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'), /id="site-header"[\s\S]*id="site-footer"/, `${f} uses the shared header/footer`);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'privacy.html'), 'utf8'), /id="contact"[\s\S]*Contact form/);
});

test('happy path: submission goes to malcolm-mail with the shared token; Malcolm\'s reply is emailed from malcolm@aichef.food; delivery reported back', async () => {
  const { post, MM } = await setup(); const R = mockResend();
  try {
    const { status, j } = await post({}, [['fridge.jpg', JPG], ['menu.pdf', PDF]]);
    assert.equal(status, 200, JSON.stringify(j)); assert.equal(j.ok, true); assert.equal(j.emailed, true); assert.equal(j.attachments, 2); assert.equal(j.attachmentsRead, 2);
    const c = MM.calls[0]; assert.equal(c.path, '/contact'); assert.equal(c.auth, 'Bearer shared-token');
    assert.equal(c.body.get('email'), 'sam@example.com'); assert.equal(c.body.get('topic'), 'recipes'); assert.equal(c.body.get('consent'), null); assert.ok(/^[0-9a-f]{24}$/.test(c.body.get('ipHash')), 'only a hash of the IP leaves the site');
    assert.deepEqual(c.body.getAll('file').map(f => f.name), ['fridge.jpg', 'menu.pdf']);
    assert.equal(R.sent.length, 1); assert.deepEqual(R.sent[0].to, ['sam@example.com']); assert.match(R.sent[0].from, /malcolm@aichef\.food/); assert.equal(R.sent[0].reply_to, 'malcolm@aichef.food');
    assert.equal(R.sent[0].subject, 'Re: Leftovers'); assert.match(R.sent[0].text, /fried rice/); assert.equal(R.sent[0].headers['Auto-Submitted'], 'auto-replied');
    const d = MM.calls[1]; assert.equal(d.path, '/contact/delivered'); assert.deepEqual(JSON.parse(d.body), { id: 'contact-11111111-2222-3333-4444-555555555555', replied: true, error: null });
  } finally { R.restore(); }
});

test('validation: required fields, email, topic, message length and consent', async () => {
  const { post, MM } = await setup();
  for (const [f, field] of [[{ name: '' }, 'name'], [{ email: 'not-an-email' }, 'email'], [{ topic: 'hacking' }, 'topic'], [{ message: 'hi' }, 'message'], [{ message: 'x'.repeat(5001) }, 'message'], [{ consent: undefined }, 'consent']]) {
    const { status, j } = await post(f); assert.equal(status, 400, JSON.stringify(f)); assert.equal(j.field, field);
  }
  const { j } = await post({ name: 'Sam\r\nBcc: victim@example.com' }); assert.equal(j.ok, true);
  assert.equal(MM.calls.find(c => c.path === '/contact').body.get('name'), 'Sam Bcc: victim@example.com', 'header-injection newlines flattened');
});

test('spam defences: honeypot is silently dropped; too-fast, forged and expired tokens are refused', async () => {
  const { post, MM, C, env } = await setup();
  const hp = await post({ website: 'http://spam.example' }); assert.equal(hp.status, 200); assert.equal(hp.j.ok, true); assert.equal(MM.calls.length, 0, 'bot gets a fake thank-you, nothing is sent');
  const fast = await post({ formToken: await C.issueFormToken(env, Date.now()) }); assert.equal(fast.status, 400); assert.equal(fast.j.retryToken, true); assert.match(fast.j.error, /quick/);
  const forged = await post({ formToken: `${Date.now() - 10000}.${'0'.repeat(32)}` }); assert.equal(forged.status, 400); assert.match(forged.j.error, /expired/);
  const old = await post({ formToken: await C.issueFormToken(env, Date.now() - 13 * 3600e3) }); assert.equal(old.status, 400);
  const none = await post({ formToken: '' }); assert.equal(none.status, 400);
  assert.equal(MM.calls.length, 0);
  const tok = await C.issueFormToken(env, Date.now() - 5000); assert.equal(await C.checkFormToken(env, tok), null);
  assert.equal(await C.checkFormToken({}, tok), 'expired', 'no secret, no tokens');
});

test('attachment filters: allow-list, size, count, magic bytes; executables, archives, SVG and lookalikes rejected before Malcolm', async () => {
  const { post, MM } = await setup();
  const bad = [
    [[['setup.exe', EXE]], /only JPG/], [[['invoice.pdf', EXE]], /programs/], [[['photo.jpg', PDF]], /don't match/],
    [[['logo.svg', new TextEncoder().encode('<svg/>')]], /only JPG/], [[['logo.txt', new TextEncoder().encode('<svg onload=alert(1)>')]], /SVG/],
    [[['stuff.zip', new Uint8Array([0x50, 0x4b, 3, 4])]], /only JPG/], [[['recipe.docx', new Uint8Array([0x1f, 0x8b, 8])]], /archives/],
    [[['old.docx', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])]], /old-style/], [[['bin.txt', new Uint8Array([65, 0, 66])]], /don't match/],
    [[['big.pdf', (() => { const b = new Uint8Array(5 * 1024 * 1024 + 1); b.set(PDF); return b; })()]], /5 MB/],
    [[['a.jpg', JPG], ['b.jpg', JPG], ['c.jpg', JPG], ['d.jpg', JPG]], /up to 3/],
  ];
  for (const [files, rx] of bad) { const { status, j } = await post({}, files); assert.equal(status, 400, files[0][0]); assert.equal(j.field, 'file'); assert.match(j.error, rx, files[0][0]); }
  assert.equal(MM.calls.length, 0, 'nothing reached malcolm-mail');
  const ok = await post({}, [['notes.txt', new TextEncoder().encode('eggs, leeks')], ['list.csv', new TextEncoder().encode('a,b\n1,2')], ['menu.pdf', PDF]]); assert.equal(ok.status, 200);
});

test('deep checks in malcolm-mail (e.g. a PDF with JavaScript) come back as a clear message', async () => {
  const { post } = await setup({ _mm: { status: 422, reason: 'PDFs with active content (JavaScript) are not accepted' } });
  const { status, j } = await post({}, [['menu.pdf', PDF]]); assert.equal(status, 400); assert.equal(j.field, 'file'); assert.match(j.error, /menu\.pdf: PDFs with active content/);
});

test('rate limits: 6 per IP per hour and 3 per email address per day', async () => {
  const { post, MM } = await setup();
  for (let i = 0; i < 3; i++) assert.equal((await post({}, [], { ip: '203.0.113.9' })).status, 200);
  const em = await post({}, [], { ip: '203.0.113.10' }); assert.equal(em.status, 429); assert.match(em.j.error, /already had 3 messages/);
  for (let i = 0; i < 3; i++) assert.equal((await post({ email: `p${i}@example.com` }, [], { ip: '203.0.113.9' })).status, 200);
  assert.equal((await post({ email: 'q@example.com' }, [], { ip: '203.0.113.9' })).status, 429, 'IP limit');
  assert.equal(MM.calls.filter(c => c.path === '/contact').length, 6);
});

test('failures are honest: not connected, malcolm-mail down, reply email fails (and is reported to the log)', async () => {
  let s = await setup({ MALCOLM_MAIL: undefined }); let r = await s.post(); assert.equal(r.status, 503); assert.match(r.j.error, /malcolm@aichef\.food/);
  s = await setup({ CONTACT_TOKEN: undefined }); r = await s.post(); assert.equal(r.status, 503);
  s = await setup({ _mm: { status: 503 } }); r = await s.post(); assert.equal(r.status, 502);
  s = await setup({ RESEND_API_KEY: undefined }); r = await s.post(); assert.equal(r.status, 200); assert.equal(r.j.emailed, false);
  assert.deepEqual(JSON.parse(s.MM.calls[1].body), { id: 'contact-11111111-2222-3333-4444-555555555555', replied: false, error: 'site email not configured' });
  s = await setup({ _mm: { reply: null } }); r = await s.post(); assert.equal(r.j.emailed, false); assert.equal(s.MM.calls.length, 1, 'no reply to send (e.g. spam or caps): nothing emailed');
});

test('staging dry run: every check runs, nothing leaves the site', async () => {
  const { post, MM } = await setup({ CONTACT_DRY_RUN: '1' }); const R = mockResend();
  try { const { status, j } = await post({}, [['fridge.jpg', JPG]]); assert.equal(status, 200); assert.equal(j.dryRun, true); assert.equal(MM.calls.length, 0); assert.equal(R.sent.length, 0); } finally { R.restore(); }
});

test('CSRF is required and the token endpoint advertises the limits', async () => {
  const { app, env } = await setup();
  const res = await app.fetch(new Request('https://aichef.food/api/contact', { method: 'POST', body: new FormData() }), env, { waitUntil() {} }); assert.equal(res.status, 403);
  const t = await (await app.fetch(new Request('https://aichef.food/api/contact/token'), env, { waitUntil() {} })).json();
  assert.match(t.token, /^\d{13}\.[0-9a-f]{32}$/); assert.equal(t.maxFiles, 3); assert.equal(t.maxBytes, 5 * 1024 * 1024);
});
