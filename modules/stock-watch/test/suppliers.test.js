'use strict';
/* SW-040 suppliers (LOGIC.md §6c): rounding to MOQ and case pack, supplier lead time, which supplier a variant has,
   CSV in and out, the store file, and the routes (admin-only writes, same-site, per-supplier PO CSV). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-suppliers-'));
const E = require('../src/engine');
const H = require('../src/helpers');
const R = require('../src/supplier-rules');
const SUP = require('../src/suppliers');
require('../src/scope').useDir(process.env.DATA_DIR);   // module on its own: one store folder

const D = E.DAY;
const now = Date.parse('2026-11-19T06:00:00Z');
/* 4 a day for 28 days at ₹500 (cost ₹200), `left` in stock now: rate 4/day */
function fixture(left = 10, vendor = 'Brass Co') {
  const stock = [
    { t: now - 29 * D, variantId: 'v1', sku: 'S1', product: 'Lamp', variant: '', before: 200, now: 200, price: 500, cost: 200, vendor },
    { t: now - D, variantId: 'v1', before: 30, now: left },
  ];
  const orders = [];
  for (let i = 0; i < 28; i++) orders.push({ t: now - 28 * D + i * D + 3600e3, order: '#' + i, variantId: 'v1', sku: 'S1', qty: 4, price: 500 });
  return { stock, orders };
}
const row = (f, sups, S = {}) => E.report(f.stock, f.orders, S, { now, suppliers: sups }).products[0];

/* ---------- the rule ---------- */
test('roundOrder: up to the MOQ, then whole case packs; nothing due stays 0', () => {
  const cases = [
    [150, { moq: null, pack: null }, 150, 0],
    [150, { moq: 200, pack: null }, 200, 50],
    [150, { moq: null, pack: 12 }, 156, 6],
    [150, { moq: 200, pack: 12 }, 204, 54],     // MOQ 200 is not a whole number of cases: 17 cases
    [144, { moq: 10, pack: 12 }, 144, 0],       // already whole cases
    [3, { moq: 1, pack: 1 }, 3, 0],
    [0, { moq: 50, pack: 12 }, 0, 0],           // no order due: never pushed to a minimum
    [-5, { moq: 50, pack: 12 }, 0, 0],
    [2.2, { moq: null, pack: 4 }, 4, 1],        // a fraction is rounded up first (3), then to the case
  ];
  for (const [q, s, want, extra] of cases) assert.deepEqual(R.roundOrder(q, s), { qty: want, extra }, `${q} with ${JSON.stringify(s)}`);
  assert.deepEqual(R.roundOrder(7, null), { qty: 7, extra: 0 });
});

test('validate: names trimmed, terms whole numbers in range or blank', () => {
  assert.deepEqual(R.validate({ name: '  Brass   Co ', leadDays: '12', moq: '', pack: 6 }).value, { name: 'Brass Co', leadDays: 12, moq: null, pack: 6 });
  assert.match(R.validate({ name: '' }).error, /needs a name/);
  assert.match(R.validate({ name: 'X', leadDays: 200 }).error, /Lead time must be a whole number from 0 to 180/);
  assert.match(R.validate({ name: 'X', pack: 0 }).error, /Case pack/);
  assert.match(R.validate({ name: 'X', moq: 2.5 }).error, /MOQ/);
  assert.match(R.validate({ name: 'X', moq: 'ten' }).error, /MOQ/);
  assert.equal(R.validate({ name: 'X'.repeat(80) }).value.name.length, R.NAME_MAX);
});

/* ---------- the engine ---------- */
test('engine: supplier lead time replaces the store’s for status, qty and order-by; MOQ + pack round the qty up', () => {
  const f = fixture(44);   // 44 in stock at 4/day = 11 days left
  const base = row(f, null);
  assert.equal(base.status, 'Order this week');   // 11 > 7 + 3, ≤ 17
  const rate = base.perDay;   // ≈ 4 (the in-stock rate, LOGIC §3)
  assert.equal(base.orderQty, Math.ceil(rate * 40 - 44));
  assert.equal(base.supplier, undefined); assert.equal(base.leadDays, undefined);
  const sups = R.resolve(f.stock, null, { suppliers: { 'brass co': { name: 'Brass Co', leadDays: 14, moq: 200, pack: 12 } }, map: {} });
  const p = row(f, sups);
  assert.equal(p.supplier, 'Brass Co'); assert.equal(p.leadDays, 14);
  assert.equal(p.status, 'Order now', '11 days left ≤ 14 + 3: order now with a 14-day supplier');
  /* raw ≈ 4 × (14 + 30 + 3) − 44 = 144 → MOQ 200 → 17 cases of 12 = 204 */
  const raw = Math.ceil(rate * 47 - 44);
  assert.ok(raw < 200);
  assert.equal(p.orderQty, 204); assert.equal(p.packExtra, 204 - raw); assert.equal(p.packExtraValue, (204 - raw) * 200);
  assert.equal(p.orderValue, 204 * 200);
  const r = H.enrich(E.report(f.stock, f.orders, {}, { now, suppliers: sups }));
  assert.match(r.products[0].why, /order by today · supplier takes 14 d$/);
  assert.equal(r.totals.packExtraValue, (204 - raw) * 200);
  /* overstock need uses the supplier's lead: rate × (14 + 30 + 3) */
  const big = row(fixture(500), sups);
  assert.equal(big.excessUnits, Math.floor(500 - big.perDay * 47));
});

