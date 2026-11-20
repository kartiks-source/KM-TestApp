'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/shopify');
const K = require('../src/keys');

test('read-only guard: queries pass, mutations and subscriptions are refused', () => {
  assert.doesNotThrow(() => S.assertReadOnly('query X { shop { name } }'));
  assert.doesNotThrow(() => S.assertReadOnly('{ shop { name } }'));
  assert.doesNotThrow(() => S.assertReadOnly('query X($q: String) { orders(query: "tag:mutation") { nodes { id } } }'));
  for (const bad of ['mutation { productDelete(input:{id:"1"}) { deletedProductId } }',
    '# just reading\nmutation M { inventorySetQuantities(input:{}) { userErrors { message } } }',
    'query A { shop { name } } mutation B { x }', 'subscription { x }', 'garbage']) {
    assert.throws(() => S.assertReadOnly(bad), /only reads/);
  }
});

test('gql refuses a mutation before anything is sent', async () => {
  let sent = 0;
  await assert.rejects(S.gql('mutation { x }', {}, { fetchImpl: () => { sent++; } }), /only reads/);
  assert.equal(sent, 0);
});

test('every query the sync sends is read-only', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/shopify'), 'utf8');
  const docs = [...src.matchAll(/`(query [\s\S]*?)`/g)].map((m) => m[1]);
  assert.ok(docs.length >= 3);
  for (const d of docs) assert.doesNotThrow(() => S.assertReadOnly(d));
});

const variant = (id, qty, extra = {}) => ({ id: `gid://shopify/ProductVariant/${id}`, sku: `SKU${id}`, title: 'Default Title', price: '499.00', inventoryQuantity: qty, inventoryItem: { tracked: true }, product: { title: `P${id}`, status: 'ACTIVE' }, ...extra });

test('stock: first read stores everything, later reads only changes', () => {
  const a = S.diffStock([variant(1, 5), variant(2, 0)], {}, 1000);
  assert.equal(a.rows.length, 2);
  assert.deepEqual(a.rows.map((r) => [r.variantId, r.before, r.now, r.price, r.variant]), [['1', null, 5, 499, ''], ['2', null, 0, 499, '']]);
  const b = S.diffStock([variant(1, 5), variant(2, 7)], a.lastQty, 2000);
  assert.deepEqual(b.rows.map((r) => [r.variantId, r.before, r.now, r.t]), [['2', 0, 7, 2000]]);
});

test('stock: untracked and non-active products are left out', () => {
  const r = S.diffStock([variant(1, 3, { inventoryItem: { tracked: false } }), variant(2, 3, { product: { title: 'x', status: 'DRAFT' } }), variant(3, 3)], {}, 1);
  assert.deepEqual(r.rows.map((x) => x.variantId), ['3']);
});

test('orders: what counts as a sale — not cancelled, not test, units net of refunds, price after all discounts', () => {
  const o = { name: '#1001', createdAt: '2026-11-18T10:00:00Z', test: false, cancelledAt: null };
  const line = (id, cur, price, v = '9') => ({ id: `gid://shopify/LineItem/${id}`, currentQuantity: cur, sku: 'A', variant: v ? { id: `gid://shopify/ProductVariant/${v}` } : null, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: String(price) } } });
  assert.deepEqual(S.orderRows(o, [line(1, 2, 315), line(2, 0, 500), line(3, 1, 10, null)]),
    [{ t: Date.parse(o.createdAt), order: '#1001', line: '1', variantId: '9', sku: 'A', qty: 2, price: 315 }]);   // refunded line and custom line drop out
  assert.deepEqual(S.orderRows({ ...o, test: true }, [line(1, 2, 315)]), []);
  assert.deepEqual(S.orderRows({ ...o, cancelledAt: '2026-11-19T00:00:00Z' }, [line(1, 2, 315)]), []);
});

