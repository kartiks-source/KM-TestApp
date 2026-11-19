'use strict';
/*
 * Turning outside data into normalised rows: CSV files, Google Sheet CSV links,
 * and Shopify Flow webhook bodies (JSON, or the same comma-separated line the sheet uses).
 *
 * Stock row  columns: Time, Variant ID, SKU, Product, Variant, Stock before, Stock now, Price
 * Order row  columns: Time, Order, Variant ID, SKU, Qty, Unit price
 */

const STOCK_COLS = ['time', 'variant id', 'sku', 'product', 'variant', 'stock before', 'stock now', 'price', 'type'];
const ORDER_COLS = ['time', 'order', 'variant id', 'sku', 'qty', 'unit price'];

const ALIASES = {
  time: ['time', 'timestamp', 'date', 'created at', 'createdat', 'at'],
  'variant id': ['variant id', 'variant_id', 'variantid', 'variant'],
  sku: ['sku', 'variant sku'],
  product: ['product', 'product title', 'title', 'name'],
  variant: ['variant', 'variant title', 'option'],
  'stock before': ['stock before', 'before', 'prior', 'inventory before', 'quantity before'],
  'stock now': ['stock now', 'now', 'after', 'inventory', 'quantity', 'stock', 'inventory now'],
  price: ['price', 'unit price', 'selling price'],
  type: ['type', 'product type', 'category', 'collection'],
  order: ['order', 'order name', 'order id', 'name'],
  qty: ['qty', 'quantity', 'units'],
  'unit price': ['unit price', 'price', 'net price', 'discounted price'],
};

/** RFC-4180-ish CSV parser (quotes, doubled quotes, CRLF). */
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
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

/** Parse a time: ISO, "2026-11-17 10:22:31", Sheets serial number, or dd/mm/yyyy hh:mm. Returns ms or null. */
function toTime(x) {
  if (x instanceof Date) return Number.isNaN(+x) ? null : +x;
  const s = clean(x);
  if (!s) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) return Math.round((+s - 25569) * 864e5 - 330 * 60e3);   // Sheets serial (IST)
  const dm = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dm) return Date.UTC(+dm[3], +dm[2] - 1, +dm[1], +(dm[4] || 0), +(dm[5] || 0), +(dm[6] || 0)) - 330 * 60e3;
  let iso = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(iso)) iso += '+05:30';           // no zone given → India
  iso = iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Map a header row to column indexes for the wanted columns. */
function headerMap(head, wanted) {
  const h = head.map((x) => clean(x).toLowerCase());
  const m = {};
  for (const col of wanted) {
    const i = h.findIndex((x) => (ALIASES[col] || [col]).includes(x));
    if (i >= 0) m[col] = i;
  }
  return m;
}
const looksLikeHeader = (row) => row.some((x) => /^(time|sku|variant id|order|qty|stock now|product)$/i.test(clean(x)));

function stockFrom(cells, m) {
  const g = (k, i) => clean(cells[m ? m[k] : i]);
  const r = {
    t: toTime(g('time', 0)), variantId: idOf(g('variant id', 1)), sku: g('sku', 2), product: g('product', 3), variant: g('variant', 4),
    before: Number(g('stock before', 5)), now: Number(g('stock now', 6)), price: Number(g('price', 7)) || 0,
  };
  const type = clean(m ? (m.type != null ? cells[m.type] : '') : cells[8]);
  if (type) r.type = type;
  return r.variantId && Number.isFinite(r.now) ? { ...r, before: Number.isFinite(r.before) ? r.before : null } : null;
}
function orderFrom(cells, m) {
  const g = (k, i) => clean(cells[m ? m[k] : i]);
  const r = { t: toTime(g('time', 0)), order: g('order', 1), variantId: idOf(g('variant id', 2)), sku: g('sku', 3), qty: Number(g('qty', 4)), price: Number(g('unit price', 5)) || 0 };
  return r.variantId && Number.isFinite(r.qty) && r.qty > 0 ? r : null;
}

/** CSV text → rows of one kind. Rows without a time get `stampNow`. Returns { rows, skipped }. */
function fromCsv(text, kind, stampNow = Date.now()) {
  const grid = parseCsv(text);
  if (!grid.length) return { rows: [], skipped: 0 };
  const wanted = kind === 'stock' ? STOCK_COLS : ORDER_COLS;
  let m = null, start = 0;
  if (looksLikeHeader(grid[0])) { m = headerMap(grid[0], wanted); start = 1; }
  const make = kind === 'stock' ? stockFrom : orderFrom;
  const rows = []; let skipped = 0;
  for (let i = start; i < grid.length; i++) {
    const r = make(grid[i], m);
    if (!r) { skipped++; continue; }
    if (!r.t) r.t = stampNow;
    rows.push(r);
  }
  return { rows, skipped };
}

/** A Shopify Flow webhook body: JSON object (keys like the columns) or one comma-separated line. */
function fromWebhook(body, kind, stampNow = Date.now()) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const k = (...names) => { for (const n of names) if (body[n] != null && body[n] !== '') return body[n]; return ''; };
    const cells = kind === 'stock'
      ? [k('time', 'at'), k('variant_id', 'variantId', 'variant id'), k('sku'), k('product', 'title'), k('variant', 'variant_title'), k('before', 'stock_before', 'prior'), k('now', 'stock_now', 'quantity'), k('price'), k('type', 'product_type', 'category')]
      : [k('time', 'created_at', 'createdAt'), k('order', 'order_name', 'name'), k('variant_id', 'variantId', 'variant id'), k('sku'), k('qty', 'quantity'), k('price', 'unit_price')];
    const r = kind === 'stock' ? stockFrom(cells) : orderFrom(cells);
    if (r && !r.t) r.t = stampNow;
    return r ? [r] : [];
  }
  return fromCsv(String(body || ''), kind, stampNow).rows;
}

/** Stable identity of a row, so the same row imported twice is kept once. */
const stockKey = (r) => `${r.t}|${r.variantId}|${r.before}|${r.now}`;
const orderKey = (r) => `${r.order || r.t}|${r.variantId}|${r.qty}`;

module.exports = { parseCsv, toTime, fromCsv, fromWebhook, stockKey, orderKey, STOCK_COLS, ORDER_COLS };
