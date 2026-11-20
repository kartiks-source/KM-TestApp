'use strict';
/* Option A: the Performity POC API ("Performity POC API: calling guide", 19 Nov 2026). */
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src/keys');
const A = require('../src/alert');

const BRAND = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
function withEnv(vars, fn) {
  return async () => {
    const keep = { ...process.env }, realFetch = global.fetch;
    try {
      for (const k of Object.keys(process.env)) if (/^(AZURE_|SHOPIFY_|TOKEN_API|ALERT_|PERFORMITY_|RAILWAY_PUBLIC_DOMAIN)/.test(k)) delete process.env[k];
      Object.assign(process.env, vars); K.clear(); K._resetPoc(); K._pace(0, 0); await fn();
    } finally { process.env = keep; global.fetch = realFetch; K.clear(); K._resetPoc(); K._pace(2100, 6100); }
  };
}
const json = (code, body) => new Response(JSON.stringify(body), { status: code });
const inMin = (m) => new Date(Date.now() + m * 60e3).toISOString().replace(/\.\d+Z$/, '');   // UTC, no zone, like the API
const ENV = { PERFORMITY_POC_API_URL: 'https://poc.example.com/', PERFORMITY_POC_API_KEY: 'k1' };

/** fake POC API: records calls; brands + fresh-token per the guide */
function fakeApi({ brands = [{ brand_id: BRAND, brand_name: 'Sammsara' }], token = (n) => ({ access_token: `tok-${n}`, shop_domain: 'sammsara.myshopify.com', expires_at: inMin(60) }) } = {}) {
  const calls = [];
  global.fetch = async (url, opt) => {
    calls.push({ url, method: opt.method || 'GET', key: opt.headers['X-Api-Key'], origin: opt.headers.origin, body: opt.body });
    if (url.endsWith('/catalys/shopify/service/external/brands')) return json(200, brands);
    if (url.endsWith('/catalys/shopify/service/external/fresh-token')) return typeof token === 'function' ? json(200, token(calls.length)) : token;
    return json(404, { error: 'nope' });
  };
  return calls;
}

test('status: URL + key are enough; https only (localhost allowed for the stand-in)', withEnv({ PERFORMITY_POC_API_URL: 'https://poc.example.com' }, () => {
  assert.deepEqual([K.status().source, K.status().missing], ['tokenapi', ['PERFORMITY_POC_API_KEY']]);
  process.env.PERFORMITY_POC_API_KEY = 'k'; assert.equal(K.status().ready, true);
  process.env.PERFORMITY_POC_API_URL = 'http://poc.example.com'; assert.match(K.status().missing[0], /https/);
  process.env.PERFORMITY_POC_API_URL = 'http://localhost:4499'; assert.equal(K.status().ready, true);
}));

test('one allowed brand: X-Api-Key sent, brand picked, POST fresh-token with brand_id, shop from shop_domain', withEnv(ENV, async () => {
  const calls = fakeApi();
  const a = await K.access(BRAND);
  assert.deepEqual([a.shop, a.token, a.brand], ['sammsara', 'tok-2', BRAND]);
  assert.equal(calls[0].url, 'https://poc.example.com/catalys/shopify/service/external/brands');
  assert.equal(calls[1].method, 'POST'); assert.deepEqual(JSON.parse(calls[1].body), { brand_id: BRAND });
  assert.ok(calls.every((c) => c.key === 'k1'));
}));

test('token asked right before each pull, reused within the pull, re-asked on a Shopify 401', withEnv(ENV, async () => {
  const calls = fakeApi();
  K.beginPull(BRAND); await K.access(BRAND); await K.access(BRAND);
  assert.equal(calls.filter((c) => c.url.endsWith('fresh-token')).length, 1);      // one per pull
  K.beginPull(BRAND); await K.access(BRAND);
  assert.equal(calls.filter((c) => c.url.endsWith('fresh-token')).length, 2);      // next pull asks again
  K.clear(); await K.access(BRAND);
  assert.equal(calls.filter((c) => c.url.endsWith('fresh-token')).length, 3);      // Shopify 401 → ask once more
}));

