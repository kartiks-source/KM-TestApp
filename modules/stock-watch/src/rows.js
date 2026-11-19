'use strict';
/*
 * Turning outside data into normalised rows: CSV files, Google Sheet CSV links,
 * and Shopify Flow webhook bodies (JSON, or the same comma-separated line the sheet uses).
 *
 * Stock row  columns: Time, Variant ID, SKU, Product, Variant, Stock before, Stock now, Price
 * Order row  columns: Time, Order, Variant ID, SKU, Qty, Unit price
 */

const STOCK_COLS = ['time', 'variant id', 'sku', 'product', 'variant', 'stock before', 'stock now', 'price', 'type', 'cost'];
const ORDER_COLS = ['time', 'order', 'variant id', 'sku', 'qty', 'unit price'];
/** Columns a CSV / Sheet file must name in its header row (a Flow row without a time is stamped now). */
const REQUIRED = { stock: ['time', 'variant id', 'stock now'], order: ['time', 'variant id', 'qty'] };
const LABEL = { time: 'Time', 'variant id': 'Variant ID', 'stock now': 'Stock now', qty: 'Qty' };
const DAY = 864e5;

/* Header names we accept besides the exact column name. An exact name always wins over an alias.
 * Not aliases on purpose: "variant" (that's the variant title, not its ID) and "collection" (not a product type). */
const ALIASES = {
  time: ['timestamp', 'date', 'created at', 'createdat', 'at'],
  'variant id': ['variantid'],
  sku: ['variant sku'],
  product: ['product title', 'title', 'name'],
  variant: ['variant title', 'option'],
  'stock before': ['before', 'prior', 'inventory before', 'quantity before'],
  'stock now': ['now', 'after', 'inventory', 'quantity', 'stock', 'inventory now'],
  price: ['unit price', 'selling price'],
  type: ['product type', 'category'],
  cost: ['unit cost', 'cost price', 'cogs', 'cost per item'],
  order: ['order name', 'order id', 'name'],
  qty: ['quantity', 'units'],
  'unit price': ['price', 'net price', 'discounted price'],
};

/** "," or ";" — whichever appears more often (outside quotes) in the first line. */
function sniffDelimiter(text) {
  let q = false, comma = 0, semi = 0;
  for (const c of String(text || '')) {
    if (c === '"') q = !q;
    else if (!q && (c === '\n' || c === '\r')) break;
    else if (!q && c === ',') comma++;
    else if (!q && c === ';') semi++;
  }
  return semi > comma ? ';' : ',';
}

