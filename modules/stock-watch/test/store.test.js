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
  return require('../src/store');
}

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
  const dir = tmpDir(); const file = path.join(dir, 'store.json');
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
  assert.ok(fs.existsSync(path.join(dir, 'store.json')));
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
  const dir = tmpDir(); const file = path.join(dir, 'store.json');
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
  const dir = tmpDir(); const file = path.join(dir, 'store.json');
  fs.writeFileSync(file, JSON.stringify({ stock: [], orders: [], source: 'empty', everLive: true, settings: {} }));
  const s = await startServer(dir);
  await stop(s);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
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
  // client ID without a store name: "connected" for the guards, but no pull can reach the network
  const s = await startServer(dir, { ADMIN_PASSWORD: 'pw', SHOPIFY_CLIENT_ID: 'x' });
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
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
  assert.equal(j.orders.length, 0);
});

test('server: Clear and import wait while a Shopify pull runs (409)', async () => {
  freshStore(tmpDir());
  delete require.cache[require.resolve('../server')];
  process.env.SHOPIFY_CLIENT_ID = 'x';
  const shopify = require('../src/shopify');
  const real = shopify.pullStock;
  let finish; shopify.pullStock = () => new Promise((r) => { finish = () => r({ rows: [], lastQty: {}, catalog: {} }); });
  const { server, syncShopify } = require('../server');
  const run = syncShopify().catch(() => {});
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(base + '/api/clear', { method: 'POST' });
    assert.equal(r.status, 409); assert.match((await r.json()).error, /pull is running/);
    r = await fetch(base + '/api/import?kind=order', { method: 'POST', body: 'x' });
    assert.equal(r.status, 409);
  } finally {
    finish(); await run; shopify.pullStock = real; delete process.env.SHOPIFY_CLIENT_ID;
    await new Promise((r) => server.close(r));
  }
});