test('expires_at is UTC without a zone (not local time); null = never expires; nearly-expired refused', withEnv(ENV, async () => {
  assert.equal(K._utc('2026-11-19T10:15:00'), Date.parse('2026-11-19T10:15:00Z'));
  assert.equal(K._utc(null), null);
  fakeApi({ token: () => ({ access_token: 't', shop_domain: 'sammsara.myshopify.com', expires_at: null }) });
  assert.equal((await K.access(BRAND)).token, 't');
  K.clear();
  fakeApi({ token: () => ({ access_token: 't', shop_domain: 'sammsara.myshopify.com', expires_at: inMin(0.5) }) });
  await assert.rejects(K.access(BRAND), /about to expire/);
}));

test('several brands: each is its own store (own token, own brand_id); PERFORMITY_BRAND_ID limits to one; unknown brand refused', withEnv(ENV, async () => {
  const OTHER = '11111111-2222-3333-4444-555555555555';
  const calls = fakeApi({ brands: [{ brand_id: BRAND, brand_name: 'Sammsara' }, { brand_id: OTHER, brand_name: 'Dawbu' }],
    token: (n) => ({ access_token: `tok-${n}`, shop_domain: 'shop.myshopify.com', expires_at: inMin(60) }) });
  const a = await K.access(BRAND), b = await K.access(OTHER);
  assert.deepEqual([a.brand, b.brand], [BRAND, OTHER]);
  assert.notEqual(a.token, b.token);
  assert.deepEqual(calls.filter((c) => c.url.endsWith('fresh-token')).map((c) => JSON.parse(c.body).brand_id), [BRAND, OTHER]);
  K.beginPull(OTHER); await K.access(BRAND);                                         // one store's pull never drops another's token
  assert.equal(calls.filter((c) => c.url.endsWith('fresh-token')).length, 2);
  process.env.PERFORMITY_BRAND_ID = OTHER; K.clear(); K._resetPoc();
  await assert.rejects(K.access(BRAND), /PERFORMITY_BRAND_ID limits this app/);
  assert.equal((await K.access(OTHER)).brand, OTHER);
  delete process.env.PERFORMITY_BRAND_ID; K.clear(); K._resetPoc();
  await assert.rejects(K.access('99999999-2222-3333-4444-555555555555'), /isn’t in our allowed list/);
  K._resetPoc(); fakeApi({ brands: [] });
  await assert.rejects(K.access(BRAND), /isn’t in our allowed list/);
}));

test('pacing: calls queue at least the call gap apart; token calls for one brand at least the token gap apart (Performity limits)', withEnv(ENV, async () => {
  const OTHER = '11111111-2222-3333-4444-555555555555';
  const at = [];
  fakeApi({ brands: [{ brand_id: BRAND, brand_name: 'S' }, { brand_id: OTHER, brand_name: 'D' }], token: (n) => { at.push(Date.now()); return { access_token: `t${n}`, shop_domain: 's.myshopify.com', expires_at: inMin(60) }; } });
  K._pace(40, 250);
  await K.brands();
  await Promise.all([K.access(BRAND), K.access(OTHER)]);              // two brands at once: queued, call gap only
  assert.ok(at[1] - at[0] >= 35 && at[1] - at[0] < 240, `two brands ${at[1] - at[0]} ms apart`);
  K.beginPull(BRAND); await K.access(BRAND);                          // same brand again: token gap
  assert.ok(at[2] - at[0] >= 245, `same brand ${at[2] - at[0]} ms apart`);
}));

test('token for a non-myshopify domain is refused (never send it elsewhere)', withEnv(ENV, async () => {
  fakeApi({ token: () => ({ access_token: 't', shop_domain: 'evil.example.com', expires_at: inMin(60) }) });
  await assert.rejects(K.access(BRAND), /myshopify/);
}));

