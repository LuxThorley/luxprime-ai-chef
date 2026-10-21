'use strict';
// Tiny dependency-free PDF writer for the Lux Prime Kitchen Magazine.
// Built for the Workers CPU budget: fonts are pre-deflated TrueType (embedded verbatim), photos are JPEG (DCTDecode, embedded
// verbatim), text is WinAnsi with build-time widths. No parsing, subsetting or compression at runtime.
const METRICS = require('./magfonts.json');
const CP = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
  0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
const FALLBACK = { 0x2010: 0x2d, 0x2011: 0x2d, 0x2012: 0x96, 0x2212: 0x2d, 0x00a0: 0x20, 0x2009: 0x20, 0x202f: 0x20, 0x2032: 0x27, 0x2033: 0x22, 0x2044: 0x2f, 0x2715: 0x78, 0xd7: 0xd7 };
function encode(str) {
  const out = [];
  for (const ch of String(str ?? '').normalize('NFC')) {
    const u = ch.codePointAt(0); let b = null;
    if (u >= 0x20 && u < 0x7f) b = u; else if (u >= 0xa0 && u <= 0xff) b = u; else if (CP[u]) b = CP[u]; else if (FALLBACK[u]) b = FALLBACK[u];
    else if (u === 0x2153) { out.push(0x31, 0x2f, 0x33); continue; } else if (u === 0x2154) { out.push(0x32, 0x2f, 0x33); continue; }
    else if (u === 10 || u === 9) b = 0x20;
    if (b != null) out.push(b);
  }
  return out;
}
const width = (str, font, size) => { const w = METRICS[font].widths; let t = 0; for (const b of encode(str)) t += w[b - 32] || 0; return t * size / 1000; };
function wrap(str, font, size, maxW) {
  const lines = [];
  for (const para of String(str ?? '').split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const cand = line ? line + ' ' + word : word;
      if (width(cand, font, size) <= maxW || !line) line = cand; else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}
const hex = bytes => bytes.map(b => b.toString(16).padStart(2, '0')).join('');
const rgb = c => { const n = parseInt(String(c).replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255].map(v => +v.toFixed(3)).join(' '); };
const f2 = n => +(+n).toFixed(2);
function jpegInfo(b) {
  if (!(b[0] === 0xff && b[1] === 0xd8)) throw new Error('not a JPEG');
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1]; const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], comps: b[i + 9] };
    i += 2 + len;
  }
  throw new Error('JPEG size not found');
}

class Page {
  constructor(doc, w, h) { this.doc = doc; this.w = w; this.h = h; this.ops = []; this.fonts = new Set(); this.imgs = new Set(); this.gs = new Set(); }
  Y(y) { return f2(this.h - y); }
  alpha(a) { if (a >= 1) return ''; const k = 'G' + Math.round(a * 100); this.gs.add(k); this.doc.gstates.add(k); return `/${k} gs `; }
  rect(x, y, w, h, color, { alpha = 1, stroke = null, lw = 0.6 } = {}) {
    this.ops.push(`q ${this.alpha(alpha)}${color ? rgb(color) + ' rg ' : ''}${stroke ? rgb(stroke) + ` RG ${lw} w ` : ''}${f2(x)} ${this.Y(y + h)} ${f2(w)} ${f2(h)} re ${color && stroke ? 'B' : color ? 'f' : 'S'} Q`); return this;
  }
  line(x1, y1, x2, y2, color, lw = 0.6, alpha = 1) { this.ops.push(`q ${this.alpha(alpha)}${rgb(color)} RG ${lw} w ${f2(x1)} ${this.Y(y1)} m ${f2(x2)} ${this.Y(y2)} l S Q`); return this; }
  text(str, x, y, { font = 'serif', size = 11, color = '#1a1a1a', align = 'left', spacing = 0, alpha = 1, maxW = null } = {}) {
    let s = String(str ?? ''); if (maxW) while (s.length > 1 && width(s, font, size) + spacing * s.length > maxW) s = s.slice(0, -2) + '…';
    const w = width(s, font, size) + spacing * Math.max(0, encode(s).length - 1);
    const dx = align === 'center' ? -w / 2 : align === 'right' ? -w : 0;
    this.fonts.add(font);
    this.ops.push(`q ${this.alpha(alpha)}BT /${font} ${size} Tf ${spacing ? f2(spacing) + ' Tc ' : ''}${rgb(color)} rg ${f2(x + dx)} ${this.Y(y)} Td <${hex(encode(s))}> Tj ET Q`); return w;
  }
  // Wrapped paragraph; y is the first baseline. Returns the y after the block.
  para(str, x, y, w, { font = 'serif', size = 11, lead = 1.38, color = '#1a1a1a', align = 'left', maxLines = Infinity } = {}) {
    const lines = wrap(str, font, size, w).slice(0, maxLines);
    for (const l of lines) { this.text(l, align === 'center' ? x + w / 2 : x, y, { font, size, color, align }); y += size * lead; }
    return y;
  }
  image(img, x, y, w, h, { fit = 'cover', alpha = 1 } = {}) {
    this.imgs.add(img.name); const r = img.w / img.h; let dw = w, dh = h;
    if (fit === 'cover') { if (w / h > r) dh = w / r; else dw = h * r; } else { if (w / h > r) dw = h * r; else dh = w / r; }
    const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    this.ops.push(`q ${this.alpha(alpha)}${f2(x)} ${this.Y(y + h)} ${f2(w)} ${f2(h)} re W n ${f2(dw)} 0 0 ${f2(dh)} ${f2(dx)} ${this.Y(dy + dh)} cm /${img.name} Do Q`); return this;
  }
}

