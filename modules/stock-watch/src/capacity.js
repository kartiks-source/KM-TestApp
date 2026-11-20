'use strict';
/*
 * Capacity warnings (SW-055): early notice, at half of ADR-0003's move trigger, before the JSON file store gets slow,
 * and before the volume fills. Shown on /status (codes + plain words, no names) and on the Data page (this store).
 * Rules: LOGIC.md §14a.
 */
const fs = require('node:fs');

const MB = 1024 * 1024;
const LIMITS = { storeBytes: 25 * MB, rows: 150000, diskUsed: 0.8 };

/** Share of the volume in use (0–1), or null when the platform can't tell. */
function diskUsed(dir) {
  try {
    const s = fs.statfsSync(dir);
    const total = Number(s.blocks) * Number(s.bsize), free = Number(s.bavail) * Number(s.bsize);
    return total > 0 ? Math.min(1, Math.max(0, 1 - free / total)) : null;
  } catch { return null; }
}

/** Warnings for one store's numbers (bytes of store.json, stock + order rows) and the disk. → [{ code, text }] */
function warnings({ storeBytes = 0, rows = 0, disk = null } = {}) {
  const out = [];
  if (storeBytes > LIMITS.storeBytes) out.push({ code: 'store-size', text: `Data file is ${Math.round(storeBytes / MB)} MB (over 25 MB): pages slow down past 50 MB. Plan the storage move (ADR-0003).` });
  if (rows > LIMITS.rows) out.push({ code: 'rows', text: `${rows.toLocaleString('en-IN')} rows kept (over 1,50,000): pages slow down past 3,00,000. Plan the storage move (ADR-0003).` });
  if (disk != null && disk > LIMITS.diskUsed) out.push({ code: 'disk', text: `Disk ${Math.round(disk * 100)}% full (over 80%): grow the volume or delete old backups before saving fails.` });
  return out;
}

module.exports = { warnings, diskUsed, LIMITS };