test('engine: a product with nothing to order is never rounded up; blank lead keeps the store’s', () => {
  const f = fixture(1000);
  const sups = R.resolve(f.stock, null, { suppliers: { 'brass co': { name: 'Brass Co', leadDays: null, moq: 500, pack: 12 } }, map: {} });
  const p = row(f, sups);
  assert.equal(p.status, 'OK'); assert.equal(p.orderQty, 0); assert.equal(p.packExtra, undefined);
  assert.equal(p.leadDays, undefined, 'no supplier lead: the store’s lead time');
  const q = row(fixture(10), sups);
  assert.equal(q.orderQty, 504);   // MOQ 500 → 42 cases of 12
});

test('resolve: SKU map beats the Shopify vendor, a variant ID works too, names match whatever their case', () => {
  const stock = [
    { t: 1, variantId: 'a', sku: 'SKU-A', vendor: 'Vendor One' },
    { t: 1, variantId: 'b', sku: 'SKU-B', vendor: 'Vendor One' },
    { t: 1, variantId: 'c', sku: '', vendor: '' },
    { t: 1, variantId: 'd', sku: 'SKU-D' },
  ];
  const data = { suppliers: { 'vendor two': { name: 'Vendor Two', leadDays: 5, moq: null, pack: 6 }, 'vendor one': { name: 'Vendor One', leadDays: 9, moq: null, pack: null } },
    map: { 'SKU-B': 'VENDOR TWO', c: 'vendor two' } };
  const r = R.resolve(stock, null, data);
  assert.deepEqual({ ...r.a }, { name: 'Vendor One', leadDays: 9, moq: null, pack: null, from: 'vendor' });
  assert.deepEqual({ ...r.b }, { name: 'Vendor Two', leadDays: 5, moq: null, pack: 6, from: 'map' });
  assert.equal(r.c.name, 'Vendor Two', 'mapped by variant ID');
  assert.equal(r.d, undefined, 'no vendor, not mapped: no supplier');
  const cat = { a: { sku: 'SKU-A', vendor: 'Catalog Vendor' } };
  assert.equal(R.resolve(stock, cat, data).a.name, 'Catalog Vendor', 'the catalog (Shopify) vendor wins over old stock rows');
  const u = R.usage(r, data);
  assert.deepEqual(u.map((x) => [x.name, x.products, x.set]), [['Vendor Two', 2, true], ['Vendor One', 1, true]]);
  assert.equal(Object.getPrototypeOf(R.resolve([{ t: 1, variantId: 'constructor', vendor: 'V' }], null, {})), null);
});

test('CSV: supplier table and SKU map read back what was written; bad rows skipped with a reason', () => {
  const sup = H.csvText(R.supLines([{ name: 'Brass Co', leadDays: 12, moq: null, pack: 6 }])).replace(/^﻿/, '');
  const back = R.parseSuppliers(sup);
  assert.deepEqual(back.rows, [{ name: 'Brass Co', leadDays: 12, moq: null, pack: 6 }]);
  const semi = R.parseSuppliers('supplier;lead time;moq;case pack\nA;3;10;\nB;x;;\n;1;;');
  assert.deepEqual(semi.rows.map((x) => x.name), ['A']);
  assert.equal(semi.skipped.length, 2);
  assert.match(semi.skipped[0].error, /B: Lead time/);
  assert.equal(R.parseSuppliers('foo,bar\n1,2').ok, false);
  const m = R.parseMap('SKU,Variant ID,Product,Supplier\nS1,1,Lamp,Brass Co\n,2,Vase,\n,,x,y');
  assert.deepEqual(m.rows, [{ sku: 'S1', supplier: 'Brass Co' }, { sku: '2', supplier: '' }]);
  assert.equal(m.skipped.length, 1);
  assert.equal(R.parseMap('SKU\nS1').ok, false);
});

