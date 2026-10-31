// buffer-drafts.js — shared, dependency-free (fetch + Web Crypto only) Buffer DRAFT client.
// Used by AIchef.food (luxprime-ai-chef) and Malcolm (malcolmai-live). Copy, don't diverge.
//
// SAFETY CONTRACT (enforced in code, covered by tests):
//  * Every post is created with saveToDraft: true. There is no code path that publishes,
//    queues or schedules. Buffer's schema requires a `mode`; per Buffer's own "Create Draft
//    Post" example we send mode: addToQueue together with saveToDraft: true, which Buffer
//    stores as status 'draft' (not queued, posting limits not checked). shareNow / shareNext /
//    customScheduled / dueAt are never sent.
//  * After creation the returned post.status MUST be 'draft'. If Buffer ever returns anything
//    else, the module immediately deletes that one post (the one it just created) and logs an
//    alert, so nothing can go out without Oliver's YES.
//  * A daily cap (default 10 drafts/day, UK calendar day) is checked before every call.
//  * Every attempt (draft, error, capped, alert) is written to an audit log.
//  * The API key is only ever placed in the Authorization header. It is never logged,
//    returned, or included in error messages.

export const BUFFER_API = 'https://api.buffer.com';
export const DEFAULT_CHANNELS = Object.freeze({
  facebook: '6ae1d5932f1f5ed648fa5a0e',  // Facebook Page: Academy of Famous and Talented Artists - AFTA
  instagram: '6ae1d92f2f1f5ed648fa9a33', // Instagram professional: cosmic.dream.lover
  linkedin: '6ae1dad82f1f5ed648faab97',  // LinkedIn profile: oliverthorley
});
export const SERVICES = Object.freeze(['facebook', 'linkedin', 'instagram']);
export const TEXT_LIMITS = Object.freeze({ facebook: 63206, linkedin: 3000, instagram: 2200 });
export const DEFAULT_DAILY_CAP = 10;
const COUNTED = ['draft', 'not_draft_deleted', 'not_draft_alert'];

const CREATE_MUTATION = `mutation OmniCreateDraft($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { id status channelId channelService } }
    ... on MutationError { message }
  }
}`;
const DELETE_MUTATION = `mutation OmniDeleteDraft($id: PostId!) { deletePost(input: { id: $id }) { __typename } }`;

export class BufferDraftError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** UK calendar day (Europe/London), e.g. "2026-10-28". */
export function ukDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Only Buffer itself, or a loopback mock for local tests, may ever receive the key. */
export function safeApiUrl(url) {
  const u = String(url || BUFFER_API).replace(/\/+$/, '');
  if (u === BUFFER_API) return u;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u)) return u;
  throw new BufferDraftError('bad_api_url', 'BUFFER_API_URL must be https://api.buffer.com (or a loopback mock for tests)');
}

function cleanUrl(v, what) {
  if (v == null || v === '') return null;
  let u; try { u = new URL(String(v)); } catch { throw new BufferDraftError('bad_input', `${what} is not a valid URL`); }
  if (u.protocol !== 'https:') throw new BufferDraftError('bad_input', `${what} must be https`);
  return u.toString();
}

/**
 * Build the CreatePostInput for one channel. Pure function (exported for tests).
 * Always: saveToDraft true. Never: shareNow, shareNext, customScheduled, dueAt.
 */
export function buildDraftInput({ service, channelId, text, link, imageUrl, title }) {
  if (!SERVICES.includes(service)) throw new BufferDraftError('bad_input', `Unsupported service: ${service}`);
  if (!channelId || !/^[a-f0-9]{24}$/i.test(String(channelId))) throw new BufferDraftError('bad_input', 'channelId must be a Buffer channel id');
  let body = String(text || '').trim();
  if (!body) throw new BufferDraftError('bad_input', 'text is required');
  const linkUrl = cleanUrl(link, 'link');
  const img = cleanUrl(imageUrl, 'imageUrl');
  if (service === 'instagram' && !img) throw new BufferDraftError('needs_image', 'Instagram drafts need an image URL (none supplied), skipped');
  const input = { channelId: String(channelId), schedulingType: 'automatic', mode: 'addToQueue', saveToDraft: true, aiAssisted: true, source: 'omnimaster-integration', assets: [] };
  if (img) input.assets.push({ image: { url: img } });
  const metadata = {};
  if (service === 'facebook') {
    metadata.facebook = { type: 'post' };
    // Buffer: linkAttachment is mutually exclusive with assets, so with an image the link stays in the text.
    if (linkUrl && !img) metadata.facebook.linkAttachment = { url: linkUrl, ...(title ? { title: String(title).slice(0, 200) } : {}) };
  } else if (service === 'linkedin') {
    if (linkUrl && !img) metadata.linkedin = { linkAttachment: { url: linkUrl, ...(title ? { title: String(title).slice(0, 200) } : {}) } };
  } else if (service === 'instagram') {
    metadata.instagram = { type: 'post', shouldShareToFeed: true };
  }
  if (Object.keys(metadata).length) input.metadata = metadata;
  if (linkUrl && service !== 'instagram' && !body.includes(linkUrl)) body += `\n\n${linkUrl}`;
  if (body.length > TEXT_LIMITS[service]) throw new BufferDraftError('too_long', `${service} text is ${body.length} chars (limit ${TEXT_LIMITS[service]})`);
  input.text = body;
  // Belt and braces: assert the invariant on the object we are about to send.
  if (input.saveToDraft !== true || input.dueAt || input.mode !== 'addToQueue') throw new BufferDraftError('safety', 'refusing non-draft input');
  return input;
}

