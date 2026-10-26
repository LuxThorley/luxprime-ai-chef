'use strict';
// Restauranteur Weekly: a personalised trade briefing for Restauranteur members only (everyone else keeps the monthly magazine).
// Built from the venue profile, linked sources, recent menus, saved keywords and the season. Optional Malcolm LLM pass; deterministic fallback.
const SEASON = { // UK seasonal produce by month (0 = Jan)
  0: ['forced rhubarb', 'blood orange', 'Jerusalem artichoke', 'cavolo nero', 'leeks', 'celeriac', 'venison', 'mussels', 'Seville orange'], 1: ['forced rhubarb', 'purple sprouting broccoli', 'parsnips', 'kale', 'chicory', 'cockles', 'hake', 'blood orange'],
  2: ['wild garlic', 'purple sprouting broccoli', 'spring onions', 'rhubarb', 'crab', 'sea trout', 'nettles', 'radishes'], 3: ['asparagus', 'wild garlic', 'morels', 'jersey royals', 'spring lamb', 'sea trout', 'watercress', 'rhubarb'],
  4: ['asparagus', 'peas', 'broad beans', 'elderflower', 'gooseberries', 'crab', 'lamb', 'new potatoes'], 5: ['strawberries', 'broad beans', 'courgettes', 'elderflower', 'mackerel', 'samphire', 'cherries', 'globe artichoke'],
  6: ['tomatoes', 'raspberries', 'courgette flowers', 'fennel', 'girolles', 'sea bass', 'runner beans', 'apricots'], 7: ['sweetcorn', 'plums', 'blackberries', 'heritage tomatoes', 'grouse', 'aubergine', 'mackerel', 'damsons'],
  8: ['ceps', 'figs', 'apples', 'pears', 'squash', 'partridge', 'oysters', 'blackberries'], 9: ['pumpkin', 'quince', 'chestnuts', 'wild mushrooms', 'pheasant', 'apples', 'mussels', 'celeriac'],
  10: ['Brussels sprouts', 'parsnips', 'chestnuts', 'cranberries', 'venison', 'clementines', 'red cabbage', 'scallops'], 11: ['Brussels sprouts', 'chestnuts', 'goose', 'clementines', 'red cabbage', 'oysters', 'turbot', 'truffle (black)'] };
const SPECIALS = { 0: ['Venison suet pudding, celeriac mash, red wine jus', 'Mussels, leeks, cider and cream, sourdough', 'Forced rhubarb and custard tart'], 1: ['Hake, purple sprouting broccoli, brown shrimp butter', 'Braised kale, parsnip and smoked cheddar pie', 'Blood orange posset, shortbread'],
  2: ['Wild garlic and spring onion risotto, crispy egg', 'Dressed crab on toast, radish, watercress', 'Rhubarb and ginger crumble'], 3: ['Asparagus, hollandaise, crispy ham', 'Spring lamb rump, Jersey Royals, wild garlic salsa verde', 'Rhubarb Bakewell, clotted cream'],
  4: ['Pea, broad bean and mint salad, whipped feta', 'Lamb neck, peas, lettuce and bacon', 'Gooseberry and elderflower fool'], 5: ['Grilled mackerel, samphire, gooseberry relish', 'Courgette, broad bean and lemon tart', 'Strawberries, Eton mess, elderflower'],
  6: ['Heritage tomato salad, pickled shallot, basil', 'Sea bass, fennel, girolles, beurre blanc', 'Raspberry and almond tart'], 7: ['Grilled sweetcorn, chipotle butter, lime', 'Roast grouse, bread sauce, game chips', 'Plum and damson crumble'],
  8: ['Ceps on toast, parsley, aged parmesan', 'Partridge, pear, chestnut and bacon', 'Fig and honey tart, crème fraîche'], 9: ['Pumpkin soup, sage brown butter, seeds', 'Pheasant, wild mushroom and chestnut pie', 'Baked quince, spiced custard'],
  10: ['Seared scallops, cauliflower, smoked bacon', 'Venison haunch, red cabbage, parsnip purée', 'Clementine and cranberry sponge'], 11: ['Oysters, shallot vinegar, brown bread', 'Roast goose, chestnut stuffing, sprouts with bacon', 'Christmas pudding, brandy butter'] };
