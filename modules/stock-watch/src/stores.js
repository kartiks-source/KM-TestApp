'use strict';
/*
 * The store registry (multi-store, ADR-0015): which stores this app shows, by id and name.
 *
 *   Performity POC API (tokenapi)  every brand our key may use: GET …/brands → [{ brand_id, brand_name }].
 *                                  Store id = the brand_id (lower case); name = brand_name; shop = from its
 *                                  last fresh-token. PERFORMITY_BRAND_ID (optional) limits it to that brand.
 *                                  The last good list is kept (memory + DATA_DIR/stores.json): when the API
 *                                  is down, the stores stay and their pulls fail with the reason.
 *   Azure Key Vault (vault)        STORES=<handle>,<handle>,… (else SHOPIFY_STORE); id = name = the handle.
 *   Railway variables (variables)  one store: SHOPIFY_STORE.
 *   no key (demo)                  two demo stores, clearly labelled: demo.STORES.
 *
 * Store ids end up in folder names and URLs, so only ids that pass scope.validId() are ever listed,
 * and a request for any id not in the list is a 404 (server.js).
 */
const fs = require('node:fs');
const path = require('node:path');
const scope = require('./scope');
const keys = require('./keys');
const demo = require('./demo');
const { writeAtomic } = require('./sidefile');

let known = null;          // tokenapi: last good list [{ id, name, shop }]
let lastError = null;      // tokenapi: why the last refresh failed (null = it worked)
let refreshedAt = 0;
const cacheFile = () => path.join(scope.root(), 'stores.json');

/** 'tokenapi' | 'vault' | 'variables' | 'demo' (no key set). */
const mode = () => keys.status().source || 'demo';
const pin = () => String(process.env.PERFORMITY_BRAND_ID || '').trim().toLowerCase();

function readCache() {
  if (known) return known;
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    known = (Array.isArray(j.list) ? j.list : []).filter((s) => s && scope.validId(s.id)).map((s) => ({ id: s.id, name: String(s.name || ''), shop: String(s.shop || '') }));
  } catch { known = []; }
  return known;
}
function writeCache() {
  try { writeAtomic(cacheFile(), JSON.stringify({ list: known, at: Date.now() }), false); } catch (e) { console.warn('stores: list not saved:', e.message); }
}

/** The stores, in order (the first is the default). Never throws, never calls the network. */
function list() {
  const m = mode();
  if (m === 'demo') return demo.STORES.map((s) => ({ id: s.id, name: s.name, demo: true }));
  if (m === 'variables') { const st = keys.status().store; return scope.validId(st) ? [{ id: st, name: st }] : []; }
  if (m === 'vault') return keys.vaultStores().filter(scope.validId).map((id) => ({ id, name: id }));
  const all = readCache().map((s) => ({ ...s, shop: keys.shopOf(s.id) || s.shop }));
  const want = pin();
  if (!want) return all;
  const hit = all.find((s) => s.id === want);
  return hit ? [hit] : scope.validId(want) && !refreshedAt ? [{ id: want, name: 'Store', shop: '' }] : [];   // pinned, list not read yet
}

/** Performity only: read the brand list again (keys.brands caches it 10 minutes). Keeps the last good list on failure. */
async function refresh({ fresh = false } = {}) {
  if (mode() !== 'tokenapi') return list();
  try {
    const b = await keys.brands({ fresh });
    const prev = new Map(readCache().map((s) => [s.id, s]));
    known = b.map((x) => ({ id: x.brand_id.toLowerCase(), name: x.brand_name || 'Store', shop: keys.shopOf(x.brand_id) || prev.get(x.brand_id.toLowerCase())?.shop || '' }))
      .filter((s) => scope.validId(s.id));
    lastError = null; refreshedAt = Date.now();
    writeCache();
  } catch (e) {
    lastError = e.message;
    readCache();
  }
  return list();
}
/** Remember a shop handle learned from a fresh-token, so the list shows it after a restart. */
function noteShop(id, shop) {
  if (mode() !== 'tokenapi' || !shop) return;
  const s = readCache().find((x) => x.id === id);
  if (s && s.shop !== shop) { s.shop = shop; writeCache(); }
}

const get = (id) => list().find((s) => s.id === id) || null;
const has = (id) => !!get(id);
const first = () => list()[0] || null;
/** Registry health for /api/stores: did the last brand-list read work? */
const info = () => ({ mode: mode(), lastError, refreshedAt: refreshedAt || null });

/**
 * Which store a request is for: ?store=<id> (must be listed, else { error: 404 }), else the sw_store cookie
 * when it names a listed store, else the first store. { error: 503 } when there is no store at all.
 */
function pick(asked, cookie) {
  if (asked != null && asked !== '') {
    const id = String(asked).toLowerCase();
    return scope.validId(id) && has(id) ? { id } : { error: 404, message: 'Unknown store' };
  }
  const c = String(cookie || '').toLowerCase();
  if (c && scope.validId(c) && has(c)) return { id: c };
  const f = first();
  if (f) return { id: f.id };
  return { error: 503, message: lastError ? `No store yet: ${lastError}` : 'No store yet: Performity’s brand list hasn’t loaded' };
}

module.exports = { list, refresh, get, has, first, pick, info, mode, noteShop,
  _reset: () => { known = null; lastError = null; refreshedAt = 0; } };
