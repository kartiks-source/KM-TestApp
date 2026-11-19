'use strict';
/*
 * Sync progress and run history (SW-030, LOGIC.md §14).
 * A run is one Shopify pull or one Google Sheet sync. While a run is going, its live counts feed the
 * "Syncing · 2,340 orders" pill; when it ends, one entry is kept in the store (store.json → syncRuns):
 *   { kind, start, ms, stock, orders, lines, error, notes }
 * Newest first, at most MAX. Pure helpers on plain objects; the caller saves.
 */

const MAX = 20;

/** A new run, counting from zero. kind: 'shopify' | 'sheet'. */
const begin = (kind, now = Date.now()) => ({ kind, start: now, phase: 'stock', stock: 0, orders: 0, lines: 0, notes: [] });

/** What the pill and status card show while a run is going (null when none). */
const progress = (run) => (run ? { kind: run.kind, start: run.start, phase: run.phase, stock: run.stock, orders: run.orders, lines: run.lines } : null);

/** Notes for variants the stock pull leaves out on purpose (not active = archived or draft; stock not tracked). */
function stockNotes(excluded) {
  const out = [];
  const n = (x) => Number(x) || 0;
  if (n(excluded && excluded.notActive)) out.push(`${n(excluded.notActive)} archived or draft variant${n(excluded.notActive) === 1 ? '' : 's'} left out`);
  if (n(excluded && excluded.untracked)) out.push(`${n(excluded.untracked)} variant${n(excluded.untracked) === 1 ? '' : 's'} with stock not tracked left out`);
  return out;
}

/** End a run and add it to the store's history. Returns the entry. A run that failed part-way keeps what it had counted. */
function finish(db, run, error = null, now = Date.now()) {
  const entry = { kind: run.kind, start: run.start, ms: Math.max(0, now - run.start), stock: run.stock, orders: run.orders, lines: run.lines,
    error: error ? String(error).slice(0, 300) : null, notes: run.notes.slice(0, 5) };
  db.syncRuns = [entry, ...(Array.isArray(db.syncRuns) ? db.syncRuns : [])].slice(0, MAX);
  return entry;
}

/** The kept runs, newest first. */
const list = (db) => (Array.isArray(db.syncRuns) ? db.syncRuns.slice(0, MAX) : []);

module.exports = { MAX, begin, progress, stockNotes, finish, list };
