// social-copy.js — turns AIchef recipes, magazine highlights or free text into platform-tailored,
// honest copy for Facebook, LinkedIn and Instagram. Pure functions, no network.
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const tagify = s => String(s || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');
const uniq = a => [...new Set(a.filter(Boolean))];

export function withUtm(url, service, campaign = 'buffer') {
  if (!url) return null;
  try { const u = new URL(url); u.searchParams.set('utm_source', service); u.searchParams.set('utm_medium', 'social'); u.searchParams.set('utm_campaign', campaign); return u.toString(); } catch { return url; }
}
export function absUrl(base, p) {
  if (!p) return null; if (/^https:\/\//i.test(p)) return p; if (/^http:\/\//i.test(p)) return null;
  return String(base).replace(/\/$/, '') + (String(p).startsWith('/') ? '' : '/') + p;
}
/** Instagram/Buffer need a public JPEG/PNG. Returns null for webp/svg/data/relative-without-base. */
export function igSafeImage(url) { return url && (/^https:\/\/[^\s]+\.(jpe?g|png)(\?[^\s]*)?$/i.test(url) || /^https:\/\/[^\s/]+\/api\/dish-image\/[0-9a-f]{32}$/.test(url)) ? url : null; }

function hashtags(list, max) { return uniq(list.map(tagify)).slice(0, max).map(t => '#' + t).join(' '); }

/**
 * recipe: AIchef recipe object { id, title, cuisine, difficulty, totalMinutes, ingredients[], diet[], tags[], image{og,large} }
 * opts: { base, link: absolute recipe URL, imageUrl?: real dish photo (cached AI photo or one Oliver supplies),
 *         allowIllustrative?: also use the curated *category* photo (off by default: it may not show this dish) }
 * returns { title, link, imageUrl, copy: { facebook, linkedin, instagram } }
 */
export function recipeCopy(recipe, { base = 'https://aichef.food', link, imageUrl: photo, allowIllustrative = false } = {}) {
  const r = recipe || {}; const title = clip(r.title || 'A new recipe', 120);
  const ings = (r.ingredients || []).map(i => (i && (i.name || i.display)) || '').filter(Boolean).slice(0, 3);
  const made = ings.length ? `Made with ${ings.length > 1 ? ings.slice(0, -1).join(', ') + ' and ' + ings[ings.length - 1] : ings[0]}.` : '';
  const desc = clip(r.description || r.intro || r.summary || made, 260);
  const facts = [r.totalMinutes ? `⏱ ${r.totalMinutes} min` : '', r.difficulty ? `${r.difficulty[0].toUpperCase()}${r.difficulty.slice(1)}` : '', r.cuisine && r.cuisine !== 'any' ? r.cuisine : ''].filter(Boolean).join(' · ');
  const diets = (Array.isArray(r.diet) ? r.diet : []).slice(0, 3);
  const curated = r.image && !r.image.ai && (r.image.og || r.image.large);
  const imageUrl = igSafeImage(absUrl(base, photo || (allowIllustrative ? curated : null)));
  const pageLink = link || absUrl(base, r.id ? `/recipe.html?id=${encodeURIComponent(r.id)}` : '/');
  const baseTags = ['AIchef', 'HomeCooking', 'RecipeOfTheDay', r.cuisine && r.cuisine !== 'any' ? `${r.cuisine}Food` : '', ...diets];
  const fb = withUtm(pageLink, 'facebook'), li = withUtm(pageLink, 'linkedin');
  return {
    title, link: pageLink, imageUrl,
    copy: {
      facebook: [`🍽 ${title}`, desc, facts, `Get the full recipe, scaled to your household, from Malcolm, your AI chef at AIchef.food 👇`, fb, hashtags(baseTags, 5)].filter(Boolean).join('\n\n'),
      linkedin: [`${title}: a new recipe on AIchef.food`, desc, facts ? `${facts}.` : '', `AIchef.food pairs a classical kitchen library with Malcolm, an AI chef that tailors recipes to your ingredients, diet and allergens (UK 14).`, `Full recipe: ${li}`, hashtags(['AIchef', 'FoodTech', 'AI', 'Cooking'], 4)].filter(Boolean).join('\n\n'),
      instagram: [`🍽 ${title}`, desc, facts, `Full recipe on AIchef.food (link in bio) ✨`, '.', hashtags([...baseTags, 'Foodie', 'EasyRecipes', 'UKFood', 'Cooking', 'FoodPhotography', 'WhatsForDinner'], 15)].filter(Boolean).join('\n\n'),
    },
  };
}

/** highlight: { title, summary, url?, imageUrl? } — e.g. a magazine story. */
export function highlightCopy(h, { base = 'https://aichef.food' } = {}) {
  const title = clip(h && h.title || 'From the AIchef.food magazine', 140); const summary = clip(h && h.summary || '', 400);
  const link = (h && h.url && /^https:\/\//.test(h.url)) ? h.url : absUrl(base, '/pricing.html');
  const imageUrl = igSafeImage(h && h.imageUrl ? absUrl(base, h.imageUrl) : null);
  return {
    title, link, imageUrl,
    copy: {
      facebook: [`📖 ${title}`, summary, `Read more in the AIchef.food magazine 👇`, withUtm(link, 'facebook'), hashtags(['AIchef', 'FoodMagazine', 'Cooking'], 3)].filter(Boolean).join('\n\n'),
      linkedin: [`${title}`, summary, `From this month's AIchef.food magazine: ${withUtm(link, 'linkedin')}`, hashtags(['AIchef', 'Food', 'Publishing'], 3)].filter(Boolean).join('\n\n'),
      instagram: [`📖 ${title}`, summary, `More in the AIchef.food magazine (link in bio) ✨`, '.', hashtags(['AIchef', 'FoodMagazine', 'Foodie', 'Cooking', 'UKFood'], 10)].filter(Boolean).join('\n\n'),
    },
  };
}

/** Free text supplied by Oliver or by Malcolm: lightly tailored per platform. */
export function genericCopy({ title, text, link, imageUrl, hashtags: tags = [] } = {}) {
  const t = String(text || '').trim(); const ttl = clip(title || '', 140);
  const head = ttl && !t.startsWith(ttl) ? `${ttl}\n\n` : '';
  const ht = hashtags(tags, 10);
  return {
    title: ttl || clip(t, 80), link: link || null, imageUrl: igSafeImage(imageUrl) || null,
    copy: {
      facebook: [head + t, link ? withUtm(link, 'facebook') : '', hashtags(tags, 5)].filter(Boolean).join('\n\n'),
      linkedin: [head + t, link ? withUtm(link, 'linkedin') : '', hashtags(tags, 4)].filter(Boolean).join('\n\n'),
      instagram: [head + t, link ? 'Link in bio ✨' : '', ht].filter(Boolean).join('\n\n').slice(0, 2200),
    },
  };
}
