'use strict';
// Parse the public-domain 1907 Heinemann translation of Escoffier's "A Guide to Modern Cookery"
// (Project Gutenberg eBook #71395) into structured entries. Usage: node scripts/build-escoffier.js <gutenberg.txt>
const fs = require('fs'); const path = require('path');
const SECTIONS = { I: 'Fonds de cuisine (stocks)', II: 'Leading warm sauces', III: 'Small compound sauces', IV: 'Cold sauces & compound butters', V: 'Aspics & savoury jellies',
  VI: 'Court-bouillons & marinades', VII: 'Elementary preparations', VIII: 'Soup garnishes', IX: 'Garnishes for relevés & entrées', X: 'Leading culinary operations',
  XI: 'Hors-d’œuvres', XII: 'Eggs', XIII: 'Soups', XIV: 'Fish', XV: 'Relevés & entrées', XVI: 'Poultry & game', XVII: 'Roasts & salads',
  XVIII: 'Vegetables & farinaceous', XIX: 'Savouries', XX: 'Entremets (sweets)', XXI: 'Ices', XXII: 'Drinks & refreshments', XXIII: 'Fruit-stews & jams' };
const ATTRIBUTION = 'From A. Escoffier, “A Guide to Modern Cookery” (London: William Heinemann, 1907). Public domain; text via Project Gutenberg eBook #71395 (www.gutenberg.org).';
const clean = s => s.replace(/_([^_]+)_/g, '$1').replace(/=([^=]+)=/g, '$1').replace(/\r/g, '');
function parse(raw) {
  let t = raw.replace(/\r/g, '');
  const a = t.indexOf('*** START OF'); if (a >= 0) t = t.slice(t.indexOf('\n', a) + 1);
  const b = t.indexOf('*** END OF'); if (b >= 0) t = t.slice(0, b);
  const m = t.indexOf('\nMENUS DE DEJEUNERS'); if (m >= 0) t = t.slice(0, m); // drop menus + index
  const lines = t.split('\n'); const out = []; let chapter = null, sub = null, cur = null, prevBlank = true;
  const flush = () => { if (cur) { cur.text = clean(cur.lines.join('\n')).replace(/\n{3,}/g, '\n\n').trim(); delete cur.lines; out.push(cur); cur = null; } };
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const ch = L.match(/^CHAPTER ([IVXL]+)\s*$/);
    if (ch) { flush(); chapter = ch[1]; sub = null; prevBlank = false; continue; }
    const h = prevBlank && L.match(/^(\d{1,4}[a-z]?)—(.+)$/);
    if (h && chapter) {
      flush(); let title = h[2].trim();
      while (lines[i + 1] && lines[i + 1].trim() && title.length > 60 && !/[.:]$/.test(title) && /^[A-Z(“'’ÉÈ-]/.test(lines[i + 1].trim()) && lines[i + 1] === lines[i + 1].toUpperCase()) title += ' ' + lines[++i].trim();
      cur = { no: h[1], n: parseInt(h[1], 10), title: clean(title).replace(/\s+/g, ' ').replace(/[.,:]$/, ''), chapter, section: SECTIONS[chapter] || chapter, sub, lines: [] };
    } else if (cur) cur.lines.push(L);
    else if (prevBlank && /^[A-Z][A-Z ’'(),-]{4,60}$/.test(L.trim()) && lines[i + 1] !== undefined && !lines[i + 1].trim()) sub = L.trim();
    prevBlank = !L.trim();
  }
  flush();
  for (const e of out) {
    const q = e.text.match(/Quantities[^\n]*\n\n?((?:\s{2,}.+\n?)+)/); const ing = q ? q[1].split('\n').map(s => s.trim()).filter(Boolean) : [];
    if (ing.length) e.ingredients = ing.slice(0, 40);
    const mp = e.text.match(/(?:Mode of Procedure|Preparation|Method)\.?—([\s\S]+)/); if (mp) e.method = mp[1].trim().slice(0, 1500);
    const refs = [...new Set([...e.text.matchAll(/\bNos?\.\s*(\d{1,4}[a-z]?)/g)].map(r => r[1]).filter(r => r !== e.no))]; if (refs.length) e.refs = refs.slice(0, 8);
    if (e.sub && /CHAPTER|PART/.test(e.sub)) e.sub = null;
  }
  return out;
}
module.exports = { parse, SECTIONS, ATTRIBUTION };
if (require.main === module) {
  const entries = parse(fs.readFileSync(process.argv[2], 'utf8'));
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'escoffier.json'), JSON.stringify({ attribution: ATTRIBUTION, sections: SECTIONS, entries }));
  console.log(entries.length, 'entries');
}
