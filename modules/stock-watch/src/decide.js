'use strict';
/*
 * Slow-seller decisions (SW-032, LOGIC.md §13d). Kept in its own file, DATA_DIR/decisions.json, so it never
 * touches store.json.   { [variantId]: { d: 'keep' | 'drop' | 'clear', base, at } }
 *   base = the product's sales per day when decided; the item stays hidden until that moves more than 50%.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DECISIONS } = require('./helpers');

const MAX_ITEMS = 5000;
const dir = () => process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const file = () => path.join(dir(), 'decisions.json');

let data = null;

function all() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.warn('decisions.json unreadable, starting empty:', e.message); data = {}; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  return data;
}

function save() {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = file() + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file());
}

/** Store one decision. decision null (or '') removes it. base = sales per day now. Returns { ok } or { ok: false, error }. */
function set(id, decision, base, now = Date.now()) {
  const key = ['string', 'number'].includes(typeof id) ? String(id).trim().slice(0, 100) : '';
  if (!key) return { ok: false, error: 'Needs a product id' };
  const d = all();
  if (decision == null || decision === '') { const had = !!d[key]; delete d[key]; save(); return { ok: true, removed: had }; }
  if (!DECISIONS.includes(decision)) return { ok: false, error: `Decision must be one of ${DECISIONS.join(', ')}` };
  if (!d[key] && Object.keys(d).length >= MAX_ITEMS) return { ok: false, error: `At most ${MAX_ITEMS} decisions` };
  d[key] = { d: decision, base: Number.isFinite(+base) ? +base : 0, at: now };
  save();
  return { ok: true };
}

function clear() { data = {}; save(); }

/**
 * HTTP: GET /api/decide, POST /api/decide { id, decision }. rateOf(id) gives the product's sales per day now
 * (from the report), so the base comes from the server, not the page. Returns { code, body } or null when the path isn't ours.
 */
async function handle(req, p, readBody, rateOf) {
  if (p !== '/api/decide') return null;
  if (req.method === 'GET') return { code: 200, body: { ok: true, decisions: all() } };
  if (req.method !== 'POST') return { code: 405, body: { ok: false, error: 'Use GET or POST' } };
  let b;
  try { b = JSON.parse(await readBody(req, 16e3) || '{}'); } catch { return { code: 400, body: { ok: false, error: 'Body must be JSON' } }; }
  if (!b || typeof b !== 'object') return { code: 400, body: { ok: false, error: 'Body must be a JSON object' } };
  const base = b.decision ? rateOf(String(b.id)) : 0;
  if (b.decision && base == null) return { code: 404, body: { ok: false, error: 'No such product' } };
  const r = set(b.id, b.decision ?? null, base);
  return r.ok ? { code: 200, body: r } : { code: 400, body: r };
}

module.exports = { all, set, clear, handle };
