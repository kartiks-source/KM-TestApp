'use strict';
/*
 * Catalys · Stock-out Watch — server. Plain Node, no dependencies.
 *
 *   npm start            → http://localhost:4400
 *   ADMIN_PASSWORD=...   → the page and /api ask for it (any user name). Required once Shopify is connected.
 *   PORT, DATA_DIR       → optional
 *   Shopify (read-only) → see src/keys.js: Azure Key Vault, or SHOPIFY_STORE + SHOPIFY_ACCESS_TOKEN
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./src/store');
const engine = require('./src/engine');
const rows = require('./src/rows');
const demo = require('./src/demo');
const keys = require('./src/keys');
const shopify = require('./src/shopify');

const PORT = Number(process.env.PORT) || 4400;
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC = path.join(__dirname, 'public');
const SYNC_EVERY = 15 * 60e3;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* ---------- helpers ---------- */
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
};
const fail = (res, code, message) => send(res, code, { ok: false, error: message });
const readBody = (req, limit = 25e6) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
/* Login: a normal sign-in page sets a signed cookie (works in every browser, including
 * embedded ones that never show a Basic-auth pop-up). Basic auth still works for scripts. */
const COOKIE = 'sw_session';
const SESSION_DAYS = 30;
const sign = (exp) => crypto.createHmac('sha256', 'stock-watch-session|' + PASSWORD).update(String(exp)).digest('base64url');
const cookieOf = (req, name) => { const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)); return m ? m[1] : ''; };
function sessionOk(req) {
  const [exp, sig] = cookieOf(req, COOKIE).split('.');
  return !!exp && +exp > Date.now() && !!sig && safeEqual(sig, sign(exp));
}
function authed(req) {
  if (!PASSWORD) return true;
  if (sessionOk(req)) return true;
  const m = String(req.headers.authorization || '').match(/^Basic (.+)$/);
  if (!m) return false;
  const [, pass = ''] = Buffer.from(m[1], 'base64').toString().split(':');
  return safeEqual(pass, PASSWORD);
}
const secure = (req) => req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
const fails = new Map();   // ip → { n, until }: slow down password guessing
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function loginPage(error = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Stock-out Watch</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--paper:#F4EFE6;--card:#FFFDF8;--ink:#1D1B2E;--soft:#6B6577;--line:#E4DCCD;--brand:#2B2A6B;--lost:#D9623B}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px}
form{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;width:100%;max-width:360px;display:grid;gap:14px}
.b{display:flex;align-items:center;gap:10px;font-weight:800;font-size:17px}h1{margin:0;font-size:22px}
label{font-size:13px;font-weight:600;color:var(--soft)}input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink)}
button{font:inherit;font-weight:700;padding:11px;border:0;border-radius:8px;background:var(--brand);color:#fff;cursor:pointer}.e{color:var(--lost);font-size:14px;margin:0}
</style></head><body><form method="post" action="/login">
<div class="b"><img src="/favicon.svg" alt="" width="28" height="28">Stock-out Watch</div><h1>Sign in</h1>
${error ? `<p class="e" role="alert">${error}</p>` : ''}
<div><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required></div>
<button type="submit">Sign in</button></form></body></html>`;
}
const publicSettings = (s) => ({ ...s });

/* ---------- Google Sheet sync (published CSV links of the Stock log / Order log tabs) ---------- */
async function syncSheet() {
  const s = store.load().settings;
  if (!s.sheetStockCsv && !s.sheetOrderCsv) return { skipped: true };
  const out = { stock: 0, orders: 0 };
  try {
    for (const [kind, url] of [['stock', s.sheetStockCsv], ['order', s.sheetOrderCsv]]) {
      if (!url) continue;
      if (!/^https:\/\/docs\.google\.com\//.test(url)) throw new Error('Sheet links must be Google Sheets "Publish to web" CSV links');
      const r = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
      if (!r.ok) throw new Error(`${kind} sheet: HTTP ${r.status}`);
      const parsed = rows.fromCsv(await r.text(), kind === 'stock' ? 'stock' : 'order');
      if (kind === 'stock') out.stock = store.add('stock', parsed.rows); else out.orders = store.add('orders', parsed.rows);
    }
    store.setSync({ lastSync: Date.now(), lastSyncError: null });
    return out;
  } catch (e) {
    store.setSync({ lastSync: Date.now(), lastSyncError: e.message });
    throw e;
  }
}

/* ---------- demo data (Sammsara's public catalog, invented stock and sales) ---------- */
function loadDemo() {
  const g = demo.generate({ now: Date.now() });
  store.replaceAll(g.stock, g.orders, 'demo');
  const s = store.load().settings;
  store.setSettings({ demoVersion: demo.VERSION, ...(['Demo Store', '', null, undefined].includes(s.storeName) || /\(demo\)$/.test(s.storeName) ? { storeName: demo.STORE_NAME } : {}) });
  return g;
}

/* ---------- Shopify, read-only pull (stock every 15 minutes, new orders since the last pull) ---------- */
let shopifyRun = null;
function shopifyStatus() {
  const k = keys.status(); const st = store.load().shopify;
  return { source: k.source, store: k.store, secretName: k.secretName || null, ready: k.ready, missing: k.missing,
    lastSync: st.lastSync, lastError: st.lastError, lastTry: st.lastTry, running: !!shopifyRun,
    backfilled: !!st.ordersCursor, scopes: shopify.SCOPES, apiVersion: shopify.API_VERSION };
}
function syncShopify() {
  if (!keys.status().source) return Promise.resolve({ skipped: true });
  if (shopifyRun) return shopifyRun;
  shopifyRun = (async () => {
    const started = Date.now();
    try {
      if (store.load().source === 'demo') store.replaceAll([], [], 'empty');   // never mix demo with live data
      const nm = store.load().settings.storeName;
      if (!nm || nm === 'Demo Store' || /\(demo\)$/.test(nm)) store.setSettings({ storeName: keys.status().store });
      const s = await shopify.pullStock(store.load().shopify.lastQty);
      const stock = store.add('stock', s.rows);
      store.setShopify({ lastQty: s.lastQty });
      let orders = 0;
      await shopify.pullOrders(store.load().shopify.ordersCursor, {
        onPage: (rows, cursor) => { orders += store.add('orders', rows); store.setShopify({ ordersCursor: cursor }); },
      });
      store.setShopify({ lastSync: Date.now(), lastTry: started, lastError: null });
      console.log(`shopify: ${stock} stock changes, ${orders} order lines (${Math.round((Date.now() - started) / 1000)} s)`);
      return { stock, orders };
    } catch (e) {
      store.setShopify({ lastTry: started, lastError: e.message });
      throw e;
    } finally { shopifyRun = null; }
  })();
  return shopifyRun;
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const p = url.pathname;
  const d = store.load();
  const days = Number(url.searchParams.get('days')) || 30;

  /* Shopify Flow → "Send HTTP request" (no login; protected by the ingest key) */
  const ingest = p.match(/^\/ingest\/(stock|order)$/);
  if (ingest && req.method === 'POST') {
    const key = url.searchParams.get('key') || req.headers['x-ingest-key'];
    if (!key || !safeEqual(key, d.settings.ingestKey)) return fail(res, 401, 'Wrong or missing ingest key');
    const raw = await readBody(req, 2e6);
    let body = raw; try { body = JSON.parse(raw); } catch { /* a plain comma-separated line */ }
    const list = (Array.isArray(body) ? body : [body]).flatMap((b) => rows.fromWebhook(b, ingest[1]));
    const n = store.add(ingest[1] === 'stock' ? 'stock' : 'orders', list);
    return send(res, 200, { ok: true, received: list.length, added: n });
  }

  if (!authed(req)) return send(res, 401, { ok: false, error: 'Login needed' });

  if (p === '/api/report' && req.method === 'GET') {
    const r = engine.report(d.stock, d.orders, d.settings, { days });
    return send(res, 200, { ok: true, ...r, source: d.source, lastSync: d.lastSync, lastSyncError: d.lastSyncError, shopify: shopifyStatus() });
  }
  if (p.startsWith('/api/product/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/product/'.length));
    return send(res, 200, { ok: true, ...engine.productDetail(id, d.stock, d.orders, d.settings, { days }) });
  }
  if (p === '/api/settings' && req.method === 'GET') return send(res, 200, { ok: true, settings: publicSettings(d.settings), source: d.source, lastSync: d.lastSync, lastSyncError: d.lastSyncError, shopify: shopifyStatus() });
  if (p === '/api/shopify/sync' && req.method === 'POST') {
    if (!keys.status().source) return fail(res, 400, 'Shopify isn’t connected');
    const run = syncShopify();
    const done = await Promise.race([run.then((x) => x, (e) => ({ error: e.message })), new Promise((r) => setTimeout(() => r(null), 25000))]);
    if (!done) return send(res, 202, { ok: true, running: true });
    return done.error ? fail(res, 502, done.error) : send(res, 200, { ok: true, ...done });
  }
  if (p === '/api/settings' && req.method === 'PUT') {
    const b = JSON.parse(await readBody(req) || '{}'); const patch = {};
    const n = (k, lo, hi) => { if (b[k] != null && b[k] !== '' && Number.isFinite(+b[k])) patch[k] = Math.min(hi, Math.max(lo, +b[k])); };
    n('leadDays', 0, 180); n('coverDays', 1, 365); n('safetyDays', 0, 60); n('demandWindowDays', 7, 90); n('smallTopUpDays', 1, 60); n('minPerDay', 0, 100); n('tzOffsetMin', -720, 840);
    if (typeof b.storeName === 'string') patch.storeName = b.storeName.slice(0, 60);
    for (const k of ['sheetStockCsv', 'sheetOrderCsv']) if (typeof b[k] === 'string') patch[k] = b[k].trim().slice(0, 500);
    if (b.newIngestKey === true) patch.ingestKey = crypto.randomBytes(16).toString('hex');
    return send(res, 200, { ok: true, settings: store.setSettings(patch) });
  }
  if (p === '/api/import' && req.method === 'POST') {
    const kind = url.searchParams.get('kind') === 'order' ? 'order' : 'stock';
    const parsed = rows.fromCsv(await readBody(req), kind);
    if (d.source === 'demo' && url.searchParams.get('replaceDemo') === '1') store.replaceAll([], [], 'empty');
    const added = store.add(kind === 'stock' ? 'stock' : 'orders', parsed.rows);
    return send(res, 200, { ok: true, read: parsed.rows.length, added, skipped: parsed.skipped });
  }
  if (p === '/api/sync' && req.method === 'POST') {
    try { return send(res, 200, { ok: true, ...(await syncSheet()) }); } catch (e) { return fail(res, 502, e.message); }
  }
  if (p === '/api/demo' && req.method === 'POST') {
    if (keys.status().source) return fail(res, 409, 'Shopify is connected, so demo data is off (it would mix with real data)');
    const g = loadDemo();
    return send(res, 200, { ok: true, stock: g.stock.length, orders: g.orders.length });
  }
  if (p === '/api/clear' && req.method === 'POST') { store.replaceAll([], [], 'empty'); return send(res, 200, { ok: true }); }
  if (p === '/api/export/reorder.csv' && req.method === 'GET') {
    const r = engine.report(d.stock, d.orders, d.settings, { days });
    const head = ['Status', 'Product', 'SKU', 'Stock now', 'Sells per day', 'Days left', 'Order qty', 'Order value', 'Lost (₹)', 'Stock-outs'];
    const q = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const csv = [head, ...r.reorder.map((x) => [x.status, x.name, x.sku, x.stock, x.perDay, x.daysLeft ?? '', x.orderQty, x.orderValue, x.lost, x.outs])].map((l) => l.map(q).join(',')).join('\n');
    return send(res, 200, '﻿' + csv, 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="reorder-${new Date().toISOString().slice(0, 10)}.csv"` });
  }
  return fail(res, 404, 'Not found');
}

