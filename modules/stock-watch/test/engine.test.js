'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');
const R = require('../src/rows');

const H = E.HOUR, D = E.DAY;
const t0 = Date.parse('2026-11-01T00:00:00Z');

test('stock-out episodes: out, small refill, out again, proper restock', () => {
  const ch = [
    { t: t0, before: 100, now: 99 },
    { t: t0 + 10 * D, before: 1, now: 0 },
    { t: t0 + 11 * D, before: 0, now: 10 },
    { t: t0 + 12 * D, before: 1, now: 0 },
    { t: t0 + 14 * D, before: 0, now: 200 },
  ];
  const eps = E.episodes(ch, t0 + 20 * D);
  assert.equal(eps.length, 2);
  assert.deepEqual(eps.map((e) => [(e.end - e.start) / D, e.topUp, e.open]), [[1, 10, false], [2, 200, false]]);
});

test('an open stock-out runs to now', () => {
  const eps = E.episodes([{ t: t0, before: 3, now: 0 }], t0 + 5 * H);
  assert.equal(eps.length, 1); assert.equal(eps[0].open, true); assert.equal(eps[0].end - eps[0].start, 5 * H);
});

test('demand ignores time out of stock', () => {
  const eps = [{ start: t0 + 10 * D, end: t0 + 13 * D }];
  const { perDay } = E.demandPerDay(250, t0, t0 + 28 * D, eps);
  assert.equal(Math.round(perDay * 100) / 100, 10);           // 250 units over 25 in-stock days
});

test('reorder plan', () => {
  assert.equal(E.plan({ stock: 0, perDay: 10, lead: 7, cover: 30, safety: 3 }).status, 'Out now');
  assert.equal(E.plan({ stock: 20, perDay: 10, lead: 7, cover: 30, safety: 3 }).status, 'Critical');
  assert.equal(E.plan({ stock: 80, perDay: 10, lead: 7, cover: 30, safety: 3 }).status, 'Order now');
  assert.equal(E.plan({ stock: 150, perDay: 10, lead: 7, cover: 30, safety: 3 }).status, 'Order this week');
  assert.equal(E.plan({ stock: 500, perDay: 10, lead: 7, cover: 30, safety: 3 }).status, 'OK');
  assert.equal(E.plan({ stock: 80, perDay: 10, lead: 7, cover: 30, safety: 3 }).qty, 320);   // 10 × 40 − 80
});

test('selling hours follow the store’s hourly pattern and split by local day', () => {
  const flat = new Array(24).fill(1);
  const r = E.sellingHours(t0, t0 + 48 * H, flat, 330);
  assert.equal(Math.round(r.total), 48);
  assert.equal(Math.round(Object.values(r.byDay).reduce((a, b) => a + b, 0)), 48);
  const nightOnly = flat.map((_, h) => (h < 6 ? 4 : 0));     // all sales between 00:00 and 06:00 IST
  const day = E.sellingHours(Date.parse('2026-11-01T06:30:00Z'), Date.parse('2026-11-01T12:30:00Z'), nightOnly, 330);   // 12:00–18:00 IST
  assert.equal(day.total, 0);
});

test('report: lost value, small top-up and repeat flags, reorder list', () => {
  const now = t0 + 28 * D;
  const stock = [
    { t: t0, variantId: '1', sku: 'A', product: 'Serum', variant: '30 ml', before: 300, now: 300, price: 500 },
    { t: t0 + 10 * D, variantId: '1', before: 1, now: 0 },
    { t: t0 + 11 * D, variantId: '1', before: 0, now: 10 },
    { t: t0 + 12 * D, variantId: '1', before: 1, now: 0 },
    { t: t0 + 14 * D, variantId: '1', before: 0, now: 40 },
  ];
  const orders = [];
  for (let d = 0; d < 28; d++) if (d < 10 || d === 11 || d >= 14) orders.push({ t: t0 + d * D, order: `#${d}`, variantId: '1', sku: 'A', qty: 10, price: 500 });
  const r = E.report(stock, orders, { tzOffsetMin: 0 }, { now, days: 28 });
  const p = r.products[0];
  assert.equal(p.perDay, 10);
  assert.equal(r.stockouts.length, 2);
  const first = r.stockouts.find((s) => s.topUp === 10);
  assert.equal(first.small, true); assert.equal(first.repeat, true);
  assert.equal(r.totals.lost, Math.round(3 * 10 * 500));        // 3 days out × 10/day × ₹500 (flat hours)
  assert.equal(p.status, 'Order now');                           // 40 in stock at 10/day = 4 days (> 3 = not critical, < lead + safety)
});

