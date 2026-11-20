'use strict';
/* SW-051: the token's permissions are read once per pull. Our own apps (vault / variables) with any write_* scope are
 * refused in plain words; Performity's token (tokenapi, ADR-0014) is allowed, noted on Data and logged once. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const T = require('../src/token-scopes');
const G = require('../src/gql-guard');

const answer = (...handles) => async (doc) => { assert.equal(doc, T.SCOPES_Q); return { currentAppInstallation: { accessScopes: handles.map((handle) => ({ handle })) } }; };
const quiet = () => { const lines = []; return { lines, warn: (m) => lines.push(m) }; };

test('the scopes query itself passes the read-only guard', () => {
  assert.doesNotThrow(() => G.assertReadOnly(T.SCOPES_Q));
  assert.match(T.SCOPES_Q, /currentAppInstallation\s*\{\s*accessScopes\s*\{\s*handle\s*\}\s*\}/);
});

test('own app, read scopes only: the pull goes on', async () => {
  for (const source of ['vault', 'variables']) {
    const r = await T.check(source, 's', { q: answer('read_products', 'read_inventory', 'read_orders'), log: quiet() });
    assert.deepEqual(r.write, []);
    assert.deepEqual(r.handles, ['read_products', 'read_inventory', 'read_orders']);
  }
});

test('own app with any write scope: refused, in plain words naming the scopes', async () => {
  for (const source of ['vault', 'variables']) {
    await assert.rejects(T.check(source, 's', { q: answer('read_products', 'write_products', 'write_inventory'), log: quiet() }),
      (e) => /can also change data \(write_inventory, write_products\)/.test(e.message) && /remove the write permissions/.test(e.message));
  }
});

test('own app: scopes that can’t be read stop the pull (fail closed)', async () => {
  await assert.rejects(T.check('vault', 's', { q: async () => { throw new Error('Shopify: HTTP 500'); }, log: quiet() }), /Couldn’t check the Shopify app’s permissions: Shopify: HTTP 500/);
  await assert.rejects(T.check('variables', 's', { q: async () => ({}), log: quiet() }), /didn’t list/);
});

test('Performity token with write scopes: not refused, returned for the Data page, logged once per store', async () => {
  T._reset();
  const log = quiet();
  const q = answer('read_products', 'write_orders', 'write_products', 'write_products');
  for (let i = 0; i < 3; i++) assert.deepEqual((await T.check('tokenapi', 'brand-a', { q, log })).write, ['write_orders', 'write_products']);
  assert.equal(log.lines.length, 1, 'logged once');
  assert.match(log.lines[0], /brand-a.*token also allows writes \(write_orders,write_products\); this app only reads/);
  await T.check('tokenapi', 'brand-b', { q, log });
  assert.equal(log.lines.length, 2, 'each store once');
  await T.check('tokenapi', 'brand-a', { q: answer('read_products'), log });
  await T.check('tokenapi', 'brand-a', { q, log });
  assert.equal(log.lines.length, 3, 'logged again after the scopes changed back');
  assert.ok(log.lines.every((l) => !/shpat_|token:/.test(l)), 'no token in the log');
});

test('Performity token: a failed scopes read is logged and the pull goes on', async () => {
  const log = quiet();
  const r = await T.check('tokenapi', 'brand-a', { q: async () => { throw new Error('Shopify: HTTP 502'); }, log });
  assert.deepEqual(r, { handles: null, write: [] });
  assert.match(log.lines[0], /not checked: Shopify: HTTP 502/);
});

/* Through the real pull (src/shopify.js gql stubbed): a refused token stops the pull before any read is stored, and
 * the error shows like any other pull failure; a noted token's write scopes reach /api/settings → shopify.writeScopes. */
test('server pull: own app with write scopes → pull fails, nothing stored; noted scopes reach the Data page', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-scopes-'));
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(AZURE_|SHOPIFY_|TOKEN_API|PERFORMITY_|STORES$|ADMIN_PASSWORD|VIEW_PASSWORD)/.test(k)) delete process.env[k];
  Object.assign(process.env, { DATA_DIR: dir, SHOPIFY_STORE: 'scope-store', SHOPIFY_ACCESS_TOKEN: 'not-used-stubbed' });
  for (const m of ['../server', '../src/store']) delete require.cache[require.resolve(m)];
  const S = require('../src/shopify');
  const orig = { gql: S.gql, pullStock: S.pullStock, pullOrders: S.pullOrders, check: T.check };
  const { server, syncShopify } = require('../server');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { Object.assign(S, { gql: orig.gql, pullStock: orig.pullStock, pullOrders: orig.pullOrders }); T.check = orig.check; server.close(); process.env = saved; fs.rmSync(dir, { recursive: true, force: true }); });

  let reads = 0;
  S.gql = async (doc) => { if (doc === T.SCOPES_Q) return { currentAppInstallation: { accessScopes: [{ handle: 'read_products' }, { handle: 'write_products' }] } }; reads++; throw new Error('not reached'); };
  S.pullStock = async () => { reads++; return { rows: [], lastQty: {}, catalog: {}, excluded: {} }; };
  await assert.rejects(syncShopify('scope-store'), /can also change data \(write_products\)/);
  assert.equal(reads, 0, 'no stock or order read after the refusal');
  let set = await (await fetch(base + '/api/settings')).json();
  assert.match(set.shopify.lastError, /remove the write permissions/);
  assert.deepEqual(set.shopify.writeScopes, []);

  T.check = async () => ({ handles: ['read_products', 'write_products'], write: ['write_products'] });   // as for a Performity token
  S.pullOrders = async () => ({ total: 0, cursor: 0 });
  await syncShopify('scope-store');
  set = await (await fetch(base + '/api/settings')).json();
  assert.equal(set.shopify.lastError, null);
  assert.deepEqual(set.shopify.writeScopes, ['write_products']);
});
