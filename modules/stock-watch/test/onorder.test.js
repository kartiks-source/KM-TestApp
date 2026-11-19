'use strict';
/* "Mark ordered" (SW-012, LOGIC.md §6b): units already on order cover demand, so the line leaves Order today. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-onorder-'));
const E = require('../src/engine');
const OO = require('../src/onorder');

const D = E.DAY;
const now = Date.parse('2026-11-19T06:00:00Z');
/* 5 a day for 27 days, then out for the last day: rate 5/day, suggested order 5 × (7 + 30 + 3) = 200 */
function fixture(lastStock = 0) {
  const stock = [
    { t: now - 28 * D, variantId: 'v1', sku: 'S1', product: 'Lamp', variant: 'Brass', before: 200, now: 200, price: 1000 },
    { t: now - D, variantId: 'v1', before: 5, now: lastStock },
  ];
  const orders = [];
  for (let i = 0; i < 27; i++) orders.push({ t: now - 28 * D + i * D, order: '#' + i, variantId: 'v1', sku: 'S1', qty: 5, price: 1000 });
  return { stock, orders };
}
const run = (f, onOrder) => E.report(f.stock, f.orders, {}, { now, onOrder }).products[0];

test('no on-order: out of stock, order 200 today', () => {
  const p = run(fixture());
  assert.equal(p.status, 'Out now');
  assert.equal(p.orderQty, 200);
  assert.equal(p.onOrder, null);
});

test('marked ordered for the full quantity, landing within lead time: "Ordered", leaves Order today', () => {
  const f = fixture();
  const r = E.report(f.stock, f.orders, {}, { now, onOrder: { v1: { qty: 200, eta: now + 7 * D, at: now - 36e5 } } });
  const p = r.products[0];
  assert.equal(p.status, 'Ordered');
  assert.equal(p.orderQty, 0);
  assert.equal(p.orderValue, 0);
  assert.deepEqual([p.onOrder.remaining, p.onOrder.counts, p.onOrder.late], [200, true, false]);
  assert.equal(r.totals.orderToday, 0);
  assert.equal(r.totals.orderValueNow, 0);
  assert.equal(r.totals.ordered, 1);
  assert.equal(r.totals.outNow, 1);                                  // the shelf is still empty
  assert.ok(r.reorder.some((x) => x.id === 'v1' && x.status === 'Ordered'));   // listed under the Ordered tab
});

test('a date picked as "today + lead time" (end of that day) still counts', () => {
  const p = run(fixture(), { v1: { qty: 200, eta: now + 7 * D + 17 * 36e5, at: now } });
  assert.equal(p.status, 'Ordered');
});

test('ordered too little: stays in Order today for the rest only', () => {
  const p = run(fixture(), { v1: { qty: 50, eta: now + 5 * D, at: now } });
  assert.equal(p.status, 'Order now');                               // 50 pcs = 10 days ≤ lead 7 + buffer 3
  assert.equal(p.orderQty, 150);                                     // 200 − 50 already on order
});

test('past the expected date with nothing received: back in Order today, flagged late', () => {
  const p = run(fixture(), { v1: { qty: 200, eta: now - 2 * D, at: now - 9 * D } });
  assert.equal(p.status, 'Out now');
  assert.equal(p.orderQty, 200);
  assert.equal(p.onOrder.late, true);
});

test('stock arriving after the order was marked counts as received', () => {
  const f = fixture(120);                                            // stock went 5 → 120 a day ago
  const p = run(f, { v1: { qty: 125, eta: now + 3 * D, at: now - 2 * D } });
  assert.equal(p.onOrder, null);                                     // 115 of 125 received (≥ 90%): done
  const part = run(f, { v1: { qty: 200, eta: now + 3 * D, at: now - 2 * D } });
  assert.equal(part.onOrder.remaining, 85);                          // 200 − (120 − 5) still to come
});

test('an order landing after the shelf empties and later than a new order could: does not count', () => {
  const f = fixture(40);                                             // 40 pcs = 8 days left
  const p = run(f, { v1: { qty: 200, eta: now + 10 * D, at: now } });   // > 8 days left + 1 day
  assert.equal(p.onOrder.counts, false);
  assert.equal(p.status, 'Order now');
  const inTime = run(f, { v1: { qty: 200, eta: now + 8 * D, at: now } });
  assert.equal(inTime.status, 'Ordered');
});

test('product drawer uses the same on-order records', () => {
  const f = fixture();
  const d = E.productDetail('v1', f.stock, f.orders, {}, { now, onOrder: { v1: { qty: 200, eta: now + 7 * D, at: now } } });
  assert.equal(d.product.status, 'Ordered');
});

test('on-order store: validates, saves to DATA_DIR/onorder.json, qty 0 removes', () => {
  assert.equal(OO.mark([{ id: 'v1', qty: -3, eta: '2026-11-25' }], { now }).ok, false);
  assert.equal(OO.mark([{ id: 'v1', qty: 10, eta: '25/11/2026' }], { now }).ok, false);
  assert.equal(OO.mark([{ id: 'v1', qty: 10, eta: '2028-01-01' }], { now }).ok, false);   // more than a year out
  assert.equal(OO.mark([{ qty: 10, eta: '2026-11-25' }], { now }).ok, false);
  const r = OO.mark([{ id: 'v1', qty: 200, eta: '2026-11-25' }, { id: 'v2', qty: 5, eta: '2026-11-30' }], { now, by: 'Asha' });
  assert.deepEqual(r, { ok: true, saved: 2, removed: 0 });
  const rec = OO.all().v1;
  assert.equal(rec.qty, 200);
  assert.equal(rec.by, 'Asha');
  assert.equal(new Date(rec.eta + 330 * 60e3).toISOString().slice(0, 10), '2026-11-25');   // end of 25 Nov, store time
  const disk = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'onorder.json'), 'utf8'));
  assert.equal(disk.v2.qty, 5);
  assert.deepEqual(OO.mark([{ id: 'v2', qty: 0 }], { now }), { ok: true, saved: 0, removed: 1 });
  assert.equal(OO.all().v2, undefined);
});
