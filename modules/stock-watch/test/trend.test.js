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