/** RFC-4180-ish CSV parser (quotes, doubled quotes, CRLF). Delimiter: "," unless given. */
function parseCsv(text, delim = ',') {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

const clean = (x) => String(x == null ? '' : x).trim();
const idOf = (x) => clean(x).replace(/^gid:\/\/shopify\/ProductVariant\//, '').replace(/[^\w-]/g, '');
const norm = (x) => clean(x).toLowerCase().replace(/[_\s]+/g, ' ');

/** A number as people type it: "₹1,299", "1 299", "1,299.50". Blank → undefined; unreadable → NaN. */
function toNum(x) {
  if (typeof x === 'number') return x;
  const s = clean(x).replace(/[₹\s ,]/g, '').replace(/^(rs\.?|inr)/i, '');
  if (s === '') return undefined;
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}

const validDate = (y, mo, d, h = 0, mi = 0, se = 0) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && se <= 59
  && new Date(Date.UTC(y, mo - 1, d)).getUTCDate() === d;   // 31/02 is not a date

/**
 * Parse a time. Returns ms or null.
 * - ISO "2026-11-17T10:22:31+05:30", "2026-11-17 10:22:31", "2026-11-17" (date only = 00:00 store time)
 * - dd/mm/yyyy [hh:mm[:ss]] (Indian order; US mm/dd/yyyy like 11/15/2026 is rejected, not guessed)
 * - Sheets serial number
 * No zone given → the store's time zone (`tzOffsetMin`, minutes east of UTC; India = 330).
 */
function toTime(x, tzOffsetMin = 330) {
  if (x instanceof Date) return Number.isNaN(+x) ? null : +x;
  const s = clean(x);
  if (!s) return null;
  const tz = tzOffsetMin * 60e3;
  if (/^\d{5}(\.\d+)?$/.test(s)) return Math.round((+s - 25569) * DAY - tz);   // Sheets serial (store time)
  const dm = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dm) {
    const [d, mo, y, h, mi, se] = [+dm[1], +dm[2], +dm[3], +(dm[4] || 0), +(dm[5] || 0), +(dm[6] || 0)];
    return validDate(y, mo, d, h, mi, se) ? Date.UTC(y, mo - 1, d, h, mi, se) - tz : null;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (iso) {
    const [y, mo, d, h, mi, se] = [+iso[1], +iso[2], +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0)];
    if (!validDate(y, mo, d, h, mi, se)) return null;
    const base = Date.UTC(y, mo - 1, d, h, mi, se) + Math.round(+(iso[7] || 0) * 1000);
    const z = iso[8];
    if (!z) return base - tz;
    if (/^z$/i.test(z)) return base;
    const zm = z.match(/^([+-])(\d{2}):?(\d{2})$/);
    return base - (zm[1] === '-' ? -1 : 1) * (+zm[2] * 60 + +zm[3]) * 60e3;
  }
  if (/(GMT|UTC)([+-]\d{4})?$/i.test(s)) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }   // "Tue, 17 Nov 2026 04:52:31 GMT"
  return null;
}

/** Map a header row to column indexes. Exact names first, then aliases; each column used once. */
function headerMap(head, wanted) {
  const h = head.map(norm);
  const m = {}; const used = new Set();
  const take = (col, names) => {
    if (m[col] != null) return;
    const i = h.findIndex((x, j) => !used.has(j) && names.includes(x));
    if (i >= 0) { m[col] = i; used.add(i); }
  };
  for (const col of wanted) take(col, [col]);
  for (const col of wanted) take(col, ALIASES[col] || []);
  return m;
}
/** A Flow body is normally one data line; treat its first row as a header only if it names 2+ columns and has no time. */
const looksLikeHeader = (row, wanted, tz) => Object.keys(headerMap(row, wanted)).length >= 2 && toTime(row[0], tz) == null;

/* One CSV row → { r } or { skip: 'noId' | 'badNumber' }. `m` = header map, or null for the fixed column order. */
function stockFrom(cells, m) {
  const g = (k, i) => clean(m ? (m[k] != null ? cells[m[k]] : '') : cells[i]);
  const variantId = idOf(g('variant id', 1));
  if (!variantId) return { skip: 'noId' };
  const now = toNum(g('stock now', 6)), before = toNum(g('stock before', 5)), price = toNum(g('price', 7));
  if (now === undefined || Number.isNaN(now) || Number.isNaN(before) || Number.isNaN(price)) return { skip: 'badNumber' };
  const r = { rawTime: g('time', 0), variantId, sku: g('sku', 2), product: g('product', 3), variant: g('variant', 4), before: before === undefined ? null : before, now, price: price || 0 };
  const type = g('type', 8);
  if (type) r.type = type;
  const cost = toNum(g('cost', 9));
  if (cost > 0) r.cost = cost;
  return { r };
}
function orderFrom(cells, m) {
  const g = (k, i) => clean(m ? (m[k] != null ? cells[m[k]] : '') : cells[i]);
  const variantId = idOf(g('variant id', 2));
  if (!variantId) return { skip: 'noId' };
  const qty = toNum(g('qty', 4)), price = toNum(g('unit price', 5));
  if (!(qty > 0) || Number.isNaN(price)) return { skip: 'badNumber' };
  return { r: { rawTime: g('time', 0), order: g('order', 1), variantId, sku: g('sku', 3), qty, price: price || 0 } };
}

