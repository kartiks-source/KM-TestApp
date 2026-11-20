'use strict';
/* SW-030: sync progress and run history. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('../src/runs');
const S = require('../src/shopify');

test('runs: finish keeps {kind, start, ms, stock, orders, lines, error, notes}, newest first, last 20', () => {
  const db = {};
  const r = R.begin('shopify', 1000);
  Object.assign(r, { stock: 3, orders: 2, lines: 5, notes: ['x'] });
  assert.deepEqual(R.progress(r), { kind: 'shopify', start: 1000, phase: 'stock', stock: 3, orders: 2, lines: 5 });
  assert.equal(R.progress(null), null);
  assert.deepEqual(R.finish(db, r, null, 43000), { kind: 'shopify', start: 1000, ms: 42000, stock: 3, orders: 2, lines: 5, error: null, notes: ['x'] });
  R.finish(db, R.begin('sheet', 50000), new Error('sheet: HTTP 404'), 51000);
  assert.deepEqual([db.syncRuns[0].kind, db.syncRuns[0].error], ['sheet', 'Error: sheet: HTTP 404']);
  for (let i = 0; i < 30; i++) R.finish(db, R.begin('shopify', 1e5 + i), null, 1e5 + i);
  assert.equal(R.list(db).length, R.MAX);
  assert.equal(R.list(db)[0].start, 1e5 + 29);
  assert.equal(R.finish({}, R.begin('x', 5), 'e'.repeat(999), 1).ms, 0);   // clock went back: never negative
  assert.equal(R.list({}).length, 0);
});

test('runs: notes name what the stock pull left out (archived/draft, untracked)', () => {
  const v = (id, extra = {}) => ({ id: `gid://shopify/ProductVariant/${id}`, sku: '', title: 'Default Title', price: '1', inventoryQuantity: 1, inventoryItem: { tracked: true }, product: { title: 'P', status: 'ACTIVE' }, ...extra });
  const d = S.diffStock([v(1), v(2, { product: { title: 'P', status: 'ARCHIVED' } }), v(3, { product: { title: 'P', status: 'DRAFT' } }), v(4, { inventoryItem: { tracked: false } })], {}, 1);
  assert.equal(d.rows.length, 1);
  assert.deepEqual(d.excluded, { notActive: 2, untracked: 1 });
  assert.deepEqual(R.stockNotes(d.excluded), ['2 archived or draft variants left out', '1 variant with stock not tracked left out']);
  assert.deepEqual(R.stockNotes({ notActive: 0, untracked: 0 }), []);
  assert.deepEqual(R.stockNotes(undefined), []);
});

/* The real syncShopify with the two Shopify reads stubbed: the pill's progress while it runs, then the stored run. */
test('runs: a Shopify pull shows live order counts, then lands in the history (and a failure keeps its error)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-runs-'));
  const saved = { ...process.env };
  Object.assign(process.env, { DATA_DIR: dir, SHOPIFY_STORE: 'test-store', SHOPIFY_ACCESS_TOKEN: 'not-used-stubbed' });
  delete process.env.ADMIN_PASSWORD; delete process.env.AZURE_KEY_VAULT_URL;
  for (const m of ['../server', '../src/store']) delete require.cache[require.resolve(m)];
  const { server, syncShopify } = require('../server');
  const store = require('../src/store');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const orig = { pullStock: S.pullStock, pullOrders: S.pullOrders };
  require('../src/token-scopes').check = async () => ({ handles: [], write: [] });   // SW-051 scope check: stubbed like the reads
  t.after(() => { Object.assign(S, orig); server.close(); process.env = saved; fs.rmSync(dir, { recursive: true, force: true }); });

  const now = Date.now();
  S.pullStock = async () => ({ rows: [{ t: now, variantId: '1', sku: 'A', product: 'P', variant: '', before: null, now: 4, price: 100 }], lastQty: { 1: 4 }, catalog: {}, excluded: { notActive: 3, untracked: 0 } });
  let mid = null;
  S.pullOrders = async (since, { onPage }) => {
    await onPage(['#1', '#2'], [{ t: now, order: '#1', line: 'l1', variantId: '1', sku: 'A', qty: 1, price: 100 }, { t: now, order: '#2', line: 'l2', variantId: '1', sku: 'A', qty: 2, price: 100 }], now);
    mid = await (await fetch(base + '/api/settings')).json();
    await onPage(['#3'], [{ t: now, order: '#3', line: 'l3', variantId: '1', sku: 'A', qty: 1, price: 100 }], now);
    return { total: 3, cursor: now };
  };
  await syncShopify('test-store');
  assert.equal(mid.shopify.running, true);
  assert.deepEqual({ ...mid.shopify.progress, start: 0 }, { kind: 'shopify', start: 0, phase: 'orders', stock: 1, orders: 2, lines: 2 });
  const after = await (await fetch(base + '/api/settings')).json();
  assert.equal(after.shopify.progress, null);
  assert.equal(after.runs.length, 1);
  const r = after.runs[0];
  assert.deepEqual([r.kind, r.stock, r.orders, r.lines, r.error, r.notes], ['shopify', 1, 3, 3, null, ['3 archived or draft variants left out']]);
  assert.ok(r.ms >= 0 && Math.abs(r.start - now) < 60e3);

  S.pullOrders = async () => { throw new Error('Shopify: throttled'); };
  await assert.rejects(syncShopify('test-store'), /throttled/);
  const runs = (await (await fetch(base + '/api/settings')).json()).runs;
  assert.equal(runs.length, 2);
  assert.deepEqual([runs[0].error, runs[0].stock], ['Shopify: throttled', 0]);
  store.saveAll();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'stores', 'test-store', 'store.json'), 'utf8')).syncRuns.length, 2, 'history is saved');
});
