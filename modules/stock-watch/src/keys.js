'use strict';
/*
 * Where the Shopify key comes from. The sync never knows; it calls access(storeId) and gets
 * { shop, token, source }. Swapping the source is a Railway variable change, not a code change.
 * Several stores (ADR-0015): every cache below is per store id; src/stores.js lists the stores.
 *
 * Shopify credentials are normally an app's CLIENT ID + CLIENT SECRET (apps made in Shopify's Dev
 * Dashboard). We swap them for a 24-hour access token (client credentials grant) and get a new one
 * before it runs out. Shopify only allows this when the app and the store are in the same Shopify
 * organisation, so for a brand's store the brand creates the app and shares its ID + secret.
 * A legacy custom-app admin token (shpat_…) still works if that's all there is.
 *
 *   0. Performity POC API (DECIDED 19 Nov 2026, option A; contract: "Performity POC API: calling guide")
 *        PERFORMITY_POC_API_URL  base address Performity sends with the key   (alias TOKEN_API_URL)
 *        PERFORMITY_POC_API_KEY  our key, sent as X-Api-Key on every call    (alias TOKEN_API_KEY)
 *        PERFORMITY_BRAND_ID     optional: limits the app to this one allowed brand (else every allowed brand is a store)
 *      GET  {base}/catalys/shopify/service/external/brands        → [{ brand_id, brand_name }]
 *      POST {base}/catalys/shopify/service/external/fresh-token   {brand_id}
 *                                                                  → { access_token, shop_domain, expires_at }
 *      expires_at is UTC without a zone ("2026-11-19T10:15:00"); null = doesn't expire.
 *      Rules we follow: ask for the token right before each pull (beginPull) and never keep it for
 *      later; on a Shopify 401 ask once more; never refresh it ourselves, never pass it on; read only.
 *      A wrong key is not retried (5 wrong keys in 15 min block our IP): we pause 15 min; on 429 we
 *      wait as told; on 500 we retry once after a short wait. Limits (30 calls/min per IP, 10 token calls/min
 *      per brand): calls are spaced at least 2.1 s apart, token calls for one brand at least 6.1 s apart.
 *
 *   1. Azure Key Vault
 *        AZURE_KEY_VAULT_URL   https://<name>.vault.azure.net
 *        AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET   our own Azure login,
 *                              "Key Vault Secrets User" on that vault only
 *        SHOPIFY_STORE         <store>      (or STORES=<store>,<store>,… for several stores)
 *      Reads either two secrets, shopify-<store>-client-id and shopify-<store>-client-secret,
 *      or one secret shopify-<store> holding JSON {"clientId":"…","clientSecret":"…"}
 *      (or a legacy shpat_… token).
 *
 *   2. Railway variables (stop-gap)
 *        SHOPIFY_STORE + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET   (legacy: SHOPIFY_ACCESS_TOKEN)
 *
 * Keys live in memory only (30 minutes), never on disk, in logs or in the browser.
 * clear() forgets them, so a token Shopify rejects is read again straight away.
 */

const scope = require('./scope');
const TTL = 30 * 60e3;
const API_SKEW = 5 * 60e3;            // stop using a token-API token 5 minutes before it expires
const KV_API = '7.5';
const VAULT_RE = /^https:\/\/[a-z][a-z0-9-]{1,22}[a-z0-9]\.vault\.azure\.net\/?$/i;
const STORE_RE = /^[a-z0-9][a-z0-9-]{0,60}$/i;

const caches = new Map();            // store id → { value, exp }
let aad = null;                     // { token, exp }
const shopTokens = new Map();       // shop → { token, exp } from a client-credentials exchange (24 h)
let scopes = '';                    // scopes Shopify granted, from the last exchange

const env = (k) => String(process.env[k] || '').trim();
const cleanShop = (s) => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.myshopify\.com$/, '');

