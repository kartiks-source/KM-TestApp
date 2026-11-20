'use strict';
/* Storage and the server routes that write to it: run on throwaway DATA_DIRs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MOD = path.join(__dirname, '..');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-store-'));

/** A fresh copy of src/store.js reading from `dir` (the module keeps its state at file level). */
function freshStore(dir) {
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../src/store')];
  require('../src/scope').useDir(dir);   // the module on its own: `dir` is the store's folder
  return require('../src/store');
}
/** Where a server keeps a store's file (multi-store, ADR-0015): DATA_DIR/stores/<id>/store.json. */
const SF = (dir, id = 'sammsara-demo') => path.join(dir, 'stores', id, 'store.json');

/** Start server.js as its own process on a free port. Resolves once it's listening. */
function startServer(dir, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: MOD, env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let up = false;
    child.stdout.on('data', (b) => {
      out += b;
      const m = !up && out.match(/http:\/\/localhost:(\d+)/);
      if (m) { up = true; resolve({ child, port: +m[1], base: `http://127.0.0.1:${m[1]}`, log: () => out }); }
    });
    child.stderr.on('data', (b) => { out += b; });
    child.on('exit', (code) => reject(Object.assign(new Error(`server exited ${code}: ${out}`), { code, out })));
  });
}
/** SIGTERM and wait for the exit code. */
const stop = (s) => new Promise((resolve) => { s.child.removeAllListeners('exit'); s.child.on('exit', (code) => resolve(code)); s.child.kill('SIGTERM'); });
/** Run server.js expecting it to exit by itself. */
const runToExit = (dir, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['server.js'], { cwd: MOD, env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: '0', ...env } });
  let out = ''; child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { out += b; });
  child.on('exit', (code) => resolve({ code, out }));
});

/* ---------- SW-004: a bad file is never silently replaced ---------- */

test('missing store.json → blank store', () => {
  const s = freshStore(tmpDir());
  const d = s.load();
  assert.equal(d.source, 'empty'); assert.deepEqual(d.stock, []);
  assert.equal(s.health().ok, true);
});

test('corrupt store.json with no backup → quarantined copy, load throws, original untouched', () => {
  const dir = tmpDir(); const file = path.join(dir, 'store.json');
  fs.writeFileSync(file, '{"stock": [1, 2');
  const s = freshStore(dir);
  assert.throws(() => s.load(), s.StoreLoadError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"stock": [1, 2');
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith('store.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"stock": [1, 2');
  assert.equal(s.health().ok, false);
});

test('corrupt store.json with a good .bak → loads the backup, corrupt copy kept', () => {
  const dir = tmpDir();
  const s1 = freshStore(dir);
  s1.add('stock', [{ t: Date.now(), variantId: '1', before: 1, now: 2 }]); s1.save(true);
  s1.add('stock', [{ t: Date.now() + 1, variantId: '1', before: 2, now: 3 }]); s1.save(true);   // first file becomes .bak
  assert.ok(fs.existsSync(path.join(dir, 'store.json.bak')));
  fs.writeFileSync(path.join(dir, 'store.json'), 'garbage');
  const s2 = freshStore(dir);
  const d = s2.load();
  assert.equal(d.stock.length, 1);   // the save before the last one
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('store.json.corrupt-')).length, 1);
});

test('a save that fails is reported and retried, never thrown', () => {
  if (process.getuid?.() === 0) return;   // root ignores folder permissions
  const dir = tmpDir();
  const s = freshStore(dir);
  s.load();
  fs.chmodSync(dir, 0o555);
  try {
    assert.equal(s.save(true), false);
    const h = s.health();
    assert.equal(h.ok, false); assert.ok(h.lastSaveError.message); assert.equal(h.pendingSave, true);
    fs.chmodSync(dir, 0o755);
    assert.equal(s.save(true), true);
    assert.equal(s.health().ok, true);
  } finally { fs.chmodSync(dir, 0o755); }
});

