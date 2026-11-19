'use strict';
/* SW-027: "This month" period and the Yesterday strip (LOGIC.md §5a). */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const P = require('../src/period');

const H = E.HOUR, D = E.DAY, IST = 330;
// 19 Nov 2026, 10:00 in India (04:30 UTC)
const now = Date.parse('2026-11-19T04:30:00Z');

test('month start is the 1st at 00:00 store time', () => {
  assert.equal(new Date(P.monthStart(now, IST)).toISOString(), '2026-10-31T18:30:00.000Z');   // 1 Nov 00:00 IST
  assert.equal(new Date(P.monthStart(now, 0)).toISOString(), '2026-11-01T00:00:00.000Z');
  // 31 Oct 20:00 UTC is already 1 Nov in India
  assert.equal(new Date(P.monthStart(Date.parse('2026-10-31T20:00:00Z'), IST)).toISOString(), '2026-10-31T18:30:00.000Z');
});

test('range: "month" gives from = month start; numbers and junk give days', () => {
  assert.deepEqual(P.range('month', now, IST), { period: 'month', from: P.monthStart(now, IST) });
  assert.deepEqual(P.range('14', now, IST), { period: 'days', days: 14 });
  assert.deepEqual(P.range(null, now, IST), { period: 'days', days: 30 });
  assert.deepEqual(P.range('x', now, IST), { period: 'days', days: 30 });
});

test('report with from = month start counts only this month', () => {
  const orders = [
    { t: P.monthStart(now, IST) - H, order: 'a', variantId: 1, sku: 'A', qty: 1, price: 1000 },   // 31 Oct 23:00 IST: last month
    { t: P.monthStart(now, IST) + H, order: 'b', variantId: 1, sku: 'A', qty: 2, price: 1000 },   // 1 Nov 01:00 IST
    { t: now - 2 * H, order: 'c', variantId: 1, sku: 'A', qty: 3, price: 1000 },
  ];
  const stock = [{ t: now - 40 * D, variantId: 1, sku: 'A', product: 'A', before: 0, now: 100, price: 1000 }];
  const r = E.report(stock, orders, { tzOffsetMin: IST }, { now, from: P.monthStart(now, IST) });
  assert.equal(r.totals.sold, 5000);
  assert.equal(r.days, 19);                                  // 1–19 Nov, partial today included
  assert.equal(r.daily[0].day, '2026-11-01');
  assert.equal(r.daily.at(-1).day, '2026-11-19');
  assert.equal(r.daily.reduce((s, d) => s + d.sold, 0), r.totals.sold);
  // a number of days still works the old way
  assert.equal(E.report(stock, orders, { tzOffsetMin: IST }, { now, days: 30 }).totals.sold, 6000);
});

test('from is never more than 90 days back and never after now', () => {
  const r = E.report([], [], {}, { now, from: now - 400 * D });
  assert.equal(r.from, now - 90 * D);
  assert.equal(E.report([], [], {}, { now, from: now + D }).from, now);
});

test('yesterday: sold and lost on yesterday’s store-time day, products that ran out and came back', () => {
  const y0 = P.dayStart(now, IST) - D;                        // 18 Nov 00:00 IST
  const stock = [
    { t: now - 30 * D, variantId: 1, sku: 'A', product: 'A', before: 0, now: 50, price: 500 },
    { t: y0 + 10 * H, variantId: 1, sku: 'A', product: 'A', before: 1, now: 0, price: 500 },      // A ran out yesterday 10:00
    { t: now - 30 * D, variantId: 2, sku: 'B', product: 'B', before: 0, now: 50, price: 500 },
    { t: y0 - 3 * D, variantId: 2, sku: 'B', product: 'B', before: 1, now: 0, price: 500 },       // B out 3 days before…
    { t: y0 + 5 * H, variantId: 2, sku: 'B', product: 'B', before: 0, now: 40, price: 500 },      // …back yesterday 05:00
    { t: y0 + 6 * H, variantId: 2, sku: 'B', product: 'B', before: 40, now: 0, price: 500 },      // out again 06:00 (counts once)
    { t: y0 + 7 * H, variantId: 2, sku: 'B', product: 'B', before: 0, now: 30, price: 500 },      // back 07:00
  ];
  const orders = [];
  for (let i = 0; i < 25; i++) orders.push({ t: now - (i + 2) * D, order: 'o' + i, variantId: 1, sku: 'A', qty: 2, price: 500 });
  orders.push({ t: y0 + 2 * H, order: 'y1', variantId: 1, sku: 'A', qty: 3, price: 500 });          // yesterday
  orders.push({ t: y0 - H, order: 'y0', variantId: 1, sku: 'A', qty: 9, price: 500 });              // the day before
  orders.push({ t: now - H, order: 't', variantId: 2, sku: 'B', qty: 9, price: 500 });              // today
  const r = E.report(stock, orders, { tzOffsetMin: IST }, { now, days: 30 });
  const y = P.yesterday(r, IST);
  assert.equal(y.day, '2026-11-18');
  assert.equal(y.sold, 1500);
  assert.equal(y.ranOut, 2);                                  // A, and B (twice, counted once)
  assert.equal(y.back, 1);                                    // B
  const bar = r.daily.find((d) => d.day === '2026-11-18');
  assert.equal(y.lost, bar.lost);                             // same number as the chart bar
  assert.ok(y.lost > 0);
});

test('yesterday when the period starts today (1st of the month): worked out from a 2-day report', () => {
  const first = Date.parse('2026-11-01T06:30:00Z');           // 1 Nov 12:00 IST
  const orders = [{ t: Date.parse('2026-10-31T10:00:00Z'), order: 'a', variantId: 1, sku: 'A', qty: 2, price: 700 }];   // 31 Oct IST
  const stock = [{ t: first - 20 * D, variantId: 1, sku: 'A', product: 'A', before: 0, now: 100, price: 700 }];
  const r = E.report(stock, orders, { tzOffsetMin: IST }, { now: first, from: P.monthStart(first, IST) });
  assert.equal(P.yesterday(r, IST), null);
  const y = P.yesterdayFor(stock, orders, { tzOffsetMin: IST }, r);
  assert.equal(y.day, '2026-10-31');
  assert.equal(y.sold, 1400);
});

test('asOf drops rows after the cut', () => {
  const a = P.asOf([{ t: 1 }, { t: 5 }], [{ t: 2 }, { t: 9 }], 5);
  assert.deepEqual(a, { stock: [{ t: 1 }, { t: 5 }], orders: [{ t: 2 }] });
});
