'use strict';
/*
 * Where the Shopify key comes from. The sync never knows; it calls access() and gets
 * { shop, token, source }. Swapping the source is a Railway variable change, not a code change.
 *
 *   1. Azure Key Vault (preferred)
 *        AZURE_KEY_VAULT_URL   https://<name>.vault.azure.net
 *        AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET   our own Azure login,
 *                              "Key Vault Secrets User" on that vault only
 *        SHOPIFY_STORE         <store> → reads the secret named shopify-<store>
 *      The secret holds the store's admin token (shpat_…), or JSON such as
 *      {"shop":"brand.myshopify.com","accessToken":"shpat_…"} or {"clientId":"…","clientSecret":"…"}.
 *
 *   2. Railway variables (stop-gap)
 *        SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN, or SHOPIFY_STORE + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *
 * Keys live in memory only (30 minutes), never on disk, in logs or in the browser.
 * clear() forgets them, so a token Shopify rejects is read again straight away.
 */

const TTL = 30 * 60e3;
const KV_API = '7.5';
const VAULT_RE = /^https:\/\/[a-z][a-z0-9-]{1,22}[a-z0-9]\.vault\.azure\.net\/?$/i;
const STORE_RE = /^[a-z0-9][a-z0-9-]{0,60}$/i;

let cache = null;                   // { value, exp }
let aad = null;                     // { token, exp }
let shopToken = null;               // { token, exp } from a client-credentials exchange

const env = (k) => String(process.env[k] || '').trim();
const cleanShop = (s) => String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.myshopify\.com$/, '');

/** Which source is configured, and what's missing. Never includes a secret. */
function status() {
  const store = cleanShop(env('SHOPIFY_STORE'));
  const vault = env('AZURE_KEY_VAULT_URL');
  if (vault) {
    const missing = [];
    if (!VAULT_RE.test(vault)) missing.push('AZURE_KEY_VAULT_URL must look like https://<name>.vault.azure.net');
    for (const k of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) if (!env(k)) missing.push(k);
    if (!STORE_RE.test(store)) missing.push('SHOPIFY_STORE');
    return { source: 'vault', store, secretName: `shopify-${store}`, ready: !missing.length, missing };
  }
  if (env('SHOPIFY_ACCESS_TOKEN') || env('SHOPIFY_CLIENT_ID')) {
    const missing = [];
    if (!STORE_RE.test(store)) missing.push('SHOPIFY_STORE');
    if (!env('SHOPIFY_ACCESS_TOKEN') && !env('SHOPIFY_CLIENT_SECRET')) missing.push('SHOPIFY_CLIENT_SECRET');
    return { source: 'variables', store, ready: !missing.length, missing };
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
  if (!r.ok || !j.access_token) throw new Error(`Shopify refused the app's client ID/secret (HTTP ${r.status})`);
  shopToken = { token: j.access_token, exp: Date.now() + Math.max(300, +j.expires_in || 86399) * 1000 - 5 * 60e3 };
  return shopToken.token;
}

/** { shop, token, source } for the configured store. Throws in plain words if it can't. */
async function access() {
  const s = status();
  if (!s.source) throw new Error('Shopify isn’t connected');
  if (!s.ready) throw new Error(`Missing Railway variables: ${s.missing.join(', ')}`);
  if (cache && Date.now() < cache.exp) return cache.value;
  const raw = s.source === 'vault'
    ? parseSecret(await readVaultSecret(s.secretName))
    : { token: env('SHOPIFY_ACCESS_TOKEN'), clientId: env('SHOPIFY_CLIENT_ID'), clientSecret: env('SHOPIFY_CLIENT_SECRET') };
  const shop = cleanShop(raw.shop) || s.store;
  if (!STORE_RE.test(shop)) throw new Error('Store name is not valid');
  const token = raw.token || (raw.clientId && raw.clientSecret ? await exchange(shop, raw.clientId, raw.clientSecret) : '');
  if (!token) throw new Error(s.source === 'vault' ? `Secret "${s.secretName}" has no Shopify token in it` : 'No Shopify token');
  const value = { shop, token, source: s.source };
  cache = { value, exp: Date.now() + TTL };
  return value;
}

function clear() { cache = null; shopToken = null; }

module.exports = { access, status, clear, parseSecret, cleanShop };