test('rows: CSV with header, Flow line without header, JSON webhook', () => {
  const csv = 'Time,Variant ID,SKU,Product,Variant,Stock before,Stock now,Price\n2026-11-17T10:00:00+05:30,gid://shopify/ProductVariant/42,"S,1",Serum,30 ml,5,0,499\n';
  const a = R.fromCsv(csv, 'stock').rows;
  assert.equal(a.length, 1); assert.equal(a[0].variantId, '42'); assert.equal(a[0].sku, 'S,1'); assert.equal(a[0].now, 0);
  const b = R.fromWebhook('2026-11-17T10:05:00+0530,42,S1,Serum,30 ml,0,12,499', 'stock');
  assert.equal(b[0].now, 12); assert.equal(b[0].t, Date.parse('2026-11-17T10:05:00+05:30'));
  const c = R.fromWebhook({ created_at: '2026-11-17T10:06:00+05:30', order: '#1001', variant_id: 42, sku: 'S1', quantity: 2, price: 449 }, 'order');
  assert.equal(c[0].qty, 2); assert.equal(c[0].price, 449);
  const noTime = R.fromWebhook(',42,S1,Serum,,3,2,499', 'stock', 123);
  assert.equal(noTime[0].t, 123);
});

test('stock rows carry an optional category; products report it with units sold and % lost', () => {
  const csv = 'Time,Variant ID,SKU,Product,Variant,Stock before,Stock now,Price,Product type\n2026-11-01T10:00:00+05:30,9,S9,Lamp,,5,4,1000,Lamps';
  const { rows } = R.fromCsv(csv, 'stock');
  assert.equal(rows[0].type, 'Lamps');
  assert.equal(R.fromCsv('Time,Variant ID,SKU,Product,Variant,Stock before,Stock now,Price\n2026-11-01T10:00:00+05:30,9,S9,Lamp,,5,4,1000', 'stock').rows[0].type, undefined);
  const now = Date.parse('2026-11-10T00:00:00Z');
  const r = E.report([{ t: now - 5 * D, variantId: '9', sku: 'S9', product: 'Lamp', before: 5, now: 4, price: 1000, type: 'Lamps' }],
    [{ t: now - 5 * D, order: '#1', variantId: '9', sku: 'S9', qty: 1, price: 1000 }], {}, { days: 30, now });
  const p = r.products[0];
  assert.equal(p.type, 'Lamps'); assert.equal(p.unitsSold, 1); assert.equal(p.lostPct, 0);
});

test('best sellers (A = first 80% of sales), profit lost at unit cost, overstock beyond twice the need', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const S = { leadDays: 7, coverDays: 30, safetyDays: 3, minPerDay: 0 };
  const stock = [
    { t: now - 20 * D, variantId: 'big', sku: 'B', product: 'Big', before: 100, now: 100, price: 1000, cost: 400 },
    { t: now - 20 * D, variantId: 'mid', sku: 'M', product: 'Mid', before: 10, now: 10, price: 1000 },
    { t: now - 20 * D, variantId: 'dead', sku: 'X', product: 'Dead', before: 50, now: 50, price: 200, cost: 80 },
    // "big" goes out for exactly one day, 10 days ago
    { t: now - 10 * D, variantId: 'big', sku: 'B', product: 'Big', before: 1, now: 0, price: 1000, cost: 400 },
    { t: now - 9 * D, variantId: 'big', sku: 'B', product: 'Big', before: 0, now: 100, price: 1000, cost: 400 },
  ];
  const orders = [];
  for (let i = 0; i < 18; i++) orders.push({ t: now - (i + 1) * D + 3600e3, order: `#b${i}`, variantId: 'big', qty: 1, price: 1000 });
  orders.push({ t: now - 2 * D, order: '#m1', variantId: 'mid', qty: 2, price: 1000 });
  const r = E.report(stock, orders, S, { days: 30, now });
  const P = Object.fromEntries(r.products.map((p) => [p.id, p]));
  assert.equal(P.big.abc, 'A');            // 18,000 of 20,000 sold
  assert.equal(P.mid.abc, 'B');            // next 10%
  assert.equal(P.dead.abc, 'C');           // didn't sell
  // a full day out costs exactly one day of sales; profit = units × (price paid − cost)
  assert.ok(P.big.lostProfit > 0 && Math.abs(P.big.lostProfit / P.big.lost - 0.6) < 0.01);
  assert.equal(P.mid.lostProfit, null);    // no cost known
  // "dead" has stock and no sales → overstocked, excess valued at unit cost
  assert.equal(P.dead.overstock, true); assert.equal(P.dead.excessUnits, 50); assert.equal(P.dead.excessValue, 50 * 80);
  // order value uses unit cost when known (cash to commit)
  if (P.big.orderQty) assert.equal(P.big.orderValue, Math.round(P.big.orderQty * 400));
});