const blankSkips = () => ({ badTime: 0, badNumber: 0, noId: 0, tooOld: 0 });

/**
 * CSV text → rows of one kind. Returns { rows, skipped, skips: { badTime, badNumber, noId, tooOld } }.
 * opts: now, tzOffsetMin (store time zone), keepDays (rows older than this are skipped as tooOld),
 *       flow (Shopify Flow: no header needed; a missing or unreadable time is stamped `now`).
 * CSV / Sheet files must start with a header row naming the required columns, else this throws
 * an Error with status 400 and `missing` (the column names).
 */
function fromCsv(text, kind, opts = {}) {
  if (typeof opts === 'number') opts = { now: opts };
  const now = opts.now ?? Date.now(), tz = opts.tzOffsetMin ?? 330, flow = !!opts.flow;
  const skips = blankSkips();
  const grid = parseCsv(text, sniffDelimiter(text));
  if (!grid.length) return { rows: [], skipped: 0, skips };
  const wanted = kind === 'stock' ? STOCK_COLS : ORDER_COLS;
  let m = null, start = 0;
  if (!flow || looksLikeHeader(grid[0], wanted, tz)) {
    m = headerMap(grid[0], wanted); start = 1;
    const missing = REQUIRED[kind].filter((c) => m[c] == null && !(flow && c === 'time')).map((c) => LABEL[c]);
    if (missing.length) throw Object.assign(new Error(`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. The first row must name the columns.`), { status: 400, missing });
  }
  const make = kind === 'stock' ? stockFrom : orderFrom;
  const rows = [];
  for (let i = start; i < grid.length; i++) {
    const x = make(grid[i], m);
    if (x.skip) { skips[x.skip]++; continue; }
    const { rawTime, ...r } = x.r;
    r.t = toTime(rawTime, tz);
    if (r.t == null) { if (flow) r.t = now; else { skips.badTime++; continue; } }
    if (r.t > now + DAY) { skips.badTime++; continue; }
    if (opts.keepDays && r.t < now - opts.keepDays * DAY) { skips.tooOld++; continue; }
    rows.push(r);
  }
  return { rows, skipped: Object.values(skips).reduce((a, b) => a + b, 0), skips };
}

/** A Shopify Flow webhook body: JSON object (keys like the columns) or comma-separated line(s). Returns rows. */
function fromWebhook(body, kind, opts = {}) {
  if (typeof opts === 'number') opts = { now: opts };
  const o = { ...opts, flow: true };
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const k = (...names) => { for (const n of names) if (body[n] != null && body[n] !== '') return body[n]; return ''; };
    const line = kind === 'stock'
      ? [k('time', 'at'), k('variant_id', 'variantId', 'variant id'), k('sku'), k('product', 'title'), k('variant', 'variant_title'), k('before', 'stock_before', 'prior'), k('now', 'stock_now', 'quantity'), k('price'), k('type', 'product_type', 'category'), k('cost', 'unit_cost', 'cost_price')]
      : [k('time', 'created_at', 'createdAt'), k('order', 'order_name', 'name'), k('variant_id', 'variantId', 'variant id'), k('sku'), k('qty', 'quantity'), k('price', 'unit_price')];
    const csv = line.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',');
    return fromCsv(csv, kind, o).rows;
  }
  return fromCsv(String(body || ''), kind, o).rows;
}

/** Stable identity of a row, so the same row imported twice is kept once. */
const stockKey = (r) => `${r.t}|${r.variantId}|${r.before}|${r.now}`;
const orderKey = (r) => (r.line ? `${r.order}|L${r.line}` : `${r.order || r.t}|${r.variantId}|${r.qty}`);

module.exports = { parseCsv, sniffDelimiter, toNum, toTime, headerMap, fromCsv, fromWebhook, stockKey, orderKey, STOCK_COLS, ORDER_COLS, REQUIRED };