/** Vault stores: STORES (comma list of shop handles), else SHOPIFY_STORE. Lower case, de-duplicated. */
function vaultStores() {
  const list = env('STORES') ? env('STORES').split(',').map(cleanShop).filter(Boolean) : [cleanShop(env('SHOPIFY_STORE'))].filter(Boolean);
  return [...new Set(list)];
}

/** Which source is configured, and what's missing; for one store when storeId is given. Never includes a secret. */
function status(storeId) {
  const store = cleanShop(env('SHOPIFY_STORE'));
  const api = apiBase();
  if (api) {
    const missing = [];
    if (!/^https:\/\/[^\s/]+/i.test(api) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(api)) missing.push('PERFORMITY_POC_API_URL must start with https://');
    if (!apiKey()) missing.push('PERFORMITY_POC_API_KEY');
    const brand = storeId || env('PERFORMITY_BRAND_ID') || null;
    return { source: 'tokenapi', store: (brand && shopOf(brand)) || (env('PERFORMITY_BRAND_ID') ? store : '') || '', brand, kind: 'Performity POC API (token asked before each pull)', ready: !missing.length, missing };
  }
  const vault = env('AZURE_KEY_VAULT_URL');
  if (vault) {
    const missing = [];
    if (!VAULT_RE.test(vault)) missing.push('AZURE_KEY_VAULT_URL must look like https://<name>.vault.azure.net');
    for (const k of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) if (!env(k)) missing.push(k);
    const list = vaultStores();
    if (!list.length) missing.push('SHOPIFY_STORE (or STORES)');
    for (const x of list) if (!STORE_RE.test(x)) missing.push(`${env('STORES') ? 'STORES' : 'SHOPIFY_STORE'}: "${x.slice(0, 40)}" isn’t a store handle`);
    const one = storeId || list[0] || '';
    return { source: 'vault', store: one, stores: list, secretName: `shopify-${one}-client-id / -client-secret (or shopify-${one})`, ready: !missing.length, missing };
  }
  if (env('SHOPIFY_CLIENT_ID') || env('SHOPIFY_CLIENT_SECRET') || env('SHOPIFY_ACCESS_TOKEN')) {
    const missing = [];
    if (!STORE_RE.test(store)) missing.push('SHOPIFY_STORE');
    if (!env('SHOPIFY_ACCESS_TOKEN')) for (const k of ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET']) if (!env(k)) missing.push(k);
    return { source: 'variables', store, ready: !missing.length, missing, kind: env('SHOPIFY_ACCESS_TOKEN') && !env('SHOPIFY_CLIENT_ID') ? 'legacy token' : 'client ID + secret' };
  }
  return { source: null, store, ready: false, missing: [] };
}

async function azureToken() {
  if (aad && Date.now() < aad.exp) return aad.token;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: env('AZURE_CLIENT_ID'), client_secret: env('AZURE_CLIENT_SECRET'), scope: 'https://vault.azure.net/.default' });
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env('AZURE_TENANT_ID'))}/oauth2/v2.0/token`,
    { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Azure sign-in failed: ${String(j.error_description || j.error || r.status).split('\n')[0].slice(0, 200)}`);
  aad = { token: j.access_token, exp: Date.now() + Math.max(120, +j.expires_in || 3600) * 1000 - 60e3 };
  return aad.token;
}

async function readVaultSecret(name) {
  const url = `${env('AZURE_KEY_VAULT_URL').replace(/\/+$/, '')}/secrets/${encodeURIComponent(name)}?api-version=${KV_API}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${await azureToken()}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (r.status === 401) { aad = null; throw new Error(`Key Vault refused our sign-in (401) for "${name}"`); }
  if (r.status === 403) throw new Error(`No access to "${name}": give our Azure app "Key Vault Secrets User" on the vault, and check its firewall allows us`);
  if (r.status === 404) throw new Error(`Secret "${name}" isn't in the vault`);
  if (!r.ok) throw new Error(`Key Vault: HTTP ${r.status} for "${name}"`);
  const j = await r.json();
  if (j.value == null) throw new Error(`Secret "${name}" is empty`);
  return String(j.value).trim();
}

