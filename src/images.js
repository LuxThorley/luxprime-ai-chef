'use strict';
// Dish imagery: curated category photos for library recipes, optional AI image generation (OpenAI-compatible
// /images/generations endpoint) for AI recipes, cached on disk, falling back to the closest curated photo.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const CATS = [
  ['baking', /brownie|banana bread|crumble|scone|pudding|cake|muffin|cookie|dessert|baking/i],
  ['breakfast', /pancake|oats|shakshuka|huevos|breakfast|smoothie|lassi|frittata|granola/i],
  ['soup', /soup|broth|burger|chowder/i],
  ['seafood', /salmon|prawn|fish|tuna|cod|seafood|paella/i],
  ['curry', /curry|tikka|masala|biryani|dal|korma|indian|katsu/i],
  ['mexican', /taco|fajita|chilli|burrito|enchilada|mexican|quesadilla/i],
  ['asian', /noodle|stir-fry|pad thai|fried rice|teriyaki|satay|chinese|thai|japanese|asian|ramen|wok/i],
  ['pasta', /spaghetti|pasta|linguine|lasagne|cannelloni|macaroni|risotto|pizza|bolognese|penne|italian/i],
  ['comfort', /pie|stew|casserole|toad|stroganoff|jacket|british|roast|sausage|hotpot/i],
  ['veggie', /vegan|veg|falafel|hummus|tagine|ratatouille|halloumi|salad|bowl|chickpea|lentil|greek|middle eastern|mediterranean|moroccan/i]
];
function curatedImage(r) {
  const hay = [r.title, r.cuisine, ...(r.tags || [])].join(' ');
  const c = (CATS.find(([, re]) => re.test(hay)) || ['ingredients'])[0];
  return { src: `/img/${c}-sm.webp`, large: `/img/${c}.webp`, og: `/img/${c}.jpg`, alt: `${r.title} — illustrative photo`, generated: false };
}
const CACHE = () => process.env.IMAGE_CACHE_DIR || path.join(__dirname, '..', 'data', 'img-cache');
const imageEnabled = () => !!(process.env.IMAGE_PROVIDER && process.env.IMAGE_PROVIDER !== 'none' && process.env.IMAGE_BASE_URL);
const keyFor = title => crypto.createHash('sha256').update(String(title).toLowerCase().trim()).digest('hex').slice(0, 32);
const inflight = new Map();
async function generateDishImage(title, { fetchImpl = fetch } = {}) {
  const k = keyFor(title), dir = CACHE(), file = path.join(dir, `${k}.png`);
  if (fs.existsSync(file)) return file;
  if (!imageEnabled()) return null;
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    const res = await fetchImpl(process.env.IMAGE_BASE_URL.replace(/\/$/, '') + '/images/generations', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.IMAGE_API_KEY ? { Authorization: `Bearer ${process.env.IMAGE_API_KEY}` } : {}) },
      body: JSON.stringify({ model: process.env.IMAGE_MODEL || 'gpt-image-1', prompt: `Professional editorial food photography of ${title}, plated beautifully, dark slate surface, warm natural light, shallow depth of field, no text, no people`, size: process.env.IMAGE_SIZE || '1024x1024', n: 1, response_format: 'b64_json' })
    });
    if (!res.ok) throw new Error(`Image HTTP ${res.status}`);
    const d = await res.json(); const item = d.data && d.data[0];
    let buf;
    if (item && item.b64_json) buf = Buffer.from(item.b64_json, 'base64');
    else if (item && item.url) { const r2 = await fetchImpl(item.url); buf = Buffer.from(await r2.arrayBuffer()); }
    else throw new Error('No image returned');
    if (buf.length > 8e6) throw new Error('Image too large');
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, buf); return file;
  })().finally(() => inflight.delete(k));
  inflight.set(k, p); return p;
}
module.exports = { curatedImage, generateDishImage, imageEnabled, keyFor };
