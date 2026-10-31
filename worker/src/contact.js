// Contact form: /contact.html -> POST /api/contact -> malcolm-mail (service binding MALCOLM_MAIL, bearer CONTACT_TOKEN).
// malcolm-mail runs the same pipeline as email to malcolm@aichef.food (classify, safety rules, smart draft, output checker,
// D1 mail log, flagged copy to Oliver with the attachments) and hands back Malcolm's checked reply. This Worker then emails
// that reply to the sender through the site's one outbound path (src/mailer.js: Resend, from malcolm@aichef.food,
// reply-to malcolm@aichef.food) and reports the outcome back so the mail log is accurate.
// Spam defences (all free): honeypot field, signed time-to-submit token, per-IP and per-email limits in the existing D1
// rate_limits table. No Turnstile: the site has none configured. Attachments are checked here (allow-list, size, magic
// bytes) and again in depth in malcolm-mail (macros, archives, active PDF content). Nothing is stored by this Worker.
import { z } from 'zod';
import { sha256Hex, timingSafeEqualStr } from './crypto.js';

export const CONTACT = { MAX_FILES: 3, MAX_BYTES: 5 * 1024 * 1024, MAX_BODY: 16 * 1024 * 1024, MIN_FILL_MS: 4000, MAX_TOKEN_AGE_MS: 12 * 3600e3, IP_PER_HOUR: 6, IP_PER_DAY: 20, EMAIL_PER_DAY: 3 };
export const TOPICS = ['general', 'recipes', 'account', 'billing', 'partnership', 'press', 'feedback', 'security', 'other'];
export const ACCEPT = '.jpg,.jpeg,.png,.webp,.pdf,.txt,.csv,.docx';
const EXT_TYPE = { jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp', pdf: 'pdf', docx: 'zip', txt: 'text', csv: 'text' };

const line = (max) => z.string().transform((s) => s.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).pipe(z.string().max(max));
export const ContactSchema = z.object({
  name: line(80).pipe(z.string().min(1, 'Please tell Malcolm your name')),
  email: z.string().trim().toLowerCase().email('Please enter a valid email address').max(200),
  topic: z.enum(TOPICS, { errorMap: () => ({ message: 'Please choose a topic' }) }),
  subject: line(150).optional().default(''),
  message: z.string().trim().min(10, 'Please write a little more (at least 10 characters)').max(5000, 'Please keep your message under 5,000 characters'),
  consent: z.literal('yes', { errorMap: () => ({ message: 'Please confirm you have read how we use your message' }) }),
});

// ---- signed time-to-submit token ----
const enc = new TextEncoder();
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const formSecret = (env) => env.CONTACT_FORM_SECRET || env.JWT_SECRET || '';
export async function issueFormToken(env, now = Date.now()) { const s = formSecret(env); return s ? `${now}.${(await hmacHex(s, `contact-form:${now}`)).slice(0, 32)}` : ''; }
export async function checkFormToken(env, token, now = Date.now()) {
  const s = formSecret(env); const m = /^(\d{13})\.([0-9a-f]{32})$/.exec(String(token || ''));
  if (!s || !m) return 'expired';
  if (!timingSafeEqualStr(m[2], (await hmacHex(s, `contact-form:${m[1]}`)).slice(0, 32))) return 'expired';
  const age = now - +m[1];
  if (age < CONTACT.MIN_FILL_MS) return 'too-fast';
  if (age > CONTACT.MAX_TOKEN_AGE_MS) return 'expired';
  return null;
}

// ---- first-line attachment check (malcolm-mail repeats it in depth) ----
const at = (b, sig, off = 0) => sig.every((v, i) => b[off + i] === v);
export function sniffHead(b) {
  if (at(b, [0x4d, 0x5a]) || at(b, [0x7f, 0x45, 0x4c, 0x46]) || at(b, [0xcf, 0xfa, 0xed, 0xfe]) || at(b, [0xfe, 0xed, 0xfa, 0xcf]) || at(b, [0xca, 0xfe, 0xba, 0xbe])) return 'executable';
  if (at(b, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  if (at(b, [0x1f, 0x8b]) || at(b, [0x52, 0x61, 0x72, 0x21]) || at(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || at(b, [0x42, 0x5a, 0x68]) || at(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'archive';
  if (at(b, [0xd0, 0xcf, 0x11, 0xe0])) return 'ole';
  if (at(b, [0xff, 0xd8, 0xff])) return 'jpg';
  if (at(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (at(b, [0x52, 0x49, 0x46, 0x46]) && at(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  const head = new TextDecoder('latin1').decode(b);
  if (/^\s{0,16}%PDF-\d/.test(head)) return 'pdf';
  if (b.includes(0)) return 'binary';
  const lead = head.replace(/^\u00ef\u00bb\u00bf/, '').trimStart().slice(0, 200).toLowerCase();
  if (/^<svg|<svg[\s>]/.test(lead)) return 'svg';
  if (/^<!doctype html|^<html|^<script|^<\?xml/.test(lead) || /^#!/.test(lead)) return 'markup';
  return 'text';
}
export async function checkUpload(file) {
  const name = String(file.name || 'attachment').split(/[\\/]/).pop().slice(-120);
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(name) || [])[1];
  const want = ext && EXT_TYPE[ext.toLowerCase()];
  if (!want) return `${name}: only JPG, PNG, WebP, PDF, TXT, CSV and DOCX files can be attached`;
  if (!file.size) return `${name}: the file is empty`;
  if (file.size > CONTACT.MAX_BYTES) return `${name}: files must be 5 MB or smaller`;
  const got = sniffHead(new Uint8Array(await file.slice(0, 1024).arrayBuffer()));
  const why = { executable: 'programs are not accepted', archive: 'archives are not accepted', ole: 'old-style Office files are not accepted (save it as .docx or PDF)', svg: 'SVG images are not accepted', markup: 'web pages and scripts are not accepted' }[got];
  if (why) return `${name}: ${why}`;
  if (got !== want) return `${name}: the file's contents don't match its .${ext.toLowerCase()} name`;
  return null;
}

// ---- rate limits on the existing D1 rate_limits table ----
export async function hit(DB, key, limit, windowSec, now = Math.floor(Date.now() / 1000)) {
  const row = await DB.prepare('SELECT n, reset_at FROM rate_limits WHERE k=?').bind(key).first();
  if (!row || row.reset_at <= now) { await DB.prepare('INSERT OR REPLACE INTO rate_limits(k,n,reset_at) VALUES(?,?,?)').bind(key, 1, now + windowSec).run(); return false; }
  if (row.n >= limit) return true;
  await DB.prepare('UPDATE rate_limits SET n=n+1 WHERE k=?').bind(key).run(); return false;
}

const FALLBACK = 'Please email malcolm@aichef.food instead.';
const withTimeout = (p, ms) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t)); };

export function mountContactRoutes(app, { mailer }) {
  app.get('/api/contact/token', async (c) => c.json({ token: await issueFormToken(c.env), maxFiles: CONTACT.MAX_FILES, maxBytes: CONTACT.MAX_BYTES, accept: ACCEPT, topics: TOPICS }));

  app.post('/api/contact', async (c) => {
    const E = c.env; const DB = E.DB;
    if (!/^multipart\/form-data/i.test(c.req.header('content-type') || '')) return c.json({ error: 'Please send the form from aichef.food/contact' }, 415);
    if (+(c.req.header('content-length') || 0) > CONTACT.MAX_BODY) return c.json({ error: 'Attachments are too large: up to 3 files of 5 MB each' }, 413);
    let form; try { form = await c.req.raw.formData(); } catch { return c.json({ error: 'Could not read the form. Please try again.' }, 400); }
    const g = (k) => (typeof form.get(k) === 'string' ? form.get(k) : '');
    // Honeypot: people never see this field. Bots get a polite "thanks" and nothing happens.
    if (g('website').trim()) return c.json({ ok: true, emailed: true });
    const t = await checkFormToken(E, g('formToken'));
    if (t === 'too-fast') return c.json({ error: 'That was very quick! Please check your message, then press Send again.', retryToken: true }, 400);
    if (t) return c.json({ error: 'This form has expired. Please refresh the page and try again.', retryToken: true }, 400);
    const ip = c.req.header('cf-connecting-ip') || 'anon'; const ipKey = (await sha256Hex(`contact-ip:${ip}`)).slice(0, 24);
    if (await hit(DB, `contact-ip-h:${ipKey}`, CONTACT.IP_PER_HOUR, 3600) || await hit(DB, `contact-ip-d:${ipKey}`, CONTACT.IP_PER_DAY, 86400)) return c.json({ error: `You've sent several messages already. Please try again later, or ${FALLBACK.toLowerCase()}` }, 429);
    const p = ContactSchema.safeParse({ name: g('name'), email: g('email'), topic: g('topic'), subject: g('subject'), message: g('message'), consent: g('consent') });
    if (!p.success) { const i = p.error.issues[0]; return c.json({ error: i.message, field: String(i.path[0] || '') }, 400); }
    const files = form.getAll('file').filter((f) => f && typeof f === 'object' && typeof f.arrayBuffer === 'function' && f.size > 0);
    if (files.length > CONTACT.MAX_FILES) return c.json({ error: `You can attach up to ${CONTACT.MAX_FILES} files`, field: 'file' }, 400);
    for (const f of files) { const why = await checkUpload(f); if (why) return c.json({ error: why, field: 'file' }, 400); }
    const emailKey = (await sha256Hex(`contact-email:${p.data.email}`)).slice(0, 24);
    if (await hit(DB, `contact-em:${emailKey}`, CONTACT.EMAIL_PER_DAY, 86400)) return c.json({ error: `Malcolm has already had ${CONTACT.EMAIL_PER_DAY} messages from this address today. Please try again tomorrow, or ${FALLBACK.toLowerCase()}` }, 429);

    if (E.CONTACT_DRY_RUN === '1') return c.json({ ok: true, emailed: false, dryRun: true, attachments: files.length, note: 'Staging preview: checks passed; nothing was sent to Malcolm.' });
    if (!E.MALCOLM_MAIL || !E.CONTACT_TOKEN) return c.json({ error: `The contact form isn't connected yet. ${FALLBACK}` }, 503);

    const u = c.get('user'); const out = new FormData();
    for (const [k, v] of Object.entries({ ...p.data, ipHash: ipKey, userId: u ? String(u.id) : '', page: '/contact' })) if (k !== 'consent') out.set(k, v);
    for (const f of files) out.append('file', f, f.name);
    let j, status;
    try {
      const r = await withTimeout(E.MALCOLM_MAIL.fetch('https://malcolm-mail/contact', { method: 'POST', headers: { authorization: `Bearer ${E.CONTACT_TOKEN}` }, body: out }), +E.CONTACT_TIMEOUT_MS || 80000);
      status = r.status; j = await r.json().catch(() => ({}));
    } catch (e) { console.error('contact: malcolm-mail', String(e.message || e).slice(0, 80)); return c.json({ error: `Malcolm couldn't take your message just now. ${FALLBACK}` }, 502); }
    if (status === 422) return c.json({ error: `${j.file ? `${j.file}: ` : ''}${j.reason || 'that attachment is not accepted'}`, field: 'file' }, 400);
    if (status === 400) return c.json({ error: 'Please check the form and try again.' }, 400);
    if (status !== 200 || !j.ok) return c.json({ error: `Malcolm couldn't take your message just now. ${FALLBACK}` }, 502);

    let emailed = false, err = null;
    if (j.reply) {
      if (!mailer.ready(E)) err = 'site email not configured';
      else {
        try { await mailer.send(E, { to: p.data.email, subject: j.reply.subject, text: j.reply.text, headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' } }); emailed = true; }
        catch (e) { err = String(e.message || e).replace(/re_[A-Za-z0-9_]+/g, '[key]').slice(0, 160); console.error('contact: reply email failed'); }
      }
      try { await E.MALCOLM_MAIL.fetch('https://malcolm-mail/contact/delivered', { method: 'POST', headers: { authorization: `Bearer ${E.CONTACT_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: j.id, replied: emailed, error: err }) }); } catch {}
    }
    return c.json({ ok: true, emailed, reference: String(j.id || '').slice(-8), attachmentsRead: (j.attachments || []).filter((a) => a.read).length, attachments: (j.attachments || []).length });
  });
}
