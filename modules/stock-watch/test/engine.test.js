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

test('trend: a stock-out is not read as falling demand; too few sales gives no trend', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  // 2 a day for 28 days, but out of stock for 7 of the last 14 days (and no sales then)
  const lines = []; let n = 0;
  for (let d = 1; d <= 28; d++) if (d > 7 || d <= 0) lines.push({ t: now - d * D + 3600e3, order: `#${n++}`, variantId: 'v', qty: 2, price: 100 });
  const eps = [{ start: now - 7 * D, end: now, open: true }];
  const t = E.trend(lines, eps, now);
  assert.equal(t.weeks.length, 8);
  assert.equal(t.weeks[7].units, 0); assert.equal(t.weeks[7].outDays, 7);
  assert.equal(t.trendPct, 0);             // raw week-on-week would say −50%
  const thin = E.trend([{ t: now - D, qty: 2 }, { t: now - 20 * D, qty: 1 }], [], now);
  assert.equal(thin.trendPct, null);       // 3 units in 28 days: too few to call
});

/* ---- cases raised by the logic critic (2026-11-19) ---- */
const S0 = { leadDays: 7, coverDays: 30, safetyDays: 3, minPerDay: 0.2 };

test('a product launched 5 days ago: rate counts only its own days; not flagged overstock', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const stock = [{ t: now - 60 * D, variantId: 'old', sku: 'O', product: 'Old', before: 50, now: 50, price: 100 },
    { t: now - 5 * D, variantId: 'new', sku: 'N', product: 'New', before: 60, now: 60, price: 100 }];
  const orders = [{ t: now - 59 * D, order: '#o', variantId: 'old', qty: 1, price: 100 }];
  for (let d = 1; d <= 5; d++) orders.push({ t: now - d * D + 3600e3, order: `#n${d}`, variantId: 'new', qty: 2, price: 100 });
  const p = E.report(stock, orders, S0, { days: 30, now }).products.find((x) => x.id === 'new');
  assert.ok(Math.abs(p.perDay - 2) < 0.01, `perDay ${p.perDay}`);
  assert.equal(p.overstock, false);
});

test('trend with short history: flat sales give a flat trend, not a jump; weeks before data are empty', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const lines = []; for (let d = 1; d <= 20; d++) lines.push({ t: now - d * D + 3600e3, qty: 2 });
  const t = E.trend(lines, [], now, now - 20 * D);
  assert.equal(t.trendPct, 0);
  assert.equal(t.weeks[0].units, null);         // 8 weeks ago: before the data
  assert.equal(t.trendNew, false);
  const tenDays = E.trend(lines.slice(0, 10), [], now, now - 10 * D);
  assert.equal(tenDays.trendNew, false);        // too little history is not "New"
});

test('"New" needs a real earlier window in stock and at least 3 sales since', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  assert.equal(E.trend([{ t: now - D, qty: 1 }], [], now, now - 60 * D).trendNew, false);   // one sale isn't a trend
  assert.equal(E.trend([{ t: now - D, qty: 2 }, { t: now - 2 * D, qty: 2 }], [], now, now - 60 * D).trendNew, true);
  const outBefore = [{ start: now - 28 * D, end: now - 14 * D }];                             // out of stock the whole earlier half
  assert.equal(E.trend([{ t: now - D, qty: 2 }, { t: now - 2 * D, qty: 2 }], outBefore, now, now - 60 * D).trendNew, false);
});

test('a best seller that sells few units (high price) is still on the reorder list', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const stock = [{ t: now - 40 * D, variantId: 'sofa', sku: 'S', product: 'Sofa', before: 1, now: 1, price: 90000 },
    { t: now - 10 * D, variantId: 'sofa', sku: 'S', product: 'Sofa', before: 1, now: 0, price: 90000 },
    { t: now - 40 * D, variantId: 'mug', sku: 'M', product: 'Mug', before: 500, now: 500, price: 100 }];
  const orders = [{ t: now - 10 * D, order: '#1', variantId: 'sofa', qty: 1, price: 90000 }];
  for (let d = 1; d <= 28; d++) orders.push({ t: now - d * D, order: `#m${d}`, variantId: 'mug', qty: 1, price: 100 });
  const r = E.report(stock, orders, S0, { days: 30, now });
  const sofa = r.products.find((p) => p.id === 'sofa');
  assert.equal(sofa.abc, 'A'); assert.ok(sofa.perDay < 0.2);
  assert.equal(sofa.status, 'Out now');          // was "Slow seller" and hidden from the reorder list
  assert.ok(r.reorder.some((p) => p.id === 'sofa'));
});