test('server: corrupt store.json and no backup → exits 1 without writing', async () => {
  const dir = tmpDir(); const file = SF(dir, 'second-demo');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  const r = await runToExit(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /Refusing to start/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json');
});

test('server: read-only DATA_DIR → keeps running, /health 503', async () => {
  if (process.getuid?.() === 0) return;
  const dir = tmpDir(); fs.chmodSync(dir, 0o555);
  const s = await startServer(dir);
  try {
    const r = await fetch(s.base + '/health');
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /Saving data fails/);
    assert.equal((await fetch(s.base + '/api/settings')).status, 200);   // still serving
  } finally { fs.chmodSync(dir, 0o755); await stop(s); }
});

test('server: SIGTERM saves and exits 0', async () => {
  const dir = tmpDir();
  const s = await startServer(dir);
  assert.equal((await fetch(s.base + '/health')).status, 200);
  const code = await stop(s);
  assert.equal(code, 0);
  assert.match(s.log(), /SIGTERM: stopping/);
  assert.ok(fs.existsSync(SF(dir)) && fs.existsSync(SF(dir, 'second-demo')), 'every store saved');
});


/* ---------- SW-007: demo data never mixes with real data ---------- */

test('first real row clears the demo and marks the store as ever live', () => {
  const s = freshStore(tmpDir());
  s.replaceAll([{ t: Date.now(), variantId: 'demo1', before: 1, now: 2 }], [{ t: Date.now(), order: '#d', variantId: 'demo1', qty: 1, price: 1 }], 'demo');
  s.add('orders', [{ t: Date.now(), order: '#1', variantId: '9', qty: 2, price: 100 }]);
  const d = s.load();
  assert.equal(d.source, 'live'); assert.equal(d.everLive, true);
  assert.deepEqual(d.orders.map((o) => o.order), ['#1']);
  assert.equal(d.stock.length, 0);
});

test('server: demo → ingest → restart with a new demo version → real row still there', async () => {
  const dir = tmpDir(); const file = SF(dir);
  let s = await startServer(dir);
  const set = await (await fetch(s.base + '/api/settings')).json();
  assert.equal(set.source, 'demo');
  const r = await fetch(s.base + '/ingest/order', { method: 'POST', headers: { 'x-ingest-key': set.settings.ingestKey, 'content-type': 'application/json' },
    body: JSON.stringify({ order: '#REAL1', variant_id: '777', qty: 3, price: 250 }) });
  assert.equal(r.status, 200);
  assert.equal(await stop(s), 0);
  let j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.source, 'live'); assert.equal(j.everLive, true);
  assert.deepEqual(j.orders.map((o) => o.order), ['#REAL1']);
  j.settings.demoVersion = 'an-older-demo'; fs.writeFileSync(file, JSON.stringify(j));   // as if the demo version were bumped
  s = await startServer(dir);
  await stop(s);
  j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.source, 'live');
  assert.deepEqual(j.orders.map((o) => o.order), ['#REAL1']);
});

test('server: cleared live store stays empty after restart (no demo)', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ stock: [], orders: [], source: 'empty', everLive: true, settings: {} }));   // single-store layout: moved into the first store
  const s = await startServer(dir);
  await stop(s);
  const j = JSON.parse(fs.readFileSync(SF(dir), 'utf8'));
  assert.equal(j.source, 'empty'); assert.equal(j.orders.length, 0);
});

/* ---------- SW-006: one source of truth per store ---------- */

test('every stored row carries its source', () => {
  const s = freshStore(tmpDir());
  s.add('orders', [{ t: Date.now(), order: '#1', variantId: '9', qty: 1, price: 10 }], 'flow');
  s.add('stock', [{ t: Date.now(), variantId: '9', before: 1, now: 0 }], 'csv');
  s.replaceOrders(['#2'], [{ t: Date.now(), order: '#2', line: '5', variantId: '9', qty: 1, price: 10 }]);
  const d = s.load();
  assert.deepEqual(d.orders.map((o) => o.src), ['flow', 'shopify']);
  assert.deepEqual(d.stock.map((o) => o.src), ['csv']);
});

