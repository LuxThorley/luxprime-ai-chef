// Lux Prime Kitchen Magazine — Worker side: entitlement, issue generation (Malcolm + FLUX + PDF), storage (KV), email (Resend).
import mag from '../../src/magazine.js';
import ai from '../../src/ai.js';
import escoffier from '../../src/escoffier.js';
import dishimage from '../../src/dishimage.js';
import imagesMod from '../../src/images.js';
import plansMod from '../../src/plans.js';
import { randomId } from './crypto.js';

const { isAdmin, isTester } = plansMod;
export const IMG_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const PREVIEW_CAPS = { admin: 20, tester: 6, subscriber: 3, member: 2, free: 1 };
const FONT_KEYS = ['serif', 'serifI', 'serifB', 'sans', 'sansB'];
const b64ToBytes = b64 => typeof Uint8Array.fromBase64 === 'function' ? Uint8Array.fromBase64(b64) : Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
const sha = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

// Entitlement: free for admin/tester; otherwise an active magazine add-on (any tier, including free accounts).
export async function magRow(env, uid) { return (await env.DB.prepare('SELECT * FROM magazine_subs WHERE user_id=?').bind(uid).first()) || null; }
export const entitled = (u, row) => isAdmin(u) || isTester(u) || !!(row && ['active', 'trialing'].includes(row.status));

// One image: KV cache hit or FLUX generation (stored under the same key /api/dish-image serves).
export async function getImage(env, key, prompt, title) {
  const kvKey = `dish/${key}.jpg`; const hit = await env.IMAGES.get(kvKey, 'arrayBuffer'); if (hit) return new Uint8Array(hit);
  const t0 = Date.now(); const out = await env.AI.run(IMG_MODEL, { prompt, steps: +env.IMAGE_STEPS || 6 });
  if (!out || !out.image) throw new Error('no image'); const bytes = b64ToBytes(out.image); if (bytes.length < 2000) throw new Error('bad image');
  await env.IMAGES.put(kvKey, bytes, { metadata: { provider: 'workers-ai/flux-1-schnell', title: String(title || '').slice(0, 120) } });
  await env.DB.prepare("INSERT INTO dish_images(key,title,prompt,alt,status,provider,ms,updated_at) VALUES(?,?,?,?, 'done','workers-ai/flux-1-schnell',?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET status='done', provider=excluded.provider, ms=excluded.ms, updated_at=CURRENT_TIMESTAMP")
    .bind(key, String(title || '').slice(0, 140), prompt, `Photo of ${title}`, Date.now() - t0).run();
  return bytes;
}
async function asset(env, path) { const r = await env.ASSETS.fetch(new Request('https://assets.local' + path)); if (!r.ok) throw new Error('asset ' + path + ' ' + r.status); return new Uint8Array(await r.arrayBuffer()); }
const libraryJpeg = (env, r) => asset(env, imagesMod.curatedImage(r || {}).og);
const coverPrompt = r => `Overhead fine-dining food photograph of ${r.title}${dishimage.keyIngredients(r).length ? `, with ${dishimage.keyIngredients(r).slice(0, 4).join(', ')}` : ''}. Luxurious, moody fine-dining styling on a dark slate table, warm candlelight and soft window light, overhead three-quarter angle, rich shadows, shallow depth of field, elegant ceramic plate, photorealistic, appetising, the plated dish fills the frame. Absolutely no text, no typography, no letters, no logos, no signage, no people, no hands, no clutter.`;

