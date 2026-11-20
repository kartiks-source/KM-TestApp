'use strict';
/*
 * Stock history rebuild (SW-063, LOGIC.md §1c). Shopify has no API for past stock levels, so a newly connected store
 * would only see stock-outs from its first pull on. Shopify does keep a log of every stock change, readable with
 * ShopifyQL (read_reports scope, Admin API 2025-10):
 *
 *   FROM inventory_adjustment_history SHOW inventory_adjustment_change WHERE inventory_state = 'available'
 *   GROUP BY hour, product_variant_id SINCE -Nd UNTIL -Md ORDER BY hour ASC LIMIT 1000
 *
 * Walking that log backwards from the stock we saw on our first pull gives the stock at every earlier hour:
 *   level(t) = stock at our first snapshot − sum of 'available' changes after t (and before the snapshot)
 * Only 'available' matches Shopify's inventoryQuantity ('committed' is stock held for unfulfilled orders).
 * A variant whose rebuilt stock ever goes below 0 is dropped (impossible with selling when out turned off, so the
 * log is incomplete for it) and counted.
 *
 *   rebuild(changes, nowLevels, firstSeenAt, opts)  pure: change log → stock rows (pullStock's shape)
 *   fetchChanges(q, days, opts)                     paged ShopifyQL reads through gql (read-only guard, cost pacing)
 *   run(opts)                                       once per store after the first good pull, or Data → Rebuild
 * Rows are stored with src 'rebuilt', only for times before the store's first live stock read; never fails a pull.
 */
const TZ = require('./tz');

const DAY = 864e5;
const QL_VERSION = '2025-10';   // the version ShopifyQL was checked on (Sammsara, 20 Nov 2026)
const CAP = 1000;               // ShopifyQL returns at most this many rows per query
const WINDOW_DAYS = 7;          // first try: a week per query; a capped window is split in half
const HISTORY_Q = 'query History($q: String!) { shopifyqlQuery(query: $q) { tableData { columns { name } rows } parseErrors } }';

class HistoryError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const rel = (n) => (n <= 0 ? 'today' : `-${n}d`);
const qlFor = (a, b, grain = 'hour') => `FROM inventory_adjustment_history SHOW inventory_adjustment_change WHERE inventory_state = 'available' GROUP BY ${grain}, product_variant_id SINCE ${rel(a)} UNTIL ${rel(b)} ORDER BY ${grain} ASC LIMIT ${CAP}`;

/** A ShopifyQL time ("2026-11-10T14:00:00+05:30", "2026-11-10T14:00:00", "2026-11-10") → ms. No zone = store time. */
function parseTime(v, zone) {
  const s = String(v == null ? '' : v).trim();
  if (/[T ]\d\d:\d\d.*(Z|[+-]\d\d:?\d\d)$/.test(s)) return Date.parse(s.replace(' ', 'T'));
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d)(?::(\d\d))?(?::(\d\d))?)?$/);
  if (!m) return NaN;
  return TZ.fromLocal(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)), zone);
}

/** tableData → [{ t, variantId, delta }] ('available' only; zero and unreadable rows skipped) + how many raw rows came back. */
function parseTable(td, zone) {
  const cols = ((td && td.columns) || []).map((c) => c && c.name);
  let rows = td && td.rows;
  if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch { rows = []; } }
  if (!Array.isArray(rows)) rows = [];
  const out = [];
  for (const raw of rows) {
    const o = Array.isArray(raw) ? Object.fromEntries(cols.map((c, i) => [c, raw[i]])) : (raw || {});
    if (o.inventory_state != null && o.inventory_state !== 'available') continue;
    const t = parseTime(o.hour != null ? o.hour : o.day, zone);
    const variantId = String(o.product_variant_id == null ? '' : o.product_variant_id).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
    const delta = Number(o.inventory_adjustment_change);
    if (!Number.isFinite(t) || !/^\d+$/.test(variantId) || !Number.isFinite(delta) || !delta) continue;
    out.push({ t, variantId, delta });
  }
  return { changes: out, count: rows.length };
}

