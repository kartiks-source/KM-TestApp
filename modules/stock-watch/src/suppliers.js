'use strict';
/*
 * Supplier table and SKU → supplier map, per store (SW-040, LOGIC.md §6c). Kept in DATA_DIR/stores/<id>/suppliers.json,
 * as safely as store.json (src/sidefile.js) and carried in every backup (src/backup.js `sideFiles`):
 *   { suppliers: { <name, lower case>: { name, leadDays, moq, pack, demo? } }, map: { <SKU or variant ID>: <supplier name> } }
 * A supplier with no terms is not stored: a Shopify vendor is a supplier already, with the store's lead time and no rounding.
 * `demo: true` marks terms seeded with the demo data; they go when real data arrives (store.endDemo), unless an admin edited them.
 * Rules (rounding, which supplier a variant has) are pure, in src/supplier-rules.js.
 *
 * Routes (writes are admin-only and same-site, like every /api write: server.js gates them before this runs):
 *   GET  /api/suppliers                          the table with product counts
 *   PUT  /api/suppliers        { suppliers }     replace the table (every change in the settings change log)
 *   POST /api/suppliers/map    { items }         set (or with supplier '' remove) SKU → supplier
 *   POST /api/suppliers/import?kind=suppliers|map   CSV body, merged in
 *   GET  /api/export/suppliers.csv?kind=suppliers|map
 */
const { sideFile } = require('./sidefile');
const R = require('./supplier-rules');
const { csvText } = require('./helpers');

const box = sideFile('suppliers.json');
const MAX_ITEMS = 5000;

/** The file, with both parts present. Throws when suppliers.json is unreadable and there is no good .bak. */
function all() {
  const d = box.read();
  if (!d.suppliers || typeof d.suppliers !== 'object' || Array.isArray(d.suppliers)) d.suppliers = {};
  if (!d.map || typeof d.map !== 'object' || Array.isArray(d.map)) d.map = {};
  return d;
}
const save = () => box.write();
const termsText = (s) => (s ? [s.leadDays != null ? `lead ${s.leadDays} d` : '', s.moq != null ? `MOQ ${s.moq}` : '', s.pack != null ? `case ${s.pack}` : ''].filter(Boolean).join(' · ') || null : null);

/** Replace the whole table with `list` (validated). Returns { ok, changes } or { ok: false, error }. */
function replace(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'suppliers must be a list' };
  if (list.length > R.MAX_SUPPLIERS) return { ok: false, error: `At most ${R.MAX_SUPPLIERS} suppliers` };
  const next = {};
  for (const s of list) {
    const v = R.validate(s); if (!v.ok) return v;
    const k = R.keyOf(v.value.name);
    if (Object.hasOwn(next, k)) return { ok: false, error: `${v.value.name} is listed twice` };
    if (R.hasTerms(v.value)) next[k] = v.value;
  }
  return commit(next);
}
/** Merge rows into the table (CSV import): a row with every term blank removes that supplier's terms. */
function merge(rows) {
  const next = { ...all().suppliers };
  for (const v of rows) { const k = R.keyOf(v.name); if (R.hasTerms(v)) next[k] = v; else delete next[k]; }
  if (Object.keys(next).length > R.MAX_SUPPLIERS) return { ok: false, error: `At most ${R.MAX_SUPPLIERS} suppliers` };
  return commit(next);
}
function commit(next) {
  const d = all(), changes = [];
  for (const k of new Set([...Object.keys(d.suppliers), ...Object.keys(next)])) {
    const a = termsText(d.suppliers[k]), b = termsText(next[k]);
    if (a !== b) changes.push({ key: `Supplier ${(next[k] || d.suppliers[k]).name}`, old: a, new: b });
    else if (next[k] && d.suppliers[k] && d.suppliers[k].demo && !next[k].demo && next[k].name === d.suppliers[k].name) next[k] = { ...next[k], demo: true };   // untouched seeded terms stay demo
  }
  d.suppliers = next; save();
  return { ok: true, changes };
}

/** Set or remove SKU → supplier lines: [{ sku, supplier }]; supplier '' = back to the Shopify vendor. */
function setMap(items) {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'Nothing to set' };
  if (items.length > MAX_ITEMS) return { ok: false, error: `At most ${MAX_ITEMS} lines at a time` };
  const d = all(), next = { ...d.map };
  let set = 0, removed = 0;
  for (const it of items) {
    const sku = R.cleanSku(it && it.sku);
    if (!sku || sku === '__proto__') return { ok: false, error: 'Each line needs a SKU or variant ID' };
    const name = R.cleanName(it.supplier);
    if (name) { next[sku] = name; set++; } else if (Object.hasOwn(next, sku)) { delete next[sku]; removed++; }
  }
  if (Object.keys(next).length > R.MAX_MAP) return { ok: false, error: `At most ${R.MAX_MAP.toLocaleString('en-IN')} SKUs mapped` };
  d.map = next; save();
  return { ok: true, set, removed, changes: set || removed ? [{ key: 'Supplier map', old: null, new: `${set} set, ${removed} back to vendor` }] : [] };
}

