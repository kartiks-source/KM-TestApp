'use strict';
/* SW-043: weekly review. Daily snapshots (src/weekly.js, snapshots.json), this week vs last week, movers, digest line,
 * route, backups. LOGIC.md §5b. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-weekly-'));
const DIR = path.join(process.env.DATA_DIR, 'one');
require('../src/scope').useDir(DIR);
const E = require('../src/engine');
const store = require('../src/store');
const W = require('../src/weekly');
const backup = require('../src/backup');
const DG = require('../src/digest');

const D = E.DAY, OFF = 330;
const mid = (key) => Date.parse(`${key}T00:00:00Z`) - OFF * 60e3;   // store midnight starting that day
const now = mid('2026-11-20') + 10 * 36e5;                          // 20 Nov, 10:00 store time

/* v1: 10 a day at ₹100 for 40 days, out from 16 Nov 00:00 store time (still out); v2: 2 a day at ₹500, out 8–9 Nov */
function fixture() {
  const start = mid('2026-10-10');
  const stock = [
    { t: start, variantId: 'v1', sku: 'A1', product: 'Lamp', variant: 'Brass', before: 0, now: 400, price: 100 },
    { t: mid('2026-11-16'), variantId: 'v1', before: 3, now: 0 },
    { t: start, variantId: 'v2', sku: 'B2', product: 'Vase', variant: 'Default Title', before: 0, now: 300, price: 500 },
    { t: mid('2026-11-08'), variantId: 'v2', before: 1, now: 0 },
    { t: mid('2026-11-10'), variantId: 'v2', before: 0, now: 200 },
  ];
  const orders = [];
  for (let t = start + 12 * 36e5; t < now; t += D) {
    if (t < mid('2026-11-16')) orders.push({ t, order: `#a${t}`, variantId: 'v1', sku: 'A1', qty: 10, price: 100 });
    if (t < mid('2026-11-08') || t >= mid('2026-11-10')) orders.push({ t: t + 36e5, order: `#b${t}`, variantId: 'v2', sku: 'B2', qty: 2, price: 500 });
  }
  return { stock, orders };
}
function reset(source = 'live') {
  const f = fixture();
  store.replaceAll(f.stock, f.orders, source);
  store.setSettings({ tzOffsetMin: OFF });
  W.clear(); W.reset();
}

test('a day\'s snapshot: that day\'s ₹ lost and stock-outs, the state at its end', () => {
  reset();
  const d = store.load();
  const s = W.compute(d, '2026-11-16');
  assert.equal(s.ranOut, 1, 'v1 ran out that day');
  assert.ok(s.lost > 800 && s.lost <= 1000, `a whole day of v1 (10 × ₹100), weighted by hour: ${s.lost}`);
  assert.equal(s.stillOut, 1);
  assert.deepEqual(Object.keys(s.lostBy), ['v1']);
  assert.equal(s.lostProfit, null, 'no unit cost → no profit lost');
  const before = W.compute(d, '2026-11-14');
  assert.equal(before.lost, 0); assert.equal(before.ranOut, 0); assert.equal(before.stillOut, 0);
  assert.ok(before.sold >= 1900 && before.sold <= 2100, `one day of sales: ${before.sold}`);
  /* rows recorded after the day ended are left out: v2's restock on 10 Nov doesn't end 8 Nov's stock-out early */
  const nov8 = W.compute(d, '2026-11-08');
  assert.equal(nov8.ranOut, 1); assert.equal(nov8.stillOut, 1);
  assert.ok(nov8.lostBy.v2 > 0);
});

test('catch-up fills the last 14 complete days once, from the first day with data; Shopify waits for a pull past midnight', async () => {
  reset();
  const taken = await W.catchUp(now);
  assert.equal(taken.length, 14);
  assert.equal(taken[0], '2026-11-06'); assert.equal(taken[13], '2026-11-19');
  const f = W.all();
  assert.equal(f.basis, 'live');
  assert.equal(f.days['2026-11-19'].src, 'day'); assert.equal(f.days['2026-11-10'].src, 'backfill');
  assert.deepEqual(await W.catchUp(now), [], 'nothing twice');
  assert.deepEqual(await W.catchUp(now + D), ['2026-11-20'], 'the next day once it has ended');
  /* a Shopify store: a day is taken only once the last good pull is after its end */
  reset();
  store.setShopify({ lastSync: mid('2026-11-19') - 60e3 });
  const t2 = await W.catchUp(now);
  assert.equal(t2[t2.length - 1], '2026-11-17', '18 Nov ends after the last pull: waits');
  store.setShopify({ lastSync: now - 60e3 });
  assert.deepEqual(await W.catchUp(now), ['2026-11-18', '2026-11-19']);
  store.setShopify({ lastSync: null });
});

