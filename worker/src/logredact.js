// Redacts personal data and credentials from everything the Worker writes to its (persisted) logs:
// email addresses, URL query strings, bearer/JWT tokens, Stripe-style keys and long random tokens.
const RULES = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  [/\b(?:sk|rk|pk|whsec)_(?:live|test)?_?[A-Za-z0-9]{8,}\b/g, '[key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [token]'],
  [/(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/g, '$1?[query]'],
  [/([?&](?:token|t|code|key|sig|signature|email|invite|verify|session)=)[^&\s"'<>]+/gi, '$1[redacted]'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[hex]'],
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[token]'],
];
export function redact(v) {
  if (typeof v === 'string') { let s = v; for (const [re, to] of RULES) s = s.replace(re, to); return s; }
  if (v instanceof Error) { const e = new Error(redact(v.message)); e.name = v.name; e.stack = v.stack ? redact(v.stack) : undefined; return e; }
  if (v && typeof v === 'object') { try { return JSON.parse(redact(JSON.stringify(v))); } catch { return '[unloggable]'; } }
  return v;
}
let installed = false;
export function installLogRedaction(con = console) {
  if (installed && con === console) return; if (con === console) installed = true;
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) { const orig = con[m] && con[m].bind(con); if (orig) con[m] = (...a) => orig(...a.map(redact)); }
}
