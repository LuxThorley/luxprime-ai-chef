// Minimal Stripe REST client over fetch (form-encoded).
export async function stripeApi(key, path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])) });
  const d = await res.json(); if (!res.ok) throw new Error(`Stripe ${res.status}: ${d.error && d.error.message}`); return d;
}
export async function stripeGet(key, path) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${key}` } });
  const d = await res.json(); if (!res.ok) throw new Error(`Stripe ${res.status}: ${d.error && d.error.message}`); return d;
}
