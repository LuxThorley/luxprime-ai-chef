// Admin-only Buffer DRAFT endpoints for AIchef.food. Nothing here publishes, queues or schedules.
//   GET  /api/admin/buffer/status  -> config + today's usage (no Buffer call unless ?check=1, read-only)
//   GET  /api/admin/buffer/log     -> last 50 audit rows
//   POST /api/admin/buffer/draft   -> create drafts (or preview with dryRun: true)
// Body for /draft:
//   { kind: 'recipe', recipeId }            library/community recipe (creates a /r/<id> share link for rich previews)
//   { kind: 'recipe', shareId }             existing /r/<id> share
//     recipe extras: imageUrl? (your own photo), allowIllustrative? (use the generic category photo; off by default)
//   { kind: 'magazine', title, summary, url?, imageUrl? }
//   { kind: 'custom', title?, text, link?, imageUrl?, hashtags?[] }
//   channels?: ['facebook','linkedin','instagram'] (default all three), overrides?: {facebook?,linkedin?,instagram?}, dryRun?: boolean
import { z } from 'zod';
import { createDrafts, d1Store, DEFAULT_CHANNELS, SERVICES, ukDay, listChannels, DEFAULT_DAILY_CAP } from './buffer-drafts.js';
import { recipeCopy, highlightCopy, genericCopy, withUtm } from './social-copy.js';

const Svc = z.enum(SERVICES);
const DraftSchema = z.object({
  kind: z.enum(['recipe', 'magazine', 'custom']),
  recipeId: z.string().max(120).regex(/^[A-Za-z0-9_\-]+$/).optional(),
  shareId: z.string().max(20).regex(/^[A-Za-z0-9_\-]+$/).optional(),
  title: z.string().trim().max(200).optional(), summary: z.string().trim().max(1200).optional(),
  text: z.string().trim().max(3000).optional(), url: z.string().url().max(500).optional(), link: z.string().url().max(500).optional(),
  imageUrl: z.string().url().max(800).optional(), allowIllustrative: z.boolean().optional(), hashtags: z.array(z.string().max(40)).max(15).optional(),
  channels: z.array(Svc).min(1).max(3).optional(),
  overrides: z.object({ facebook: z.string().max(3000).optional(), linkedin: z.string().max(3000).optional(), instagram: z.string().max(2200).optional() }).optional(),
  dryRun: z.boolean().optional(),
});

export function channelsFromEnv(env) {
  return { facebook: env.BUFFER_CHANNEL_FACEBOOK || DEFAULT_CHANNELS.facebook, linkedin: env.BUFFER_CHANNEL_LINKEDIN || DEFAULT_CHANNELS.linkedin, instagram: env.BUFFER_CHANNEL_INSTAGRAM || DEFAULT_CHANNELS.instagram };
}
const siteBase = env => (env.APP_URL || 'https://aichef.food').replace(/\/$/, '');

