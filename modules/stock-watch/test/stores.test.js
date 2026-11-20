'use strict';
/* Multi-store (ADR-0015): store ids, the registry (demo, variables, vault, Performity via the stand-in API) and the
 * one-time move of a single-store DATA_DIR into the first store. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const MOD = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-stores-'));
process.env.DATA_DIR = tmp();
const scope = require('../src/scope');
const keys = require('../src/keys');
const stores = require('../src/stores');
const migrate = require('../src/migrate');

const B1 = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90', B2 = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
function withEnv(vars, fn) {
  return async () => {
    const keep = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) if (/^(AZURE_|SHOPIFY_|TOKEN_API|PERFORMITY_|STORES$)/.test(k)) delete process.env[k];
      Object.assign(process.env, { DATA_DIR: tmp() }, vars); keys.clear(); keys._resetPoc(); keys._pace(0, 0); stores._reset();
      await fn();
    } finally { process.env = keep; keys.clear(); keys._resetPoc(); keys._pace(2100, 6100); stores._reset(); }
  };
}
/** The stand-in Performity API (scripts/stand-in-token-api.js) on a free port. */
function standIn(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(MOD, 'scripts', 'stand-in-token-api.js')], { env: { PATH: process.env.PATH, PORT: '0', STAND_IN_KEY: 'k', ...env } });
    let out = '';
    child.stdout.on('data', (b) => { out += b; const m = out.match(/on :(\d+)/); if (m) resolve({ child, url: `http://127.0.0.1:${m[1]}` }); });
    child.on('exit', (c) => reject(new Error(`stand-in exited ${c}: ${out}`)));
  });
}
const stopChild = (c) => new Promise((r) => { c.removeAllListeners('exit'); c.on('exit', r); c.kill(); });

/* ---------- store ids ---------- */

test('store ids: uuid or a short lower-case handle; nothing that could leave the stores folder', () => {
  for (const ok of [B1, 'sammsara-demo', 'brand', 'a', 'x'.repeat(61)]) assert.equal(scope.validId(ok), true, ok);
  for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', '-x', 'Brand', 'x'.repeat(62), 'a b', 'a%2f', null, 42, B1.toUpperCase()]) assert.equal(scope.validId(bad), false, String(bad));
  assert.throws(() => scope.run('../etc', () => 1), /Unknown store/);
  assert.equal(scope.current(), null);
  assert.throws(() => scope.id(), /No store chosen/);
  assert.equal(scope.run('brand', () => scope.dir()), path.join(process.env.DATA_DIR, 'stores', 'brand'));
});

test('scope: the store id survives awaits and timers inside run(); two stores at once never see each other', async () => {
  const seen = [];
  const job = (id, ms) => scope.run(id, async () => { await new Promise((r) => setTimeout(r, ms)); seen.push([id, scope.id()]); await Promise.resolve(); seen.push([id, scope.id()]); });
  await Promise.all([job('alpha', 20), job('beta', 5), job('gamma', 10)]);
  assert.equal(seen.length, 6);
  assert.ok(seen.every(([want, got]) => want === got), JSON.stringify(seen));
});

/* ---------- registry ---------- */

test('registry, no key: two clearly labelled demo stores', withEnv({}, () => {
  const l = stores.list();
  assert.deepEqual(l.map((s) => s.id), ['sammsara-demo', 'second-demo']);
  assert.ok(l.every((s) => / \(demo\)$/.test(s.name) && s.demo));
  assert.equal(stores.mode(), 'demo');
  assert.deepEqual(stores.pick('second-demo', ''), { id: 'second-demo' });
  assert.deepEqual(stores.pick('', 'second-demo'), { id: 'second-demo' }, 'cookie when no ?store=');
  assert.deepEqual(stores.pick('', 'gone'), { id: 'sammsara-demo' }, 'a stale cookie falls back to the first store');
  assert.equal(stores.pick('nope', '').error, 404);
  assert.equal(stores.pick('../x', '').error, 404);
}));

