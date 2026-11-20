'use strict';
/*
 * CSV import with a preview and column mapping (SW-045, LOGIC.md §1b).
 *
 *   detect(head)            which kind of file this is: a Shopify products export, a Shopify orders export, our own Stock
 *                           log / Order log, or something else; and the mapping we'd use (our column ← their header)
 *   preview(text, opts)     the first 5 rows as they would be read, with the mapping and the rules that apply
 *   parse(text, kind, map)  the whole file → rows, through src/rows.js (same checks and skips as every other CSV)
 *   remembered / remember   the mapping chosen last time for the same set of headers, per store (DATA_DIR/stores/<id>/mappings.json)
 *
 * A mapping is { <our column>: <their header, as written in the file> | special | '' }. Specials:
 *   '@now'      Time (stock only): the moment of the import. A Shopify products export is a stock count with no time.
 *   '@sku'      Variant ID: the SKU stands in. Shopify exports carry no variant ID; the ID already used for that SKU in this
 *               store is taken when there is one, so an export joins rows that came from Flow, the Sheet or an earlier file.
 *   '@options'  Variant: Option1 / Option2 / Option3 Value joined with " / " ("Default Title" = no variant name).
 * Shopify exports also get their own rules: rows of one product (Handle) or one order (Name) share the values Shopify
 * writes only on the first row; image-only rows are ignored; untracked, draft and archived variants are left out;
 * cancelled, voided and refunded orders are left out; unit price = Lineitem price − Lineitem discount ÷ quantity.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const rows = require('./rows');
const scope = require('./scope');

const SAMPLE = 5;
const CELL_MAX = 120;        // preview cells and header names are cut to this many characters
const MAX_SETS = 50;         // remembered mappings per store (oldest dropped)
const FILE_NAME = 'mappings.json';

/* Our columns, in the order the preview shows them. need = required (rows.REQUIRED); specials offered in the select. */
const COLUMNS = {
  stock: [
    { key: 'time', label: 'Time', need: true, specials: ['@now'] },
    { key: 'variant id', label: 'Variant ID', need: true, specials: ['@sku'] },
    { key: 'sku', label: 'SKU' },
    { key: 'product', label: 'Product' },
    { key: 'variant', label: 'Variant', specials: ['@options'] },
    { key: 'stock now', label: 'Stock now', need: true },
    { key: 'stock before', label: 'Stock before' },
    { key: 'price', label: 'Price' },
    { key: 'cost', label: 'Cost' },
    { key: 'type', label: 'Type' },
    { key: 'vendor', label: 'Vendor' },
  ],
  order: [
    { key: 'time', label: 'Time', need: true },
    { key: 'order', label: 'Order' },
    { key: 'variant id', label: 'Variant ID', need: true, specials: ['@sku'] },
    { key: 'sku', label: 'SKU' },
    { key: 'qty', label: 'Qty', need: true },
    { key: 'unit price', label: 'Unit price' },
    { key: 'line discount', label: 'Line discount' },
  ],
};
const SPECIAL = { '@now': 'When you import', '@sku': 'Use the SKU', '@options': 'Option values' };
const KINDS = ['stock', 'order'];