/** Vault: shopify-<store>-client-id + shopify-<store>-client-secret, else one shopify-<store> secret. */
async function readVaultCredentials(store) {
  try {
    const [clientId, clientSecret] = await Promise.all([readVaultSecret(`shopify-${store}-client-id`), readVaultSecret(`shopify-${store}-client-secret`)]);
    return { clientId, clientSecret };
  } catch (e) {
    if (!/isn't in the vault/.test(e.message)) throw e;
    return parseSecret(await readVaultSecret(`shopify-${store}`));
  }
}

/** A secret's value → { shop?, token?, clientId?, clientSecret? }. */
function parseSecret(value) {
  const v = String(value || '').trim();
  if (!v.startsWith('{')) return { token: v };
  let o; try { o = JSON.parse(v); } catch { return { token: v }; }
  const pick = (...ks) => { for (const k of ks) if (o[k]) return String(o[k]).trim(); return ''; };
  return {
    shop: pick('shop', 'store', 'domain', 'shopDomain', 'shop_domain'),
    token: pick('accessToken', 'access_token', 'adminToken', 'admin_api_access_token', 'token'),
    clientId: pick('clientId', 'client_id', 'apiKey', 'api_key'),
    clientSecret: pick('clientSecret', 'client_secret', 'apiSecret', 'api_secret'),
  };
}

/** Apps made in Shopify's Dev Dashboard give a client ID + secret; swap them for a short-lived token. */
async function exchange(shop, clientId, clientSecret) {
  const have = shopTokens.get(shop);
  if (have && Date.now() < have.exp) return have.token;
  const r = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const why = String(j.error || j.errors || '').toLowerCase();
    if (why.includes('shop_not_permitted')) throw new Error('Shopify: this app isn’t in the same Shopify organisation as the store. The brand must create the app in its own Dev Dashboard, install it, and share that client ID + secret');
    if (r.status === 400 || r.status === 401 || why.includes('invalid_client')) throw new Error('Shopify refused the client ID / secret: check both, and that the app is installed on the store');
    throw new Error(`Shopify token exchange failed (HTTP ${r.status})`);
  }
  scopes = String(j.scope || '');
  shopTokens.set(shop, { token: j.access_token, exp: Date.now() + Math.max(300, +j.expires_in || 86399) * 1000 - 5 * 60e3 });
  return j.access_token;
}

/* ---- Performity POC API (option A) ---- */
const apiBase = () => (env('PERFORMITY_POC_API_URL') || env('TOKEN_API_URL')).replace(/\/+$/, '');
const apiKey = () => env('PERFORMITY_POC_API_KEY') || env('TOKEN_API_KEY');
const EXT = '/catalys/shopify/service/external';
const lastShop = new Map();          // brand → shop handle from its last fresh-token
let brandCache = null, holdUntil = 0, holdWhy = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Performity's limits: 30 calls/min per IP, 10 token calls/min per brand. Calls queue one behind the other. */
const PACE = { call: 2100, token: 6100 };
let lastCall = 0, gate = Promise.resolve();
const lastToken = new Map();         // brand → time of its last fresh-token call
function pace(brand) {
  const p = gate.then(async () => {
    const now = Date.now();
    let wait = Math.max(0, lastCall + PACE.call - now);
    if (brand) wait = Math.max(wait, (lastToken.get(brand) || 0) + PACE.token - now);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now(); if (brand) lastToken.set(brand, lastCall);
  });
  gate = p.catch(() => {});
  return p;
}

