'use strict';
/* CSV / Sheet / Flow parsing (SW-010). Table-driven: one line per case. LOGIC.md §1a. */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rows');

const NOW = Date.parse('2026-11-19T12:00:00+05:30');
const IST = (s) => Date.parse(s + '+05:30');
const STOCK_HEAD = 'Time,Variant ID,SKU,Product,Variant,Stock before,Stock now,Price';
const ORDER_HEAD = 'Time,Order,Variant ID,SKU,Qty,Unit price';
const opts = { now: NOW, tzOffsetMin: 330, keepDays: 120 };

test('toTime: accepted and rejected formats', () => {
  const cases = [
    ['2026-11-15T10:00:00+05:30', IST('2026-11-15T10:00:00')],
    ['2026-11-15T04:30:00Z', IST('2026-11-15T10:00:00')],
    ['2026-11-15 10:00:00', IST('2026-11-15T10:00:00')],           // no zone → store time
    ['2026-11-15T10:00:00+0530', IST('2026-11-15T10:00:00')],
    ['2026-11-15', IST('2026-11-15T00:00:00')],                    // date only = 00:00 store time
    ['15/11/2026', IST('2026-11-15T00:00:00')],
    ['15/11/2026 10:30', IST('2026-11-15T10:30:00')],
    ['5/1/2026', IST('2026-01-05T00:00:00')],                      // day first
    ['46341', IST('2026-11-15T00:00:00')],                         // Sheets serial
    ['11/15/2026', null],                                          // US month/day: month 15 → rejected, not guessed
    ['32/01/2026', null], ['00/01/2026', null], ['15/13/2026', null], ['15/00/2026', null],
    ['31/02/2026', null], ['2026-02-30', null], ['2026-13-01', null], ['2026-11-15 25:00', null],
    ['tomorrow', null], ['', null], ['Nov 15 2026', null],
  ];
  for (const [input, want] of cases) assert.equal(R.toTime(input), want, input);
  assert.equal(R.toTime('2026-11-15', 0), Date.parse('2026-11-15T00:00:00Z'), 'store time zone follows the setting');
});

test('toNum: rupees, commas, spaces', () => {
  const cases = [['₹1,299', 1299], ['1 299', 1299], ['1,299.50', 1299.5], ['Rs. 499', 499], ['INR 10', 10], [' 12 ', 12], ['-3', -3],
    ['', undefined], ['  ', undefined], ['abc', NaN], ['12abc', NaN], ['1.2.3', NaN]];
  for (const [input, want] of cases) assert.ok(Object.is(R.toNum(input), want), `${input} → ${R.toNum(input)}`);
});

test('fromCsv stock: one row per case → kept value or skip reason', () => {
  const cases = [
    // [data line, expected { now, price, before } or skip reason]
    ['2026-11-15 10:00,42,S1,Serum,,5,0,499', { now: 0, price: 499, before: 5 }],
    ['2026-11-15 10:00,42,S1,Serum,,5,3,"₹1,299"', { now: 3, price: 1299, before: 5 }],
    ['2026-11-15 10:00,42,S1,Serum,,," 1,200 ",', { now: 1200, price: 0, before: null }],
    ['2026-11-15 10:00,42,S1,Serum,,5,,499', 'badNumber'],          // blank stock → skipped, not a phantom stock-out
    ['2026-11-15 10:00,42,S1,Serum,,5,n/a,499', 'badNumber'],
    ['2026-11-15 10:00,42,S1,Serum,,5,3,abc', 'badNumber'],
    ['2026-11-15 10:00,,S1,Serum,,5,3,499', 'noId'],
    ['11/15/2026,42,S1,Serum,,5,3,499', 'badTime'],                // US date
    ['nonsense,42,S1,Serum,,5,3,499', 'badTime'],
    [',42,S1,Serum,,5,3,499', 'badTime'],                          // no time in a file: skipped, not stamped now
    ['2026-11-25 10:00,42,S1,Serum,,5,3,499', 'badTime'],          // > now + 1 day
    ['2026-01-01 10:00,42,S1,Serum,,5,3,499', 'tooOld'],           // older than 120 days
  ];
  for (const [line, want] of cases) {
    const p = R.fromCsv(`${STOCK_HEAD}\n${line}`, 'stock', opts);
    if (typeof want === 'string') { assert.equal(p.rows.length, 0, line); assert.equal(p.skips[want], 1, line); assert.equal(p.skipped, 1, line); }
    else { assert.equal(p.rows.length, 1, line); const r = p.rows[0]; assert.deepEqual({ now: r.now, price: r.price, before: r.before }, want, line); }
  }
});

test('fromCsv order: numbers and skips', () => {
  const cases = [
    ['15/11/2026 10:00,#1001,42,S1,2,"₹1,299.00"', { qty: 2, price: 1299 }],
    ['15/11/2026 10:00,#1001,42,S1,"1,000",499', { qty: 1000, price: 499 }],
    ['15/11/2026 10:00,#1001,42,S1,0,499', 'badNumber'],
    ['15/11/2026 10:00,#1001,42,S1,,499', 'badNumber'],
    ['15/11/2026 10:00,#1001,42,S1,2,free', 'badNumber'],
    ['15/11/2026 10:00,#1001,,S1,2,499', 'noId'],
    ['11/15/2026 10:00,#1001,42,S1,2,499', 'badTime'],
  ];
  for (const [line, want] of cases) {
    const p = R.fromCsv(`${ORDER_HEAD}\n${line}`, 'order', opts);
    if (typeof want === 'string') assert.equal(p.skips[want], 1, line);
    else assert.deepEqual({ qty: p.rows[0].qty, price: p.rows[0].price }, want, line);
  }
});