const norm = rows.norm;
const clean = (x) => String(x == null ? '' : x).trim();
const cut = (x) => { const s = clean(x); return s.length > CELL_MAX ? s.slice(0, CELL_MAX - 1) + '…' : s; };
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/* ---------- Shopify admin exports ---------- */
const FORMATS = {
  'shopify-products': {
    kind: 'stock', label: 'Shopify products export',
    test: (h) => h.has('handle') && h.has('variant sku') && (h.has('variant inventory qty') || h.has('variant price')),
    group: 'handle', fill: ['title', 'vendor', 'type', 'tags', 'status', 'product category', 'published'],
    want: {
      time: ['@now'], 'variant id': ['variant id', '@sku'], sku: ['variant sku'], product: ['title'], variant: ['@options'],
      'stock now': ['variant inventory qty', 'inventory quantity', 'inventory qty', 'on hand', 'available'],
      price: ['variant price'], cost: ['cost per item'], type: ['type'], vendor: ['vendor'],
    },
    rules: ['Rows of one product share its title, vendor and type.', 'Left out: image-only rows, and variants that are untracked, draft or archived.',
      'Stock is counted at the moment you import, so import a fresh export each time.'],
  },
  'shopify-orders': {
    kind: 'order', label: 'Shopify orders export',
    test: (h) => h.has('name') && h.has('lineitem quantity'),
    group: 'name', fill: ['created at', 'financial status', 'cancelled at', 'paid at'],
    want: {
      time: ['created at'], order: ['name'], 'variant id': ['lineitem variant id', '@sku'], sku: ['lineitem sku'], qty: ['lineitem quantity'],
      'unit price': ['lineitem price'], 'line discount': ['lineitem discount'],
    },
    rules: ['Rows of one order share its date and payment status.', 'Left out: cancelled, voided and refunded orders.',
      'Price paid = line price − line discount ÷ quantity (order-wide discount codes are not spread over the lines).'],
  },
};
const OWN = { stock: 'Stock log (our columns)', order: 'Order log (our columns)' };

/** Header names → a Set of their normal forms (lower case, _ = space). */
const headSet = (head) => new Set(head.map(norm));
/** Index of a header (exact text first, then the normal form), or -1. */
function indexOf(head, name) {
  const i = head.findIndex((h) => clean(h) === clean(name));
  return i >= 0 ? i : head.findIndex((h) => norm(h) === norm(name));
}
const hasOptions = (head) => indexOf(head, 'option1 value') >= 0;

/** Which file this is, from its header row: { format, label, kind } (format null = not one we know). */
function formatOf(head, kind) {
  const h = headSet(head);
  for (const [id, f] of Object.entries(FORMATS)) if (f.test(h)) return { format: id, label: f.label, kind: f.kind };
  const own = KINDS.filter((k) => rows.REQUIRED[k].every((c) => rows.headerMap(head, k === 'stock' ? rows.STOCK_COLS : rows.ORDER_COLS)[c] != null));
  const k = own.includes(kind) ? kind : own[0];
  if (k) return { format: k, label: OWN[k], kind: k };
  return { format: null, label: 'CSV file', kind: KINDS.includes(kind) ? kind : 'stock' };
}

/** The mapping we'd suggest for this header row and kind. */
function suggest(head, kind, format) {
  const cols = COLUMNS[kind], f = FORMATS[format], map = {};
  if (f && f.kind === kind) {
    for (const c of cols) {
      const pick = (f.want[c.key] || []).find((n) => (n === '@options' ? hasOptions(head) : n.startsWith('@') ? true : indexOf(head, n) >= 0));
      map[c.key] = pick ? (pick.startsWith('@') ? pick : clean(head[indexOf(head, pick)])) : '';
    }
    return map;
  }
  const m = rows.headerMap(head, kind === 'stock' ? rows.STOCK_COLS : rows.ORDER_COLS);
  for (const c of cols) map[c.key] = m[c.key] != null ? clean(head[m[c.key]]) : '';
  if (!map['variant id'] && map.sku) map['variant id'] = '@sku';   // no ID column: match on SKU
  return map;
}