const TIPS = ['Cross-utilise trim: veg peelings into stock, herb stalks into oils, bread ends into crumb or pangrattato.', 'Re-cost your top five sellers against this week’s invoices — a 10p swing per portion adds up fast.', 'Write specials around what is cheapest and best this week, not the other way round.', 'Weigh waste for a week by station; most kitchens find 3–5% of food cost in the bin.', 'Batch sauces and garnishes on quieter days and label with day dots (FIFO).', 'Offer a set lunch built from the same mise en place as dinner to lift GP without extra prep.', 'Agree a weekly “market price” line with your fish supplier to lock in the best catch.', 'Portion control: scale-check proteins at the start of every service.'];
const TRENDS = ['Seasonal British small plates and sharing formats', 'Fire, smoke and live-coal cooking', 'Low- and no-alcohol pairings', 'Nose-to-tail and root-to-leaf menus', 'Ferments, pickles and house-made condiments', 'Premium sandwiches and elevated bar snacks', 'Plant-forward mains with real substance', 'Heritage and regional British cheeses'];
const isoWeek = (d = new Date()) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 864e5 + 1) / 7)).padStart(2, '0')}`; };
const pick = (arr, n, seed) => { const a = [...arr]; let s = seed; const out = []; while (a.length && out.length < n) { s = (s * 9301 + 49297) % 233280; out.push(a.splice(s % a.length, 1)[0]); } return out; };
// Monday 08:00+ UK time? (Europe/London aware via Intl)
function ukParts(now = new Date()) { const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', hour12: false }); const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value])); return { weekday: p.weekday, hour: +p.hour }; }
const sendWindow = (now = new Date()) => { const p = ukParts(now); return p.weekday === 'Mon' && p.hour >= 8; };
function buildIssue({ profile = {}, menus = [], keywords = [], user = {} } = {}, now = new Date(), ai = null) {
  const m = now.getUTCMonth(); const week = isoWeek(now); const seed = [...(String(user.id || 0) + week)].reduce((s, c) => s + c.charCodeAt(0), 7);
  const venue = profile.name || 'your venue'; const kind = profile.venueType || 'restaurant'; const pub = /pub|bar|inn/.test(kind);
  const produce = pick(SEASON[m], 6, seed); const next = pick(SEASON[(m + 1) % 12], 3, seed + 1);
  const cuisines = [...new Set((profile.sources || []).flatMap(s => (s.analysis && s.analysis.cuisines) || []))].slice(0, 3);
  const benches = (profile.sources || []).filter(s => s.kind === 'benchmark').map(s => s.name || s.url).slice(0, 3);
  const recent = menus.slice(0, 3).map(x => x.title);
  const kw = keywords.slice(0, 5);
  const specials = SPECIALS[m];
  const issue = { kind: 'restauranteur-weekly', week, venue, title: `Restauranteur Weekly · ${venue}`, dateLabel: now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }),
    intro: `Good morning from Malcolm. Here’s your briefing for ${venue} this week${recent.length ? `, built around ${recent.length > 1 ? 'your recent menus' : 'your menu'} “${recent[0]}”` : ''}${kw.length ? ` and your keywords (${kw.join(', ')})` : ''}.`,
    sections: [
      { h: 'In season now', items: [`At their best this week: ${produce.join(', ')}.`, `Coming next month: ${next.join(', ')} — start talking to suppliers.`] },
      { h: 'Specials to try', items: specials },
      { h: 'Menu ideas for you', items: [cuisines.length ? `Lean into your ${cuisines.join(' / ')} identity with one bold seasonal plate on each course.` : 'Add one bold seasonal plate on each course to keep regulars curious.', recent.length ? `Refresh “${recent[0]}”: swap the weakest-selling dish for one built on ${produce[0]} and re-cost it in the Menu Builder.` : 'Build this week’s specials board in the Menu Builder and download a Kitchen Pack for the team.', benches.length ? `Benchmark watch: compare your pricing and seasonality with ${benches.join(', ')} — inspiration only, never copy.` : 'Link a benchmark site in the Menu Builder to compare seasonality and pricing.'] },
      { h: 'Trends', items: pick(TRENDS, 2, seed + 2) },
      { h: 'Cost-saving tips', items: pick(TIPS, 2, seed + 3) }
    ], footer: 'Estimates and ideas only — always check suppliers, allergens and costs. Sent to Restauranteur members weekly; other plans receive the monthly magazine.' };
  if (ai && ai.intro) issue.intro = String(ai.intro).slice(0, 500);
  if (ai && Array.isArray(ai.ideas) && ai.ideas.length) issue.sections[2].items = ai.ideas.slice(0, 4).map(x => String(x).slice(0, 240));
  return issue;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function renderHtml(issue, { webUrl = '', unsubUrl = '', prefsUrl = '' } = {}) {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(issue.title)}</title></head><body style="margin:0;background:#f6f1e7"><div style="font-family:Georgia,serif;max-width:620px;margin:auto;background:#fffdf8;color:#2b2118;padding:28px">
<p style="letter-spacing:.22em;font-size:11px;color:#a8683e;margin:0">RESTAURANTEUR WEEKLY · ${esc(issue.week)}</p><h1 style="font-weight:normal;margin:.3em 0">${esc(issue.venue)}</h1><p style="color:#7a7065;margin:0 0 14px">${esc(issue.dateLabel)}</p><p>${esc(issue.intro)}</p>
${issue.sections.map(s => `<h2 style="font-size:16px;letter-spacing:.06em;color:#a8683e;border-top:1px solid #e6dccb;padding-top:12px">${esc(s.h)}</h2><ul>${s.items.map(i => `<li style="margin:.35em 0">${esc(i)}</li>`).join('')}</ul>`).join('')}
<p style="font-size:12px;color:#7a7065;border-top:1px solid #e6dccb;padding-top:12px">${esc(issue.footer)}${webUrl ? ` · <a href="${esc(webUrl)}">View in browser</a>` : ''}${prefsUrl ? ` · <a href="${esc(prefsUrl)}">Weekly or monthly?</a>` : ''}${unsubUrl ? ` · <a href="${esc(unsubUrl)}">Unsubscribe</a>` : ''}</p></div></body></html>`;
}
function renderText(issue, { webUrl = '', unsubUrl = '' } = {}) { return `${issue.title} — ${issue.dateLabel}\n\n${issue.intro}\n\n${issue.sections.map(s => `${s.h.toUpperCase()}\n${s.items.map(i => '• ' + i).join('\n')}`).join('\n\n')}\n\n${issue.footer}\nView in browser: ${webUrl}\nUnsubscribe: ${unsubUrl}`; }
const aiMessages = (ctx, issue) => [{ role: 'system', content: 'You are Malcolm, consulting chef writing a weekly trade briefing for a UK restaurant/pub client. British English. Reply JSON only: {"intro": string (2 sentences, warm, specific), "ideas": [3-4 concise, actionable menu ideas using the seasonal produce]}' }, { role: 'user', content: JSON.stringify({ venue: issue.venue, type: ctx.profile && ctx.profile.venueType, description: ctx.profile && ctx.profile.description, recentMenus: (ctx.menus || []).slice(0, 3).map(m => m.title), keywords: ctx.keywords, seasonal: issue.sections[0].items }) }];
module.exports = { SEASON, isoWeek, ukParts, sendWindow, buildIssue, renderHtml, renderText, aiMessages };