test('registry, Railway variables: one store (SHOPIFY_STORE); vault: STORES, else SHOPIFY_STORE', withEnv({ SHOPIFY_STORE: 'Brand-One.myshopify.com', SHOPIFY_CLIENT_ID: 'c', SHOPIFY_CLIENT_SECRET: 's' }, () => {
  assert.deepEqual(stores.list().map((s) => s.id), ['brand-one']);
  Object.assign(process.env, { AZURE_KEY_VAULT_URL: 'https://test-vault.vault.azure.net', AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's', STORES: 'alpha, beta,alpha,Gamma' });
  assert.equal(stores.mode(), 'vault');
  assert.deepEqual(stores.list().map((s) => s.id), ['alpha', 'beta', 'gamma']);
  assert.equal(keys.status().ready, true);
  process.env.STORES = 'alpha,bad store';
  assert.match(keys.status().missing.join(), /"bad store" isn’t a store handle/);
  assert.deepEqual(stores.list().map((s) => s.id), ['alpha'], 'a bad handle is never listed');
}));

test('registry, Performity: every allowed brand from the stand-in API (2 brands); the last good list is kept when the API is down', async () => {
  const api = await standIn({ STAND_IN_BRANDS: '2' });
  try {
    await withEnv({ PERFORMITY_POC_API_URL: api.url, PERFORMITY_POC_API_KEY: 'k' }, async () => {
      const dir = process.env.DATA_DIR;
      assert.deepEqual(stores.list(), [], 'nothing before the first read');
      const l = await stores.refresh();
      assert.deepEqual(l.map((s) => [s.id, s.name]), [[B1, 'Dev store'], [B2, 'Dev store 2']]);
      assert.equal(stores.info().lastError, null);
      assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'stores.json'), 'utf8')).list.length === 2, 'kept on disk for restarts');
      await stopChild(api.child);
      stores._reset();                                                  // as after a restart, with the API down
      const again = await stores.refresh({ fresh: true });
      assert.deepEqual(again.map((s) => s.id), [B1, B2], 'last good list');
      assert.match(stores.info().lastError, /unreachable/);
      process.env.PERFORMITY_BRAND_ID = B2;
      assert.deepEqual(stores.list().map((s) => s.id), [B2], 'PERFORMITY_BRAND_ID limits the list to that brand');
    })();
  } finally { api.child.kill(); }
});

test('registry, Performity: a pinned brand is listed before the first read, so its data can open at once', withEnv({ PERFORMITY_POC_API_URL: 'http://127.0.0.1:9', PERFORMITY_POC_API_KEY: 'k', PERFORMITY_BRAND_ID: B1 }, () => {
  assert.deepEqual(stores.list().map((s) => s.id), [B1]);
}));

test('Performity key never leaves for a URL we refuse (plain http, not localhost) or empty (SEC-1)', async () => {
  const realFetch = global.fetch; let calls = 0;
  global.fetch = async () => { calls++; return new Response('[]', { status: 200 }); };
  try {
    for (const vars of [{ PERFORMITY_POC_API_URL: 'http://poc.example.com', PERFORMITY_POC_API_KEY: 'k' }, { PERFORMITY_POC_API_URL: 'http://[::1]:5527', PERFORMITY_POC_API_KEY: 'k' }, { PERFORMITY_POC_API_URL: 'https://poc.example.com' }]) {
      await withEnv(vars, async () => {
        assert.equal(keys.status().ready, false);
        await stores.refresh({ fresh: true });
        assert.match(stores.info().lastError, /Missing Railway variables/);
        await assert.rejects(keys.brands({ fresh: true }), /Missing Railway variables/);
      })();
    }
    assert.equal(calls, 0, 'no request made');
  } finally { global.fetch = realFetch; }
});

test('fresh token per store from the stand-in API: each brand its own token and shop; the shop is learned', async () => {
  const api = await standIn({ STAND_IN_BRANDS: '2', SHOPIFY_DEV_TOKEN: 'shpat_one', SHOP_DOMAIN: 'one.myshopify.com', SHOPIFY_DEV_TOKEN_2: 'shpat_two', SHOP_DOMAIN_2: 'two.myshopify.com' });
  try {
    await withEnv({ PERFORMITY_POC_API_URL: api.url, PERFORMITY_POC_API_KEY: 'k' }, async () => {
      await stores.refresh();
      const [a, b] = [await keys.access(B1), await keys.access(B2)];
      assert.deepEqual([a.shop, a.token, b.shop, b.token], ['one', 'shpat_one', 'two', 'shpat_two']);
      assert.equal(stores.get(B2).shop, 'two');
      assert.equal(keys.status(B1).store, 'one');
    })();
  } finally { api.child.kill(); }
});

