'use strict';
/*
 * Monthly sales targets on groups, stock-aware (SW-042, LOGIC.md §9c). Admin sets a ₹ target per group (category,
 * collection, tag, parent product); the same target applies every month until changed. Kept in
 * <store folder>/targets.json (src/sidefile.js: atomic, .bak, carried in backups):
 *
 *   targets.json = { [lens]: { [groupKey]: { amount, at, by } } }
 *
 * Progress is month-to-date (from the 1st, store time), saved settings, same rules as the This month period:
 *   rate          = sold so far ÷ days gone (at least 1 day)
 *   forecast      = sold so far + rate × days left                       ← with stock-outs (as things are going)
 *   forecastFull  = (sold + lost) so far + (sold + lost) rate × days left ← if nothing had been out of stock
 *   gap           = max(0, target − forecast);  gapStockouts = min(gap, forecastFull − forecast)
 *   light         = green: forecast ≥ target · amber: forecast ≥ 90% of target · red: below
 */
const { sideFile } = require('./sidefile');
const { LENSES } = require('./groups');

const DAY = 864e5;
const MAX_TARGETS = 2000;
const MAX_AMOUNT = 1e11;
const AMBER = 0.9;
const box = sideFile('targets.json');
const own = (o, k) => !!o && Object.hasOwn(o, k);

const all = () => box.read();

/** Set one target; amount 0 / null / '' removes it. Returns { ok, removed? } or { ok: false, error }. */
function set(lens, key, amount, by = null, now = Date.now()) {
  if (!LENSES.includes(lens)) return { ok: false, error: 'Unknown group' };
  if (typeof key !== 'string' || key.length > 300 || key === '__proto__') return { ok: false, error: 'Needs a group key' };
  const f = all();
  if (amount == null || amount === '' || +amount === 0) {
    const had = own(f[lens], key);
    if (had) { delete f[lens][key]; if (!Object.keys(f[lens]).length) delete f[lens]; box.write(); }
    return { ok: true, removed: had };
  }
  const v = Math.round(+amount);
  if (!Number.isFinite(+amount) || v < 1 || v > MAX_AMOUNT) return { ok: false, error: 'Target must be ₹1 or more' };
  const count = Object.values(f).reduce((s, x) => s + Object.keys(x || {}).length, 0);
  if (!own(f[lens], key) && count >= MAX_TARGETS) return { ok: false, error: `At most ${MAX_TARGETS} targets` };
  if (!own(f, lens)) f[lens] = {};
  f[lens][key] = { amount: v, at: now, by: by ? String(by).slice(0, 40) : null };
  box.write();
  return { ok: true };
}

/** Days in the store-time month that starts at `from` (UTC ms of local midnight on the 1st). */
function monthDays(from, offMin) {
  const d = new Date(from + offMin * 60e3 + 12 * 36e5);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** One group's progress against its target (pure). sold / lost = month to date. */
function progress(target, sold, lost, gone, total) {
  const g = Math.min(total, Math.max(1, gone)), left = Math.max(0, total - gone);
  const forecast = sold + (sold / g) * left;
  const forecastFull = (sold + lost) + ((sold + lost) / g) * left;
  const gap = Math.max(0, target - forecast);
  const gapStockouts = Math.min(gap, Math.max(0, forecastFull - forecast));
  const light = forecast >= target ? 'green' : forecast >= AMBER * target ? 'amber' : 'red';
  const r = (x) => Math.round(x);
  return { target, sold: r(sold), lost: r(lost), forecast: r(forecast), forecastFull: r(forecastFull), gap: r(gap), gapStockouts: r(gapStockouts), pct: target ? Math.round((sold / target) * 100) : null, light };
}

/**
 * The targets of one lens with their progress. monthGroups(lens) → groups.build() of the month-to-date report.
 * Returns { lens, month, from, daysGone, daysInMonth, rows: { [key]: progress + { label } } }.
 */
function forLens(lens, monthGroups, from, now, offMin) {
  const list = all()[lens] || {};
  const total = monthDays(from, offMin), gone = (now - from) / DAY;
  const rows = {};
  const keys = Object.keys(list);
  if (keys.length) {
    const byKey = new Map(monthGroups(lens).groups.map((g) => [g.key, g]));
    for (const k of keys) {
      const g = byKey.get(k);
      rows[k] = { ...progress(list[k].amount, g ? g.sold : 0, g ? g.lost : 0, gone, total), label: g ? g.label : k, at: list[k].at, by: list[k].by };
    }
  }
  const d = new Date(from + offMin * 60e3 + 12 * 36e5);
  return { lens, month: d.toISOString().slice(0, 7), from, daysGone: Math.round(gone * 10) / 10, daysInMonth: total, rows };
}

/**
 * HTTP: GET /api/targets?lens= (view), POST /api/targets { lens, key, amount } (admin; view-only refused before this,
 * server.js). ctx = { by, monthGroups(lens), from, now, offMin }. Returns { code, body } or null when not ours.
 */
async function handle(req, url, readBody, ctx) {
  if (url.pathname !== '/api/targets') return null;
  if (req.method === 'GET') {
    const lens = url.searchParams.get('lens') || '';
    if (!LENSES.includes(lens)) return { code: 400, body: { ok: false, error: 'Unknown group' } };
    return { code: 200, body: { ok: true, ...forLens(lens, ctx.monthGroups, ctx.from, ctx.now, ctx.offMin) } };
  }
  if (req.method !== 'POST') return { code: 405, body: { ok: false, error: 'Use GET or POST' } };
  let b;
  try { b = JSON.parse(await readBody(req, 16e3) || '{}'); } catch { return { code: 400, body: { ok: false, error: 'Body must be JSON' } }; }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { code: 400, body: { ok: false, error: 'Body must be a JSON object' } };
  const r = set(b.lens, b.key, b.amount, ctx.by);
  return { code: r.ok ? 200 : 400, body: r };
}

module.exports = { all, set, progress, monthDays, forLens, handle, AMBER, MAX_TARGETS, FILE_NAME: box.name, reset: box.reset };