test('guide error handling: 401 pauses 15 min without retrying; 403 IP / brand, 404, 409 explained; 500 retried once', withEnv(ENV, async () => {
  let n = 0;
  global.fetch = async () => { n++; return json(401, { error: 'Invalid API key' }); };
  await assert.rejects(K.access(BRAND), /401.*Paused 15 minutes/);
  await assert.rejects(K.access(BRAND), /Paused 15 minutes/);
  assert.equal(n, 1);                                                   // second attempt never reached the API
  for (const [code, err, re] of [[403, 'IP not allowed', /static outbound IP/], [403, 'Brand not allowed', /brand not allowed/], [404, 'No connected Shopify store for this brand.', /no connected Shopify store/], [409, 'Shopify store must be reconnected in Performity.', /reconnect/]]) {
    K._resetPoc(); K.clear();
    fakeApi({ token: json(code, { error: err }) });
    await assert.rejects(K.access(BRAND), re);
  }
  K._resetPoc(); K.clear(); let tries = 0;
  global.fetch = async (url) => { if (url.endsWith('/brands')) return json(200, [{ brand_id: BRAND, brand_name: 'S' }]); tries++; return tries === 1 ? json(500, { error: 'Internal error' }) : json(200, { access_token: 'ok', shop_domain: 'sammsara.myshopify.com', expires_at: inMin(60) }); };
  assert.equal((await K.access(BRAND)).token, 'ok'); assert.equal(tries, 2);
}));

test('alerts: one message on failure, reminder after 6 h, one on recovery, tokens scrubbed', withEnv({ ALERT_WEBHOOK_URL: 'https://hooks.example.com/x' }, async () => {
  A._reset(); const sent = [];
  const fetchImpl = async (u, opt) => { sent.push(JSON.parse(opt.body).text); return json(200, {}); };
  const t0 = Date.parse('2026-11-20T00:00:00Z');
  const one = { store: 'Brand One', key: 'brand-one', fetchImpl };
  await A.syncResult(false, 'Shopify rejected Bearer shpat_abc123', { now: t0, ...one });
  await A.syncResult(false, 'again', { now: t0 + 3600e3, ...one });
  await A.syncResult(false, 'other store down', { now: t0 + 3600e3, store: 'Brand Two', key: 'brand-two', fetchImpl });   // its own first alert
  await A.syncResult(false, 'again', { now: t0 + 6 * 3600e3, ...one });
  await A.syncResult(true, '', { now: t0 + 7 * 3600e3, ...one });
  await A.syncResult(true, '', { now: t0 + 8 * 3600e3, ...one });
  assert.equal(sent.length, 4);
  assert.doesNotMatch(sent[0], /shpat_abc123/);
  assert.match(sent[0], /Stock-out Watch \(Brand One\)/, 'names the store');
  assert.match(sent[1], /\(Brand Two\).*other store down/);
  assert.match(sent[2], /Brand One.*still failing for 6 h/); assert.match(sent[3], /Brand One.*work again/);
}));

test('Origin: our Railway domain by default, PERFORMITY_ORIGIN wins, none when neither is set', withEnv({ ...ENV, RAILWAY_PUBLIC_DOMAIN: 'web-x.up.railway.app' }, async () => {
  let calls = fakeApi(); await K.brands({ fresh: true });
  assert.equal(calls[0].origin, 'https://web-x.up.railway.app');
  process.env.PERFORMITY_ORIGIN = 'https://stock.catalys.co/'; calls = fakeApi(); await K.brands({ fresh: true });
  assert.equal(calls[0].origin, 'https://stock.catalys.co');
  delete process.env.PERFORMITY_ORIGIN; delete process.env.RAILWAY_PUBLIC_DOMAIN; calls = fakeApi(); await K.brands({ fresh: true });
  assert.equal(calls[0].origin, undefined);
}));

test('403 Origin not allowed says which origin we sent and how to fix it', withEnv({ ...ENV, PERFORMITY_ORIGIN: 'https://a.example' }, async () => {
  global.fetch = async () => json(403, { error: 'Origin not allowed' });
  await assert.rejects(K.brands({ fresh: true }), /origin not allowed.*https:\/\/a\.example.*PERFORMITY_ORIGIN/);
}));
