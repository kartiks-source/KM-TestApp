'use strict';
/* SW-042: monthly targets on groups, stock-aware. Progress, forecast with and without stock-outs, the part of the gap
 * that is stock-outs, traffic lights, storage (targets.json), backups. LOGIC.md §9c. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-targets-'));
require('../src/scope').useDir(path.join(process.env.DATA_DIR, 'one'));
const T = require('../src/targets');
const backup = require('../src/backup');
const period = require('../src/period');

test('progress: run-rate forecast with and without stock-outs; gap and its stock-out part; lights', () => {
  // day 10 of 30: ₹30,000 sold + ₹10,000 lost so far, target ₹1,00,000
  const p = T.progress(100000, 30000, 10000, 10, 30);
  assert.equal(p.forecast, 90000, '30k + 3k/day × 20 days');
  assert.equal(p.forecastFull, 120000, '40k + 4k/day × 20 days');
  assert.equal(p.gap, 10000);
  assert.equal(p.gapStockouts, 10000, 'the whole gap is stock-outs (capped at the gap)');
  assert.equal(p.light, 'amber', '90% of target = within 10%');
  assert.equal(p.pct, 30);
  assert.equal(T.progress(100000, 40000, 0, 10, 30).light, 'green', 'forecast 120k ≥ target');
  const red = T.progress(100000, 20000, 2000, 10, 30);
  assert.equal(red.light, 'red', 'forecast 60k < 90k');
  assert.equal(red.gap, 40000);
  assert.equal(red.gapStockouts, 6000, 'stock-outs explain only 66k − 60k');
  // first hours of the month: at least one day counts as gone (no 30× blow-up)
  assert.equal(T.progress(100000, 1000, 0, 0.2, 30).forecast, 1000 + 1000 * 29.8);
  // month over: forecast = sold
  assert.equal(T.progress(100000, 95000, 5000, 30, 30).forecast, 95000);
});

test('monthDays: store-time month length', () => {
  assert.equal(T.monthDays(period.monthStart(Date.parse('2026-02-10T00:00:00Z'), 330), 330), 28);
  assert.equal(T.monthDays(period.monthStart(Date.parse('2026-11-30T20:00:00Z'), 330), 330), 31, '30 Nov 20:00 UTC = 1 Dec in India');
});

test('set / remove targets; validation; forLens joins month-to-date groups', () => {
  assert.equal(T.set('title', 'x', 100).ok, false);
  assert.equal(T.set('type', 'Rings', -5).ok, false);
  assert.equal(T.set('type', 'Rings', 'abc').ok, false);
  assert.equal(T.set('type', '__proto__', 100).ok, false);
  assert.deepEqual(T.set('type', 'Rings', 200000, 'admin'), { ok: true });
  assert.deepEqual(T.set('type', 'Gone', 5000), { ok: true });
  assert.equal(T.all().type.Rings.amount, 200000);
  assert.equal(T.all().type.Rings.by, 'admin');
  const from = period.monthStart(Date.parse('2026-11-11T06:30:00Z'), 330), now = from + 10 * 864e5;
  const r = T.forLens('type', () => ({ groups: [{ key: 'Rings', label: 'Rings', sold: 50000, lost: 10000 }] }), from, now, 330);
  assert.equal(r.month, '2026-11');
  assert.equal(r.daysInMonth, 30);
  assert.equal(r.rows.Rings.forecast, 150000);
  assert.equal(r.rows.Rings.light, 'red');
  assert.equal(r.rows.Gone.sold, 0, 'a target whose group has no sales this month still shows');
  assert.deepEqual(T.set('type', 'Gone', 0), { ok: true, removed: true });
  assert.equal(T.forLens('tag', () => { throw new Error('not called without targets'); }, from, now, 330).rows && true, true);
  assert.ok(backup.SIDES['targets.json'], 'backups carry targets.json');
});