test('the same order via Flow and then the Shopify pull counts once in totals.sold', () => {
  const E = require('../src/engine');
  const s = freshStore(tmpDir()); const t = Date.now() - 3600e3;
  s.add('orders', [{ t, order: '#1001', variantId: '9', qty: 2, price: 500 }], 'flow');
  s.add('orders', [{ t: t + 60e3, order: '#1001', variantId: '9', qty: 2, price: 500 }], 'csv');   // same sale from a CSV: same key
  s.replaceOrders(['#1001'], [{ t, order: '#1001', line: '77', variantId: '9', qty: 2, price: 500 }]);
  const d = s.load();
  assert.equal(d.orders.length, 1);
  assert.equal(E.report(d.stock, d.orders, {}, { now: Date.now() }).totals.sold, 1000);
});

test('server: Shopify connected → Flow ingest, CSV import and Sheet sync refused with 409', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ stock: [], orders: [], source: 'empty', settings: { ingestKey: 'k123' } }));
  // client ID without a secret: "connected" for the guards, but no pull can reach the network
  const s = await startServer(dir, { ADMIN_PASSWORD: 'pw', SHOPIFY_STORE: 'test-store', SHOPIFY_CLIENT_ID: 'x' });
  const auth = { authorization: 'Basic ' + Buffer.from('u:pw').toString('base64') };
  try {
    let r = await fetch(s.base + '/ingest/order', { method: 'POST', headers: { 'x-ingest-key': 'k123' }, body: JSON.stringify({ order: '#1', variant_id: '1', qty: 1 }) });
    assert.equal(r.status, 409); assert.match((await r.json()).error, /only data source/);
    r = await fetch(s.base + '/api/import?kind=order', { method: 'POST', headers: auth, body: 'time,order,variant id,sku,qty,unit price\n2026-11-18 10:00,#1,1,A,1,10' });
    assert.equal(r.status, 409);
    r = await fetch(s.base + '/api/sync', { method: 'POST', headers: auth });
    assert.equal(r.status, 409);
    r = await fetch(s.base + '/ingest/order', { method: 'POST', headers: { 'x-ingest-key': 'wrong' }, body: '{}' });
    assert.equal(r.status, 401);   // the key is still checked first
  } finally { await stop(s); }
  const j = JSON.parse(fs.readFileSync(SF(dir, 'test-store'), 'utf8'));
  assert.equal(j.orders.length, 0);
});

test('server: Clear and import wait while a Shopify pull runs (409)', async () => {
  freshStore(tmpDir());
  delete require.cache[require.resolve('../server')];
  process.env.SHOPIFY_CLIENT_ID = 'x'; process.env.SHOPIFY_STORE = 'test-store';
  const shopify = require('../src/shopify');
  const real = shopify.pullStock;
  let finish; shopify.pullStock = () => new Promise((r) => { finish = () => r({ rows: [], lastQty: {}, catalog: {} }); });
  const { server, syncShopify } = require('../server');
  const run = syncShopify('test-store').catch(() => {});
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(base + '/api/clear', { method: 'POST' });
    assert.equal(r.status, 409); assert.match((await r.json()).error, /pull is running/);
    r = await fetch(base + '/api/import?kind=order', { method: 'POST', body: 'x' });
    assert.equal(r.status, 409);
  } finally {
    finish(); await run; shopify.pullStock = real; delete process.env.SHOPIFY_CLIENT_ID; delete process.env.SHOPIFY_STORE;
    await new Promise((r) => server.close(r));
  }
});

/* ---------- SW-002: current stock never disappears; inactive items left out ---------- */
const E = require('../src/engine');
const SH = require('../src/shopify');
const DAYMS = 864e5;

