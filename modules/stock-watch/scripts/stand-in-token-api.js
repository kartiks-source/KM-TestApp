'use strict';
/*
 * Stand-in for the Performity POC API ("Performity POC API: calling guide"), for testing before access.
 *   STAND_IN_KEY=secret SHOPIFY_DEV_TOKEN=shpat_… SHOP_DOMAIN=dev-store.myshopify.com node scripts/stand-in-token-api.js
 * then run the app with PERFORMITY_POC_API_URL=http://localhost:4499 PERFORMITY_POC_API_KEY=secret
 * Use only with a Shopify DEVELOPMENT store token. Never with a client's token.
 *
 * Several brands (multi-store, ADR-0015): STAND_IN_BRANDS=2 lists a second brand, "Dev store 2", with its own
 * token and shop: SHOPIFY_DEV_TOKEN_2 + SHOP_DOMAIN_2 (default: the first brand's). Like the real API it allows
 * 10 token calls a minute per brand (then 429). PORT=0 picks a free port; the port is printed.
 */
const http = require('node:http');
const KEY = process.env.STAND_IN_KEY || 'stand-in-key';
const BRANDS = [
  { brand_id: '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90', brand_name: 'Dev store', token: process.env.SHOPIFY_DEV_TOKEN || '', shop: process.env.SHOP_DOMAIN || 'dev-store.myshopify.com' },
  { brand_id: '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f', brand_name: 'Dev store 2', token: process.env.SHOPIFY_DEV_TOKEN_2 || process.env.SHOPIFY_DEV_TOKEN || '', shop: process.env.SHOP_DOMAIN_2 || process.env.SHOP_DOMAIN || 'dev-store.myshopify.com' },
].slice(0, Math.min(2, Math.max(1, Number(process.env.STAND_IN_BRANDS) || 1)));
const tokenCalls = new Map();   // brand → times of its token calls in the last minute
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.headers['x-api-key'] !== KEY) return send(res, 401, { error: 'Invalid API key' });
  if (req.method === 'GET' && p === '/catalys/shopify/service/external/brands') return send(res, 200, BRANDS.map((b) => ({ brand_id: b.brand_id, brand_name: b.brand_name })));
  if (req.method === 'POST' && p === '/catalys/shopify/service/external/fresh-token') {
    let body = ''; req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      let id = ''; try { id = JSON.parse(body).brand_id; } catch { /* bad body */ }
      if (!id) return send(res, 400, { error: 'brand_id (uuid) is required' });
      const b = BRANDS.find((x) => x.brand_id === id);
      if (!b) return send(res, 403, { error: 'Brand not allowed' });
      const now = Date.now(), recent = (tokenCalls.get(id) || []).filter((t) => now - t < 60e3);
      if (recent.length >= 10) return send(res, 429, { error: 'Too many token requests for this brand' });
      tokenCalls.set(id, [...recent, now]);
      if (!b.token) return send(res, 404, { error: 'No connected Shopify store for this brand.' });
      return send(res, 200, { access_token: b.token, shop_domain: b.shop.toLowerCase(), expires_at: new Date(now + 60 * 60e3).toISOString().replace(/\.\d+Z$/, '') });
    });
  }
  send(res, 404, { error: 'not found' });
});
server.listen(process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 4499, () => {
  console.log(`stand-in Performity POC API on :${server.address().port} (${BRANDS.map((b) => `${b.brand_name}: ${b.shop}`).join(', ')})`);
});