export function mountBufferRoutes(app, { needAuth, isAdmin, rl, body, CR, cctx, randomId }) {
  const adminOnly = async (c, next) => isAdmin(c.get('user')) ? next() : c.json({ error: 'Admins only' }, 403);

  app.get('/api/admin/buffer/status', needAuth, adminOnly, async c => {
    const env = c.env; const cap = +env.BUFFER_DAILY_CAP || DEFAULT_DAILY_CAP; const day = ukDay();
    const used = await d1Store(env.DB).countDay(day, ['draft', 'not_draft_deleted', 'not_draft_alert']).catch(() => null);
    const out = { configured: !!env.BUFFER_API_KEY, mode: 'drafts-only', day, used, cap, channels: channelsFromEnv(env) };
    if (c.req.query('check') === '1' && env.BUFFER_API_KEY) {
      try { out.buffer = (await listChannels({ apiKey: env.BUFFER_API_KEY, organizationId: env.BUFFER_ORG_ID, apiUrl: env.BUFFER_API_URL })).map(ch => ({ id: ch.id, service: ch.service, name: ch.name, connected: !ch.isDisconnected })); }
      catch (e) { out.bufferError = String(e.message || e).slice(0, 160); }
    }
    return c.json(out);
  });

  app.get('/api/admin/buffer/log', needAuth, adminOnly, async c => c.json({ rows: await d1Store(c.env.DB).recent(50) }));

  app.post('/api/admin/buffer/draft', needAuth, adminOnly, rl('bufferdraft', 20, 3600), async c => {
    const p = DraftSchema.safeParse(await body(c)); if (!p.success) return c.json({ error: (p.error.issues[0] && p.error.issues[0].message) || 'Invalid input' }, 400);
    const b = p.data; const env = c.env; const base = siteBase(env); const u = c.get('user');
    let pack, source;
    if (b.kind === 'recipe') {
      let recipe = null, link = null;
      if (b.shareId) {
        const row = await env.DB.prepare('SELECT recipe_json FROM shares WHERE id=?').bind(b.shareId).first();
        if (!row) return c.json({ error: 'Share not found' }, 404); recipe = JSON.parse(row.recipe_json); link = `${base}/r/${b.shareId}`;
      } else if (b.recipeId) {
        const ctx = await cctx(c); ctx.params = { id: b.recipeId };
        const r = await CR.H.one(ctx); if (r.status !== 200) return c.json(r.json, r.status); recipe = r.json.recipe;
      } else return c.json({ error: 'Give recipeId or shareId' }, 400);
      if (!link && !b.dryRun) { // a /r/<id> share page carries Open Graph tags, so Facebook/LinkedIn show a rich preview
        const sid = randomId(6, 'base64url'); await env.DB.prepare('INSERT INTO shares(id,recipe_json) VALUES(?,?)').bind(sid, JSON.stringify(recipe).slice(0, 60000)).run(); link = `${base}/r/${sid}`;
      }
      // Photo: Oliver's own imageUrl, else the recipe's cached AI dish photo (only if it really exists in KV).
      let photo = b.imageUrl || null; const im = recipe && recipe.image;
      if (!photo && im && im.ai && /^[0-9a-f]{32}$/.test(String(im.key || '')) && env.IMAGES && await env.IMAGES.get(`dish/${im.key}.jpg`, 'arrayBuffer')) photo = `${base}/api/dish-image/${im.key}`;
      pack = recipeCopy(recipe, { base, link: link || undefined, imageUrl: photo || undefined, allowIllustrative: !!b.allowIllustrative }); source = 'aichef:recipe';
    } else if (b.kind === 'magazine') {
      if (!b.title) return c.json({ error: 'title is required' }, 400);
      pack = highlightCopy({ title: b.title, summary: b.summary, url: b.url, imageUrl: b.imageUrl }, { base }); source = 'aichef:magazine';
    } else {
      if (!b.text) return c.json({ error: 'text is required' }, 400);
      pack = genericCopy({ title: b.title, text: b.text, link: b.link, imageUrl: b.imageUrl, hashtags: b.hashtags }); source = 'aichef:custom';
    }
    const ch = channelsFromEnv(env); const wanted = b.channels || SERVICES;
    const posts = wanted.map(s => ({ service: s, channelId: ch[s], title: pack.title, text: (b.overrides && b.overrides[s]) || pack.copy[s], link: s === 'instagram' ? null : withUtm(pack.link, s), imageUrl: pack.imageUrl }));
    if (b.dryRun) return c.json({ dryRun: true, mode: 'drafts-only', posts: posts.map(x => ({ ...x, skipped: x.service === 'instagram' && !x.imageUrl ? 'Instagram needs an image' : undefined })) });
    const results = await createDrafts(posts, { apiKey: env.BUFFER_API_KEY, apiUrl: env.BUFFER_API_URL, store: d1Store(env.DB), source, actor: u && u.id, cap: +env.BUFFER_DAILY_CAP || DEFAULT_DAILY_CAP });
    const okAny = results.some(r => r.ok);
    return c.json({ mode: 'drafts-only', note: 'Saved as Buffer drafts only. Nothing is published or queued until Oliver approves it in Buffer.', link: pack.link, results }, okAny ? 201 : (results.some(r => r.status === 'capped') ? 429 : 502));
  });
}