/** A mapping from the page / API, checked against this file: unknown keys or headers → 400. Missing keys = not used. */
function checkMap(raw, head, kind) {
  let m = raw;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { throw badRequest('The column mapping must be JSON'); } }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw badRequest('The column mapping must be a JSON object');
  const cols = COLUMNS[kind], out = {};
  for (const k of Object.keys(m)) if (!cols.some((c) => c.key === k)) throw badRequest(`Unknown column in the mapping: ${String(k).slice(0, 40)}`);
  for (const c of cols) {
    const v = m[c.key] == null ? '' : m[c.key];
    if (typeof v !== 'string' || v.length > 200) throw badRequest(`Bad mapping for ${c.label}`);
    if (!v) { out[c.key] = ''; continue; }
    if (v.startsWith('@')) {
      if (!(c.specials || []).includes(v) || (v === '@options' && !hasOptions(head))) throw badRequest(`${c.label} can’t be “${SPECIAL[v] || v.slice(0, 40)}”`);
      out[c.key] = v; continue;
    }
    if (indexOf(head, v) < 0) throw badRequest(`Column “${v.slice(0, 60)}” is not in the file`);
    out[c.key] = v;
  }
  return out;
}
/** Required columns with nothing to read from (Variant ID from the SKU needs a SKU column). */
const missingOf = (map, kind) => [...COLUMNS[kind].filter((c) => c.need && !map[c.key]).map((c) => c.label), ...(map['variant id'] === '@sku' && !map.sku ? ['SKU'] : [])];

/* ---------- reading ---------- */
/** CSV text → { head, body } (body = data rows). truncated: the text is the start of a bigger file, its last row may be cut. */
function grid(text, truncated = false) {
  const g = rows.parseCsv(text, rows.sniffDelimiter(text));
  if (!g.length) throw badRequest('The file is empty');
  const body = g.slice(1);
  if (truncated && body.length) body.pop();
  return { head: g[0], body };
}
/** Shopify writes product / order values on the first row only: copy them down to the rows of the same handle / order. */
function fillDown(head, body, format) {
  const f = FORMATS[format]; if (!f) return body;
  const gi = indexOf(head, f.group); if (gi < 0) return body;
  const cols = f.fill.map((n) => indexOf(head, n)).filter((i) => i >= 0);
  let prev = null;
  return body.map((r) => {
    const row = r.slice();
    if (prev && clean(row[gi]) && clean(row[gi]) === clean(prev[gi])) for (const i of cols) if (!clean(row[i])) row[i] = prev[i];
    prev = row; return row;
  });
}
/** Shopify-only filters: 'ignore' (not a data row), a skip reason, or null (keep). */
function ruleFor(head, row, format) {
  const at = (n) => { const i = indexOf(head, n); return i >= 0 ? clean(row[i]) : null; };
  if (format === 'shopify-products') {
    if (!at('variant sku') && !at('variant inventory qty') && !at('option1 value') && !at('variant price')) return 'ignore';   // image rows
    const tracker = at('variant inventory tracker');
    if (tracker === '') return 'untracked';
    const st = (at('status') || '').toLowerCase();
    if (st === 'draft' || st === 'archived') return 'inactive';
  }
  if (format === 'shopify-orders') {
    if (at('cancelled at')) return 'cancelled';
    if (['voided', 'refunded'].includes((at('financial status') || '').toLowerCase())) return 'cancelled';
  }
  return null;
}
const OPTION_COLS = ['option1 value', 'option2 value', 'option3 value'];
/** One data row → cells in our columns' order (ready for rows.fromGrid). */
function cellsFor(head, row, kind, map, ctx) {
  const val = (key) => {
    const v = map[key];
    if (!v) return '';
    if (v === '@now') return new Date(ctx.now).toISOString();
    if (v === '@options') {
      const parts = OPTION_COLS.map((n) => { const i = indexOf(head, n); return i >= 0 ? clean(row[i]) : ''; }).filter(Boolean);
      return parts.length === 1 && parts[0] === 'Default Title' ? '' : parts.join(' / ');
    }
    if (v === '@sku') {
      const sku = val('sku');
      return sku ? (ctx.idForSku && ctx.idForSku.get(sku)) || rows.idOf(sku) : '';
    }
    return clean(row[indexOf(head, v)]);
  };
  const out = COLUMNS[kind].map((c) => val(c.key));
  if (kind === 'order' && map['line discount']) {   // price paid = line price − line discount ÷ qty
    const ix = (k) => COLUMNS.order.findIndex((c) => c.key === k);
    const price = rows.toNum(out[ix('unit price')]), qty = rows.toNum(out[ix('qty')]), disc = rows.toNum(out[ix('line discount')]);
    if (Number.isFinite(price) && qty > 0 && disc > 0) out[ix('unit price')] = String(Math.max(0, Math.round((price - disc / qty) * 100) / 100));
  }
  return out;
}
const blankSkips = () => ({ badTime: 0, badNumber: 0, noId: 0, tooOld: 0, cancelled: 0, untracked: 0, inactive: 0 });