async function gql(apiUrl, apiKey, fetchImpl, query, variables, timeoutMs = 15000) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(apiUrl, { method: 'POST', signal: ctl && ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'User-Agent': 'OmniMaster-Buffer-Drafts/1.0' },
      body: JSON.stringify({ query, variables }) });
    let j = null; try { j = await r.json(); } catch { j = null; }
    if (!r.ok) throw new BufferDraftError('buffer_http', `Buffer HTTP ${r.status}`, { httpStatus: r.status });
    if (!j) throw new BufferDraftError('buffer_bad_response', 'Buffer returned non-JSON');
    if (j.errors && j.errors.length) throw new BufferDraftError('buffer_graphql', String(j.errors[0].message || 'GraphQL error').slice(0, 200));
    return j.data;
  } catch (e) {
    if (e instanceof BufferDraftError) throw e;
    throw new BufferDraftError('buffer_network', e && e.name === 'AbortError' ? 'Buffer request timed out' : 'Buffer request failed');
  } finally { if (t) clearTimeout(t); }
}

/** Read-only: list channels (used by status endpoints). */
export async function listChannels({ apiKey, organizationId, apiUrl, fetchImpl = fetch }) {
  if (!apiKey) throw new BufferDraftError('not_configured', 'BUFFER_API_KEY is not set');
  const d = await gql(safeApiUrl(apiUrl), apiKey, fetchImpl,
    'query($o: OrganizationId!){ channels(input:{organizationId:$o}){ id name service isDisconnected } }', { o: organizationId });
  return d.channels || [];
}

/**
 * Create ONE Buffer draft. Returns { ok, status, postId?, service, error? }. Never throws for
 * Buffer/cap problems (they are logged and returned); throws BufferDraftError only for bad input.
 * deps: { apiKey, store, source, actor?, cap?, apiUrl?, fetchImpl?, now? }
 */
export async function createDraft(post, deps) {
  const { apiKey, store, source, actor = null, apiUrl, fetchImpl = fetch, now = () => new Date() } = deps || {};
  const cap = Number.isFinite(+deps.cap) && +deps.cap > 0 ? Math.min(+deps.cap, 50) : DEFAULT_DAILY_CAP;
  if (!store) throw new BufferDraftError('not_configured', 'audit store missing');
  const input = buildDraftInput(post); // validates; throws bad_input / needs_image / too_long
  const at = now(); const day = ukDay(at);
  const row = { created_at: at.toISOString(), day, source: String(source || 'unknown').slice(0, 40), service: post.service, channel_id: input.channelId,
    buffer_post_id: null, status: 'error', title: String(post.title || '').slice(0, 200) || null, actor: actor ? String(actor).slice(0, 120) : null, error: null };
  if (!apiKey) { row.error = 'BUFFER_API_KEY not set'; await store.log(row); return { ok: false, service: post.service, status: 'error', error: row.error }; }
  const used = await store.countDay(day, COUNTED);
  if (used >= cap) { row.status = 'capped'; row.error = `daily cap ${cap} reached`; await store.log(row); return { ok: false, service: post.service, status: 'capped', error: row.error, used, cap }; }
  const url = safeApiUrl(apiUrl);
  try {
    const d = await gql(url, apiKey, fetchImpl, CREATE_MUTATION, { input });
    const res = d && d.createPost;
    if (!res || res.__typename !== 'PostActionSuccess' || !res.post) { row.error = String((res && res.message) || (res && res.__typename) || 'unknown Buffer error').slice(0, 200); await store.log(row); return { ok: false, service: post.service, status: 'error', error: row.error }; }
    row.buffer_post_id = String(res.post.id);
    if (res.post.status !== 'draft') {
      // Should be impossible with saveToDraft: true. Remove the post we just created so it cannot publish.
      let deleted = false;
      try { const del = await gql(url, apiKey, fetchImpl, DELETE_MUTATION, { id: row.buffer_post_id }); deleted = !!(del && del.deletePost && del.deletePost.__typename === 'DeletePostSuccess'); } catch { deleted = false; }
      row.status = deleted ? 'not_draft_deleted' : 'not_draft_alert';
      row.error = `Buffer returned status '${res.post.status}' instead of 'draft'; ${deleted ? 'post deleted automatically' : 'AUTO-DELETE FAILED: delete it in Buffer now'}`;
      await store.log(row); return { ok: false, service: post.service, status: row.status, postId: row.buffer_post_id, error: row.error };
    }
    row.status = 'draft'; await store.log(row);
    return { ok: true, service: post.service, status: 'draft', postId: row.buffer_post_id, used: used + 1, cap };
  } catch (e) {
    row.error = String(e && e.message || 'Buffer call failed').slice(0, 200); await store.log(row);
    return { ok: false, service: post.service, status: 'error', error: row.error };
  }
}

