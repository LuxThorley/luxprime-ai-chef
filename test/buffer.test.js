'use strict';
// Buffer DRAFT integration — Buffer is always mocked here (no network).
const test = require('node:test'); const assert = require('node:assert'); const path = require('path'); const fs = require('fs');
const Database = require('better-sqlite3');
const W = path.join(__dirname, '..', 'worker');
const FAKE_KEY = 'TEST_KEY_never_print_me_0123456789abcdefXYZ';
const CH = { facebook: '6ae1d5932f1f5ed648fa5a0e', instagram: '6ae1d92f2f1f5ed648fa9a33', linkedin: '6ae1dad82f1f5ed648faab97' };
const load = () => import(path.join(W, 'src', 'buffer-drafts.js'));
const copyMod = () => import(path.join(W, 'src', 'social-copy.js'));

function memStore(initial = 0) { const rows = []; return { rows, async countDay() { return initial + rows.filter(r => ['draft', 'not_draft_deleted', 'not_draft_alert'].includes(r.status)).length; }, async log(r) { rows.push(r); } }; }
function mockBuffer(handler) {
  const calls = [];
  const f = async (url, init) => { const b = JSON.parse(init.body); calls.push({ url, auth: init.headers.Authorization, body: b }); const data = handler(b, calls.length); return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }); };
  return { f, calls };
}
const draftOk = (status = 'draft') => b => /deletePost/.test(b.query) ? { data: { deletePost: { __typename: 'DeletePostSuccess' } } } : { data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'post_' + b.variables.input.channelId.slice(-4), status, channelId: b.variables.input.channelId, channelService: 'x' } } } };

test('buildDraftInput: always saveToDraft, never shareNow/dueAt; per-network metadata', async () => {
  const { buildDraftInput } = await load();
  for (const service of ['facebook', 'linkedin', 'instagram']) {
    const i = buildDraftInput({ service, channelId: CH[service], text: 'Hello', link: 'https://aichef.food/r/abc', imageUrl: 'https://aichef.food/img/pasta.jpg', title: 'T' });
    assert.equal(i.saveToDraft, true); assert.equal(i.mode, 'addToQueue'); assert.equal(i.dueAt, undefined); assert.equal(i.schedulingType, 'automatic');
    assert.deepEqual(i.assets, [{ image: { url: 'https://aichef.food/img/pasta.jpg' } }]);
    assert.ok(!JSON.stringify(i).includes('shareNow'));
  }
  const fb = buildDraftInput({ service: 'facebook', channelId: CH.facebook, text: 'Hi', link: 'https://aichef.food/r/x', title: 'T' });
  assert.equal(fb.metadata.facebook.type, 'post'); assert.equal(fb.metadata.facebook.linkAttachment.url, 'https://aichef.food/r/x'); assert.deepEqual(fb.assets, []);
  const fbImg = buildDraftInput({ service: 'facebook', channelId: CH.facebook, text: 'Hi', link: 'https://aichef.food/r/x', imageUrl: 'https://aichef.food/a.jpg' });
  assert.equal(fbImg.metadata.facebook.linkAttachment, undefined, 'linkAttachment is mutually exclusive with assets'); assert.match(fbImg.text, /https:\/\/aichef\.food\/r\/x/);
  const li = buildDraftInput({ service: 'linkedin', channelId: CH.linkedin, text: 'Hi', link: 'https://aichef.food/r/x' });
  assert.equal(li.metadata.linkedin.linkAttachment.url, 'https://aichef.food/r/x');
  const ig = buildDraftInput({ service: 'instagram', channelId: CH.instagram, text: 'Hi', imageUrl: 'https://aichef.food/a.jpg', link: 'https://aichef.food/r/x' });
  assert.deepEqual(ig.metadata.instagram, { type: 'post', shouldShareToFeed: true }); assert.ok(!ig.text.includes('https://'), 'no dead links in IG captions');
  assert.throws(() => buildDraftInput({ service: 'instagram', channelId: CH.instagram, text: 'Hi' }), e => e.code === 'needs_image');
  assert.throws(() => buildDraftInput({ service: 'facebook', channelId: CH.facebook, text: 'Hi', imageUrl: 'http://insecure/x.jpg' }), e => e.code === 'bad_input');
  assert.throws(() => buildDraftInput({ service: 'twitter', channelId: CH.facebook, text: 'Hi' }), e => e.code === 'bad_input');
  assert.throws(() => buildDraftInput({ service: 'linkedin', channelId: CH.linkedin, text: 'x'.repeat(3001) }), e => e.code === 'too_long');
});