/** One ShopifyQL read. Throws HistoryError on parse errors or a missing table. */
async function one(q, ql, zone) {
  const d = await q(HISTORY_Q, { q: ql });
  const r = d && d.shopifyqlQuery;
  const pe = r && r.parseErrors;
  if (Array.isArray(pe) ? pe.length : pe) throw new HistoryError('parse', `Shopify didn’t accept the change-log query (${[].concat(pe).map((x) => (x && x.message) || x).join('; ').slice(0, 160)})`);
  if (!r || !r.tableData) throw new HistoryError('empty', 'Shopify returned no change-log table');
  return parseTable(r.tableData, zone);
}

/**
 * Every 'available' stock change of the last `days` days (day offsets in the store's time zone, today included).
 * A week per query; a window that comes back with 1,000 rows (the cap) is split in half; a single capped day is
 * read by day instead of by hour; still capped → HistoryError('cap').
 */
async function fetchChanges(q, days, { zone = 'Asia/Kolkata', cap = CAP } = {}) {
  const out = [];
  const todo = [];
  for (let a = days; a >= 0; a -= WINDOW_DAYS) todo.push([a, Math.max(0, a - WINDOW_DAYS + 1)]);
  let calls = 0;
  while (todo.length) {
    const [a, b] = todo.shift();
    calls++;
    const r = await one(q, qlFor(a, b), zone);
    if (r.count < cap) { out.push(...r.changes); continue; }
    if (a > b) { const m = Math.floor((a + b) / 2) + 1; todo.unshift([a, m], [m - 1, b]); continue; }
    calls++;
    const byDay = await one(q, qlFor(a, b, 'day'), zone);
    if (byDay.count >= cap) throw new HistoryError('cap', `more than ${cap} stock changes on one day`);
    out.push(...byDay.changes);
  }
  return { changes: out, calls };
}

/**
 * Pure. changes = [{ t, variantId, delta }]; nowLevels = { variantId: stock at our first snapshot };
 * firstSeenAt = time of that snapshot; opts.since = earliest time to rebuild; opts.meta = { variantId: a stock row
 * (sku, product, variant, price, type, vendor, cost) }. Changes at or after firstSeenAt, or before since, are ignored
 * (a change in the snapshot's own hour counts as before it).
 * → { rows, kept, changed, flat, dropped: [ids], total }. Per variant kept: one row at `since` (stock then, before
 * blank), then one row per hour its stock changed. Flat = no change in the log (stock the same the whole time).
 */
function rebuild(changes, nowLevels, firstSeenAt, { since = firstSeenAt - 60 * DAY, meta = {} } = {}) {
  const by = new Map();
  for (const c of changes || []) {
    const id = String(c.variantId);
    if (!(c.t >= since && c.t < firstSeenAt) || !Object.hasOwn(nowLevels, id)) continue;
    if (!by.has(id)) by.set(id, new Map());
    const m = by.get(id); m.set(c.t, (m.get(c.t) || 0) + Number(c.delta));
  }
  const rows = [], dropped = []; let changed = 0, flat = 0;
  for (const [id, L0] of Object.entries(nowLevels)) {
    const cs = [...(by.get(id) || new Map())].filter(([, d]) => d).sort((a, b) => a[0] - b[0]);
    let L = Number(L0); const steps = [];
    for (let i = cs.length - 1; i >= 0; i--) { const [t, d] = cs[i]; steps.unshift({ t, before: L - d, now: L }); L -= d; }
    if (L < 0 || steps.some((s) => s.before < 0)) { dropped.push(id); continue; }
    const r = meta[id] || {};
    const row = (t, before, now) => ({ t, variantId: id, sku: r.sku || '', product: r.product || '', variant: r.variant || '', before, now, price: Number(r.price) || 0,
      ...(r.type ? { type: r.type } : {}), ...(r.vendor ? { vendor: r.vendor } : {}), ...(r.cost ? { cost: r.cost } : {}) });
    rows.push(row(since, null, L));
    for (const s of steps) rows.push(row(s.t, s.before, s.now));
    if (steps.length) changed++; else flat++;
  }
  return { rows, kept: changed + flat, changed, flat, dropped, total: Object.keys(nowLevels).length };
}

