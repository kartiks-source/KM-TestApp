'use strict';
/*
 * Settings change log (SW-029, LOGIC.md §13). One entry per changed setting:
 *   { at, by, key, old, new }
 * Kept in the store (store.json → settingsLog), newest first, at most MAX entries.
 * Keys are never written: the ingest key shows as "(old key)" → "(new key)".
 * Pure helpers on the store object; the caller saves.
 */

const MAX = 200;
const HIDDEN = new Set(['ingestKey']);
const MASK = { old: '(old key)', new: '(new key)' };

/** Settings in `patch` whose value differs from `before`, as [{ key, old, new }]. Numbers compared as numbers. */
function diff(before, patch) {
  const out = [];
  for (const [key, v] of Object.entries(patch || {})) {
    const was = before ? before[key] : undefined;
    const same = typeof v === 'number' && was != null && String(was).trim() !== '' ? +was === v : was === v;
    if (same) continue;
    out.push(HIDDEN.has(key) ? { key, old: was ? MASK.old : null, new: MASK.new } : { key, old: was === undefined ? null : was, new: v });
  }
  return out;
}

/** Add changes to the store's log. `by` says who (role, and "script" for Basic auth). Returns the entries added. */
function record(db, changes, by, at = Date.now()) {
  if (!changes.length) return [];
  const added = changes.map((c) => ({ at, by: String(by || 'admin'), key: c.key, old: c.old, new: c.new }));
  db.settingsLog = [...added, ...(Array.isArray(db.settingsLog) ? db.settingsLog : [])].slice(0, MAX);
  return added;
}

/** The latest `n` entries, newest first. */
const recent = (db, n = 50) => (Array.isArray(db.settingsLog) ? db.settingsLog.slice(0, n) : []);

/** The newest entry whose key is one of `keys` (e.g. the Plan settings), or null. */
const lastOf = (db, keys) => recent(db, MAX).find((e) => keys.includes(e.key)) || null;

module.exports = { MAX, diff, record, recent, lastOf };
