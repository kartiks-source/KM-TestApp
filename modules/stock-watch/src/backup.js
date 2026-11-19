'use strict';
/*
 * Backups of the store (SW-005). store.json holds stock-out history that Shopify can't resend, so:
 *
 *   DATA_DIR/backups/store-YYYYMMDD.json              one a day (store's local date), checked hourly
 *   DATA_DIR/backups/store-YYYYMMDD-HHMMSS-<why>.json  before every replaceAll (Clear, demo → live,
 *                                                     import replacing demo, demo reload) and before a restore
 *
 * The newest 14 of each kind are kept. Demo data and an empty store are never backed up: there's
 * nothing to lose, and demo reloads would push real snapshots out of the 14.
 * GET /api/export/backup.json (login needed) downloads the store as it is now.
 * Restore: copy a backup to DATA_DIR/restore.json and restart; see docs/RUNBOOK.md.
 *
 * Wiring: server.js calls start() first thing at startup (before anything loads the store) and
 * route() inside the logged-in part of the API.
 */
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA_DIR, 'backups');
const FILE = path.join(DATA_DIR, 'store.json');
const RESTORE = path.join(DATA_DIR, 'restore.json');
const KEEP = 14;
const DAILY = /^store-\d{8}\.json$/;
const EVENT = /^store-\d{8}-\d{6}-[a-z0-9-]+\.json$/;

/** The store as JSON, without the in-memory dedupe indexes (top-level keys starting with "_"). */
function text() {
  const d = store.load();
  return JSON.stringify(d, function (k, v) { return this === d && k.startsWith('_') ? undefined : v; });
}
const worthKeeping = (d) => d.source !== 'demo' && (d.stock.length || d.orders.length);

/** Write via a temp file, fsync, rename: a crash leaves the old file or the new one, never half of one. */
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

/** Local date/time stamps at the store's time-zone offset (minutes). */
function stamp(t, offMin) {
  const iso = new Date(t + (offMin || 0) * 60e3).toISOString();
  return { day: iso.slice(0, 10).replace(/-/g, ''), time: iso.slice(11, 19).replace(/:/g, '') };
}

/** Keep the newest KEEP of each kind (names sort by time). */
function rotate() {
  let names; try { names = fs.readdirSync(DIR); } catch { return; }
  for (const re of [DAILY, EVENT]) {
    const old = names.filter((n) => re.test(n)).sort().reverse().slice(KEEP);
    for (const n of old) { try { fs.unlinkSync(path.join(DIR, n)); } catch { /* already gone */ } }
  }
}

/** Snapshot now, labelled `why` (e.g. "before-clear"). Returns the file written, or null if nothing to keep. */
function snapshot(why, now = Date.now()) {
  const d = store.load();
  if (!worthKeeping(d)) return null;
  const s = stamp(now, d.settings.tzOffsetMin);
  const file = path.join(DIR, `store-${s.day}-${s.time}-${String(why).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}.json`);
  writeAtomic(file, text());
  rotate();
  console.log(`backup: ${path.basename(file)} (${d.stock.length} stock rows, ${d.orders.length} order lines)`);
  return file;
}

/** Today's daily backup, if it isn't there yet. Returns the file written, or null. */
function daily(now = Date.now()) {
  const d = store.load();
  if (!worthKeeping(d)) return null;
  const file = path.join(DIR, `store-${stamp(now, d.settings.tzOffsetMin).day}.json`);
  if (fs.existsSync(file)) return null;
  writeAtomic(file, text());
  rotate();
  console.log(`backup: daily ${path.basename(file)}`);
  return file;
}

/**
 * Restore on boot: if DATA_DIR/restore.json exists and looks like a store, the current store.json is
 * kept as a "before-restore" backup and restore.json takes its place. A file that isn't a store is
 * renamed restore.json.rejected-<time> and the current store stays. Must run before store.load().
 */
function restorePending(now = Date.now()) {
  if (!fs.existsSync(RESTORE)) return null;
  let ok = false, off = 330;
  try {
    const d = JSON.parse(fs.readFileSync(RESTORE, 'utf8'));
    ok = !!d && Array.isArray(d.stock) && Array.isArray(d.orders) && !!d.settings && typeof d.settings === 'object';
    if (ok && Number.isFinite(d.settings.tzOffsetMin)) off = d.settings.tzOffsetMin;
  } catch { ok = false; }
  if (!ok) {
    const bad = `${RESTORE}.rejected-${now}`;
    fs.renameSync(RESTORE, bad);
    console.error(`restore: ${path.basename(bad)} is not a Stock-out Watch store (needs stock, orders, settings); kept the current store`);
    return { restored: false, rejected: bad };
  }
  let kept = null;
  if (fs.existsSync(FILE)) {
    const s = stamp(now, off);
    kept = path.join(DIR, `store-${s.day}-${s.time}-before-restore.json`);
    fs.mkdirSync(DIR, { recursive: true });
    fs.copyFileSync(FILE, kept);
  }
  fs.renameSync(RESTORE, FILE);
  rotate();
  console.log(`restore: store.json replaced from restore.json${kept ? `; previous store kept as backups/${path.basename(kept)}` : ''}`);
  return { restored: true, kept };
}

let started = false;
/** Startup: apply a pending restore, snapshot before every replaceAll, daily backup now and hourly. */
function start({ everyMs = 60 * 60e3 } = {}) {
  if (started) return; started = true;
  try { restorePending(); } catch (e) { console.error('restore failed:', e.message); }
  const replaceAll = store.replaceAll;
  store.replaceAll = function (stock, orders, source) {
    try { snapshot(`before-${source === 'demo' ? 'demo' : 'clear'}`); } catch (e) { console.error('backup before replace failed:', e.message); }
    return replaceAll.apply(this, arguments);
  };
  const tick = () => { try { daily(); } catch (e) { console.error('daily backup failed:', e.message); } };
  tick();
  setInterval(tick, everyMs).unref();
}

/** GET /api/export/backup.json (call only after the login check). Returns true when it answered. */
function route(req, res, url) {
  if (url.pathname !== '/api/export/backup.json' || req.method !== 'GET') return false;
  const s = stamp(Date.now(), store.load().settings.tzOffsetMin);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="stock-watch-store-${s.day}-${s.time}.json"` });
  res.end(text());
  return true;
}

module.exports = { start, route, snapshot, daily, rotate, restorePending, text, DIR, KEEP };