/** The demo's suppliers (src/demo.js), only when the store has none: they show what lead time, MOQ and case packs do. */
function seedDemo(list) {
  const d = all();
  if (Object.keys(d.suppliers).length) return false;
  for (const s of list) { const v = R.validate(s); if (v.ok) d.suppliers[R.keyOf(v.value.name)] = { ...v.value, demo: true }; }
  save();
  return true;
}
/** Real data arrived: seeded demo terms go (an admin's edits stay). Writes only when something changes. */
function clearDemo() {
  const d = all(); let n = 0;
  for (const [k, s] of Object.entries(d.suppliers)) if (s && s.demo) { delete d.suppliers[k]; n++; }
  if (n) save();
  return n;
}
function clear() { box.write({ suppliers: {}, map: {} }); }

const json = (b) => { try { const j = JSON.parse(b || '{}'); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };
const bad = (error) => ({ code: 400, body: { ok: false, error } });
/**
 * HTTP. ctx: { resolved() → resolve() for this store, products() → [{ id, sku, name }], log(changes), fileName(kind) }.
 * Returns { code, body, type?, headers? } or null when the path isn't ours.
 */
async function handle(req, url, readBody, ctx) {
  const p = url.pathname, m = req.method;
  if (p === '/api/suppliers' && m === 'GET') {
    /* M11: count only the products the page lists (active, tracked), not every archived / draft variant in the catalog */
    const ids = new Set(ctx.products().map((x) => String(x.id)));
    const res = Object.fromEntries(Object.entries(ctx.resolved()).filter(([id]) => ids.has(String(id)))), list = R.usage(res, all());
    const n = ids.size, assigned = Object.keys(res).length;
    return { code: 200, body: { ok: true, suppliers: list, mapped: Object.keys(all().map).length, products: n, unassigned: Math.max(0, n - assigned), limits: R.LIMITS } };
  }
  if (p === '/api/suppliers' && m === 'PUT') {
    const b = json(await readBody(req, 256e3)); if (!b) return bad('Body must be a JSON object');
    const r = replace(b.suppliers); if (!r.ok) return bad(r.error);
    ctx.log(r.changes);
    return { code: 200, body: { ok: true, changed: r.changes.length } };
  }
  if (p === '/api/suppliers/map' && m === 'POST') {
    const b = json(await readBody(req, 512e3)); if (!b) return bad('Body must be a JSON object');
    const r = setMap(b.items); if (!r.ok) return bad(r.error);
    ctx.log(r.changes);
    return { code: 200, body: { ok: true, set: r.set, removed: r.removed } };
  }
  if (p === '/api/suppliers/import' && m === 'POST') {
    const kind = url.searchParams.get('kind') === 'map' ? 'map' : 'suppliers';
    const parsed = kind === 'map' ? R.parseMap(await readBody(req, 4e6)) : R.parseSuppliers(await readBody(req, 1e6));
    if (!parsed.ok) return bad(parsed.error);
    if (!parsed.rows.length) return bad(`No rows read${parsed.skipped.length ? ` (${parsed.skipped.length} skipped: ${parsed.skipped[0].error}, line ${parsed.skipped[0].line})` : ''}`);
    const r = kind === 'map' ? setMap(parsed.rows) : merge(parsed.rows);
    if (!r.ok) return bad(r.error);
    ctx.log(r.changes);
    return { code: 200, body: { ok: true, kind, read: parsed.rows.length, skipped: parsed.skipped.length, skips: parsed.skipped.slice(0, 5) } };
  }
  if (p === '/api/export/suppliers.csv' && m === 'GET') {
    const kind = url.searchParams.get('kind') === 'map' ? 'map' : 'suppliers';
    const lines = kind === 'map' ? R.mapLines(ctx.products(), ctx.resolved()) : R.supLines(R.usage(ctx.resolved(), all()));
    return { code: 200, body: csvText(lines), type: 'text/csv; charset=utf-8', headers: { 'content-disposition': `attachment; filename="${ctx.fileName(kind)}"` } };
  }
  if (p === '/api/suppliers' || p === '/api/suppliers/map' || p === '/api/suppliers/import') return { code: 405, body: { ok: false, error: 'Method not allowed' } };
  return null;
}

module.exports = { all, replace, merge, setMap, seedDemo, clearDemo, clear, handle, reset: box.reset, FILE_NAME: box.name };