test('a variant unchanged for 130 days keeps its stock and counts in overstock ₹', () => {
  const s = freshStore(tmpDir()); const now = Date.now();
  s.add('stock', [{ t: now - 130 * DAYMS, variantId: 'A', product: 'Dead stock', before: null, now: 50, price: 1000, cost: 400 },
    { t: now - 2 * DAYMS, variantId: 'B', product: 'Seller', before: 10, now: 9, price: 100 }], 'csv');
  s.prune(true, now);
  const d = s.load();
  assert.deepEqual(d.stock.map((r) => r.variantId).sort(), ['A', 'B']);
  const r = E.report(d.stock, d.orders, {}, { now, catalog: d.catalog });
  const a = r.products.find((p) => p.id === 'A');
  assert.equal(a.stock, 50); assert.equal(a.overstock, true); assert.equal(a.excessValue, 20000);
  assert.equal(r.totals.excessValue >= 20000, true);
});

test('a stock-out open for 130 days keeps its opening row and stays in the out-now list', () => {
  const s = freshStore(tmpDir()); const now = Date.now();
  s.add('stock', [
    { t: now - 140 * DAYMS, variantId: 'X', before: 3, now: 5 },
    { t: now - 130 * DAYMS, variantId: 'X', before: 5, now: 0 },
    { t: now - 125 * DAYMS, variantId: 'X', before: 0, now: -1 },
  ], 'csv');
  s.prune(true, now);
  const d = s.load();
  assert.deepEqual(d.stock.map((r) => r.t - now).sort((a, b) => a - b), [-130 * DAYMS, -125 * DAYMS]);
  const r = E.report(d.stock, d.orders, {}, { now });
  const so = r.stockouts.find((x) => x.id === 'X');
  assert.equal(so.open, true); assert.equal(so.start, now - 130 * DAYMS);
  assert.equal(r.totals.stillOut, 1);
  assert.equal(r.products.find((p) => p.id === 'X').stock, -1);
});

const gv = (id, qty, extra = {}, product = {}) => ({ id: `gid://shopify/ProductVariant/${id}`, sku: `S${id}`, title: 'Default Title', price: '1000.00', inventoryQuantity: qty,
  inventoryItem: { tracked: true, unitCost: { amount: '400.00' } }, product: { id: `gid://shopify/Product/${id}0`, title: `P${id}`, status: 'ACTIVE', productType: 'Decor', tags: ['gift'], ...product }, ...extra });

test('pull: catalog lists every variant with status; inactive ones get no stock rows', () => {
  const r = SH.diffStock([gv(1, 5), gv(2, 7, {}, { status: 'ARCHIVED' }), gv(3, 4, { inventoryItem: { tracked: false } })], {}, 1000);
  assert.deepEqual(r.rows.map((x) => x.variantId), ['1']);
  assert.deepEqual(Object.keys(r.catalog), ['1', '2', '3']);
  assert.deepEqual([r.catalog['1'].active, r.catalog['2'].status, r.catalog['3'].status], [true, 'ARCHIVED', 'UNTRACKED']);
  assert.deepEqual([r.catalog['1'].productId, r.catalog['1'].tags, r.catalog['1'].cost, r.catalog['1'].stock], ['10', ['gift'], 400, 5]);
});

test('an archived variant is left out of overstock and reorder, and shown as excluded', () => {
  const s = freshStore(tmpDir()); const now = Date.now();
  const p = SH.diffStock([gv(1, 500), gv(2, 100, {}, { status: 'ARCHIVED' })], {}, now - 3 * DAYMS);
  s.add('stock', p.rows, 'shopify'); s.setCatalog(p.catalog, now - 3 * DAYMS);
  const d = s.load();
  const r = E.report(d.stock, d.orders, {}, { now, catalog: d.catalog });
  assert.equal(r.products.some((x) => x.id === '2'), false);
  assert.equal(r.reorder.some((x) => x.id === '2'), false);
  assert.equal(r.totals.excessValue, 500 * 400);   // variant 1 only
  assert.deepEqual(r.data.excluded, { variants: 1, pcs: 100, byStatus: { ARCHIVED: 1 } });
});

