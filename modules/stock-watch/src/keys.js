'use strict';
/*
 * Where the Shopify key comes from. The sync never knows; it calls access() and gets
 * { shop, token, source }. Swapping the source is a Railway variable change, not a code change.
 *
 * Shopify credentials are normally an app's CLIENT ID + CLIENT SECRET (apps made in Shopify's Dev
 * Dashboard). We swap them for a 24-hour access token (client credentials grant) and get a new one
 * before it runs out. Shopify only allows this when the app and the store are in the same Shopify
 * organisation, so for a brand's store the brand creates the app and shares its ID + secret.
 * A legacy custom-app admin token (shpat_…) still works if that's all there is.
 *
 *   0. Token API from the main product (DECIDED, 19 Nov 2026: Shopify Access Options, option A)
 *        TOKEN_API_URL         https://… base of the dev team's token API
 *        TOKEN_API_KEY         the key only this app holds (Railway variable)
 *        TOKEN_API_HEADER      optional header name; default "Authorization" sent as "Bearer <key>",
 *                              any other name (e.g. X-Api-Key) is sent with the raw key
 *        SHOPIFY_STORE         <store> (the part before .myshopify.com)
 *      GET {TOKEN_API_URL}/poc/shopify/token?store=<store>.myshopify.com
 *        → { store, access_token, expires_at, scopes }
 *      We NEVER refresh a token and never see the app's keys. The token is kept in memory until
 *      5 minutes before expires_at; if Shopify rejects it we ask the API once more; if the API is
 *      down we keep using the current token until it expires, then pulls pause and alert.
 *
 *   1. Azure Key Vault
 *        AZURE_KEY_VAULT_URL   https://<name>.vault.azure.net
 *        AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET   our own Azure login,
 *                              "Key Vault Secrets User" on that vault only
 *        SHOPIFY_STORE         <store>
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

const TTL = 30 * 60e3;
const API_SKEW = 5 * 60e3;            // stop using a token-API token 5 minutes before it expires
const KV_API = '7.5';
const VAULT_RE = /^https:\/\/[a-z][a-z0-9-]{1,22}[a-z0-9]\.vault\.azure\.net\/?$/i;
const STORE_RE = /^[a-z0-9][a-z0-9-]{0,60}$/i;

let cache = null;                   // { value, exp }
let aad = null;                     // { token, exp }
let shopToken = null;               // { token, exp } from a client-credentials exchange (24 h)
let scopes = '';                    // scopes Shopify granted, from the last exchange

const env = (k) => String(process.env[k] || '').trim();
const cleanShop = (s) => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.myshopify\.com$/, '');

/** Which source is configured, and what's missing. Never includes a secret. */
function status() {
  const store = cleanShop(env('SHOPIFY_STORE'));
  const api = env('TOKEN_API_URL');
  if (api) {
    const missing = [];
    if (!/^https:\/\/[^\s/]+/i.test(api) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(api)) missing.push('TOKEN_API_URL must start with https://');
    if (!env('TOKEN_API_KEY')) missing.push('TOKEN_API_KEY');
    if (!STORE_RE.test(store)) missing.push('SHOPIFY_STORE');
    return { source: 'tokenapi', store, kind: 'main product token API (hourly tokens)', ready: !missing.length, missing };
  }
  const vault = env('AZURE_KEY_VAULT_URL');
  if (vault) {
    const missing = [];
    if (!VAULT_RE.test(vault)) missing.push('AZURE_KEY_VAULT_URL must look like https://<name>.vault.azure.net');
    for (const k of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) if (!env(k)) missing.push(k);
    if (!STORE_RE.test(store)) missing.push('SHOPIFY_STORE');
    return { source: 'vault', store, secretName: `shopify-${store}-client-id / -client-secret (or shopify-${store})`, ready: !missing.length, missing };
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
  if (shopToken && Date.now() < shopToken.exp) return shopToken.token;
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
  shopToken = { token: j.access_token, exp: Date.now() + Math.max(300, +j.expires_in || 86399) * 1000 - 5 * 60e3 };
  return shopToken.token;
}

/** Token API (option A): the current token for this store. Never refreshes anything itself. */
let lastApi = null;                 // last good { value, exp } from the token API, kept as a fallback
async function fromTokenApi(s) {
  const base = env('TOKEN_API_URL').replace(/\/+$/, '');
  const header = env('TOKEN_API_HEADER') || 'Authorization';
  const key = env('TOKEN_API_KEY');
  const domain = `${s.store}.myshopify.com`;
  let r;
  try {
    r = await fetch(`${base}/poc/shopify/token?store=${encodeURIComponent(domain)}`, {
      headers: { [header]: header.toLowerCase() === 'authorization' ? `Bearer ${key}` : key, accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
  } catch (e) { r = null; }
  if (!r || r.status >= 500) {
    if (lastApi && Date.now() < lastApi.exp) return lastApi;                 // API down: keep the current token until it expires
    throw new Error('Token API is unavailable and the last token has expired: pulls are paused until it answers');
  }
  if (r.status === 401 || r.status === 403) throw new Error('Token API refused our key: check TOKEN_API_KEY, and that this server’s outbound IP is allow-listed');
  if (r.status === 404) throw new Error(`Store ${domain} isn’t allow-listed on the token API`);
  if (!r.ok) throw new Error(`Token API answered HTTP ${r.status}`);
  const j = await r.json().catch(() => ({}));
  if (!j.access_token || typeof j.access_token !== 'string') throw new Error('Token API gave no access_token');
  if (j.store && cleanShop(j.store) !== s.store) throw new Error(`Token API returned a token for ${j.store}, not ${domain}`);
  const expires = Date.parse(j.expires_at);
  const exp = (Number.isFinite(expires) ? expires : Date.now() + 55 * 60e3) - API_SKEW;
  if (exp <= Date.now()) throw new Error('Token API gave a token that is already expiring');
  scopes = Array.isArray(j.scopes) ? j.scopes.join(',') : String(j.scopes || '');
  lastApi = { value: { shop: s.store, token: j.access_token, source: 'tokenapi' }, exp };
  return lastApi;
}

/** { shop, token, source } for the configured store. Throws in plain words if it can't. */
async function access() {
  const s = status();
  if (!s.source) throw new Error('Shopify isn’t connected');
  if (!s.ready) throw new Error(`Missing Railway variables: ${s.missing.join(', ')}`);
  if (cache && Date.now() < cache.exp) return cache.value;
  if (s.source === 'tokenapi') { cache = await fromTokenApi(s); return cache.value; }
  const raw = s.source === 'vault' ? await readVaultCredentials(s.store)
    : { token: env('SHOPIFY_CLIENT_ID') ? '' : env('SHOPIFY_ACCESS_TOKEN'), clientId: env('SHOPIFY_CLIENT_ID'), clientSecret: env('SHOPIFY_CLIENT_SECRET') };
  const shop = cleanShop(raw.shop) || s.store;
  if (!STORE_RE.test(shop)) throw new Error('Store name is not valid');
  const token = raw.token || (raw.clientId && raw.clientSecret ? await exchange(shop, raw.clientId, raw.clientSecret) : '');
  if (!token) throw new Error(s.source === 'vault' ? `No Shopify client ID + secret found for "${s.store}" in the vault` : 'No Shopify credentials');
  const value = { shop, token, source: s.source };
  cache = { value, exp: Date.now() + TTL };
  return value;
}

/** Forget the cached token (Shopify rejected it): the next access() asks the source again. */
function clear() { cache = null; shopToken = null; if (lastApi) lastApi = null; }
const grantedScopes = () => scopes;

module.exports = { access, status, clear, parseSecret, cleanShop, grantedScopes };