/**
 * The whole file → rows. kind: 'stock' | 'order'; map: a mapping (checked here), or null for the remembered / suggested one.
 * opts: now, timeZone (store zone, SW-049; else tzOffsetMin), keepDays, idForSku (Map SKU → variant ID already in this store), truncated.
 * Returns { rows, skipped, skips, ignored, format, kind, map, head }. 400 when a required column has no mapping.
 */
function parse(text, kind, map, opts = {}) {
  const now = opts.now ?? Date.now();
  const { head, body: raw } = grid(text, opts.truncated);
  const fmt = formatOf(head, kind);
  const k = KINDS.includes(kind) ? kind : fmt.kind;
  const m = map ? checkMap(map, head, k) : opts.remembered && opts.remembered.kind === k ? checkMap(opts.remembered.map, head, k) : suggest(head, k, fmt.format);
  const missing = missingOf(m, k);
  if (missing.length) throw Object.assign(badRequest(`Choose a column for ${missing.join(', ')}`), { missing });
  const body = fillDown(head, raw, fmt.format);
  const skips = blankSkips(); let ignored = 0;
  const canon = [COLUMNS[k].map((c) => c.key)];
  const ctx = { now, idForSku: opts.idForSku };
  for (const row of body) {
    const rule = ruleFor(head, row, fmt.format);
    if (rule === 'ignore') { ignored++; continue; }
    if (rule) { skips[rule]++; continue; }
    canon.push(cellsFor(head, row, k, m, ctx));
  }
  const r = rows.fromGrid(canon, k, { now, timeZone: opts.timeZone, tzOffsetMin: opts.tzOffsetMin, keepDays: opts.keepDays });
  for (const [s, n] of Object.entries(r.skips)) skips[s] += n;
  return { rows: r.rows, skipped: Object.values(skips).reduce((a, b) => a + b, 0), skips, ignored, format: fmt.format, kind: k, map: m, head };
}

/**
 * What the page shows before an import: the file's kind, our columns with the header each one reads, every header,
 * and the first 5 data rows as they'd be read (or why one would be skipped). Writes nothing.
 * opts as parse(); kind '' = from the file. A required column without a mapping is not an error here: `missing` names it.
 */
function preview(text, kind, map, opts = {}) {
  const now = opts.now ?? Date.now();
  const { head, body: raw } = grid(text, opts.truncated);
  const fmt = formatOf(head, kind);
  const k = KINDS.includes(kind) ? kind : fmt.kind;
  const remembered = !map && opts.remembered && opts.remembered.kind === k;
  const m = map ? checkMap(map, head, k) : remembered ? checkMap(opts.remembered.map, head, k) : suggest(head, k, fmt.format);
  const missing = missingOf(m, k);
  const body = fillDown(head, raw, fmt.format);
  const sample = [];
  for (const row of body) {
    if (sample.length >= SAMPLE) break;
    const rule = ruleFor(head, row, fmt.format);
    if (rule === 'ignore') continue;
    const cells = missing.length ? null : cellsFor(head, row, k, m, { now, idForSku: opts.idForSku });
    let read = null, skip = rule;
    if (!skip && cells) {
      const r = rows.fromGrid([COLUMNS[k].map((c) => c.key), cells], k, { now, timeZone: opts.timeZone, tzOffsetMin: opts.tzOffsetMin, keepDays: opts.keepDays });
      if (r.rows.length) read = r.rows[0]; else skip = Object.keys(r.skips).find((s) => r.skips[s]) || 'badNumber';
    }
    sample.push({ raw: Object.fromEntries(COLUMNS[k].map((c) => [c.key, m[c.key] && !m[c.key].startsWith('@') ? cut(row[indexOf(head, m[c.key])]) : ''])), read, skip });
  }
  const f = FORMATS[fmt.format];
  return {
    format: fmt.format, label: fmt.label, kind: k, remembered: !!remembered,
    headers: [...new Set(head.map(clean).filter(Boolean))].map(cut),
    columns: COLUMNS[k].map((c) => ({ key: c.key, label: c.label, need: !!c.need, specials: (c.specials || []).filter((s) => s !== '@options' || hasOptions(head)).map((s) => ({ value: s, label: SPECIAL[s] })) })),
    map: m, missing, rules: f && f.kind === k ? f.rules : [], sample,
  };
}

