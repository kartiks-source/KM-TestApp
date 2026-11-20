'use strict';
/* Sprint 3 merge (1.1.0): the B-review weekly snapshots and group targets follow the store's time zone (SW-049),
 * including the 23- and 25-hour days at a daylight saving change. LOGIC.md §0a, §5b, §9c. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-s3merge-'));
require('../src/scope').useDir(path.join(process.env.DATA_DIR, 'one'));
const W = require('../src/weekly');
const T = require('../src/targets');
const TZ = require('../src/tz');
const period = require('../src/period');

const ZONE = 'Europe/London';
const at = (iso) => Date.parse(iso);

function day(key, extra = []) {
  const stock = [{ t: at('2026-03-01T00:00:00Z'), variantId: 'v1', sku: 'A1', product: 'Lamp', variant: 'Brass', before: 0, now: 500, price: 100 }];
  const orders = [
    { t: at(`${key}T00:30:00Z`), order: '#1', variantId: 'v1', sku: 'A1', qty: 1, price: 100 },
    ...extra.map((t, i) => ({ t, order: `#x${i}`, variantId: 'v1', sku: 'A1', qty: 1, price: 100 })),
  ];
  return { settings: { timeZone: ZONE }, stock, orders, catalog: {} };
}

test('weekly snapshot day = the store day in its zone: 23-hour spring day and 25-hour autumn day', () => {
  /* 29 Mar 2026: London clocks go 01:00 → 02:00 (23 hours). 23:30 local = 22:30 UTC, still that day. */
  const spring = W.compute(day('2026-03-29', [at('2026-03-29T22:30:00Z'), at('2026-03-29T23:30:00Z')]), '2026-03-29', {}, 0);
  assert.equal(spring.sold, 200, 'the 00:30 UTC (= 00:30 GMT) and 22:30 UTC (= 23:30 BST) sales; 23:30 UTC is the next day');
  /* 25 Oct 2026: clocks go 02:00 → 01:00 (25 hours). Day runs 24 Oct 23:00 UTC → 26 Oct 00:00 UTC. */
  const autumn = W.compute(day('2026-10-25', [at('2026-10-24T23:10:00Z'), at('2026-10-25T23:50:00Z')]), '2026-10-25', {}, 0);
  assert.equal(autumn.sold, 300, '00:10 BST, 00:30 UTC and 23:50 GMT all fall on 25 Oct in London');
});

test('targets: month length and month name in the store zone (name or old minutes)', () => {
  const from = period.monthStart(at('2026-11-15T12:00:00Z'), ZONE);
  assert.equal(TZ.dayKey(from, ZONE), '2026-11-01');
  assert.equal(T.monthDays(from, ZONE), 30);
  assert.equal(T.monthDays(period.monthStart(at('2026-11-30T20:00:00Z'), 330), 330), 31, 'old minutes still work: 30 Nov 20:00 UTC = 1 Dec in India');
  const r = T.forLens('type', () => ({ groups: [] }), from, from + 5 * 864e5, ZONE);
  assert.equal(r.month, '2026-11'); assert.equal(r.daysInMonth, 30);
});
