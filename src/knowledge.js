'use strict';
// Tiny BM25 retrieval over src/data/knowledge.json (built by scripts/build-knowledge.js). No external services.
const KB = require('./data/knowledge.json');
const STOP = new Set('a an the and or of to in on for with is are be it i you my me we our your can do does how what which who when where why this that at as by from about please malcolm tell give get have has'.split(' '));
const tok = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9£ ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w)).map(w => w.replace(/(ies)$/, 'y').replace(/(?<=[a-z]{3})s$/, ''));
const docs = KB.chunks.map(c => { const t = tok(c.title + ' ' + c.title + ' ' + c.text); const tf = {}; t.forEach(w => tf[w] = (tf[w] || 0) + 1); return { c, tf, len: t.length }; });
const N = docs.length, avg = docs.reduce((s, d) => s + d.len, 0) / N; const df = {};
docs.forEach(d => Object.keys(d.tf).forEach(w => df[w] = (df[w] || 0) + 1));
function retrieve(q, { k = 4, src } = {}) {
  const qs = [...new Set(tok(q))]; if (!qs.length) return [];
  const res = [];
  for (const d of docs) { if (src && !src(d.c.src)) continue; let s = 0, hit = 0;
    for (const w of qs) { const f = d.tf[w]; if (!f) continue; hit++; const idf = Math.log(1 + (N - df[w] + 0.5) / (df[w] + 0.5)); s += idf * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * d.len / avg)); }
    if (s > 0) res.push({ ...d.c, score: Math.round(s * 100) / 100, coverage: hit / qs.length }); }
  return res.sort((a, b) => b.score - a.score).slice(0, k);
}
// Confident enough to ground an answer? (score + query coverage). Below this Malcolm says he doesn't know.
const grounded = hits => !!hits[0] && hits[0].score >= 4 && hits[0].coverage >= 0.5;
module.exports = { retrieve, grounded, size: N, built: KB.built };
