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
const H = require('../src/helpers');
require('../src/scope').useDir(process.env.DATA_DIR);   // module on its own: one store folder

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
  assert.equal(p.status, 'Out now');                                 // shelf empty: still Out now (was "Order now")
  assert.equal(p.orderQty, 150);                                     // 200 − 50 already on order
});

test('out of stock with a part-filled order: stays Out now in Order today and in out now, whatever the shortfall', () => {
  /* critic L2: 2/day, stock 0, PO landing in 3 days. 10 pcs → was "Order now", 25 pcs → "Order this week" (left
     Order today with the shelf empty); 50 pcs covers the need → Ordered, still counted in out now. */
  const stock = [{ t: now - 28 * D, variantId: 'v2', sku: 'S2', product: 'Vase', before: 60, now: 56, price: 500 }, { t: now - D, variantId: 'v2', before: 2, now: 0 }];
  const orders = [];
  for (let i = 0; i < 27; i++) orders.push({ t: now - 28 * D + i * D, order: '#' + i, variantId: 'v2', sku: 'S2', qty: 2, price: 500 });
  const at = (qty) => E.report(stock, orders, {}, { now, onOrder: { v2: { qty, eta: now + 3 * D, at: now } } });
  for (const qty of [10, 25]) {
    const r = at(qty), p = r.products[0];
    assert.equal(p.status, 'Out now', `PO ${qty}`);
    assert.equal(p.orderQty, 80 - qty, `PO ${qty}: only the extra`);   // 2 × 40 − on order
    assert.equal(r.totals.outNow, 1);
    assert.equal(r.totals.orderToday, 1);
  }
  const full = at(80);
  assert.equal(full.products[0].status, 'Ordered');
  assert.equal(full.totals.outNow, 1);
  assert.equal(full.totals.orderToday, 0);
});

test('in stock, Critical, with a part-filled order: stays Critical in Order today (final r2 L1)', () => {
  /* 5/day, stock 10 (2 d left), PO of 50 lands in 5 d: used to become "Order this week", off Order today. */
  const stock = [{ t: now - 28 * D, variantId: 'v3', sku: 'S3', product: 'Mug', before: 150, now: 150, price: 300 }, { t: now - D, variantId: 'v3', before: 15, now: 10 }];
  const orders = [];
  for (let i = 0; i < 28; i++) orders.push({ t: now - 28 * D + i * D + 1000, order: '#' + i, variantId: 'v3', sku: 'S3', qty: 5, price: 300 });
  const at = (qty) => E.report(stock, orders, {}, { now, onOrder: { v3: { qty, eta: now + 5 * D, at: now } } });
  const none = E.report(stock, orders, {}, { now }).products[0];
  assert.equal(none.status, 'Critical');
  for (const qty of [30, 50]) {
    const r = at(qty), p = r.products[0];
    assert.equal(p.onOrder.counts, true, `PO ${qty} counts`);
    assert.equal(p.status, 'Critical', `PO ${qty}`);
    assert.equal(p.orderQty, none.orderQty - qty, `PO ${qty}: only the extra`);
    assert.equal(r.totals.orderToday, 1, `PO ${qty}: still in Order today`);
    assert.match(H.why(p, { leadDays: 7, safetyDays: 3, tzOffsetMin: 330 }, now).why, /order by today/);
  }
  assert.equal(at(250).products[0].status, 'Ordered');
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

test('Ordered tab = every open order (part, late, covered), late first, with what is still to come; warehouse digest says the same', () => {
  /* critic SIMP-1: the tab listed status "Ordered" only, so a part order or a late one never showed to the warehouse */
  const H = require('../src/helpers');
  const Dg = require('../src/digest');
  const lamp = fixture();                                            // v1: out, needs 200
  const vase = { stock: lamp.stock.map((r) => ({ ...r, variantId: 'v2', sku: 'S2', product: 'Vase' })), orders: lamp.orders.map((o) => ({ ...o, variantId: 'v2', sku: 'S2' })) };
  const bowl = { stock: lamp.stock.map((r) => ({ ...r, variantId: 'v3', sku: 'S3', product: 'Bowl' })), orders: lamp.orders.map((o) => ({ ...o, variantId: 'v3', sku: 'S3' })) };
  const onOrder = {
    v1: { qty: 200, eta: now + 5 * D, at: now - 36e5 },               // covers the need → Ordered
    v2: { qty: 12, eta: now + 3 * D, at: now - 36e5 },                // part order → stays Out now
    v3: { qty: 200, eta: now - 2 * D, at: now - 9 * D },              // late
  };
  const r = H.enrich(E.report([...lamp.stock, ...vase.stock, ...bowl.stock], [...lamp.orders, ...vase.orders, ...bowl.orders], {}, { now, onOrder }));
  const rows = H.reorderRows(r.products, { filter: 'ordered' });
  assert.deepEqual(rows.map((p) => p.id), ['v3', 'v2', 'v1']);       // late first, then by landing date
  assert.deepEqual(rows.map((p) => p.status), ['Out now', 'Out now', 'Ordered']);
  assert.equal(rows.find((p) => p.id === 'v2').onOrder.remaining, 12);
  assert.equal(H.poLines(r, { filter: 'ordered' }).length, 1 + 3);   // the CSV of the tab has the same rows
  assert.deepEqual(H.onOrderSummary(r.products, now), { lines: 3, late: 1, week: 2, pcs: 412, next: now + 3 * D });
  const d = Dg.build({ report: r, role: 'warehouse', now });
  assert.match(d.lines[1], /^On order: 3 lines, 412 pcs to come · 2 due this week · 1 late\.$/);
  assert.match(d.lines[2], /^Bowl.*: 200 pcs · late, was due /);
  assert.ok(!/Order today/.test(d.text), 'the warehouse digest never says "order today"');
});