// Build one personalised issue. Throws 'AI_BUSY' if Malcolm fell back to the library (the caller retries later).
export async function buildIssue(env, user, { fetchImpl, issueNo = 1, manageUrl, now = new Date(), allowLibrary = false } = {}) {
  const t0 = Date.now(); const all = async (sql, p) => (await env.DB.prepare(sql).bind(...p).all()).results;
  const [history, favourites] = await Promise.all([all('SELECT query_json FROM history WHERE user_id=? ORDER BY id DESC LIMIT 60', [user.id]), all('SELECT recipe_json FROM favourites WHERE user_id=? ORDER BY id DESC LIMIT 30', [user.id])]);
  const profile = mag.buildProfile({ history, favourites, user }, now); const q = mag.buildQuery(profile);
  let references = []; try { references = await escoffier.references(all, q, {}); } catch (e) { console.error('mag escoffier', e && e.message); }
  const out = await ai.generate(q, { fetchImpl, retries: 0, references });
  if ((out.source === 'offline' || out.fallbackReason) && !allowLibrary) throw new Error('AI_BUSY');
  const recipes = out.recipes.slice(0, 3).map(r => ({ ...r, _pairing: mag.pairing(r) }));
  const tAI = Date.now() - t0;
  // Sequential with one retry: parallel FLUX calls can be rate-limited, and a library photo is a poor substitute for the dish.
  const tryImg = async (key, prompt, title) => { for (let a = 0; a < 2; a++) { try { return await getImage(env, key, prompt, title); } catch (e) { console.error('mag img', a, e && e.message); } } return null; };
  const dishImgs = []; for (const r of recipes) dishImgs.push((await tryImg(await dishimage.imageKey(r), dishimage.buildPrompt(r), r.title)) || await libraryJpeg(env, r));
  const cp = coverPrompt(recipes[0]); const hero = (await tryImg('c' + (await sha(cp)).slice(1), cp, recipes[0].title + ' (cover)')) || dishImgs[0];
  const escNo = (recipes.find(r => r.escoffier) || {}).escoffier; let entry = null; if (escNo) { try { entry = await escoffier.getEntry(all, escNo.no); } catch {} }
  const fontFiles = Object.fromEntries(await Promise.all(FONT_KEYS.map(async k => [k, await asset(env, `/mag/${k}.bin`)])));
  const data = { profile, recipes, shop: mag.shoppingList(recipes, profile), issueNo, manageUrl, blessing: out.blessing, escoffierNote: mag.escoffierNote(recipes, entry ? { ...entry, title: escoffier.titleCase(entry.title) } : null, profile) };
  const pdf = mag.render(data, { hero, dishes: dishImgs }, fontFiles);
  return { pdf, profile, titles: recipes.map(r => r.title), ms: Date.now() - t0, aiMs: tAI, source: out.source };
}

// Store an issue in KV behind an unguessable token (download link in the email; 400-day expiry).
export async function storeIssue(env, pdf) { const token = randomId(24); await env.IMAGES.put(`mag/${token}.pdf`, pdf, { expirationTtl: 400 * 86400 }); return token; }