test('orders: first run loads 60 days by creation; later runs re-read changed orders; pages and extra lines all read', async () => {
  const now = Date.parse('2026-11-19T00:00:00Z');
  const line = (v) => ({ id: `gid://shopify/LineItem/${v}`, currentQuantity: 1, sku: v, variant: { id: `gid://shopify/ProductVariant/${v}` }, discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '10' } } });
  const pages = [
    { orders: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [{ id: 'o1', name: '#1', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z', lineItems: { pageInfo: { hasNextPage: true, endCursor: 'l1' }, nodes: [line('1')] } }] } },
    { orders: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'o2', name: '#2', createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T05:00:00Z', cancelledAt: '2026-11-12T05:00:00Z', lineItems: { pageInfo: { hasNextPage: false }, nodes: [line('3')] } }] } },
  ];
  const seen = []; let filter;
  const q = async (doc, v) => {
    if (doc.includes('order(id')) return { order: { lineItems: { pageInfo: { hasNextPage: false }, nodes: [line('2')] } } };
    filter = v.q; return pages[v.after ? 1 : 0];
  };
  const r = await S.pullOrders(null, { q, now, onPage: (names, rows, cursor) => seen.push([names, rows.map((x) => x.variantId), cursor]) });
  assert.equal(r.total, 2);
  assert.deepEqual(seen, [[['#1'], ['1', '2'], Date.parse('2026-11-11T00:00:00Z')], [['#2'], [], Date.parse('2026-11-12T05:00:00Z')]]);   // #2 cancelled → no lines, so its old lines get removed
  assert.match(filter, /^created_at:>='2026-09-20/);
  await S.pullOrders(Date.parse('2026-11-18T00:00:00Z'), { q, now });
  assert.match(filter, /^updated_at:>='2026-11-17T23:30/);       // 30-minute overlap
});

test('keys: secret formats and store names', () => {
  assert.deepEqual(K.parseSecret(' shpat_abc '), { token: 'shpat_abc' });
  const j = K.parseSecret('{"shop":"brand.myshopify.com","accessToken":"shpat_x"}');
  assert.equal(j.shop, 'brand.myshopify.com'); assert.equal(j.token, 'shpat_x');
  assert.equal(K.parseSecret('{"client_id":"id","client_secret":"sec"}').clientSecret, 'sec');
  assert.equal(K.cleanShop('https://Brand.myshopify.com/admin'), 'brand');
});

test('keys: which source is set up, and what is missing', () => {
  const keep = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (/^(AZURE_|SHOPIFY_)/.test(k)) delete process.env[k];
    assert.equal(K.status().source, null);
    Object.assign(process.env, { SHOPIFY_STORE: 'brand', SHOPIFY_CLIENT_ID: 'cid' });
    assert.deepEqual(K.status().missing, ['SHOPIFY_CLIENT_SECRET']);           // client ID without its secret
    process.env.SHOPIFY_CLIENT_SECRET = 'sec';
    assert.deepEqual([K.status().source, K.status().ready, K.status().kind], ['variables', true, 'client ID + secret']);
    delete process.env.SHOPIFY_CLIENT_ID; delete process.env.SHOPIFY_CLIENT_SECRET;
    process.env.SHOPIFY_ACCESS_TOKEN = 'shpat_x';
    assert.deepEqual([K.status().ready, K.status().kind], [true, 'legacy token']);
    Object.assign(process.env, { AZURE_KEY_VAULT_URL: 'https://brand-kv.vault.azure.net', AZURE_TENANT_ID: 't' });
    const v = K.status();
    assert.equal(v.source, 'vault'); assert.match(v.secretName, /shopify-brand-client-id/); assert.equal(v.ready, false);
    assert.deepEqual(v.missing, ['AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']);
    process.env.AZURE_KEY_VAULT_URL = 'https://evil.example.com';
    assert.match(K.status().missing[0], /vault\.azure\.net/);
  } finally { process.env = keep; }
});

test('keys: client ID + secret are swapped for a 24-hour token, reused until near expiry; clear errors', async () => {
  const keep = { ...process.env }, realFetch = global.fetch;
  try {
    for (const k of Object.keys(process.env)) if (/^(AZURE_|SHOPIFY_)/.test(k)) delete process.env[k];
    Object.assign(process.env, { SHOPIFY_STORE: 'brand', SHOPIFY_CLIENT_ID: 'cid', SHOPIFY_CLIENT_SECRET: 'sec' });
    let calls = 0, body = '';
    global.fetch = async (url, opt) => {
      calls++; body = String(opt.body);
      assert.equal(url, 'https://brand.myshopify.com/admin/oauth/access_token');
      return new Response(JSON.stringify({ access_token: 'tok1', scope: 'read_products,read_inventory,read_orders', expires_in: 86399 }), { status: 200 });
    };
    K.clear();
    const a = await K.access('brand');
    assert.deepEqual([a.shop, a.token], ['brand', 'tok1']);
    assert.match(body, /grant_type=client_credentials/); assert.match(body, /client_id=cid/);
    await K.access('brand'); assert.equal(calls, 1);                                   // cached
    assert.match(K.grantedScopes(), /read_inventory/);
    global.fetch = async () => new Response(JSON.stringify({ error: 'shop_not_permitted' }), { status: 400 });
    K.clear();
    await assert.rejects(K.access('brand'), /same Shopify organisation/);
  } finally { process.env = keep; global.fetch = realFetch; K.clear(); }
});
