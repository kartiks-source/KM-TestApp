'use strict';
/* Multi-store (ADR-0015): the 15-minute loop pulls one store at a time (Performity: 30 calls/min per IP, 10 token
 * calls/min per brand; the Shopify app's limit is shared), a manual pull queues behind it, and each store's rows land
 * in its own store.json. Shopify reads are stubbed; three vault stores, no network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-sched-'));
for (const k of Object.keys(process.env)) if (/^(AZURE_|SHOPIFY_|TOKEN_API|PERFORMITY_|STORES$|ADMIN_PASSWORD|ALERT_)/.test(k)) delete process.env[k];
Object.assign(process.env, { DATA_DIR: dir, AZURE_KEY_VAULT_URL: 'https://test-vault.vault.azure.net', AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's', STORES: 'alpha,beta,gamma' });
const S = require('../src/shopify');
const C = require('../src/catalog');
const scope = require('../src/scope');
const { pullAll, syncShopify } = require('../server');

test('pull loop: stores one after the other, never two at once; a manual pull queues; rows stay in their store', async () => {
  let active = 0, most = 0; const order = [];
  S.pullStock = async () => {
    active++; most = Math.max(most, active); order.push(scope.id());
    await new Promise((r) => setTimeout(r, 25));
    const id = scope.id(), now = Date.now();
    active--;
    return { rows: [{ t: now, variantId: `v-${id}`, sku: id, product: `Only in ${id}`, variant: '', before: null, now: 3, price: 100 }], lastQty: { [`v-${id}`]: 3 }, catalog: {}, excluded: {} };
  };
  S.pullOrders = async (since, { onPage }) => { await onPage([`#${scope.id()}`], [{ t: Date.now(), order: `#${scope.id()}`, line: '1', variantId: `v-${scope.id()}`, sku: 'x', qty: 1, price: 100 }], Date.now()); return { total: 1 }; };
  C.refreshCollections = async () => ({ skipped: true });
  require('../src/token-scopes').check = async () => ({ handles: [], write: [] });   // SW-051 scope check: stubbed like the reads

  const loop = pullAll();
  const manual = syncShopify('beta');                       // while the loop starts: queued like any other pull
  assert.equal(syncShopify('beta'), manual, 'asking again for a store already queued gives the same pull');
  await Promise.all([loop, manual]);
  assert.equal(most, 1, 'never two pulls at once');
  assert.deepEqual(order, ['beta', 'alpha', 'beta', 'gamma'], 'the manual pull was queued first, then the loop took every store in order');
  require('../src/store').saveAll();
  for (const id of ['alpha', 'beta', 'gamma']) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'stores', id, 'store.json'), 'utf8'));
    assert.deepEqual([...new Set(j.stock.map((r) => r.variantId))], [`v-${id}`], `${id} holds only its own stock rows`);
    assert.deepEqual([...new Set(j.orders.map((r) => r.order))], [`#${id}`], `${id} holds only its own orders`);
    assert.ok(j.shopify.lastSync, `${id} pulled`);
  }
});