test('createDraft: sends Bearer key only to Buffer, logs audit row, never leaks the key', async () => {
  const { createDraft } = await load(); const m = mockBuffer(draftOk()); const store = memStore();
  const r = await createDraft({ service: 'linkedin', channelId: CH.linkedin, text: 'Test', title: 'Bolognese' }, { apiKey: FAKE_KEY, store, source: 'aichef:test', actor: 'u1', fetchImpl: m.f });
  assert.equal(r.ok, true); assert.equal(r.status, 'draft'); assert.equal(r.postId, 'post_ab97');
  assert.equal(m.calls.length, 1); assert.equal(m.calls[0].url, 'https://api.buffer.com'); assert.equal(m.calls[0].auth, 'Bearer ' + FAKE_KEY);
  assert.equal(m.calls[0].body.variables.input.saveToDraft, true); assert.match(m.calls[0].body.query, /createPost/);
  assert.equal(store.rows.length, 1); const row = store.rows[0];
  for (const k of ['created_at', 'day', 'source', 'service', 'channel_id', 'buffer_post_id', 'title']) assert.ok(row[k], k);
  assert.equal(row.status, 'draft'); assert.equal(row.title, 'Bolognese');
  assert.ok(!JSON.stringify([r, store.rows]).includes(FAKE_KEY));
});

test('createDraft: if Buffer ever returns a non-draft status, the post is deleted at once and flagged', async () => {
  const { createDraft } = await load(); const m = mockBuffer(draftOk('scheduled')); const store = memStore();
  const r = await createDraft({ service: 'facebook', channelId: CH.facebook, text: 'x' }, { apiKey: FAKE_KEY, store, source: 't', fetchImpl: m.f });
  assert.equal(r.ok, false); assert.equal(r.status, 'not_draft_deleted'); assert.equal(m.calls.length, 2); assert.match(m.calls[1].body.query, /deletePost/);
  assert.equal(m.calls[1].body.variables.id, r.postId);
});

test('createDraft: daily cap blocks before any Buffer call; default cap is 10', async () => {
  const { createDraft, DEFAULT_DAILY_CAP } = await load(); assert.equal(DEFAULT_DAILY_CAP, 10);
  const m = mockBuffer(draftOk()); const store = memStore(10);
  const r = await createDraft({ service: 'linkedin', channelId: CH.linkedin, text: 'x' }, { apiKey: FAKE_KEY, store, source: 't', fetchImpl: m.f });
  assert.equal(r.status, 'capped'); assert.equal(m.calls.length, 0); assert.equal(store.rows[0].status, 'capped');
  const s2 = memStore(2); const r2 = await createDraft({ service: 'linkedin', channelId: CH.linkedin, text: 'x' }, { apiKey: FAKE_KEY, store: s2, source: 't', fetchImpl: m.f, cap: 2 });
  assert.equal(r2.status, 'capped');
});