test('a cost change shows on the next pull without a stock move', () => {
  const s = freshStore(tmpDir()); const now = Date.now();
  const a = SH.diffStock([gv(1, 5)], {}, now - DAYMS);
  s.add('stock', a.rows, 'shopify'); s.setCatalog(a.catalog, now - DAYMS);
  const b = SH.diffStock([gv(1, 5, { inventoryItem: { tracked: true, unitCost: { amount: '650.00' } } })], a.lastQty, now);
  assert.equal(b.rows.length, 0);
  s.setCatalog(b.catalog, now);
  const d = s.load();
  assert.equal(E.report(d.stock, d.orders, {}, { now, catalog: d.catalog }).products.find((x) => x.id === '1').cost, 650);
});

test('catalog: inactive time is kept across pulls; deleted variants are tombstoned, then pruned after 120 days', () => {
  const s = freshStore(tmpDir()); const now = Date.now();
  s.add('stock', [{ t: now - 200 * DAYMS, variantId: '9', before: null, now: 4 }], 'shopify');
  s.setCatalog(SH.diffStock([gv(1, 5, {}, { status: 'DRAFT' })], {}, now - 10 * DAYMS).catalog, now - 10 * DAYMS);
  s.setCatalog(SH.diffStock([gv(1, 5, {}, { status: 'DRAFT' })], {}, now).catalog, now);
  let c = s.load().catalog;
  assert.equal(c['1'].inactiveSince, now - 10 * DAYMS);
  assert.equal(c['9'].status, 'DELETED');   // has rows, not returned by Shopify
  c['9'].inactiveSince = now - 121 * DAYMS;
  s.prune(true, now);
  c = s.load().catalog;
  assert.equal(c['9'], undefined);
  assert.equal(s.load().stock.some((r) => r.variantId === '9'), false);
});

test('a stock-out on a product that went inactive ends then, and is not "still out"', () => {
  const now = Date.now();
  const stock = [{ t: now - 20 * DAYMS, variantId: '1', before: 2, now: 0 }];
  const orders = [{ t: now - 25 * DAYMS, order: '#1', variantId: '1', qty: 10, price: 100 }];
  const catalog = { 1: { product: 'P', variant: '', stock: 0, active: false, status: 'ARCHIVED', inactiveSince: now - 15 * DAYMS } };
  const r = E.report(stock, orders, {}, { now, catalog });
  const so = r.stockouts.find((x) => x.id === '1');
  assert.equal(so.open, false); assert.equal(so.end, now - 15 * DAYMS); assert.equal(so.small, false);
  assert.equal(r.totals.stillOut, 0);
  assert.equal(r.products.find((x) => x.id === '1').status, 'Inactive');
});

/* ---------- SW-019: /status for uptime monitors ---------- */

test('server: /status is open, 200 without Shopify, and reports size and row counts', async () => {
  const s = await startServer(tmpDir());
  try {
    const r = await fetch(s.base + '/status');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true); assert.equal(j.stale, false); assert.equal(j.shopify, false);
    assert.ok(j.orderRows > 0); assert.ok(j.stockRows > 0);
    const rep = await (await fetch(s.base + '/api/report')).json();
    assert.deepEqual(rep.freshness, { shopify: false, lastPull: null, ageMin: null, stale: false, staleAfterMin: 45 });
  } finally { await stop(s); }
});