/* ---------- remembered mappings (per store, per set of headers) ---------- */
/** Same headers in any order → the same key. */
const setKey = (head) => crypto.createHash('sha256').update([...new Set(head.map(norm).filter(Boolean))].sort().join('\u0001')).digest('hex').slice(0, 20);
const file = () => path.join(scope.dir(), FILE_NAME);
/** { sets: { key: { kind, map, at } } }. A file that can't be read is set aside and starts empty: a lost mapping costs one re-pick. */
function loadAll() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (j && typeof j === 'object' && j.sets && typeof j.sets === 'object' && !Array.isArray(j.sets)) return j;
    throw new Error('not a mappings file');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      const aside = `${file()}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try { fs.renameSync(file(), aside); } catch { /* leave it */ }
      console.warn(`${FILE_NAME} can't be read (${e.message}); set aside, starting with no remembered mappings.`);
    }
    return { sets: {} };
  }
}
/** The mapping remembered for this header row, or null. */
function remembered(head) {
  const s = loadAll().sets[setKey(head)];
  return s && KINDS.includes(s.kind) && s.map && typeof s.map === 'object' ? s : null;
}
/** Remember the mapping used for this header row (after a good import). */
function remember(head, kind, map, now = Date.now()) {
  const all = loadAll();
  all.sets[setKey(head)] = { kind, map, at: now };
  const keys = Object.keys(all.sets).sort((a, b) => (all.sets[b].at || 0) - (all.sets[a].at || 0));
  for (const k of keys.slice(MAX_SETS)) delete all.sets[k];
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all)); fs.renameSync(tmp, file());
}
/** The header row of a CSV text, without reading the rest of the file (for formatOf() / remembered()). */
function headOf(text) {
  const s = String(text || ''); let q = false, i = 0;
  for (; i < s.length; i++) { const c = s[i]; if (c === '"') q = !q; else if (!q && (c === '\n' || c === '\r')) break; }
  const g = rows.parseCsv(s.slice(0, i), rows.sniffDelimiter(s));
  if (!g.length) throw badRequest('The file is empty');
  return g[0];
}

/** SKU → the variant ID this store already uses for it (newest stock row wins; the Shopify catalog over rows). */
function idsBySku(stock = [], catalog = {}) {
  const m = new Map(), at = new Map();
  for (const r of stock) {
    const s = clean(r && r.sku); if (!s || !r.variantId) continue;
    if (!(at.get(s) > r.t)) { m.set(s, String(r.variantId)); at.set(s, r.t); }
  }
  for (const [id, c] of Object.entries(catalog || {})) { const s = clean(c && c.sku); if (s) m.set(s, String(id)); }
  return m;
}

module.exports = { COLUMNS, FORMATS, SPECIAL, formatOf, suggest, checkMap, parse, preview, remembered, remember, headOf, setKey, idsBySku, FILE_NAME, SAMPLE };