/* ---------- static ---------- */
function serveStatic(req, res, url) {
  if (!authed(req)) {
    if (url.pathname === '/favicon.svg') { res.writeHead(200, { 'content-type': TYPES['.svg'] }); return fs.createReadStream(path.join(PUBLIC, 'favicon.svg')).pipe(res); }
    return send(res, 302, '', 'text/plain', { location: '/login' });
  }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname === '/login' && req.method === 'GET') {
      if (!PASSWORD || authed(req)) return send(res, 302, '', 'text/plain', { location: '/' });
      return send(res, 200, loginPage(), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const ip = ipOf(req); const f = fails.get(ip);
      if (f && f.n >= 10 && Date.now() < f.until) return send(res, 429, loginPage('Too many tries. Wait 15 minutes.'), 'text/html; charset=utf-8');
      const pass = new URLSearchParams(await readBody(req, 4096)).get('password') || '';
      if (!PASSWORD || !safeEqual(pass, PASSWORD)) {
        const n = (f && Date.now() < f.until ? f.n : 0) + 1; fails.set(ip, { n, until: Date.now() + 15 * 60e3 });
        return send(res, 401, loginPage('Wrong password.'), 'text/html; charset=utf-8');
      }
      fails.delete(ip);
      const exp = Date.now() + SESSION_DAYS * 864e5;
      return send(res, 303, '', 'text/plain', { location: '/', 'set-cookie': `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req)}` });
    }
    if (url.pathname === '/logout') return send(res, 303, '', 'text/plain', { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req)}` });
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ingest/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    return fail(res, e.code === 413 ? 413 : 500, e.code === 413 ? 'Upload too large' : 'Something went wrong on the server');
  }
});

if (require.main === module) {
  if (keys.status().source && !PASSWORD) {
    console.error('Refusing to start: Shopify is connected, so set ADMIN_PASSWORD first.');
    process.exit(1);
  }
  const d = store.load();
  const stale = d.source === 'demo' && d.settings.demoVersion !== demo.VERSION;
  if (!keys.status().source && (stale || (d.source === 'empty' && !d.stock.length && !d.orders.length))) {
    loadDemo();
    console.log('Loaded demo data (replace it from Data & settings).');
  }
  setInterval(() => syncSheet().catch((e) => console.warn('sheet sync:', e.message)), SYNC_EVERY).unref();
  if (keys.status().source) {
    const pull = () => syncShopify().catch((e) => console.warn('shopify pull failed:', e.message));
    setTimeout(pull, 5000).unref();
    setInterval(pull, SYNC_EVERY).unref();
  }
  server.listen(PORT, () => console.log(`Stock-out Watch on http://localhost:${PORT}${PASSWORD ? ' (password on)' : ''}`));
}

module.exports = { server, syncShopify };