test('server: /status 503 when the last Shopify pull is over 45 min old, 200 when recent', async () => {
  for (const [ago, code] of [[50, 503], [5, 200]]) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ stock: [], orders: [], source: 'live', settings: {}, shopify: { lastSync: Date.now() - ago * 60e3 } }));
    const s = await startServer(dir, { ADMIN_PASSWORD: 'pw', SHOPIFY_STORE: 'test-store', SHOPIFY_CLIENT_ID: 'x' });
    try {
      const r = await fetch(s.base + '/status');
      assert.equal(r.status, code);
      const j = await r.json();
      assert.equal(j.stale, code === 503); assert.equal(j.ageMin, ago);
      assert.equal(JSON.stringify(j).includes('pw'), false);
      const rep = await (await fetch(s.base + '/api/report', { headers: { authorization: 'Basic ' + Buffer.from('u:pw').toString('base64') } })).json();
      assert.equal(rep.freshness.stale, code === 503);
    } finally { await stop(s); }
  }
});

/* ---------- SW-047: schemaVersion written and read ---------- */

test('schemaVersion: a new store is written with schemaVersion 1', () => {
  const dir = tmpDir(); const s = freshStore(dir);
  s.load(); assert.equal(s.save(true), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')).schemaVersion, s.SCHEMA_VERSION);
  assert.equal(s.SCHEMA_VERSION, 1);
});

test('schemaVersion: a file without it (Sprint 1 shape) loads as schema 1, rows kept, and is saved with it', () => {
  const dir = tmpDir(); const file = path.join(dir, 'store.json');
  fs.writeFileSync(file, JSON.stringify({ settings: { leadDays: 9 }, stock: [], orders: [{ t: Date.now(), order: '#1', variantId: '1', qty: 1, price: 5 }], source: 'live' }));
  const s = freshStore(dir);
  const d = s.load();
  assert.equal(d.schemaVersion, 1); assert.equal(d.orders.length, 1); assert.equal(d.settings.leadDays, 9);
  s.save(true);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(j.schemaVersion, 1); assert.equal(j.orders.length, 1);
});

test('schemaVersion: a file from a newer app is refused and never overwritten', () => {
  const dir = tmpDir(); const file = path.join(dir, 'store.json');
  const text = JSON.stringify({ schemaVersion: 2, settings: {}, stock: [], orders: [], source: 'live', future: { x: 1 } });
  fs.writeFileSync(file, text);
  const s = freshStore(dir);
  assert.throws(() => s.load(), (e) => e instanceof s.StoreLoadError && /schema 2.*reads up to schema 1/.test(e.message));
  assert.equal(s.health().ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.throws(() => s.migrate({ schemaVersion: 'x' }), /bad schemaVersion/);
});

test('server: a store file from a newer app → refuses to start, file untouched', async () => {
  const dir = tmpDir(); const file = SF(dir, 'second-demo');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify({ schemaVersion: 99, settings: {}, stock: [], orders: [], source: 'live' });
  fs.writeFileSync(file, text);
  const r = await runToExit(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /Refusing to start.*schema 99/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

/* ---------- SW-007: demo → live also drops Mark ordered and decisions made on the demo, in every path ---------- */

test('demo → live by Flow, Sheet, CSV or Shopify: demo rows, Mark ordered and decisions all go', () => {
  const onorder = require('../src/onorder'); const decide = require('../src/decide');
  const now = Date.now(), real = [{ t: now, order: '#R', variantId: '9', qty: 1, price: 10 }];
  const paths = {
    flow: (s) => s.add('orders', real.map((r) => ({ ...r })), 'flow'),
    sheet: (s) => s.add('stock', [{ t: now, variantId: '9', before: 1, now: 3 }], 'sheet'),
    csv: (s) => s.add('orders', real.map((r) => ({ ...r })), 'csv'),
    shopifyOrders: (s) => s.replaceOrders(['#R'], real.map((r) => ({ ...r })), 'shopify'),
    shopifyPull: (s) => s.endDemo(),   // pullOne() calls it before reading anything
  };
  for (const [name, go] of Object.entries(paths)) {
    const dir = tmpDir(); const s = freshStore(dir); onorder.reset(); decide.reset();
    s.replaceAll([{ t: now, variantId: 'demo1', before: 1, now: 2 }], [{ t: now, order: '#d', variantId: 'demo1', qty: 1, price: 1 }], 'demo');
    assert.equal(onorder.mark([{ id: 'demo1', qty: 5, eta: now + 864e5 }]).ok, true);
    assert.equal(decide.set('demo1', 'drop', 0.1).ok, true);
    go(s);
    assert.deepEqual(onorder.all(), {}, `${name}: Mark ordered cleared`);
    assert.deepEqual(decide.all(), {}, `${name}: decisions cleared`);
    assert.ok(!s.load().stock.concat(s.load().orders).some((r) => r.src === 'demo'), `${name}: no demo rows`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'onorder.json'), 'utf8')), {}, `${name}: on disk too`);
  }
});

test('a live store keeps its Mark ordered and decisions when more real rows arrive', () => {
  const onorder = require('../src/onorder'); const decide = require('../src/decide');
  const s = freshStore(tmpDir()); onorder.reset(); decide.reset();
  s.add('orders', [{ t: Date.now(), order: '#1', variantId: '9', qty: 1, price: 10 }], 'flow');
  onorder.mark([{ id: '9', qty: 5, eta: Date.now() + 864e5 }]); decide.set('9', 'keep', 1);
  s.add('orders', [{ t: Date.now(), order: '#2', variantId: '9', qty: 1, price: 10 }], 'flow');
  assert.equal(s.endDemo(), false);
  assert.ok(onorder.all()['9']); assert.ok(decide.all()['9']);
});

test('server: demo → Flow ingest or CSV import drops demo Mark ordered and decisions', async () => {
  for (const via of ['flow', 'import']) {
    const dir = tmpDir(); const s = await startServer(dir);
    try {
      const rep = await (await fetch(s.base + '/api/report')).json();
      const id = String(rep.products[0].id), slow = rep.decide[0];
      const eta = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
      assert.equal((await fetch(s.base + '/api/onorder', { method: 'POST', body: JSON.stringify({ items: [{ id, qty: 3, eta }] }) })).status, 200);
      if (slow) assert.equal((await fetch(s.base + '/api/decide', { method: 'POST', body: JSON.stringify({ id: slow.id, decision: 'keep' }) })).status, 200);
      if (via === 'flow') {
        const key = (await (await fetch(s.base + '/api/settings')).json()).settings.ingestKey;
        assert.equal((await fetch(s.base + '/ingest/order', { method: 'POST', headers: { 'x-ingest-key': key }, body: JSON.stringify({ order: '#REAL', variant_id: '777', qty: 1, price: 9 }) })).status, 200);
      } else {
        const csv = `Time,Order,Variant ID,SKU,Qty,Unit price\n${new Date().toISOString().slice(0, 16).replace('T', ' ')},#REAL,777,S,1,9\n`;
        const r = await fetch(s.base + '/api/import?kind=order', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: csv });
        assert.equal(r.status, 200, await r.clone().text());
      }
      assert.deepEqual((await (await fetch(s.base + '/api/onorder')).json()).onOrder, {}, `${via}: Mark ordered gone`);
      assert.deepEqual((await (await fetch(s.base + '/api/decide')).json()).decisions, {}, `${via}: decisions gone`);
      const after = await (await fetch(s.base + '/api/report')).json();
      assert.equal(after.source, 'live');
    } finally { await stop(s); }
  }
});

test('draft while sold out, reactivated on restock: ₹ lost for the draft days never comes back (final critic L1)', () => {
  const s = freshStore(tmpDir()); const H = 3600e3;
  const now = Date.parse('2026-11-20T06:30:00Z');
  const orders = [];
  for (let d = 26; d <= 60; d++) orders.push({ t: now - d * DAYMS + 5 * H, order: `#${d}`, variantId: '1', sku: 'S1', qty: 5, price: 1000 });
  s.add('orders', orders, 'shopify');
  let last = {};
  const pull = (qty, t, status = 'ACTIVE') => { const r = SH.diffStock([gv(1, qty, {}, { status })], last, t); s.add('stock', r.rows, 'shopify'); s.setCatalog(r.catalog, t); last = r.lastQty; };
  pull(40, now - 60 * DAYMS); pull(0, now - 25 * DAYMS); pull(0, now - 24 * DAYMS, 'DRAFT');
  const at = (t) => { const d = s.load(); return E.report(d.stock, d.orders, {}, { now: t, days: 30, catalog: d.catalog }); };
  const draft = at(now);
  const so0 = draft.stockouts.filter((x) => x.id === '1');
  assert.equal(so0.length, 1); assert.equal(so0[0].hours, 24);
  const barDraft = draft.daily.find((x) => x.day === '2026-11-10');
  assert.equal(barDraft.lost, 0, 'no ₹ lost while it was draft');

  pull(10, now - DAYMS);   // restocked and active again (Shopify's blank-before row)
  const c = s.load().catalog['1'];
  assert.equal(c.active, true);
  assert.deepEqual(c.spells, [{ from: now - 24 * DAYMS, to: now - DAYMS, status: 'DRAFT' }]);
  const back = at(now);
  const so1 = back.stockouts.filter((x) => x.id === '1');
  assert.equal(so1.length, 1, 'still one 24 h stock-out, not one running through the draft days');
  assert.equal(so1[0].hours, 24); assert.equal(so1[0].open, false);
  assert.equal(back.daily.find((x) => x.day === '2026-11-10').lost, 0, 'a past daily bar does not change after the fact');
  assert.ok(Math.abs(back.totals.lost - draft.totals.lost) <= draft.totals.lost * 0.05, `₹ lost stays put: ${draft.totals.lost} → ${back.totals.lost}`);
  assert.ok(back.products.find((x) => x.id === '1').perDay >= 4.8, 'draft days are not in-stock days with no sales (≈0.6 a day if they were)');

  /* the CEO digest's "7 days before" sees the spell too */
  const P = require('../src/period');
  assert.deepEqual(P.catalogAsOf(s.load().catalog, now - 3 * DAYMS)['1'], { active: false, status: 'DRAFT', inactiveSince: now - 24 * DAYMS });
  assert.deepEqual(P.catalogAsOf(s.load().catalog, now)['1'], { spells: [{ from: now - 24 * DAYMS, to: now - DAYMS }] });

  /* spells older than 120 days are pruned */
  s.load().catalog['1'].spells[0].to = now - 121 * DAYMS;
  s.prune(true, now);
  assert.equal(s.load().catalog['1'].spells, undefined);
});

test('reactivated while still at 0: out again from the moment it came back', () => {
  const now = Date.parse('2026-11-20T06:30:00Z');
  const stock = [{ t: now - 20 * DAYMS, variantId: '1', before: 3, now: 0, price: 100 }, { t: now - 2 * DAYMS, variantId: '1', before: null, now: 0, price: 100 }];
  const orders = [{ t: now - 25 * DAYMS, order: '#1', variantId: '1', qty: 10, price: 100 }];
  const catalog = { 1: { product: 'P', variant: '', stock: 0, active: true, status: 'ACTIVE', spells: [{ from: now - 15 * DAYMS, to: now - 2 * DAYMS }] } };
  const so = E.report(stock, orders, {}, { now, catalog }).stockouts.filter((x) => x.id === '1').sort((a, b) => a.start - b.start);
  assert.deepEqual(so.map((x) => [x.start, x.end, x.open]), [[now - 20 * DAYMS, now - 15 * DAYMS, false], [now - 2 * DAYMS, null, true]]);
});