/** Draft several services in one go (each counts towards the cap). Instagram without image => skipped, not an error. */
export async function createDrafts(posts, deps) {
  const out = [];
  for (const p of posts) {
    try { out.push(await createDraft(p, deps)); }
    catch (e) { out.push({ ok: false, service: p.service, status: e.code === 'needs_image' ? 'skipped' : 'invalid', error: String(e.message || e) }); }
  }
  return out;
}

// ---------- Audit/cap stores ----------
/** D1 store. Table: see migrations/0014_buffer_drafts.sql */
export function d1Store(db) {
  return {
    async countDay(day, statuses) {
      const qs = statuses.map(() => '?').join(',');
      const r = await db.prepare(`SELECT COUNT(*) AS n FROM buffer_drafts WHERE day=? AND status IN (${qs})`).bind(day, ...statuses).first();
      return (r && +r.n) || 0;
    },
    async log(row) {
      await db.prepare('INSERT INTO buffer_drafts(created_at,day,source,service,channel_id,buffer_post_id,status,title,actor,error) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .bind(row.created_at, row.day, row.source, row.service, row.channel_id, row.buffer_post_id, row.status, row.title, row.actor, row.error).run();
    },
    async recent(limit = 50) {
      const r = await db.prepare('SELECT id,created_at,day,source,service,channel_id,buffer_post_id,status,title,actor,error FROM buffer_drafts ORDER BY id DESC LIMIT ?').bind(Math.min(200, Math.max(1, limit | 0))).all();
      return r.results || [];
    },
  };
}

/** KV store (Malcolm has no D1). Counter per UK day + one log key per attempt (kept 180 days). */
export function kvStore(kv, prefix = 'buffer') {
  const TTL = 180 * 86400;
  return {
    async countDay(day) { return +(await kv.get(`${prefix}:count:${day}`)) || 0; },
    async log(row) {
      const rand = Math.random().toString(36).slice(2, 8);
      await kv.put(`${prefix}:log:${row.created_at}:${rand}`, JSON.stringify(row), { expirationTtl: TTL });
      if (COUNTED.includes(row.status)) { const k = `${prefix}:count:${row.day}`; await kv.put(k, String((+(await kv.get(k)) || 0) + 1), { expirationTtl: 3 * 86400 }); }
    },
    async recent(limit = 50) {
      const l = await kv.list({ prefix: `${prefix}:log:` }); const keys = l.keys.map(k => k.name).sort().reverse().slice(0, Math.min(200, limit));
      return (await Promise.all(keys.map(k => kv.get(k)))).filter(Boolean).map(s => JSON.parse(s));
    },
  };
}

/** Constant-time string compare for shared-secret auth (Malcolm endpoint). */
export function timingSafeEqual(a, b) {
  const e = new TextEncoder(); const x = e.encode(String(a)); const y = e.encode(String(b));
  let diff = x.length ^ y.length; const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i % (x.length || 1)] || 0) ^ (y[i % (y.length || 1)] || 0);
  return diff === 0 && x.length === y.length;
}
