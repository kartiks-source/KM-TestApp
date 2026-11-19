'use strict';
/*
 * Storage: one JSON file per store (DATA_DIR/store.json). Fine for a demo and for one
 * store with a few months of data; when to move is in docs/adr/0003.
 *
 * Safety (SW-004): only a missing file starts blank; a file that can't be read is quarantined and
 * never overwritten; writes are fsynced before the rename; the previous good file is kept as
 * store.json.bak; a failed write is retried and reported by health().
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stockKey, orderKey } = require('./rows');
const { DEFAULT_SETTINGS } = require('./engine');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');
const BAK = FILE + '.bak';
const KEEP_DAYS = 120;
const RETRY_MS = [5e3, 30e3, 120e3];   // a failed save is tried again after 5 s, 30 s, then every 2 min

let db = null;
let saveTimer = null;
let loadError = null;
let saveTries = 0;
let lastSaveError = null;
let lastSaveAt = null;

const blankShopify = () => ({ lastQty: {}, ordersCursor: null, lastSync: null, lastError: null, lastTry: null });

function blank() {
  return { settings: { ...DEFAULT_SETTINGS, ingestKey: crypto.randomBytes(16).toString('hex'), sheetStockCsv: '', sheetOrderCsv: '' },
    stock: [], orders: [], catalog: {}, source: 'empty', lastSync: null, lastSyncError: null, shopify: blankShopify() };
}

/** Thrown when store.json exists but can't be read and there's no good backup. The server exits on it. */
class StoreLoadError extends Error {}

/** Read and parse one store file; null when it doesn't exist. Any other problem throws. */
function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const j = JSON.parse(raw);
  if (!j || typeof j !== 'object' || !Array.isArray(j.stock) || !Array.isArray(j.orders)) throw new Error('not a Stock-out Watch store');
  return j;
}

/*
 * Only a missing file gives a blank store. A file that can't be read or parsed is copied aside
 * (store.json.corrupt-<time>) and left as it is; the last good save (store.json.bak) is used
 * instead. With no good backup, load() throws StoreLoadError and nothing is ever written.
 */
function load() {
  if (db) return db;
  if (loadError) throw loadError;
  let data;
  try { data = readJson(FILE) || blank(); } catch (e) {
    const aside = `${FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.copyFileSync(FILE, aside); } catch { /* unreadable: it stays where it is, untouched */ }
    let bak = null;
    try { bak = readJson(BAK); } catch { /* the backup is bad too */ }
    if (!bak) {
      loadError = new StoreLoadError(`store.json can't be read (${e.message}) and there is no good store.json.bak; copied to ${path.basename(aside)}. Not starting, so nothing is overwritten.`);
      throw loadError;
    }
    console.error(`store: store.json can't be read (${e.message}); copied to ${path.basename(aside)} and loaded store.json.bak instead.`);
    data = bak;
  }
  db = data;
  db.settings = { ...blank().settings, ...db.settings };
  db.shopify = { ...blankShopify(), ...db.shopify };
  if (!db.catalog || typeof db.catalog !== 'object') db.catalog = {};
  if (!db.settings.ingestKey) db.settings.ingestKey = crypto.randomBytes(16).toString('hex');
  if (db.source === 'live') db.everLive = true;   // stores saved before everLive existed
  db._stockKeys = new Set(db.stock.map(stockKey));
  db._orderKeys = new Set(db.orders.map(orderKey));
  return db;
}

/*
 * Demo data never mixes with real data (SW-007): the first real rows to arrive (Flow, Sheet, CSV,
 * Shopify) clear the demo first. everLive is kept for good, so demo data never comes back at start-up.
 */
function goLive(d, rows) {
  if (!rows.length) return;
  if (d.source === 'demo') {
    d.stock = []; d.orders = []; d._stockKeys = new Set(); d._orderKeys = new Set(); d.shopify = blankShopify();
    console.log('store: real data arrived, demo data cleared');
  }
  if (d.source !== 'live') d.source = 'live';
  d.everLive = true;
}