test('overview totals equal the sum of the product rows (partial first day included)', () => {
  const demo = require('../src/demo');
  const now = Date.parse('2026-11-19T07:30:00Z');
  const g = demo.generate({ now });
  for (const days of [7, 30]) {
    const r = E.report(g.stock, g.orders, {}, { days, now });
    const sold = r.products.reduce((s, p) => s + p.sold, 0), lost = r.products.reduce((s, p) => s + p.lost, 0);
    assert.equal(r.totals.sold, sold); assert.equal(r.totals.lost, lost);
    const ds = r.daily.reduce((s, d) => s + d.sold, 0);
    assert.ok(Math.abs(ds - sold) <= r.daily.length, `daily ${ds} vs rows ${sold}`);   // rounding per day only
  }
});

test('typical-product baseline is the median product trend, not raw store units', () => {
  const now = Date.parse('2026-11-19T07:30:00Z');
  const g = require('../src/demo').generate({ now });
  const r = E.report(g.stock, g.orders, {}, { days: 30, now });
  const v = r.products.map((p) => p.trendPct).filter((x) => x != null).sort((a, b) => a - b);
  const m = Math.floor(v.length / 2), med = v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  assert.ok(Math.abs(r.totals.storeTrendPct - med) < 0.06);
});

test('slow-seller cutoff 0 never makes a product with no demand "Out now"', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const r = E.report([{ t: now - 10 * D, variantId: 'x', sku: 'X', product: 'X', before: 1, now: 0, price: 10 }], [], { ...S0, minPerDay: 0 }, { days: 30, now });
  assert.notEqual(r.products[0].status, 'Out now');
  assert.equal(r.reorder.length, 0);
});

test('store: replacing an order removes its old lines (cancellation / refund picked up later)', () => {
  const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
  delete require.cache[require.resolve('../src/store')];
  const store = require('../src/store');
  store.replaceAll([], [], 'empty');
  store.replaceOrders(['#1', '#2'], [{ t: Date.now(), order: '#1', line: 'a', variantId: 'v', qty: 2, price: 10 }, { t: Date.now(), order: '#2', line: 'b', variantId: 'v', qty: 1, price: 10 }]);
  assert.equal(store.load().orders.length, 2);
  store.replaceOrders(['#1'], [{ t: Date.now(), order: '#1', line: 'a', variantId: 'v', qty: 1, price: 10 }]);   // one unit refunded
  store.replaceOrders(['#2'], []);                                                                            // cancelled
  assert.deepEqual(store.load().orders.map((o) => [o.order, o.qty]), [['#1', 1]]);
});

/* ---- SW-001: report survives any data size ---- */
test('minMax: one loop, no spread; empty gives ±Infinity', () => {
  assert.deepEqual(E.minMax([3, 1, 2]), { min: 1, max: 3 });
  assert.deepEqual(E.minMax([{ t: 5 }, { t: 2 }], (x) => x.t), { min: 2, max: 5 });
  assert.deepEqual(E.minMax([]), { min: Infinity, max: -Infinity });
});

test('no spread into Math.min/max anywhere in src/', () => {
  const fs = require('node:fs'), path = require('node:path');
  const dir = path.join(__dirname, '../src');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /Math\.(min|max)\([^)]*\.\.\./, f);
  }
});

test('report on 300k order lines + 200k stock rows: < 1.5 s, no throw, no NaN/Infinity', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const V = 1000, stock = [], orders = [];
  for (let v = 0; v < V; v++) {
    let s = 50;
    for (let i = 0; i < 200; i++) {
      const b = s; s = rnd() < 0.1 ? 0 : Math.floor(rnd() * 100);
      stock.push({ t: now - 120 * D + i * (120 * D / 200) + Math.floor(rnd() * H), variantId: 'v' + v, sku: 'S' + v, product: 'P' + v, before: b, now: s, price: 500, cost: 200 });
    }
  }
  for (let i = 0; i < 300000; i++) orders.push({ t: now - Math.floor(rnd() * 120 * D), order: '#' + i, variantId: 'v' + Math.floor(rnd() * V), qty: 1 + Math.floor(rnd() * 3), price: 500 });
  const start = process.hrtime.bigint();
  const r = E.report(stock, orders, {}, { days: 90, now });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 1500, `report took ${Math.round(ms)} ms`);
  assert.equal(r.data.stockRows, 200000); assert.equal(r.data.orderRows, 300000);
  assert.ok(r.data.firstOrder <= r.data.lastOrder && r.data.firstStock <= r.data.lastStock);
  const bad = [];
  const walk = (x, at) => {
    if (typeof x === 'number') { if (!Number.isFinite(x)) bad.push(at); return; }
    if (x && typeof x === 'object' && !(x instanceof Set)) for (const [k, v] of Object.entries(x)) walk(v, `${at}.${k}`);
  };
  walk({ totals: r.totals, daily: r.daily, data: r.data, stockouts: r.stockouts }, 'r');
  walk(r.products, 'r.products');                                  // daysLeft is null (not Infinity) when nothing sells
  assert.deepEqual(bad.slice(0, 5), []);
});