/* ---------- migration of a single-store DATA_DIR ---------- */

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function oldDataDir() {
  const root = tmp();
  const files = { 'store.json': '{"stock":[],"orders":[],"settings":{"storeName":"Old"}}', 'store.json.bak': '{"stock":[],"orders":[]}', 'onorder.json': '{"1":{"qty":5}}',
    'decisions.json': '{}', 'catalog.json': '{"collections":{}}', 'backups/store-20261118.json': '{"b":1}', 'backups/store-20261119-120000-before-clear.json': '{"b":2}' };
  for (const [n, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, n)), { recursive: true }); fs.writeFileSync(path.join(root, n), v); }
  fs.writeFileSync(path.join(root, 'secret'), 'x'.repeat(64));
  return { root, files };
}

test('migration: every old file moves into stores/<first>, byte for byte; secret stays; running it again does nothing', () => {
  const { root, files } = oldDataDir();
  const r = migrate.run(root, 'sammsara-demo');
  assert.deepEqual([r.migrated, r.files, r.removed, r.kept], [true, 7, 7, []]);
  for (const [n, v] of Object.entries(files)) {
    assert.equal(fs.readFileSync(path.join(root, 'stores', 'sammsara-demo', n), 'utf8'), v, n);
    assert.equal(fs.existsSync(path.join(root, n)), false, `${n} removed from the top`);
  }
  assert.equal(fs.existsSync(path.join(root, 'backups')), false, 'empty backups folder removed');
  assert.equal(fs.readFileSync(path.join(root, 'secret'), 'utf8').length, 64, 'sign-in secret is for every store: stays');
  assert.deepEqual(migrate.run(root, 'sammsara-demo'), { migrated: false });
  assert.deepEqual(fs.readdirSync(path.join(root, 'stores')), ['sammsara-demo'], 'no staging folder left');
});

test('migration: a crash mid-copy leaves the originals; the next start copies again from them', () => {
  const { root, files } = oldDataDir();
  const staging = path.join(root, 'stores', '.migrating-brand');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'store.json'), '{"half":');            // what a crash leaves
  migrate.run(root, 'brand');
  assert.equal(fs.readFileSync(path.join(root, 'stores', 'brand', 'store.json'), 'utf8'), files['store.json']);
  assert.equal(fs.existsSync(staging), false);
});

test('migration: a crash after the move but before clean-up is finished next start; a file changed since is kept', () => {
  const { root } = oldDataDir();
  migrate.run(root, 'brand');
  const target = path.join(root, 'stores', 'brand');
  fs.copyFileSync(path.join(target, 'onorder.json'), path.join(root, 'onorder.json'));   // as if removal stopped half way
  fs.mkdirSync(path.join(root, 'backups'));
  fs.copyFileSync(path.join(target, 'backups', 'store-20261118.json'), path.join(root, 'backups', 'store-20261118.json'));
  fs.writeFileSync(path.join(root, 'decisions.json'), '{"p":{"d":"keep"}}');           // changed after the copy: never deleted
  const r = migrate.run(root, 'brand');
  assert.equal(r.removed, 2);
  assert.deepEqual(r.kept, ['decisions.json']);
  assert.equal(fs.existsSync(path.join(root, 'onorder.json')), false);
  assert.equal(fs.readFileSync(path.join(root, 'decisions.json'), 'utf8'), '{"p":{"d":"keep"}}');
  assert.equal(fs.readFileSync(path.join(target, 'decisions.json'), 'utf8'), '{}', 'the moved copy is untouched');
});

test('migration: stores/<id> already holding other data → refuses, touches nothing', () => {
  const { root } = oldDataDir();
  fs.mkdirSync(path.join(root, 'stores', 'brand'), { recursive: true });
  fs.writeFileSync(path.join(root, 'stores', 'brand', 'store.json'), '{"other":1}');
  const before = sha(path.join(root, 'store.json'));
  assert.throws(() => migrate.run(root, 'brand'), migrate.MigrationError);
  assert.equal(sha(path.join(root, 'store.json')), before);
  assert.equal(fs.readFileSync(path.join(root, 'stores', 'brand', 'store.json'), 'utf8'), '{"other":1}');
});

