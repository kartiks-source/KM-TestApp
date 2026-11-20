'use strict';
/*
 * Suppliers (SW-040, LOGIC.md §6c). Pure functions, no I/O: tested in test/suppliers.test.js.
 *   terms      a supplier's lead time (days), minimum order (MOQ, units per line) and case pack (units per case)
 *   resolve()  which supplier each variant buys from: the SKU → supplier map first (set on Data → Suppliers or by CSV),
 *              else Shopify's product vendor; then that supplier's terms
 *   roundOrder() order qty rounded UP to at least the MOQ, then up to whole case packs
 *   CSV in and out for the supplier table and the SKU map
 * Storage and routes: src/suppliers.js.
 */
const { parseCsv, sniffDelimiter } = require('./rows');
const { vendorMap } = require('./helpers');

const NAME_MAX = 60;
const MAX_SUPPLIERS = 500;
const MAX_MAP = 20000;
/* allowed values; blank = not set (lead: the store's lead time; MOQ and pack: no rounding) */
const LIMITS = { leadDays: [0, 180], moq: [1, 1e6], pack: [1, 1e5] };
const LABEL = { leadDays: 'Lead time', moq: 'MOQ', pack: 'Case pack' };

/** A supplier name as stored: trimmed, inner spaces collapsed, no control characters, at most 60 characters. */
const cleanName = (x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
/** The key a supplier is found by: names match whatever their case. */
const keyOf = (name) => cleanName(name).toLowerCase();
/** A SKU or variant ID used as a map key. */
const cleanSku = (x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);

/** One term: null when blank; a whole number inside LIMITS; otherwise { error }. */
function term(k, v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  const [lo, hi] = LIMITS[k];
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < lo || n > hi) return { error: `${LABEL[k]} must be a whole number from ${lo} to ${hi.toLocaleString('en-IN')}, or blank` };
  return n;
}
/** A supplier row from the page or a CSV: { ok, value: { name, leadDays, moq, pack } } or { ok: false, error }. */
function validate(s) {
  const name = cleanName(s && s.name);
  if (!name) return { ok: false, error: 'Each supplier needs a name' };
  const value = { name };
  for (const k of Object.keys(LIMITS)) {
    const t = term(k, s[k]);
    if (t && typeof t === 'object') return { ok: false, error: `${name}: ${t.error}` };
    value[k] = t;
  }
  return { ok: true, value };
}
const hasTerms = (s) => s && (s.leadDays != null || s.moq != null || s.pack != null);

/**
 * SW-040 rule: order qty rounded UP to at least the MOQ, then up to whole case packs. Only an order that is due
 * (qty > 0) is rounded: a product that needs nothing is never pushed to a minimum. extra = units added by the rounding.
 */
function roundOrder(qty, sup) {
  const q0 = Math.max(0, Math.ceil(+qty || 0));
  if (!(q0 > 0) || !sup) return { qty: q0, extra: 0 };
  let q = q0;
  if (sup.moq > 1) q = Math.max(q, sup.moq);
  if (sup.pack > 1) q = Math.ceil(q / sup.pack) * sup.pack;
  return { qty: q, extra: q - q0 };
}

/** SKU per variant: the newest stock row that has one, the catalog's when there is one (same order as vendorMap). */
function skuMap(stock = [], catalog = null) {
  const m = Object.create(null), seen = Object.create(null);
  for (const r of stock) if (r && r.sku && !(seen[r.variantId] > r.t)) { m[String(r.variantId)] = String(r.sku); seen[r.variantId] = r.t; }
  if (catalog && typeof catalog === 'object') for (const [id, c] of Object.entries(catalog)) if (c && c.sku) m[String(id)] = String(c.sku);
  return m;
}

/**
 * Which supplier each variant buys from, with its terms. data = suppliers.json: { suppliers: { key: terms }, map: { sku|id: name } }.
 * Returns { [variantId]: { name, leadDays, moq, pack, from: 'map' | 'vendor' } } (a null prototype: IDs are data).
 * Variants with neither a mapped supplier nor a vendor are left out (no supplier: global lead time, no rounding).
 */
function resolve(stock, catalog, data) {
  const sups = (data && data.suppliers) || {}, map = (data && data.map) || {};
  const vendors = vendorMap(stock, catalog), skus = skuMap(stock, catalog);
  const ids = new Set(Object.keys(vendors));
  for (const r of stock) if (r && r.variantId != null) ids.add(String(r.variantId));
  if (catalog && typeof catalog === 'object') for (const id of Object.keys(catalog)) ids.add(id);
  const out = Object.create(null);
  for (const id of ids) {
    const sku = skus[id] || '';
    const mapped = (sku && Object.hasOwn(map, sku) ? map[sku] : null) || (Object.hasOwn(map, id) ? map[id] : null);
    const name = cleanName(mapped || vendors[id] || '');
    if (!name) continue;
    const t = Object.hasOwn(sups, keyOf(name)) ? sups[keyOf(name)] : null;
    out[id] = { name: t ? t.name : name, leadDays: t ? t.leadDays ?? null : null, moq: t ? t.moq ?? null : null, pack: t ? t.pack ?? null : null, from: mapped ? 'map' : 'vendor' };
  }
  return out;
}

