'use strict';
// Builds src/data/knowledge.json: a small retrieval index over every public site resource (pages, plans, gifts,
// restauranteur packs, magazine/nutrition sample PDFs, recipe library). Escoffier is searched live from D1 at runtime.
// Usage: node scripts/build-knowledge.js [pdfDir]   (PDF text via poppler `pdftotext` if available)
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..'); const PUB = path.join(ROOT, 'public'); const out = [];
const clean = s => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
function chunk(text, size = 700) { const s = text.split(/(?<=[.!?])\s+/); const c = []; let b = ''; for (const x of s) { if ((b + ' ' + x).length > size && b) { c.push(b.trim()); b = ''; } b += ' ' + x; } if (b.trim()) c.push(b.trim()); return c; }
const add = (src, title, url, text) => chunk(text).forEach((t, i) => t.length > 40 && out.push({ id: `${src}#${i}`, src, title, url, text: t }));
for (const f of fs.readdirSync(PUB).filter(f => f.endsWith('.html') && f !== '404.html')) {
  const h = fs.readFileSync(path.join(PUB, f), 'utf8'); const title = clean((h.match(/<title>([\s\S]*?)<\/title>/i) || [, f])[1]);
  add('page:' + f, title, '/' + (f === 'index.html' ? '' : f), clean(h.replace(/<div id="site-(header|footer)"><\/div>/g, '')));
}
process.env.FREE_SEARCHES = process.env.FREE_SEARCHES || '3';
const plans = require('../src/plans').plans();
for (const p of Object.values(plans)) add('plan:' + p.id, `${p.name} plan`, '/pricing.html', `${p.name} plan costs ${p.price}${p.id === 'free' ? '' : ' per month or ' + p.annualPrice + ' per year'}. Includes: ${p.features.join('; ')}.`);
try { const g = require('../src/gift'); const txt = JSON.stringify(g.options ? g.options() : Object.keys(g)).slice(0, 2000); add('gift', 'Gift memberships', '/gift.html', 'Gift memberships and certificates: buy any plan as a prepaid gift sent by email or a printable QR certificate; recipients redeem at /redeem.html. ' + clean(txt.replace(/[{}"\[\]]/g, ' '))); } catch {}
const pdfDir = process.argv[2] || path.join(ROOT, '..', '..');
const PDFS = { 'gift-certificate-sample.pdf': ['Gift certificate sample', '/gift.html'], 'magazine-sample.pdf': ['AIchef.food Magazine sample', '/pricing.html'], 'nutrition-kitchen-pack.pdf': ['Nutrition kitchen pack', '/app.html'], 'restauranteur-kitchen-plan-sample.pdf': ['Restauranteur kitchen plan sample', '/restauranteur.html'], 'restauranteur-live-kitchen-pack.pdf': ['Restauranteur kitchen pack', '/restauranteur.html'], 'restauranteur-live-menu.pdf': ['Restauranteur menu sample', '/restauranteur.html'], 'restauranteur-sample-pub-chalkboard.pdf': ['Pub chalkboard menu sample', '/restauranteur.html'] };
for (const [f, [t, u]] of Object.entries(PDFS)) { const p = path.join(pdfDir, f); if (!fs.existsSync(p)) continue; try { add('pdf:' + f, t, u, execFileSync('pdftotext', ['-l', '4', p, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ').slice(0, 5000)); } catch {} }
const { RECIPES } = require('../src/recipes');
for (const r of RECIPES) out.push({ id: 'recipe:' + r.id, src: 'recipe', title: r.title, url: `/recipe.html?id=${r.id}`, text: `${r.title} (${r.cuisine}, ${r.difficulty}, ${r.totalMinutes} min, serves ${r.baseServings}). Ingredients: ${r.ingredients.map(i => i.name).join(', ')}. Allergens: ${r.allergens.join(', ') || 'none of UK 14'}. Tags: ${r.tags.join(', ')}.` });
fs.writeFileSync(path.join(ROOT, 'src', 'data', 'knowledge.json'), JSON.stringify({ built: new Date().toISOString(), chunks: out }));
console.log('knowledge chunks', out.length, 'sources', new Set(out.map(c => c.src)).size);