test('createDraft: errors are logged without the key; no key => no call; foreign API host refused', async () => {
  const { createDraft, safeApiUrl } = await load();
  const m = mockBuffer(() => ({ errors: [{ message: 'Unauthorized' }] })); const store = memStore();
  const r = await createDraft({ service: 'linkedin', channelId: CH.linkedin, text: 'x' }, { apiKey: FAKE_KEY, store, source: 't', fetchImpl: m.f });
  assert.equal(r.ok, false); assert.equal(r.status, 'error'); assert.ok(!JSON.stringify(store.rows).includes(FAKE_KEY));
  const m2 = mockBuffer(draftOk()); const r2 = await createDraft({ service: 'linkedin', channelId: CH.linkedin, text: 'x' }, { apiKey: '', store: memStore(), source: 't', fetchImpl: m2.f });
  assert.equal(r2.ok, false); assert.equal(m2.calls.length, 0);
  assert.throws(() => safeApiUrl('https://evil.example.com'), e => e.code === 'bad_api_url'); assert.equal(safeApiUrl('http://127.0.0.1:8799'), 'http://127.0.0.1:8799');
  const m3 = mockBuffer(draftOk()); const r3 = await createDraft({ service: 'linkedin', channelId: CH.linkedin, text: 'x' }, { apiKey: FAKE_KEY, store: memStore(), source: 't', fetchImpl: m3.f, apiUrl: 'https://evil.example.com' }).catch(e => e);
  assert.ok(r3 instanceof Error && r3.code === 'bad_api_url'); assert.equal(m3.calls.length, 0);
});

test('createDrafts: Instagram without an image is skipped, others still drafted', async () => {
  const { createDrafts } = await load(); const m = mockBuffer(draftOk()); const store = memStore();
  const out = await createDrafts(['facebook', 'linkedin', 'instagram'].map(s => ({ service: s, channelId: CH[s], text: 'x' })), { apiKey: FAKE_KEY, store, source: 't', fetchImpl: m.f });
  assert.deepEqual(out.map(o => o.status), ['draft', 'draft', 'skipped']); assert.equal(m.calls.length, 2);
});

test('social copy: recipe -> tailored FB/LinkedIn/IG with link back and jpg photo', async () => {
  const { recipeCopy, highlightCopy, igSafeImage } = await copyMod();
  const { RECIPES } = require('../src/recipes.js'); const r = RECIPES[0];
  const p = recipeCopy(r, { base: 'https://aichef.food', link: 'https://aichef.food/r/abc123', allowIllustrative: true });
  assert.equal(p.link, 'https://aichef.food/r/abc123'); assert.match(p.imageUrl, /^https:\/\/aichef\.food\/img\/.+\.jpg$/);
  assert.equal(recipeCopy(r, { link: 'https://aichef.food/r/x' }).imageUrl, null, 'generic category photo is not used unless asked');
  assert.equal(recipeCopy(r, { imageUrl: 'https://aichef.food/api/dish-image/' + 'a'.repeat(32) }).imageUrl, 'https://aichef.food/api/dish-image/' + 'a'.repeat(32));
  assert.match(p.copy.facebook, /utm_source=facebook/); assert.match(p.copy.linkedin, /utm_source=linkedin/); assert.match(p.copy.instagram, /link in bio/);
  assert.ok(p.copy.instagram.length <= 2200); assert.ok(p.copy.linkedin.length <= 3000); assert.ok(p.copy.facebook.includes(r.title));
  assert.equal(igSafeImage('https://aichef.food/img/a.webp'), null);
  const h = highlightCopy({ title: 'November issue', summary: 'Game season' }); assert.match(h.copy.facebook, /November issue/);
});

// ---- Worker routes against a real SQLite-backed D1 shim ----
function d1() {
  const db = new Database(':memory:');
  for (const f of fs.readdirSync(path.join(W, 'migrations')).sort()) db.exec(fs.readFileSync(path.join(W, 'migrations', f), 'utf8'));
  const prep = sql => { let args = []; const s = { bind: (...a) => { args = a; return s; }, first: async () => { const st = db.prepare(sql); return st.reader ? (st.get(...args) ?? null) : (st.run(...args), null); }, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes, last_row_id: r.lastInsertRowid } }; } }; return s; };
  return { raw: db, D: { prepare: prep, batch: async st => Promise.all(st.map(x => x.run())) } };
}
const KV = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); }, list: async () => ({ keys: [] }) }; };

