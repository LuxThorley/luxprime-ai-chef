'use strict';
// The single outbound-email path for the whole site (verification, magazine, household invites, anything new).
// Resend over HTTPS works from both Node and Workers. Inactive until RESEND_API_KEY is set; never throws secrets into logs.
const DEFAULT_FROM = '"Malcolm · AIchef.food" <malcolm@aichef.food>';
const REPLY_TO = 'malcolm@aichef.food';
const from = (env = {}) => env.MAIL_FROM || env.MAGAZINE_FROM || DEFAULT_FROM;
const replyTo = (env = {}) => env.MAIL_REPLY_TO || REPLY_TO;
const ready = (env = {}) => !!env.RESEND_API_KEY;
async function send(env, { to, subject, text, html, headers, attachments }, fetchImpl = fetch) {
  if (!ready(env)) return { sent: false, reason: 'email-not-configured' };
  const body = { from: from(env), reply_to: replyTo(env), to: Array.isArray(to) ? to : [to], subject, text, ...(html ? { html } : {}), ...(headers ? { headers } : {}), ...(attachments ? { attachments } : {}) };
  const r = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return { sent: true, id: (await r.json()).id };
}
module.exports = { send, ready, from, replyTo, DEFAULT_FROM, REPLY_TO };
