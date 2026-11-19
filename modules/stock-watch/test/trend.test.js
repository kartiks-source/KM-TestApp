'use strict';
/* SW-021: the ₹ effect behind the Overview "Moving" card (LOGIC.md §7d). */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');

const D = E.DAY;
const now = Date.parse('2026-11-19T06:00:00Z');
const stockRow = (id) => ({ t: now - 28 * D, variantId: id, sku: id, product: id, before: 500, now: 500, price: 1000 });
function lines(id, perDayEarlier, perDayRecent) {
  const out = [];
  for (let i = 0; i < 28; i++) out.push({ t: now - 28 * D + i * D + 36e5, order: `${id}${i}`, variantId: id, qty: i < 14 ? perDayEarlier : perDayRecent, price: 1000 });
  return out;
}

test('trend ₹ effect = change in daily rate × average price × 30', () => {
  const r = E.report([stockRow('up'), stockRow('down'), stockRow('thin')],
    [...lines('up', 2, 3), ...lines('down', 4, 2), { t: now - D, order: 'x', variantId: 'thin', qty: 1, price: 1000 }], {}, { now });
  const by = Object.fromEntries(r.products.map((p) => [p.id, p]));
  assert.equal(by.up.trendPct, 50);
  assert.equal(by.up.rateDelta, 1);
  assert.equal(by.up.trendValue, 30000);           // +1 a day × ₹1,000 × 30
  assert.equal(by.down.trendPct, -50);
  assert.equal(by.down.trendValue, -60000);        // −2 a day × ₹1,000 × 30
  assert.equal(by.thin.trendPct, null);
  assert.equal(by.thin.trendValue, null);          // no trend to call → no ₹ effect
});

test('"New" products get a ₹ effect from zero', () => {
  const t = E.trend([{ t: now - D, qty: 2 }, { t: now - 2 * D, qty: 2 }], [], now, now - 60 * D);
  assert.equal(t.trendNew, true);
  assert.equal(t.rateDelta, Math.round((4 / 14) * 1000) / 1000);
});

/* S1 (critic round 1): the up/down call is read against the typical product, not against 0 (LOGIC.md §7d) */
test('trend call: red only 10+ points below the typical product', () => {
  assert.equal(E.trendCall(-20, -25), 'flat', '−20% when typical is −25%: holding up');
  assert.equal(E.trendCall(-36, -25), 'down');
  assert.equal(E.trendCall(-14, -25), 'flat', 'better than typical but still falling: never green (critic UI-1)');
  assert.equal(E.trendCall(14, 40), 'flat', 'worse than typical but still rising: never red');
  assert.equal(E.trendCall(12, -25), 'up');
  assert.equal(E.trendCall(-12, null), 'down', 'no baseline: against 0');
  assert.equal(E.trendCall(null, -25), null);
  /* in a report: 6 products, all falling; red only for the one 10+ points below the median */
  const falls = { a: [10, 6], b: [10, 6], c: [10, 6], d: [10, 6], e: [10, 7], f: [10, 3] };
  const ids = Object.keys(falls);
  const r = E.report(ids.map(stockRow), ids.flatMap((id) => lines(id, ...falls[id])), {}, { now });
  const by = Object.fromEntries(r.products.map((p) => [p.id, p]));
  assert.equal(r.totals.storeTrendPct, -40);
  assert.deepEqual(ids.map((id) => by[id].trendCall), ['flat', 'flat', 'flat', 'flat', 'flat', 'down']);   // e −30% beats typical −40% by 10 points but is falling: grey
  assert.ok(ids.every((id) => by[id].trendPct <= -30), 'every raw trend is a fall');
});