class Doc {
  constructor({ title = 'Document', author = 'Lux Prime Kitchen', fontFiles = {} } = {}) { this.pages = []; this.images = []; this.gstates = new Set(); this.meta = { title, author }; this.fontFiles = fontFiles; }
  page(w = 595.28, h = 841.89) { const p = new Page(this, w, h); this.pages.push(p); return p; }
  addJpeg(bytes) { const i = jpegInfo(bytes); const img = { name: 'Im' + (this.images.length + 1), bytes, ...i }; this.images.push(img); return img; }
  save() {
    const te = new TextEncoder(); const chunks = []; let len = 0; const offs = [];
    const push = x => { const b = typeof x === 'string' ? te.encode(x) : x; chunks.push(b); len += b.length; };
    let n = 0; const ref = () => ++n; const objs = [];
    const add = (id, body, stream) => objs.push({ id, body, stream });
    const catalog = ref(), pagesId = ref(), info = ref();
    const usedFonts = [...new Set(this.pages.flatMap(p => [...p.fonts]))]; const fontIds = {};
    for (const f of usedFonts) {
      const m = METRICS[f]; const fid = ref(), did = ref(), fileId = ref(); fontIds[f] = fid;
      const file = this.fontFiles[f]; if (!file) throw new Error('font file missing: ' + f);
      add(fileId, `<< /Length ${file.length} /Length1 ${m.len1} /Filter /FlateDecode >>`, file);
      add(did, `<< /Type /FontDescriptor /FontName /${m.name} /Flags ${(m.serif ? 2 : 0) | 32 | (m.italic ? 64 : 0)} /FontBBox [${m.bbox.join(' ')}] /ItalicAngle ${m.italic} /Ascent ${m.ascent} /Descent ${m.descent} /CapHeight ${m.cap} /StemV 80 /FontFile2 ${fileId} 0 R >>`);
      add(fid, `<< /Type /Font /Subtype /TrueType /BaseFont /${m.name} /FirstChar 32 /LastChar 255 /Widths [${m.widths.join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor ${did} 0 R >>`);
    }
    const imgIds = {};
    for (const im of this.images) { const id = ref(); imgIds[im.name] = id; add(id, `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /${im.comps === 1 ? 'DeviceGray' : im.comps === 4 ? 'DeviceCMYK' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>`, im.bytes); }
    const gsIds = {}; for (const g of this.gstates) { const id = ref(); gsIds[g] = id; const a = +g.slice(1) / 100; add(id, `<< /Type /ExtGState /ca ${a} /CA ${a} >>`); }
    const pageIds = [];
    for (const p of this.pages) {
      const pid = ref(), cid = ref(); pageIds.push(pid); const content = te.encode(p.ops.join('\n'));
      add(cid, `<< /Length ${content.length} >>`, content);
      const res = `<< /Font << ${[...p.fonts].map(f => `/${f} ${fontIds[f]} 0 R`).join(' ')} >> /XObject << ${[...p.imgs].map(i => `/${i} ${imgIds[i]} 0 R`).join(' ')} >> /ExtGState << ${[...p.gs].map(g => `/${g} ${gsIds[g]} 0 R`).join(' ')} >> >>`;
      add(pid, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${f2(p.w)} ${f2(p.h)}] /Resources ${res} /Contents ${cid} 0 R >>`);
    }
    const pdfStr = s => '(' + String(s).replace(/[^\x20-\x7e]/g, '').replace(/([()\\])/g, '\\$1') + ')';
    add(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R /ViewerPreferences << /DisplayDocTitle true >> >>`);
    add(pagesId, `<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`);
    add(info, `<< /Title ${pdfStr(this.meta.title)} /Author ${pdfStr(this.meta.author)} /Producer (Lux Prime Kitchen) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
    push('%PDF-1.7\n'); push(new Uint8Array([37, 226, 227, 207, 211, 10]));
    objs.sort((a, b) => a.id - b.id);
    for (const o of objs) {
      offs[o.id] = len; push(`${o.id} 0 obj\n${o.body}\n`);
      if (o.stream) { push('stream\n'); push(o.stream); push('\nendstream\n'); }
      push('endobj\n');
    }
    const xref = len; let x = `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= n; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
    push(x + `trailer\n<< /Size ${n + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(len); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out;
  }
}
module.exports = { Doc, width, wrap, encode, jpegInfo, METRICS };