/* ---------- saving: temp file, fsync, rename; the file it replaces stays as store.json.bak ---------- */
function writeNow() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { _stockKeys, _orderKeys, ...plain } = db;
  const tmp = FILE + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(plain)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(FILE)) {   // keep the last good save: a hard link costs nothing; a copy where links aren't allowed
    try { fs.rmSync(BAK, { force: true }); fs.linkSync(FILE, BAK); } catch { try { fs.copyFileSync(FILE, BAK); } catch { /* best effort */ } }
  }
  fs.renameSync(tmp, FILE);
  try { const dir = fs.openSync(DATA_DIR, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* not every OS can fsync a folder */ }
}

/** Write the store (now, or batched after 500 ms). Never throws: a failed write is kept in health().lastSaveError and retried. */
function save(now = false) {
  clearTimeout(saveTimer); saveTimer = null;
  if (!db) return true;
  const attempt = () => {
    saveTimer = null;
    try {
      writeNow();
      if (lastSaveError) console.log('store: saved again after an earlier failure');
      lastSaveError = null; saveTries = 0; lastSaveAt = Date.now();
      return true;
    } catch (e) {
      if (!lastSaveError || lastSaveError.message !== e.message) console.error('store: save failed:', e.message);
      lastSaveError = { message: e.message, at: Date.now() };
      saveTimer = setTimeout(attempt, RETRY_MS[Math.min(saveTries++, RETRY_MS.length - 1)]);
      saveTimer.unref?.();
      return false;
    }
  };
  if (now) return attempt();
  saveTimer = setTimeout(attempt, 500);
  saveTimer.unref?.();
  return true;
}

/** For /health and /status: ok = the store loaded and the last write worked. */
function health() {
  return { ok: !loadError && !!db && !lastSaveError, loaded: !!db, loadError: loadError ? loadError.message : null,
    lastSaveError, lastSaveAt, pendingSave: !!saveTimer };
}

/** Where a row came from (SW-006): shopify, flow, sheet, csv or demo. Stored on every row as `src`. */
const SOURCES = ['shopify', 'flow', 'sheet', 'csv', 'demo'];
const stamp = (rows, src) => { if (src) for (const r of rows) if (!r.src) r.src = src; return rows; };

/** Add rows from `src`, skipping ones already stored. Returns how many were new. */
function add(kind, rows, src) {
  const d = load();
  stamp(rows, src);
  goLive(d, rows);
  const list = kind === 'stock' ? d.stock : d.orders;
  const keys = kind === 'stock' ? d._stockKeys : d._orderKeys;
  const keyOf = kind === 'stock' ? stockKey : orderKey;
  let n = 0;
  for (const r of rows) { const k = keyOf(r); if (keys.has(k)) continue; keys.add(k); list.push(r); n++; }
  if (n) prune();
  if (rows.length) save();
  return n;
}

/*
 * Retention (SW-002, ADR-0010): order lines and stock changes older than KEEP_DAYS are dropped,
 * except, per variant, the newest stock row (its stock now, even if it hasn't moved in months) and
 * the row that opened a stock-out still running. A variant deleted from Shopify more than KEEP_DAYS
 * ago loses all its old rows and its catalog entry.
 */
function pruneStock(rows, cut, catalog = {}) {
  if (!rows.some((r) => r.t < cut)) return rows;
  const gone = (id) => { const c = catalog[id]; return !!c && c.status === 'DELETED' && c.inactiveSince < cut; };
  const by = new Map();
  for (const r of rows) { const id = String(r.variantId); if (!by.has(id)) by.set(id, []); by.get(id).push(r); }
  const keep = new Set();
  for (const [id, list] of by) {
    if (gone(id)) continue;
    list.sort((a, b) => a.t - b.t);
    let i = list.length - 1; keep.add(list[i]);
    if (Number(list[i].now) <= 0) { while (i > 0 && Number(list[i - 1].now) <= 0) i--; keep.add(list[i]); }   // the stock-out's first row
  }
  return rows.filter((r) => r.t >= cut || keep.has(r));
}