test('Worker: /api/admin/buffer/* needs a signed-in admin + CSRF; dryRun previews; real call drafts only', async () => {
  const mod = await import(path.join(W, 'src', 'index.js')); const app = mod.default; const { raw, D } = d1();
  const cols = raw.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  const mk = (id, email) => { const row = { id, email, password_hash: 'x', name: 'N', plan: 'free', created_at: new Date().toISOString(), email_verified: 1 }; const k = Object.keys(row).filter(c => cols.includes(c)); raw.prepare(`INSERT INTO users(${k.join(',')}) VALUES(${k.map(() => '?').join(',')})`).run(...k.map(c => row[c])); raw.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)').run('s_' + id, id, Date.now() + 864e5); };
  mk(1, 'oliver@example.com'); mk(2, 'someone@example.com');
  const env = { DB: D, IMAGES: KV(), ADMIN_EMAILS: 'oliver@example.com', APP_URL: 'https://aichef.food', BUFFER_ORG_ID: '6ae1d230f1223d958c420338', BUFFER_API_KEY: FAKE_KEY, ASSETS: { fetch: async () => new Response('') } };
  const call = (p, { sid, method = 'GET', json, csrf = true } = {}) => app.fetch(new Request('https://aichef.food' + p, { method, headers: { 'content-type': 'application/json', cookie: `lp_csrf=tok${sid ? '; lp_session=' + sid : ''}`, ...(csrf ? { 'x-csrf-token': 'tok' } : {}) }, body: json ? JSON.stringify(json) : undefined }), env, { waitUntil() {} });
  const body = { kind: 'recipe', recipeId: 'classic-spaghetti-bolognese' };
  assert.equal((await call('/api/admin/buffer/draft', { method: 'POST', json: body })).status, 401);
  assert.equal((await call('/api/admin/buffer/draft', { method: 'POST', json: body, sid: 's_2' })).status, 403);
  assert.equal((await call('/api/admin/buffer/draft', { method: 'POST', json: body, sid: 's_1', csrf: false })).status, 403);
  const dry = await call('/api/admin/buffer/draft', { method: 'POST', json: { ...body, dryRun: true }, sid: 's_1' }); const dj = await dry.json();
  assert.equal(dry.status, 200); assert.equal(dj.posts.length, 3); assert.ok(dj.posts.every(p => p.text.includes('Bolognese')));
  const orig = globalThis.fetch; const m = mockBuffer(draftOk()); globalThis.fetch = m.f;
  try {
    const res = await call('/api/admin/buffer/draft', { method: 'POST', json: body, sid: 's_1' }); const j = await res.json();
    assert.equal(res.status, 201); assert.deepEqual(j.results.map(r => r.status), ['draft', 'draft', 'skipped'], 'no real photo => Instagram skipped'); assert.match(j.link, /^https:\/\/aichef\.food\/r\//);
    assert.ok(m.calls.every(c => c.body.variables.input.saveToDraft === true && !c.body.variables.input.dueAt));
    assert.ok(!JSON.stringify(j).includes(FAKE_KEY));
    const log = await (await call('/api/admin/buffer/log', { sid: 's_1' })).json(); assert.equal(log.rows.length, 2); assert.ok(log.rows.every(r => r.source === 'aichef:recipe' && r.buffer_post_id));
    const st = await (await call('/api/admin/buffer/status', { sid: 's_1' })).json(); assert.equal(st.used, 2); assert.equal(st.cap, 10); assert.equal(st.mode, 'drafts-only'); assert.ok(!JSON.stringify(st).includes(FAKE_KEY));
    assert.equal((await call('/api/admin/buffer/status', { sid: 's_2' })).status, 403);
  } finally { globalThis.fetch = orig; }
});
