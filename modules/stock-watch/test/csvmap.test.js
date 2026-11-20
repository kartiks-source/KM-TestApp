'use strict';
/* SW-045: import preview + column mapping, Shopify admin exports (src/csvmap.js, LOGIC.md §1b). Real-shaped samples in test/fixtures. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../src/csvmap');
const scope = require('../src/scope');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const NOW = Date.parse('2026-11-20T06:00:00Z');
const opts = { now: NOW, tzOffsetMin: 330, keepDays: 120 };
const bySku = (rows) => Object.fromEntries(rows.map((r) => [r.sku + (r.order ? r.order : ''), r]));

test('Shopify products export: detected, mapped out of the box, one stock row per tracked active variant', () => {
  const p = C.parse(fx('shopify-products.csv'), '', null, opts);
  assert.equal(p.format, 'shopify-products'); assert.equal(p.kind, 'stock');
  assert.deepEqual(p.map, { time: '@now', 'variant id': '@sku', sku: 'Variant SKU', product: 'Title', variant: '@options', 'stock now': 'Variant Inventory Qty', 'stock before': '', price: 'Variant Price', cost: 'Cost per item', type: 'Type', vendor: 'Vendor' });
  const r = bySku(p.rows);
  assert.deepEqual(Object.keys(r).sort(), ['BL-01', 'NT-BLK-L', 'NT-WHT-L']);
  assert.deepEqual(r['NT-BLK-L'], { variantId: 'NT-BLK-L', sku: 'NT-BLK-L', product: 'Nesting Table', variant: 'Black Marble / Large', before: null, now: 4, price: 14999, type: 'Tables', cost: 8200, vendor: 'Sammsara Studio', t: NOW });
  assert.equal(r['NT-WHT-L'].product, 'Nesting Table', 'title, vendor, type copied down the handle');
  assert.equal(r['NT-WHT-L'].vendor, 'Sammsara Studio');
  assert.equal(r['NT-WHT-L'].now, 0, 'an empty shelf is kept: 0 is a real stock count');
  assert.equal(r['BL-01'].variant, '', '"Default Title" = no variant name');
  assert.equal(r['BL-01'].cost, undefined, 'blank cost per item: no cost');
  assert.equal(p.ignored, 1, 'image-only row ignored, not counted as skipped');
  assert.equal(p.skips.untracked, 1, 'Variant Inventory Tracker blank: stock not tracked');
  assert.equal(p.skips.inactive, 1, 'archived product left out');
  assert.equal(p.skipped, 2);
});

test('Shopify orders export: cancelled / voided / refunded out, rows of one order share its date, discount netted', () => {
  const p = C.parse(fx('shopify-orders.csv'), '', null, opts);
  assert.equal(p.format, 'shopify-orders'); assert.equal(p.kind, 'order');
  assert.deepEqual(p.map, { time: 'Created at', order: 'Name', 'variant id': '@sku', sku: 'Lineitem sku', qty: 'Lineitem quantity', 'unit price': 'Lineitem price', 'line discount': 'Lineitem discount' });
  const r = bySku(p.rows);
  assert.deepEqual(Object.keys(r).sort(), ['BL-01#1042', 'BL-01#1043', 'LC-RUST#1043', 'LC-RUST#1047', 'NT-BLK-L#1042']);
  assert.equal(r['NT-BLK-L#1042'].price, 13999, '14,999 − 2,000 ÷ 2');
  assert.equal(r['NT-BLK-L#1042'].qty, 2);
  assert.equal(r['NT-BLK-L#1042'].t, Date.parse('2026-11-15T10:22:31+05:30'));
  assert.equal(r['BL-01#1043'].t, r['LC-RUST#1043'].t, 'blank Created at on a later line takes the order’s');
  assert.equal(r['LC-RUST#1047'].price, 1249, 'partially refunded kept; 1,299 − 100 ÷ 2');
  assert.equal(p.skips.cancelled, 2, '#1044 voided + cancelled, #1045 refunded');
  assert.equal(p.skips.noId, 1, 'gift wrap: no SKU');
});

test('SKU → the variant ID this store already uses, so an export joins Flow / Sheet rows', () => {
  const ids = C.idsBySku([{ t: 1, variantId: '111', sku: 'BL-01' }, { t: 5, variantId: '222', sku: 'BL-01' }, { t: 3, variantId: '333', sku: 'BL-01' }], { 999: { sku: 'NT-BLK-L' } });
  assert.equal(ids.get('BL-01'), '222', 'newest row wins');
  assert.equal(ids.get('NT-BLK-L'), '999', 'catalog');
  const p = C.parse(fx('shopify-orders.csv'), 'order', null, { ...opts, idForSku: ids });
  assert.ok(p.rows.filter((x) => x.sku === 'BL-01').every((x) => x.variantId === '222'));
  assert.ok(p.rows.filter((x) => x.sku === 'LC-RUST').every((x) => x.variantId === 'LC-RUST'), 'unknown SKU: the SKU itself');
});

test('a changed mapping is used; bad mappings → 400', () => {
  const t = fx('shopify-orders.csv');
  const map = { ...C.parse(t, 'order', null, opts).map, 'line discount': '' };
  const p = C.parse(t, 'order', JSON.stringify(map), opts);
  assert.equal(bySku(p.rows)['NT-BLK-L#1042'].price, 14999, 'no discount column: list price');
  const bad = (m, re) => assert.throws(() => C.parse(t, 'order', m, opts), (e) => e.status === 400 && re.test(e.message));
  bad('{', /must be JSON/);
  bad('[1]', /JSON object/);
  bad({ ...map, colour: 'Name' }, /Unknown column/);
  bad({ ...map, qty: 'Quantity please' }, /not in the file/);
  bad({ ...map, time: '@now' }, /can’t be “When you import”/);   // a sale needs its own time
  bad({ ...map, qty: '' }, /Choose a column for Qty/);
  bad({ ...map, sku: '' }, /Choose a column for SKU/);   // Variant ID from the SKU needs one
  bad({ ...map, qty: 42 }, /Bad mapping for Qty/);
});

test('our own Stock log / Order log headers are recognised; other files get a suggestion from the aliases', () => {
  const own = C.preview('Time,Variant ID,SKU,Product,Variant,Stock before,Stock now,Price\n2026-11-19 10:00,42,S1,Serum,,5,3,"1,299"\n', '', null, opts);
  assert.equal(own.format, 'stock'); assert.equal(own.kind, 'stock'); assert.deepEqual(own.missing, []);
  assert.equal(own.sample[0].read.now, 3);
  const ord = C.preview('Time,Order,Variant ID,SKU,Qty,Unit price\n2026-11-19 10:00,#1,42,S1,2,500\n', '', null, opts);
  assert.equal(ord.format, 'order'); assert.equal(ord.kind, 'order');
  const other = C.preview('Date;Item code;On hand\n19/11/2026;AB-1;7\n', 'stock', null, opts);
  assert.equal(other.format, null); assert.equal(other.label, 'CSV file');
  assert.equal(other.map.time, 'Date'); assert.equal(other.map['variant id'], '');
  assert.deepEqual(other.missing, ['Variant ID', 'Stock now']);
  assert.equal(other.sample.length, 1); assert.equal(other.sample[0].read, null);
  const fixed = C.preview('Date;Item code;On hand\n19/11/2026;AB-1;7\n', 'stock', { time: 'Date', sku: 'Item code', 'variant id': '@sku', 'stock now': 'On hand' }, opts);
  assert.deepEqual(fixed.missing, []);
  assert.deepEqual({ id: fixed.sample[0].read.variantId, now: fixed.sample[0].read.now }, { id: 'AB-1', now: 7 });
});

test('preview: first 5 rows as they would be read, skip reasons, specials offered only where they fit; truncated head drops its last row', () => {
  const v = C.preview(fx('shopify-orders.csv'), '', null, opts);
  assert.equal(v.sample.length, 5);
  assert.deepEqual(v.sample.map((s) => s.skip), [null, null, null, null, 'cancelled']);
  assert.equal(v.sample[0].read.price, 13999);
  assert.equal(v.sample[0].raw.sku, 'NT-BLK-L');
  assert.ok(v.headers.includes('Lineitem sku') && v.headers.length === 79);
  assert.deepEqual(v.columns.find((c) => c.key === 'time').specials, [], 'orders: no "when you import"');
  assert.ok(v.rules.some((r) => /cancelled, voided and refunded/.test(r)));
  const pr = C.preview(fx('shopify-products.csv'), '', null, opts);
  assert.deepEqual(pr.sample.map((s) => s.skip), [null, null, null, 'untracked', 'inactive'], 'image row not shown');
  assert.deepEqual(pr.columns.find((c) => c.key === 'variant').specials.map((s) => s.value), ['@options']);
  const plain = C.preview('Time,Variant ID,Stock now\n2026-11-19,1,3\n', 'stock', null, opts);
  assert.deepEqual(plain.columns.find((c) => c.key === 'variant').specials, [], 'no Option1 Value column: no option values');
  const head = C.preview('Time,Variant ID,Stock now\n2026-11-19,1,3\n2026-11-19,2,"4', 'stock', null, { ...opts, truncated: true });
  assert.equal(head.sample.length, 1);
  assert.throws(() => C.preview('', 'stock', null, opts), /empty/);
});

test('remembered mapping: per store folder, per header set (any order), last 50 kept, a bad file starts empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-csvmap-')); scope.useDir(dir);
  try {
    const head = ['Date', 'Item code', 'On hand'];
    assert.equal(C.remembered(head), null);
    C.remember(head, 'stock', { time: 'Date', 'variant id': '@sku', sku: 'Item code', 'stock now': 'On hand' }, 1);
    assert.equal(C.remembered(['On hand', 'item_code', 'DATE']).map.sku, 'Item code', 'same set, other order and case');
    const p = C.parse('Date,Item code,On hand\n19/11/2026,AB-1,7\n', 'stock', null, { ...opts, remembered: C.remembered(head) });
    assert.equal(p.rows[0].now, 7);
    const v = C.preview('Date,Item code,On hand\n19/11/2026,AB-1,7\n', '', null, { ...opts, remembered: C.remembered(head) });
    assert.equal(v.remembered, true); assert.equal(v.kind, 'stock');
    for (let i = 0; i < 55; i++) C.remember([`h${i}`], 'order', {}, 100 + i);
    const kept = JSON.parse(fs.readFileSync(path.join(dir, C.FILE_NAME), 'utf8'));
    assert.equal(Object.keys(kept.sets).length, 50);
    assert.equal(C.remembered(head), null, 'oldest dropped');
    fs.writeFileSync(path.join(dir, C.FILE_NAME), '{not json');
    assert.equal(C.remembered(['h54']), null);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith(C.FILE_NAME + '.corrupt-')), 'bad file set aside');
    C.remember(head, 'stock', { time: 'Date' }, 2);
    assert.equal(C.remembered(head).map.time, 'Date');
  } finally { scope.useDir(null); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('headOf reads only the header row (quoted newlines inside it are fine)', () => {
  assert.deepEqual(C.headOf('"A\nB",C\n1,2\n'), ['A\nB', 'C']);
  assert.deepEqual(C.formatOf(C.headOf(fx('shopify-products.csv'))).format, 'shopify-products');
  assert.equal(C.formatOf(C.headOf(fx('shopify-orders.csv'))).format, 'shopify-orders');
});