/* ---------- the store file ---------- */
test('store: replace / merge / map; seeded demo terms go when real data arrives, edited ones stay', () => {
  SUP.clear();
  assert.equal(SUP.replace([{ name: 'A', leadDays: 3 }, { name: 'a', moq: 2 }]).ok, false, 'same name twice');
  assert.match(SUP.replace([{ name: 'A', leadDays: 999 }]).error, /Lead time/);
  let r = SUP.replace([{ name: 'A', leadDays: 3 }, { name: 'Only a vendor' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(SUP.all().suppliers), ['a'], 'a supplier with no terms isn’t stored');
  assert.deepEqual(r.changes, [{ key: 'Supplier A', old: null, new: 'lead 3 d' }]);
  r = SUP.merge([{ name: 'B', leadDays: null, moq: 5, pack: 5 }, { name: 'A', leadDays: null, moq: null, pack: null }]);
  assert.deepEqual(Object.keys(SUP.all().suppliers), ['b'], 'all-blank row removes the terms');
  assert.equal(SUP.setMap([{ sku: 'S1', supplier: 'B' }, { sku: 'S2', supplier: 'B' }]).set, 2);
  assert.equal(SUP.setMap([{ sku: 'S1', supplier: '' }]).removed, 1);
  assert.deepEqual(SUP.all().map, { S2: 'B' });
  assert.equal(SUP.setMap([{ sku: '__proto__', supplier: 'B' }]).ok, false);
  const onDisk = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'suppliers.json'), 'utf8'));
  assert.deepEqual(Object.keys(onDisk.suppliers), ['b']);
  SUP.clear();
  assert.equal(SUP.seedDemo([{ name: 'D1', leadDays: 9 }, { name: 'D2', pack: 6 }]), true);
  assert.equal(SUP.seedDemo([{ name: 'D3', leadDays: 1 }]), false, 'never over a table that has suppliers');
  SUP.replace([{ name: 'D1', leadDays: 9 }, { name: 'D2', pack: 12 }]);   // D1 untouched, D2 edited
  assert.equal(SUP.clearDemo(), 1);
  assert.deepEqual(Object.keys(SUP.all().suppliers), ['d2']);
});

/* ---------- the routes: the real server ---------- */
const SERVER = path.join(__dirname, '..', 'server.js');
const ADMIN = 'admin password 123', VIEW = 'view password 456';
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject); });
async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-sup-srv-'));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: ADMIN, VIEW_PASSWORD: VIEW }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => { const on = (c) => { out += c; if (out.includes('Stock-out Watch on')) resolve(); }; child.stdout.on('data', on); child.stderr.on('data', on); exited.then(resolve); });
  const base = `http://127.0.0.1:${port}`;
  return { dir, log: () => out, req: (p, opt = {}) => fetch(base + p, opt), stop: async () => { child.kill(); await exited; fs.rmSync(dir, { recursive: true, force: true }); } };
}
const basic = (pass) => ({ authorization: 'Basic ' + Buffer.from(`x:${pass}`).toString('base64') });
const A = { ...basic(ADMIN), 'content-type': 'application/json' };

test('routes: demo suppliers listed; admin edits are logged; view-only and cross-site writes refused', async (t) => {
  const s = await start(); t.after(s.stop);
  const g = await (await s.req('/api/suppliers', { headers: basic(VIEW) })).json();   // view-only may read
  assert.ok(g.suppliers.length >= 5, 'demo vendors with terms');
  assert.ok(g.suppliers.every((x) => x.products > 0));
  const writes = [['PUT', '/api/suppliers', JSON.stringify({ suppliers: [] })], ['POST', '/api/suppliers/map', JSON.stringify({ items: [{ sku: 'x', supplier: 'y' }] })], ['POST', '/api/suppliers/import?kind=suppliers', 'Supplier\nX']];
  for (const [method, p, body] of writes) {
    const v = await s.req(p, { method, headers: basic(VIEW), body });
    assert.equal(v.status, 403, `view ${method} ${p}`);
    const x = await s.req(p, { method, headers: { ...A, 'sec-fetch-site': 'cross-site' }, body });
    assert.equal(x.status, 403, `cross-site ${method} ${p}`);
    assert.match((await x.json()).error, /Cross-site/);
  }
  assert.equal((await (await s.req('/api/suppliers', { headers: basic(ADMIN) })).json()).suppliers.length, g.suppliers.length, 'nothing changed');
  const list = g.suppliers.map((x) => ({ name: x.name, leadDays: x.leadDays, moq: x.moq, pack: x.pack }));
  list[0].pack = 24;
  const put = await s.req('/api/suppliers', { method: 'PUT', headers: A, body: JSON.stringify({ suppliers: list }) });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).changed, 1);
  const bad = await s.req('/api/suppliers', { method: 'PUT', headers: A, body: JSON.stringify({ suppliers: [{ name: 'X', moq: -1 }] }) });
  assert.equal(bad.status, 400);
  const set = await (await s.req('/api/settings', { headers: basic(ADMIN) })).json();
  assert.equal(set.changes[0].key, `Supplier ${list[0].name}`);
  assert.match(set.changes[0].new, /case 24/);
  const sf = JSON.parse(fs.readFileSync(path.join(s.dir, 'stores', 'sammsara-demo', 'suppliers.json'), 'utf8'));
  assert.equal(sf.suppliers[list[0].name.toLowerCase()].pack, 24);
  /* the report uses it: every row of that supplier with an order is a whole number of cases of 24 */
  const r = await (await s.req('/api/report?days=30', { headers: basic(ADMIN) })).json();
  const mine = r.reorder.filter((p) => p.supplier === list[0].name && p.orderQty > 0);
  assert.ok(mine.length > 0);
  assert.ok(mine.every((p) => p.orderQty % 24 === 0), 'rounded to the new case pack');
  /* the backup export carries suppliers.json */
  const bk = await (await s.req('/api/export/backup.json', { headers: basic(ADMIN) })).json();
  assert.equal(bk.sideFiles['suppliers.json'].suppliers[list[0].name.toLowerCase()].pack, 24);
});

