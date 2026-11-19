'use strict';
/* Option A (Shopify Access Options, 19 Nov 2026): the main product's token API is the key source. */
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src/keys');
const A = require('../src/alert');

function withEnv(vars, fn) {
  return async () => {
    const keep = { ...process.env }, realFetch = global.fetch;
    try {
      for (const k of Object.keys(process.env)) if (/^(AZURE_|SHOPIFY_|TOKEN_API|ALERT_)/.test(k)) delete process.env[k];
      Object.assign(process.env, vars); K.clear(); await fn();
    } finally { process.env = keep; global.fetch = realFetch; K.clear(); }
  };
}
const ok = (body) => new Response(JSON.stringify(body), { status: 200 });

test('token API: status, required variables, https only', withEnv({ TOKEN_API_URL: 'https://api.example.com', SHOPIFY_STORE: 'brand' }, () => {
  assert.deepEqual([K.status().source, K.status().missing], ['tokenapi', ['TOKEN_API_KEY']]);
  process.env.TOKEN_API_KEY = 'k';
  assert.equal(K.status().ready, true);
  process.env.TOKEN_API_URL = 'http://api.example.com';
  assert.match(K.status().missing[0], /https/);
  process.env.TOKEN_API_URL = 'http://localhost:9999';                  // the local stand-in is allowed
  assert.equal(K.status().ready, true);
}));

test('token API: fetches the current token, sends the key, caches until 5 min before expiry, never refreshes', withEnv({ TOKEN_API_URL: 'https://api.example.com/', TOKEN_API_KEY: 'poc-key', SHOPIFY_STORE: 'Brand' }, async () => {
  let calls = 0, seen;
  global.fetch = async (url, opt) => {
    calls++; seen = { url, auth: opt.headers.Authorization };
    return ok({ store: 'brand.myshopify.com', access_token: 'tok-1', expires_at: new Date(Date.now() + 60 * 60e3).toISOString(), scopes: ['read_orders', 'read_products', 'read_inventory'] });
  };
  const a = await K.access();
  assert.deepEqual([a.shop, a.token, a.source], ['brand', 'tok-1', 'tokenapi']);
  assert.equal(seen.url, 'https://api.example.com/poc/shopify/token?store=brand.myshopify.com');
  assert.equal(seen.auth, 'Bearer poc-key');
  await K.access(); assert.equal(calls, 1);                            // cached
  assert.match(K.grantedScopes(), /read_inventory/);
  K.clear(); await K.access(); assert.equal(calls, 2);                 // Shopify rejected it → ask once more
}));

test('token API: custom header, plain errors, wrong store refused', withEnv({ TOKEN_API_URL: 'https://api.example.com', TOKEN_API_KEY: 'raw', TOKEN_API_HEADER: 'X-Api-Key', SHOPIFY_STORE: 'brand' }, async () => {
  let hdr;
  global.fetch = async (u, opt) => { hdr = opt.headers['X-Api-Key']; return ok({ store: 'other.myshopify.com', access_token: 't', expires_at: new Date(Date.now() + 3600e3).toISOString() }); };
  await assert.rejects(K.access(), /not brand\.myshopify\.com/);
  assert.equal(hdr, 'raw');
  global.fetch = async () => new Response('{}', { status: 403 }); K.clear();
  await assert.rejects(K.access(), /refused our key.*allow-listed/);
  global.fetch = async () => new Response('{}', { status: 404 }); K.clear();
  await assert.rejects(K.access(), /isn’t allow-listed/);
}));

test('token API down: keep the current token until it expires, then pause with a clear message', withEnv({ TOKEN_API_URL: 'https://api.example.com', TOKEN_API_KEY: 'k', SHOPIFY_STORE: 'brand' }, async () => {
  global.fetch = async () => ok({ access_token: 'tok-ok', expires_at: new Date(Date.now() + 10 * 60e3).toISOString() });
  assert.equal((await K.access()).token, 'tok-ok');
  global.fetch = async () => new Response('', { status: 503 });
  assert.equal((await K.access()).token, 'tok-ok');                    // still cached, API not even asked
  global.fetch = async () => ok({ access_token: 't', expires_at: new Date(Date.now() + 2 * 60e3).toISOString() });
  K.clear();
  await assert.rejects(K.access(), /already expiring/);                // never use a token in its last 5 minutes
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(K.access(), /unavailable.*paused/);
}));

test('alerts: one message on failure, reminder after 6 h, one on recovery, tokens scrubbed', withEnv({ ALERT_WEBHOOK_URL: 'https://hooks.example.com/x' }, async () => {
  A._reset(); const sent = [];
  const fetchImpl = async (u, opt) => { sent.push(JSON.parse(opt.body).text); return ok({}); };
  const t0 = Date.parse('2026-11-20T00:00:00Z');
  await A.syncResult(false, 'Shopify rejected Bearer shpat_abc123', { now: t0, store: 'brand', fetchImpl });
  await A.syncResult(false, 'again', { now: t0 + 3600e3, fetchImpl });          // within 6 h: quiet
  await A.syncResult(false, 'again', { now: t0 + 6 * 3600e3, fetchImpl });     // reminder
  await A.syncResult(true, '', { now: t0 + 7 * 3600e3, fetchImpl });
  await A.syncResult(true, '', { now: t0 + 8 * 3600e3, fetchImpl });           // already fine: quiet
  assert.equal(sent.length, 3);
  assert.doesNotMatch(sent[0], /shpat_abc123/);
  assert.match(sent[1], /still failing for 6 h/); assert.match(sent[2], /work again/);
}));
