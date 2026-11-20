'use strict';
/*
 * Stand-in for the Performity POC API ("Performity POC API: calling guide"), for testing before access.
 *   STAND_IN_KEY=secret SHOPIFY_DEV_TOKEN=shpat_… SHOP_DOMAIN=dev-store.myshopify.com node scripts/stand-in-token-api.js
 * then run the app with PERFORMITY_POC_API_URL=http://localhost:4499 PERFORMITY_POC_API_KEY=secret
 * Use only with a Shopify DEVELOPMENT store token. Never with a client's token.
 */
const http = require('node:http');
const KEY = process.env.STAND_IN_KEY || 'stand-in-key';
const TOKEN = process.env.SHOPIFY_DEV_TOKEN || '';
const SHOP = (process.env.SHOP_DOMAIN || 'dev-store.myshopify.com').toLowerCase();
const BRAND = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.headers['x-api-key'] !== KEY) return send(res, 401, { error: 'Invalid API key' });
  if (req.method === 'GET' && p === '/catalys/shopify/service/external/brands') return send(res, 200, [{ brand_id: BRAND, brand_name: 'Dev store' }]);
  if (req.method === 'POST' && p === '/catalys/shopify/service/external/fresh-token') {
    let b = ''; req.on('data', (c) => { b += c; });
    return req.on('end', () => {
      let id = ''; try { id = JSON.parse(b).brand_id; } catch { /* bad body */ }
      if (!id) return send(res, 400, { error: 'brand_id (uuid) is required' });
      if (id !== BRAND) return send(res, 403, { error: 'Brand not allowed' });
      if (!TOKEN) return send(res, 404, { error: 'No connected Shopify store for this brand.' });
      return send(res, 200, { access_token: TOKEN, shop_domain: SHOP, expires_at: new Date(Date.now() + 60 * 60e3).toISOString().replace(/\.\d+Z$/, '') });
    });
  }
  send(res, 404, { error: 'not found' });
}).listen(Number(process.env.PORT) || 4499, () => console.log(`stand-in Performity POC API on :${Number(process.env.PORT) || 4499} (${SHOP})`));