/** One call to the POC API, with the guide's error handling. Never loops on a wrong key. */
async function pocCall(path, opts = {}, retried = false) {
  const st = status();   // the key goes only to an https:// (or localhost) URL, and never empty (a wrong key counts towards an IP block)
  if (st.source !== 'tokenapi' || !st.ready) throw new Error(`Missing Railway variables: ${st.missing.join(', ') || 'PERFORMITY_POC_API_URL'}`);
  if (Date.now() < holdUntil) throw new Error(holdWhy);
  await pace(opts.brand);
  if (Date.now() < holdUntil) throw new Error(holdWhy);
  let r;
  try {
    const { brand, ...init } = opts;
    r = await fetch(`${apiBase()}${EXT}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'X-Api-Key': apiKey(), accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    });
  } catch { throw new Error('Performity POC API is unreachable: pulls pause until it answers'); }
  if (r.ok) return r.json();
  const msg = String((await r.json().catch(() => ({}))).error || '');
  const hold = (ms, why) => { holdUntil = Date.now() + ms; holdWhy = why; throw new Error(why); };
  if (r.status === 401) hold(15 * 60e3, 'Performity refused our API key (401): check PERFORMITY_POC_API_KEY. Paused 15 minutes so we never get the IP blocked');
  if (r.status === 403 && /ip/i.test(msg)) throw new Error('Performity: IP not allowed. Give Performity this server’s static outbound IP (Railway → service → Settings → Networking)');
  if (r.status === 403 && /brand/i.test(msg)) throw new Error('Performity: brand not allowed for our key. Use a brand from the list or ask Performity to allow it');
  if (r.status === 403) throw new Error(`Performity refused the call (403${msg ? `: ${msg}` : ''})`);
  if (r.status === 404) throw new Error('Performity: this brand has no connected Shopify store');
  if (r.status === 409) throw new Error('Performity: the brand must reconnect its Shopify store in Performity');
  if (r.status === 429) hold(/invalid key/i.test(msg) ? 15 * 60e3 : 60e3, 'Performity: too many requests. Waiting before trying again');
  if (r.status >= 500 && !retried) { await sleep(2000); return pocCall(path, opts, true); }
  throw new Error(`Performity POC API answered HTTP ${r.status}${msg ? `: ${msg}` : ''}`);
}

/** Brands our key may use: [{ brand_id, brand_name }], cached 10 minutes. */
async function brands({ fresh = false } = {}) {
  if (!fresh && brandCache && Date.now() < brandCache.exp) return brandCache.list;
  const j = await pocCall('/brands');
  const list = (Array.isArray(j) ? j : []).filter((b) => b && /^[0-9a-f-]{36}$/i.test(String(b.brand_id))).map((b) => ({ brand_id: String(b.brand_id), brand_name: String(b.brand_name || '') }));
  brandCache = { list, exp: Date.now() + 10 * 60e3 };
  return list;
}

/** Check a brand may be pulled: in the allowed list, and PERFORMITY_BRAND_ID (when set) is that brand.
 *  Store ids are lower case (folder names); the brand_id goes back to Performity exactly as it gave it. */
async function checkBrand(storeId) {
  const id = String(storeId || '').toLowerCase();
  const want = env('PERFORMITY_BRAND_ID').toLowerCase();
  if (want && id !== want) throw new Error(`PERFORMITY_BRAND_ID limits this app to brand ${want}`);
  const hit = (await brands()).find((b) => b.brand_id.toLowerCase() === id);
  if (!hit) throw new Error(`Brand ${id} isn’t in our allowed list at Performity`);
  return hit.brand_id;
}

/** UTC without a zone ("2026-11-19T10:15:00") must not be read as local time. */
function utc(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const t = Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? t : null;
}

async function fromTokenApi(storeId) {
  const brand = await checkBrand(storeId);
  const j = await pocCall('/fresh-token', { method: 'POST', body: JSON.stringify({ brand_id: brand }), brand });
  if (!j || typeof j.access_token !== 'string' || !j.access_token) throw new Error('Performity gave no access_token');
  const domain = String(j.shop_domain || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) throw new Error('Performity gave a shop_domain that isn’t a *.myshopify.com store');
  const want = env('PERFORMITY_BRAND_ID') ? cleanShop(env('SHOPIFY_STORE')) : '';   // a check for the one pinned brand only
  if (want && cleanShop(domain) !== want) throw new Error(`Performity returned ${domain}, not ${want}.myshopify.com`);
  const expires = utc(j.expires_at);                                   // null = doesn't expire
  if (expires != null && expires - Date.now() < 60e3) throw new Error('Performity gave a token that is about to expire');
  lastShop.set(brand.toLowerCase(), cleanShop(domain));
  /* kept for this pull only (beginPull clears it), and never past 5 minutes before expiry */
  const exp = Math.min(Date.now() + 30 * 60e3, expires == null ? Infinity : expires - API_SKEW);
  return { value: { shop: cleanShop(domain), token: j.access_token, source: 'tokenapi', brand }, exp: Math.max(exp, Date.now() + 60e3) };
}

/** { shop, token, source } for one store (default: the current one, src/scope.js). Throws in plain words if it can't. */
async function access(storeId = scope.id()) {
  const s = status(storeId);
  if (!s.source) throw new Error('Shopify isn’t connected');
  if (!s.ready) throw new Error(`Missing Railway variables: ${s.missing.join(', ')}`);
  const c = caches.get(storeId);
  if (c && Date.now() < c.exp) return c.value;
  if (s.source === 'tokenapi') { const v = await fromTokenApi(storeId); caches.set(storeId, v); return v.value; }
  if (s.source === 'vault' && !vaultStores().includes(storeId)) throw new Error(`Store "${storeId}" isn’t in STORES / SHOPIFY_STORE`);
  if (s.source === 'variables' && storeId !== s.store) throw new Error(`Store "${storeId}" isn’t SHOPIFY_STORE`);
  const raw = s.source === 'vault' ? await readVaultCredentials(storeId)
    : { token: env('SHOPIFY_CLIENT_ID') ? '' : env('SHOPIFY_ACCESS_TOKEN'), clientId: env('SHOPIFY_CLIENT_ID'), clientSecret: env('SHOPIFY_CLIENT_SECRET') };
  const shop = cleanShop(raw.shop) || storeId;
  if (!STORE_RE.test(shop)) throw new Error('Store name is not valid');
  const token = raw.token || (raw.clientId && raw.clientSecret ? await exchange(shop, raw.clientId, raw.clientSecret) : '');
  if (!token) throw new Error(s.source === 'vault' ? `No Shopify client ID + secret found for "${storeId}" in the vault` : 'No Shopify credentials');
  const value = { shop, token, source: s.source };
  caches.set(storeId, { value, exp: Date.now() + TTL });
  return value;
}

/** Forget a store's cached token (Shopify rejected it): its next access() asks the source again. No store: forget all. */
function clear(storeId = scope.current()) {
  if (!storeId) { caches.clear(); shopTokens.clear(); return; }
  const c = caches.get(storeId); caches.delete(storeId);
  shopTokens.delete(c ? c.value.shop : storeId);
}
/** Start of a store's Shopify pull: the POC API's rule is to ask for the token right before each pull. */
function beginPull(storeId = scope.id()) { if (status().source === 'tokenapi') caches.delete(storeId); }
const grantedScopes = () => scopes;
/** The shop handle Performity gave for a brand on its last fresh-token ('' before the first). */
const shopOf = (brand) => lastShop.get(String(brand || '').toLowerCase()) || '';

module.exports = { access, status, clear, beginPull, brands, vaultStores, shopOf, parseSecret, cleanShop, grantedScopes, _utc: utc,
  _resetPoc: () => { holdUntil = 0; holdWhy = ''; brandCache = null; lastShop.clear(); lastToken.clear(); lastCall = 0; gate = Promise.resolve(); },
  _pace: (call, token) => { PACE.call = call; PACE.token = token; } };