// Email via Resend (only provider that can mail arbitrary addresses from Workers here). Inactive until RESEND_API_KEY + MAGAZINE_FROM exist.
export const emailReady = env => !!(env.RESEND_API_KEY && env.MAGAZINE_FROM);
export async function sendIssueEmail(env, { to, name, month, year, titles, downloadUrl, unsubUrl, manageUrl, pdf }) {
  if (!emailReady(env)) return { sent: false, reason: 'email-not-configured' };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<div style="background:#16171b;padding:32px 0;font-family:Georgia,'Times New Roman',serif"><div style="max-width:560px;margin:0 auto;background:#fbf8f2;padding:36px 40px;color:#25211c">
<p style="font:600 11px/1 Arial,sans-serif;letter-spacing:4px;color:#a8683e;margin:0 0 18px">LUX PRIME KITCHEN MAGAZINE</p>
<h1 style="font-weight:normal;font-style:italic;font-size:34px;margin:0 0 6px">Your ${esc(month)} issue</h1>
<p style="font-size:17px;line-height:1.5">Dear ${esc(name)}, Malcolm has composed this month’s issue just for you:</p>
<ul style="font-size:17px;line-height:1.6">${titles.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
<p style="font-size:16px;line-height:1.5">Plus your aisle-by-aisle shopping list, wine pairings and this month’s Escoffier note.</p>
<p style="margin:26px 0"><a href="${esc(downloadUrl)}" style="background:#c9a35a;color:#16171b;text-decoration:none;padding:13px 22px;font:600 14px Arial,sans-serif;letter-spacing:1px">DOWNLOAD YOUR MAGAZINE (PDF)</a></p>
<p style="font:12px/1.6 Arial,sans-serif;color:#7a7065">You’re receiving this because you opted in to Lux Prime Kitchen Magazine (£1.99/month). <a href="${esc(unsubUrl)}" style="color:#7a7065">Unsubscribe from these emails</a> · <a href="${esc(manageUrl)}" style="color:#7a7065">Manage or cancel your add-on</a>.</p>
</div></div>`;
  const body = { from: env.MAGAZINE_FROM, to: [to], subject: `Your Lux Prime Kitchen Magazine — ${month} ${year}`, html,
    text: `Dear ${name},\n\nYour ${month} issue of Lux Prime Kitchen Magazine is ready: ${titles.join('; ')}.\nDownload: ${downloadUrl}\n\nUnsubscribe: ${unsubUrl}\nManage or cancel: ${manageUrl}\n`,
    headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
  if (pdf && pdf.length < 8e6 && typeof pdf.toBase64 === 'function') body.attachments = [{ filename: `Lux-Prime-Kitchen-Magazine-${month}-${year}.pdf`, content: pdf.toBase64() }];
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { sent: true, id: (await r.json()).id };
}

const londonParts = d => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(p => [p.type, p.value]));
export const issueMonth = (d = new Date()) => { const p = londonParts(d); return `${p.year}-${p.month}`; };

// Cron tick: on the 1st (from 08:00 UK) enqueue opted-in, entitled readers; every tick processes a small batch (CPU/AI safe).
export async function tick(env, { fetchImpl, base, batch = 1 }) {
  const now = new Date(); const lp = londonParts(now); const month = issueMonth(now); const log = { month, enqueued: 0, processed: [] };
  if (+lp.day === 1 && +lp.hour >= 8) {
    const { results } = await env.DB.prepare("SELECT u.* FROM users u JOIN magazine_subs m ON m.user_id=u.id WHERE m.opt_in=1").all();
    for (const u of results) { const row = await magRow(env, u.id); if (!entitled(u, row)) continue;
      const r = await env.DB.prepare("INSERT OR IGNORE INTO magazine_issues(user_id,month,kind,status) VALUES(?,?,'monthly','pending')").bind(u.id, month).run(); log.enqueued += r.meta.changes || 0; }
  }
  await env.DB.prepare("UPDATE magazine_issues SET status='retry' WHERE status='working' AND kind IN ('monthly','sample') AND started_at < datetime('now','-30 minutes')").run();
  const { results: due } = await env.DB.prepare("SELECT i.id, i.user_id, i.attempts, i.kind FROM magazine_issues i WHERE i.kind IN ('monthly','sample') AND i.status IN ('pending','retry') AND i.attempts<4 ORDER BY i.id LIMIT ?").bind(batch).all();
  for (const it of due) {
    await env.DB.prepare("UPDATE magazine_issues SET status='working', attempts=attempts+1, started_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','retry')").bind(it.id).run();
    try {
      let u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(it.user_id).first(); const row = await magRow(env, it.user_id); const sample = it.kind === 'sample';
      // 'sample' rows are created by an operator in D1 only: build + store, never email. The shared tester appears as "Alex".
      if (sample && u && isTester(u)) u = { ...u, name: 'Alex' };
      if (!u || (!sample && (!row || !row.opt_in || !entitled(u, row)))) { await env.DB.prepare("UPDATE magazine_issues SET status='skipped' WHERE id=?").bind(it.id).run(); continue; }
      const n = ((await env.DB.prepare("SELECT COUNT(*) n FROM magazine_issues WHERE user_id=? AND kind='monthly' AND status='sent'").bind(u.id).first()) || {}).n || 0;
      const manageUrl = `${base}/account.html#magazine`;
      const iss = await buildIssue(env, u, { fetchImpl, issueNo: n + 1, manageUrl, allowLibrary: it.attempts >= 2 });
      const token = await storeIssue(env, iss.pdf);
      const mail = sample ? { sent: false, reason: 'sample' } : await sendIssueEmail(env, { to: u.email, name: iss.profile.name, month: iss.profile.month, year: iss.profile.year, titles: iss.titles, downloadUrl: `${base}/m/issue/${token}`, unsubUrl: `${base}/m/unsubscribe?t=${row && row.unsub_token}`, manageUrl, pdf: iss.pdf });
      await env.DB.prepare("UPDATE magazine_issues SET status=?, token=?, bytes=?, ms=?, error=?, sent_at=CURRENT_TIMESTAMP WHERE id=?").bind(mail.sent ? 'sent' : 'ready', token, iss.pdf.length, iss.ms, mail.sent ? null : mail.reason, it.id).run();
      log.processed.push({ id: it.id, sent: mail.sent, ms: iss.ms });
    } catch (e) {
      console.error('magazine tick', e && e.message);
      await env.DB.prepare("UPDATE magazine_issues SET status='retry', error=? WHERE id=?").bind(String(e && e.message || e).slice(0, 200), it.id).run();
    }
  }
  return log;
}
export const newUnsubToken = () => randomId(24);