let lastPrune = 0;
/** Runs at most once an hour (it walks every row), or now with force. */
function prune(force = false, now = Date.now()) {
  if (!force && now - lastPrune < 3600e3) return;
  lastPrune = now;
  const cut = now - KEEP_DAYS * 864e5;
  const d = load();
  const stock = pruneStock(d.stock, cut, d.catalog);
  if (stock.length !== d.stock.length) { d.stock = stock; d._stockKeys = new Set(d.stock.map(stockKey)); }
  if (d.orders.some((r) => r.t < cut)) { d.orders = d.orders.filter((r) => r.t >= cut); d._orderKeys = new Set(d.orders.map(orderKey)); }
  if (d.catalog) for (const [id, c] of Object.entries(d.catalog)) if (c.status === 'DELETED' && c.inactiveSince < cut) delete d.catalog[id];
}

/*
 * The current-stock snapshot (SW-002, ADR-0010): every variant Shopify returned on this pull, with
 * its stock now, price, cost, type, tags and status, replaced whole on each pull. Engine reads stock
 * and attributes from here; stock rows are history only. A variant that turns inactive (archived,
 * draft, untracked) keeps the time it was first seen inactive; one that disappears (deleted) is kept
 * as a DELETED entry, and so is any variant with stock rows that Shopify no longer returns.
 */
function setCatalog(next, now = Date.now()) {
  const d = load(); const prev = d.catalog || {}; const out = {};
  for (const [id, c] of Object.entries(next)) {
    const p = prev[id];
    out[id] = c.active !== false ? c : { ...c, inactiveSince: p && p.active === false && p.status !== 'DELETED' && p.inactiveSince ? p.inactiveSince : now };
  }
  const tomb = (id, base) => { out[id] = { ...base, active: false, status: 'DELETED', inactiveSince: base.status === 'DELETED' && base.inactiveSince ? base.inactiveSince : now, stock: base.stock ?? null }; };
  for (const [id, p] of Object.entries(prev)) if (!out[id]) tomb(id, p);
  for (const r of d.stock) { const id = String(r.variantId); if (!out[id]) tomb(id, { product: r.product, variant: r.variant, sku: r.sku, stock: null, seenAt: r.t }); }
  d.catalog = out;
  save();
  return out;
}

/** Replace every line of these orders with `rows` (a cancelled or fully refunded order ends up with none). */
function replaceOrders(names, rows, src = 'shopify') {
  const d = load(); const set = new Set(names);
  stamp(rows, src);
  goLive(d, rows);
  const before = d.orders.length;
  d.orders = d.orders.filter((r) => !set.has(r.order)).concat(rows);
  d._orderKeys = new Set(d.orders.map(orderKey));
  prune(); save();
  return { added: rows.length, removed: before - (d.orders.length - rows.length) };
}

function replaceAll(stock, orders, source) {
  const d = load();
  if (source === 'demo') { stamp(stock, 'demo'); stamp(orders, 'demo'); }
  d.stock = stock; d.orders = orders; d.source = source;
  d._stockKeys = new Set(stock.map(stockKey)); d._orderKeys = new Set(orders.map(orderKey));
  d.shopify = blankShopify();   // re-read everything from Shopify on the next pull
  d.catalog = {};
  save(true);
}

function setSettings(patch) {
  const d = load();
  d.settings = { ...d.settings, ...patch };
  save(true);
  return d.settings;
}

function setSync(info) { Object.assign(load(), info); save(); }

function setShopify(patch) { const d = load(); d.shopify = { ...d.shopify, ...patch }; save(); return d.shopify; }

module.exports = { SOURCES, load, add, setCatalog, prune, pruneStock, replaceAll, replaceOrders, setSettings, setSync, setShopify, save, health, StoreLoadError, FILE, BAK, DATA_DIR, KEEP_DAYS };