/** The store's first live stock read: its time, and each variant's stock then (Shopify rows at that moment). */
function snapshot(stock) {
  let first = Infinity;
  for (const r of stock) if (r.src !== 'rebuilt' && r.t < first) first = r.t;
  const levels = {}, meta = {};
  if (!Number.isFinite(first)) return { firstSeenAt: null, levels, meta };
  for (const r of stock) {
    if (r.t !== first || r.src !== 'shopify' || r.now == null || !Number.isFinite(Number(r.now))) continue;
    levels[String(r.variantId)] = Number(r.now); meta[String(r.variantId)] = r;
  }
  return { firstSeenAt: first, levels, meta };
}

/** A failure in plain words for the Data page. */
function noteFor(e) {
  const m = String((e && e.message) || e || '');
  if (/lacks a read permission|access denied|read_reports|scope/i.test(m)) return 'Past stock-outs not rebuilt: the Shopify token can’t read reports (needs read_reports). Stock-outs count from the first pull on.';
  if (e && e.code === 'cap') return `Past stock-outs not rebuilt: ${m}, more than Shopify’s change log can return. Stock-outs count from the first pull on.`;
  return `Past stock-outs not rebuilt: ${m.slice(0, 160)}. Stock-outs count from the first pull on.`;
}

/**
 * Rebuild the current store's stock history (call inside scope.run). Never throws: the outcome is saved as
 * store.shopify.history { at, ok, kept, total, dropped, changed, flat, from, until, rows, calls, note } and
 * store.shopify.historyRebuiltAt, and returned. Re-running replaces earlier rebuilt rows.
 */
async function run({ q, now = Date.now(), days = 60 } = {}) {
  const store = require('./store');
  const shopify = require('./shopify');
  const ask = q || ((doc, vars) => shopify.gql(doc, vars, { version: QL_VERSION }));
  const d = store.load();
  const zone = TZ.zoneOf(d.settings);
  const done = (info) => { store.setShopify({ historyRebuiltAt: now, history: { at: now, ...info } }); return { at: now, ...info }; };
  const { firstSeenAt, levels, meta } = snapshot(d.stock);
  if (!firstSeenAt || !Object.keys(levels).length) return done({ ok: false, note: 'Past stock-outs not rebuilt: no Shopify stock read yet to start from.' });
  const since = firstSeenAt - days * DAY;
  let got;
  try { got = await fetchChanges(ask, Math.min(118, Math.ceil((now - since) / DAY)), { zone }); } catch (e) {
    console.warn('history: rebuild skipped:', e.message);
    const prev = d.shopify.history;   // a failed re-run keeps the earlier rebuild (its rows stay) and says why it didn't redo it
    return done(prev && prev.ok ? { ...prev, note: noteFor(e) } : { ok: false, note: noteFor(e) });
  }
  const out = rebuild(got.changes, levels, firstSeenAt, { since, meta });
  store.setRebuilt(out.rows);
  console.log(`history: rebuilt ${out.kept} of ${out.total} variants (${out.dropped.length} dropped, ${got.calls} ShopifyQL calls)`);
  return done({ ok: true, kept: out.kept, total: out.total, changed: out.changed, flat: out.flat, dropped: out.dropped.length,
    from: since, until: firstSeenAt, rows: out.rows.length, calls: got.calls, note: null });
}

module.exports = { HISTORY_Q, QL_VERSION, CAP, qlFor, parseTime, parseTable, fetchChanges, rebuild, snapshot, noteFor, run, HistoryError };