/* ---- SW-003: long stock-outs keep their demand ---- */
test('a best seller out for the last 30 days stays Out now, on Reorder, with ₹ lost at its earlier rate', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const stock = [{ t: now - 90 * D, variantId: 'best', sku: 'B', product: 'Best', before: 400, now: 400, price: 1000 },
    { t: now - 30 * D, variantId: 'best', sku: 'B', product: 'Best', before: 1, now: 0, price: 1000 }];
  const orders = [];
  for (let d = 31; d <= 90; d++) for (let k = 0; k < 5; k++) orders.push({ t: now - d * D + (2 + 4 * k) * H, order: `#${d}-${k}`, variantId: 'best', qty: 1, price: 1000 });
  const r = E.report(stock, orders, S0, { days: 30, now });
  const p = r.products[0];
  assert.equal(p.rateBasis, 'history');
  assert.ok(Math.abs(p.perDay - 5) < 0.01, `perDay ${p.perDay}`);
  assert.equal(p.status, 'Out now');
  assert.ok(p.orderQty > 0); assert.equal(p.orderQty, 5 * (7 + 30 + 3));
  assert.ok(Math.abs(p.lost - 30 * 5 * 1000) <= 0.05 * 30 * 5 * 1000, `lost ${p.lost}`);
  assert.ok(r.reorder.some((x) => x.id === 'best'));
});

test('7+ in-stock days in the window: rate unchanged (window basis)', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const stock = [{ t: now - 90 * D, variantId: 'v', sku: 'V', product: 'V', before: 400, now: 400, price: 100 },
    { t: now - 20 * D, variantId: 'v', sku: 'V', product: 'V', before: 1, now: 0, price: 100 }];   // 8 in-stock days in the 28
  const orders = [];
  for (let d = 21; d <= 90; d++) orders.push({ t: now - d * D + H, order: `#${d}`, variantId: 'v', qty: d <= 28 ? 1 : 5, price: 100 });
  const p = E.report(stock, orders, S0, { days: 30, now }).products[0];
  assert.equal(p.rateBasis, 'window');
  assert.ok(Math.abs(p.perDay - 1) < 0.01, `perDay ${p.perDay}`);    // 8 units ÷ 8 in-stock days
});

test('in-stock lookback: most recent 28 in-stock days, skipping stock-outs; capped at history start', () => {
  const now = 100 * D;
  const eps = [{ start: 40 * D, end: 50 * D }, { start: 80 * D, end: now }];
  assert.equal(E.inStockStart(eps, 0, now, 28 * D), 52 * D);    // the open stock-out is skipped; 28 of the 30 in-stock days 50→80
  assert.equal(E.inStockStart(eps, 0, now, 40 * D), 30 * D);    // 30 (50→80) + 10 (30→40)
  assert.equal(E.inStockStart(eps, 45 * D, now, 40 * D), 45 * D);
});

test('out since before the history starts: rate from the days before the stock-out began', () => {
  const now = Date.parse('2026-11-28T00:00:00Z');
  const lines = []; for (let d = 1; d <= 28; d++) lines.push({ t: now - 150 * D - d * D, qty: 3 });
  const eps = [{ start: now - 150 * D, end: now, open: true }];
  const r = E.demandRate(lines, eps, { winFrom: now - 28 * D, histFrom: now - 120 * D, now, wantDays: 28, first: now - 200 * D });
  assert.equal(r.basis, 'before-out');
  assert.ok(Math.abs(r.perDay - 3) < 0.01, `perDay ${r.perDay}`);
});