test('routes: map + CSV import/export; per-supplier PO CSV = that supplier’s lines to order', async (t) => {
  const s = await start(); t.after(s.stop);
  const r = await (await s.req('/api/report?days=30', { headers: basic(ADMIN) })).json();
  const p = r.reorder.find((x) => x.orderQty > 0 && x.sku);
  const imp = await s.req('/api/suppliers/import?kind=map', { method: 'POST', headers: { ...basic(ADMIN), 'content-type': 'text/csv' }, body: `SKU,Supplier\n${p.sku},Fresh Supplier\n,\n` });
  assert.equal(imp.status, 200);
  assert.equal((await imp.json()).read, 1);
  const imp2 = await s.req('/api/suppliers/import?kind=suppliers', { method: 'POST', headers: { ...basic(ADMIN), 'content-type': 'text/csv' }, body: 'Supplier,Lead time (days),MOQ (units),Case pack (units)\nFresh Supplier,3,1000,\n' });
  assert.equal(imp2.status, 200);
  assert.equal((await s.req('/api/suppliers/import?kind=suppliers', { method: 'POST', headers: { ...basic(ADMIN), 'content-type': 'text/csv' }, body: 'nothing,here\n1,2' })).status, 400);
  const r2 = await (await s.req('/api/report?days=30', { headers: basic(ADMIN) })).json();
  const q = r2.products.find((x) => x.id === p.id);
  assert.equal(q.supplier, 'Fresh Supplier'); assert.equal(q.leadDays, 3);
  if (q.orderQty > 0) assert.ok(q.orderQty >= 1000, 'MOQ 1000');
  const mapCsv = await s.req('/api/export/suppliers.csv?kind=map', { headers: basic(VIEW) });
  assert.equal(mapCsv.status, 200);
  assert.match(mapCsv.headers.get('content-disposition'), /supplier-map-sammsara-demo-\d{4}-\d{2}-\d{2}\.csv/);
  const mt = (await mapCsv.text()).replace(/^﻿/, '');
  assert.match(mt.split('\n')[0], /^"SKU","Variant ID","Product","Supplier","From"/);
  assert.ok(mt.includes(`"${p.sku}","${p.id}"`) && mt.includes('"Fresh Supplier","set here"'));
  const supCsv = (await (await s.req('/api/export/suppliers.csv?kind=suppliers', { headers: basic(ADMIN) })).text()).replace(/^﻿/, '');
  assert.ok(supCsv.includes('"Fresh Supplier","3","1000",""'));
  /* per-supplier PO CSV */
  const name = r2.reorder.find((x) => x.orderQty > 0 && x.supplier).supplier;
  const want = r2.reorder.filter((x) => x.orderQty > 0 && x.supplier === name);
  const po = await s.req(`/api/export/reorder.csv?days=30&filter=all&supplier=${encodeURIComponent(name)}`, { headers: basic(ADMIN) });
  assert.match(po.headers.get('content-disposition'), /filename="po-[a-z0-9-]+-sammsara-demo-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = (await po.text()).replace(/^﻿/, '').split('\n').slice(1);
  assert.equal(lines.length, want.length);
  assert.ok(lines.every((l) => l.startsWith(`"${name}",`)));
  const total = lines.reduce((a, l) => a + +l.split('","')[6], 0);
  assert.equal(total, want.reduce((a, x) => a + x.orderValue, 0));
});
