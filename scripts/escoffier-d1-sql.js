'use strict';
// Emit INSERT batches (each < 90 KB) for loading data/escoffier.json into D1. Usage: node scripts/escoffier-d1-sql.js > out.json
const { entries } = require('../data/escoffier.json');
const q = v => v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const rows = entries.map(e => `(${[e.no, e.n, e.title, e.chapter, e.section, e.sub || null, e.text, e.ingredients ? JSON.stringify(e.ingredients) : null, e.method || null, e.refs ? JSON.stringify(e.refs) : null].map(q).join(',')})`);
const batches = []; let cur = [];
const head = 'INSERT OR REPLACE INTO escoffier(no,n,title,chapter,section,sub,text,ingredients,method,refs) VALUES';
for (const r of rows) { if (cur.length && head.length + cur.join(',').length + r.length > 90000) { batches.push(head + cur.join(',')); cur = []; } cur.push(r); }
if (cur.length) batches.push(head + cur.join(','));
process.stdout.write(JSON.stringify(batches));