test('migration is once per DATA_DIR: a later top-level file never moves, even when the first store changes (ISO-1)', () => {
  const { root } = oldDataDir();
  migrate.run(root, 'alpha');
  const a = path.join(root, 'stores', 'alpha');
  const before = sha(path.join(a, 'store.json'));
  fs.writeFileSync(path.join(root, 'restore.json'), '{"stock":[],"orders":[]}');      // old-runbook habit
  fs.mkdirSync(path.join(root, 'stores', 'beta'));
  fs.writeFileSync(path.join(root, 'stores', 'beta', 'store.json'), '{"beta":1}');   // the new first store already holds data
  const r = migrate.run(root, 'beta');                                                // must not throw (no crash loop)
  assert.equal(r.id, 'alpha', 'finished against the store it moved into');
  assert.equal(fs.readFileSync(path.join(root, 'stores', 'beta', 'store.json'), 'utf8'), '{"beta":1}', 'beta untouched');
  assert.equal(fs.existsSync(path.join(root, 'stores', 'beta', 'restore.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'restore.json')), true, 'left at the top, with a warning');
  assert.equal(sha(path.join(a, 'store.json')), before);
  migrate.run(root, 'gamma');                                                         // an empty new first store: still nothing moves
  assert.equal(fs.existsSync(path.join(root, 'stores', 'gamma')), false);
  assert.equal(migrate.movedTo(root), 'alpha');
});

test('migration home: the store SHOPIFY_STORE / PERFORMITY_BRAND_ID names when listed, else the first', withEnv({ AZURE_KEY_VAULT_URL: 'https://test-vault.vault.azure.net', AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's', STORES: 'alpha,beta', SHOPIFY_STORE: 'beta' }, () => {
  assert.equal(stores.home().id, 'beta');
  process.env.SHOPIFY_STORE = 'gone';
  assert.equal(stores.home().id, 'alpha');
  for (const k of Object.keys(process.env)) if (/^(AZURE_|STORES$)/.test(k)) delete process.env[k];
  assert.equal(stores.home().id, 'sammsara-demo', 'demo: the first');
}));

test('server start on an old single-store DATA_DIR: data shows in the first store, the second store gets its own demo', async () => {
  const { root } = oldDataDir();
  fs.writeFileSync(path.join(root, 'store.json'), JSON.stringify({ stock: [{ t: Date.now() - 864e5, variantId: '42', sku: 'OLD', product: 'Old lamp', variant: '', before: 3, now: 2, price: 500 }],
    orders: [{ t: Date.now() - 864e5, order: '#OLD1', variantId: '42', sku: 'OLD', qty: 1, price: 500 }], source: 'live', everLive: true, settings: { storeName: 'Old store' } }));
  fs.rmSync(path.join(root, 'store.json.bak'));
  const child = spawn(process.execPath, ['server.js'], { cwd: MOD, env: { PATH: process.env.PATH, DATA_DIR: root, PORT: '0' } });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => { out += b; const m = out.match(/localhost:(\d+)/); if (m) resolve(m[1]); });
    child.stderr.on('data', (b) => { out += b; });
    child.on('exit', (c) => reject(new Error(`exit ${c}: ${out}`)));
  });
  try {
    const list = (await (await fetch(`http://127.0.0.1:${port}/api/stores`)).json()).stores;
    assert.deepEqual(list.map((s) => [s.id, s.name]), [['sammsara-demo', 'Old store'], ['second-demo', 'Second store (demo)']]);
    const a = await (await fetch(`http://127.0.0.1:${port}/api/report?store=sammsara-demo`)).json();
    assert.deepEqual([a.source, a.data.orderRows], ['live', 1], 'the old live data, never replaced by a demo');
    const b = await (await fetch(`http://127.0.0.1:${port}/api/report?store=second-demo`)).json();
    assert.equal(b.source, 'demo');
    assert.equal(fs.existsSync(path.join(root, 'store.json')), false);
  } finally { child.removeAllListeners('exit'); child.kill(); }
});
