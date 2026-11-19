'use strict';
/*
 * Stand-in for the dev team's token API (option A contract), for testing before the real one exists.
 *   STAND_IN_KEY=secret SHOPIFY_DEV_TOKEN=shpat_… STORES=dev-store.myshopify.com node scripts/stand-in-token-api.js
 * then run the app with TOKEN_API_URL=http://localhost:4499 TOKEN_API_KEY=secret SHOPIFY_STORE=dev-store
 * Use only with a Shopify DEVELOPMENT store token. Never with a client's token.
 */
const http = require('node:http');
const KEY = process.env.STAND_IN_KEY || 'stand-in-key';
const TOKEN = process.env.SHOPIFY_DEV_TOKEN || '';
const STORES = String(process.env.STORES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { error: 'unauthorized' });
  if (url.pathname === '/poc/shopify/stores') return send(res, 200, STORES.map((store) => ({ store })));
  if (url.pathname === '/poc/shopify/token') {
    const store = String(url.searchParams.get('store') || '').toLowerCase();
    if (!STORES.includes(store)) return send(res, 404, { error: 'store not allow-listed' });
    if (!TOKEN) return send(res, 503, { error: 'no token configured' });
    return send(res, 200, { store, access_token: TOKEN, expires_at: new Date(Date.now() + 60 * 60e3).toISOString(), scopes: ['read_products', 'read_inventory', 'read_orders'] });
  }
  send(res, 404, { error: 'not found' });
}).listen(Number(process.env.PORT) || 4499, () => console.log(`stand-in token API on :${Number(process.env.PORT) || 4499} for ${STORES.join(', ') || '(no stores)'}`));