test('this week vs last week: flows summed, states the newest day; movers by change in ₹ lost', async () => {
  reset();
  await W.catchUp(now);
  const s = W.current(now);
  assert.equal(s.ready, true); assert.equal(s.complete, true);
  assert.equal(s.upTo, '2026-11-19'); assert.equal(s.from, '2026-11-13');
  assert.equal(s.prevFrom, '2026-11-06'); assert.equal(s.prevTo, '2026-11-12');
  const days = W.all().days, sum = (a, b, k) => { let x = 0; for (let k2 = a; k2 <= b; k2 = new Date(Date.parse(k2 + 'T00:00:00Z') + D).toISOString().slice(0, 10)) x += days[k2][k]; return x; };
  assert.equal(s.thisWeek.lost, sum('2026-11-13', '2026-11-19', 'lost'));
  assert.equal(s.lastWeek.lost, sum('2026-11-06', '2026-11-12', 'lost'));
  assert.equal(s.thisWeek.ranOut, 1); assert.equal(s.lastWeek.ranOut, 1);
  assert.equal(s.thisWeek.stillOut, days['2026-11-19'].stillOut);
  assert.equal(s.lastWeek.stillOut, days['2026-11-12'].stillOut);
  assert.equal(s.thisWeek.lostProfit, null);
  assert.deepEqual(s.movers.map((m) => m.id), ['v1', 'v2'], 'v1 lost more this week; v2 lost less');
  assert.equal(s.movers[0].name, 'Lamp · Brass'); assert.equal(s.movers[1].name, 'Vase', '"Default Title" dropped, as in the report');
  assert.ok(s.movers[0].change > 0 && s.movers[1].change < 0);
  assert.equal(s.metrics.find((m) => m.k === 'lost').better, 'down');
});

test('summary with a short history: what there is, no comparison or movers yet', () => {
  const day = { sold: 10, lost: 5, lostProfit: null, ranOut: 1, stillOut: 1, excessValue: 0, toReorder: 2, orderToday: 1, orderTodayValue: 300, lostBy: { a: 5 } };
  const s = W.summary({ '2026-11-18': day, '2026-11-19': { ...day, stillOut: 3 } }, '2026-11-20');
  assert.equal(s.ready, true); assert.equal(s.complete, false); assert.equal(s.days, 2); assert.equal(s.lastWeek, null);
  assert.equal(s.thisWeek.lost, 10); assert.equal(s.thisWeek.stillOut, 3);
  assert.deepEqual(s.movers, []);
  assert.equal(W.summary({}, '2026-11-20').ready, false);
  assert.equal(W.summary({ '2026-11-20': day }, '2026-11-20').ready, false, 'today is never in it');
  assert.equal(W.digestLine(s), null, 'no line without last week');
});

test('demo → live starts the snapshots again; Clear forgets them; kept 400 days', async () => {
  reset('demo');
  await W.catchUp(now);
  assert.equal(W.all().basis, 'demo');
  assert.ok(W.current(now).ready);
  store.add('orders', [{ t: now - 36e5, order: '#live1', variantId: 'v9', qty: 1, price: 10 }], 'csv');   // first real row: the demo goes
  assert.equal(store.load().source, 'live');
  assert.equal(W.current(now).ready, false, 'demo snapshots are never shown on real data');
  reset();
  await W.catchUp(now);
  const f = W.all();
  f.days['2025-01-01'] = { ...f.days['2026-11-19'] };
  W.clear(); W.reset();
  assert.deepEqual(W.all().days, {});
  await W.catchUp(now);
  const g = W.all(); g.days['2025-10-10'] = { ...g.days['2026-11-19'] }; g.days['2025-10-30'] = { ...g.days['2026-11-19'] };
  delete g.days['2026-11-19'];
  await W.catchUp(now);
  assert.ok(!W.all().days['2025-10-10'], 'over 400 days: dropped');
  assert.ok(W.all().days['2025-10-30'], 'within 400 days: kept');
});

test('digest line: one line for Founder / Everyone, never for the CEO (who has the week already)', async () => {
  reset();
  await W.catchUp(now);
  const line = W.digestLine(W.current(now));
  assert.match(line, /^This week: ₹[\d,.]+( L)? lost to stock-outs, (up|down) from ₹[\d,.]+( L)? last week · 1 stock-out \(1 the week before\)\.$/);
  const r = E.report(store.load().stock, store.load().orders, store.load().settings, { now, days: 30 });
  const every = DG.build({ report: r, role: '', storeName: 'X', now, review: line });
  assert.ok(every.lines.includes(line)); assert.ok(every.lines.length <= DG.MAX_LINES);
  assert.ok(DG.build({ report: r, role: 'founder', storeName: 'X', now, review: line }).lines.includes(line));
  assert.ok(!DG.build({ report: r, role: 'ceo', storeName: 'X', now, review: line }).lines.includes(line));
});

test('backups carry snapshots.json', async () => {
  reset();
  await W.catchUp(now);
  const ex = JSON.parse(backup.text());
  assert.ok(ex.sideFiles['snapshots.json'].days['2026-11-19']);
});