/** Supplier names on offer with how many variants each has: every supplier with terms, and every vendor / mapped name in use. */
function usage(resolved, data) {
  const by = new Map();
  for (const s of Object.values((data && data.suppliers) || {})) by.set(keyOf(s.name), { ...s, products: 0, set: hasTerms(s) });
  for (const r of Object.values(resolved)) {
    const k = keyOf(r.name);
    if (!by.has(k)) by.set(k, { name: r.name, leadDays: null, moq: null, pack: null, products: 0, set: false });
    by.get(k).products++;
  }
  return [...by.values()].sort((a, b) => b.products - a.products || a.name.localeCompare(b.name));
}

/* ---------- CSV ---------- */
const SUP_HEAD = ['Supplier', 'Lead time (days)', 'MOQ (units)', 'Case pack (units)'];
const MAP_HEAD = ['SKU', 'Variant ID', 'Product', 'Supplier', 'From'];
const supLines = (list) => [SUP_HEAD, ...list.map((s) => [s.name, s.leadDays ?? '', s.moq ?? '', s.pack ?? ''])];
/** The SKU map as a sheet: every variant, its supplier and where that comes from ("set here" or "Shopify vendor"). */
function mapLines(products, resolved) {
  return [MAP_HEAD, ...products.map((p) => {
    const r = resolved[String(p.id)];
    return [p.sku || '', String(p.id), p.name || '', r ? r.name : '', r ? (r.from === 'map' ? 'set here' : 'Shopify vendor') : ''];
  })];
}

/** Header index for the first matching alias, case and spacing ignored. */
function col(head, aliases) {
  const h = head.map((x) => String(x).toLowerCase().replace(/\(.*?\)/g, '').replace(/[_\s]+/g, ' ').trim());
  for (const a of aliases) { const i = h.indexOf(a); if (i >= 0) return i; }
  return -1;
}
function table(text) {
  const t = String(text || '');
  const rows = parseCsv(t, sniffDelimiter(t));
  if (!rows.length) return { error: 'The file is empty' };
  return { head: rows[0], body: rows.slice(1) };
}
/** Supplier table CSV → { ok, rows: [terms], skipped: [{ line, error }] } or { ok: false, error } (no Supplier column). */
function parseSuppliers(text) {
  const t = table(text); if (t.error) return { ok: false, error: t.error };
  const c = { name: col(t.head, ['supplier', 'vendor', 'name']), leadDays: col(t.head, ['lead time', 'lead days', 'lead']), moq: col(t.head, ['moq', 'minimum order', 'min order']), pack: col(t.head, ['case pack', 'pack', 'case', 'pack size']) };
  if (c.name < 0) return { ok: false, error: 'The file needs a Supplier column (header row: Supplier, Lead time (days), MOQ (units), Case pack (units))' };
  const rows = [], skipped = [];
  t.body.forEach((cells, i) => {
    const v = validate({ name: cells[c.name], leadDays: c.leadDays >= 0 ? cells[c.leadDays] : '', moq: c.moq >= 0 ? cells[c.moq] : '', pack: c.pack >= 0 ? cells[c.pack] : '' });
    if (v.ok) rows.push(v.value); else skipped.push({ line: i + 2, error: v.error });
  });
  return { ok: true, rows, skipped };
}
/** SKU map CSV → { ok, rows: [{ sku, supplier }], skipped } (SKU, else Variant ID; blank Supplier = back to the Shopify vendor). */
function parseMap(text) {
  const t = table(text); if (t.error) return { ok: false, error: t.error };
  const c = { sku: col(t.head, ['sku']), id: col(t.head, ['variant id', 'variant', 'id']), sup: col(t.head, ['supplier', 'vendor']) };
  if (c.sup < 0 || (c.sku < 0 && c.id < 0)) return { ok: false, error: 'The file needs a SKU (or Variant ID) column and a Supplier column' };
  const rows = [], skipped = [];
  t.body.forEach((cells, i) => {
    const sku = cleanSku(c.sku >= 0 ? cells[c.sku] : '') || cleanSku(c.id >= 0 ? cells[c.id] : '');
    if (!sku) { skipped.push({ line: i + 2, error: 'no SKU or variant ID' }); return; }
    rows.push({ sku, supplier: cleanName(cells[c.sup]) });
  });
  return { ok: true, rows, skipped };
}

module.exports = {
  NAME_MAX, MAX_SUPPLIERS, MAX_MAP, LIMITS, cleanName, cleanSku, keyOf, term, validate, hasTerms, roundOrder, skuMap, resolve, usage,
  SUP_HEAD, MAP_HEAD, supLines, mapLines, parseSuppliers, parseMap,
};