test('headers: required columns, exact names beat aliases, no misleading aliases', () => {
  const missing = [
    ['stock', 'foo,bar,baz\n1,2,3', ['Time', 'Variant ID', 'Stock now']],
    ['stock', 'Time,SKU,Stock now\n2026-11-15,S1,3', ['Variant ID']],
    ['stock', 'Time,Variant,Stock now\n2026-11-15,Black,3', ['Variant ID']],             // "variant" is the title, not the ID
    ['order', 'Time,Order,SKU,Unit price\n2026-11-15,#1,S1,499', ['Variant ID', 'Qty']],
    ['stock', '2026-11-15 10:00,42,S1,Serum,,5,3,499', ['Time', 'Variant ID', 'Stock now']], // no header row at all
  ];
  for (const [kind, csv, cols] of missing) {
    assert.throws(() => R.fromCsv(csv, kind, opts), (e) => e.status === 400 && assert.deepEqual(e.missing, cols) === undefined && cols.every((c) => e.message.includes(c)), csv);
  }
  // exact "Variant ID" wins; "Variant" maps to the variant title; "Stock now" beats the "Inventory" alias wherever it sits
  const p = R.fromCsv('Variant,Inventory,Stock now,Variant ID,Time\nBlack,99,3,42,2026-11-15', 'stock', opts);
  assert.deepEqual([p.rows[0].variantId, p.rows[0].variant, p.rows[0].now], ['42', 'Black', 3]);
  // aliases still work when the exact name is absent
  const a = R.fromCsv('Timestamp,variant_id,Quantity\n2026-11-15,42,7', 'stock', opts);
  assert.deepEqual([a.rows[0].variantId, a.rows[0].now], ['42', 7]);
  // "Collection" is not a product type
  const c = R.fromCsv(`${STOCK_HEAD},Collection\n2026-11-15,42,S1,Serum,,5,3,499,Summer sale`, 'stock', opts);
  assert.equal(c.rows[0].type, undefined);
  const t = R.fromCsv(`${STOCK_HEAD},Category\n2026-11-15,42,S1,Serum,,5,3,499,Lamps`, 'stock', opts);
  assert.equal(t.rows[0].type, 'Lamps');
});

test('semicolon files are read', () => {
  const p = R.fromCsv('Time;Variant ID;SKU;Product;Variant;Stock before;Stock now;Price\n15/11/2026 10:00;42;S1;"Serum, 30 ml";;5;3;"1,299"', 'stock', opts);
  assert.equal(p.rows.length, 1);
  assert.deepEqual([p.rows[0].product, p.rows[0].now, p.rows[0].price], ['Serum, 30 ml', 3, 1299]);
  assert.equal(R.sniffDelimiter('a,b;c,d'), ',');
  assert.equal(R.sniffDelimiter('"a;b;c",d'), ',');
});

test('skip counts add up and match rows kept', () => {
  const csv = [STOCK_HEAD, '2026-11-15,1,,,,,3,', '2026-11-15,2,,,,,,', ',3,,,,,3,', '2026-01-01,4,,,,,3,', '2026-11-15,,,,,,3,', '2026-11-16,5,,,,,1,'].join('\n');
  const p = R.fromCsv(csv, 'stock', opts);
  assert.deepEqual(p.skips, { badTime: 1, badNumber: 1, noId: 1, tooOld: 1 });
  assert.equal(p.skipped, 4);
  assert.deepEqual(p.rows.map((r) => r.variantId), ['1', '5']);
});

test('Flow: no header needed; missing or unreadable time is stamped now; future time skipped', () => {
  assert.equal(R.fromWebhook(',42,S1,Serum,,3,2,499', 'stock', { now: NOW })[0].t, NOW);
  assert.equal(R.fromWebhook('garbage,42,S1,Serum,,3,2,499', 'stock', { now: NOW })[0].t, NOW);
  assert.equal(R.fromWebhook('2026-11-15 10:00,42,S1,Serum,,3,2,499', 'stock', { now: NOW })[0].t, IST('2026-11-15T10:00:00'));
  assert.equal(R.fromWebhook('2026-12-15 10:00,42,S1,Serum,,3,2,499', 'stock', { now: NOW }).length, 0);
  assert.equal(R.fromWebhook({ variant_id: 42, now: 0, price: '₹1,299' }, 'stock', { now: NOW })[0].price, 1299);
  assert.equal(R.fromWebhook({ variant_id: 42, now: '' }, 'stock', { now: NOW }).length, 0, 'blank stock skipped');
  assert.equal(R.fromWebhook({ order: '#1', variant_id: 42, quantity: 2, price: 449, created_at: 'soon' }, 'order', { now: NOW })[0].t, NOW);
  // a Flow body that sends its own header row still maps by name
  const h = R.fromWebhook(`${ORDER_HEAD}\n2026-11-15 10:00,#7,42,S1,2,499`, 'order', { now: NOW });
  assert.deepEqual([h[0].order, h[0].qty], ['#7', 2]);
});
