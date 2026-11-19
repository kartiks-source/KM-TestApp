'use strict';
/*
 * Catalys · Stock-out Watch — server. Plain Node, no dependencies.
 *
 *   npm start            → http://localhost:4400
 *   ADMIN_PASSWORD=...   → the page and /api ask for it (any user name). Required once Shopify is connected,
 *                          and with NODE_ENV=production (at least 12 characters).
 *   PORT, DATA_DIR       → optional
 *   Shopify (read-only) → see src/keys.js: client ID + secret from Azure Key Vault, or SHOPIFY_STORE + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
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
const PROD = process.env.NODE_ENV === 'production';
const MIN_PASSWORD = 12;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');   // same folder as src/store.js
const PUBLIC = path.join(__dirname, 'public');
const SYNC_EVERY = 15 * 60e3;
const KEEP_DAYS = 120;   // same as src/store.js: older rows would be pruned on save, so they're reported as skipped
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* ---------- helpers ---------- */
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
};
const fail = (res, code, message) => send(res, code, { ok: false, error: message });
const readBody = (req, limit = 25e6) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Upload too large'), { status: 413 })); req.removeAllListeners('data'); req.resume(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* ---------- login ----------
 * A sign-in page sets a signed cookie (works in every browser, including embedded ones that never
 * show a Basic-auth pop-up). Basic auth still works for scripts. One limiter covers both.
 * Session cookies are signed with a key made from a random secret in DATA_DIR/secret (mode 600)
 * plus a fingerprint of the password, so changing ADMIN_PASSWORD signs everyone out. */
const COOKIE = 'sw_session';
const SESSION_DAYS = 30;
function loadSecret() {
  const file = path.join(DATA_DIR, 'secret');
  try { const v = fs.readFileSync(file, 'utf8').trim(); if (v.length >= 32) { try { fs.chmodSync(file, 0o600); } catch { /* read-only volume: still usable */ } return v; } }
  catch (e) { if (e.code !== 'ENOENT') console.warn('session secret unreadable, making a new one:', e.code || e.message); }
  const v = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, v + '\n', { mode: 0o600 }); }
  catch (e) { console.warn('session secret not saved (sign-ins end on restart):', e.code || e.message); }
  return v;
}
let sessionKey = null;
const keyOf = () => sessionKey || (sessionKey = crypto.createHmac('sha256', loadSecret()).update('password|' + crypto.createHash('sha256').update(PASSWORD).digest('hex')).digest());
const sign = (exp) => crypto.createHmac('sha256', keyOf()).update('session|' + exp).digest('base64url');
const cookieOf = (req, name) => { const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)); return m ? m[1] : ''; };
function sessionOk(req) {
  const [exp, sig] = cookieOf(req, COOKIE).split('.');
  return !!exp && +exp > Date.now() && !!sig && safeEqual(sig, sign(exp));
}
const secure = (req) => req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
/** Client IP: the last X-Forwarded-For hop (added by Railway's proxy; earlier hops are whatever the client sent), else the socket. */
const ipOf = (req) => { const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean); return hops.length ? hops[hops.length - 1] : String(req.socket.remoteAddress || ''); };

/* Wrong-password limiter for the sign-in form and Basic auth: 10 per IP per 15 minutes, 100 across all IPs. */
const LIMIT = { window: 15 * 60e3, perIp: 10, global: 100, maxIps: 10000 };
const fails = new Map();   // ip → { n, until }
let globalFails = [];      // times of the latest wrong passwords (at most LIMIT.global)
let lastSweep = 0;
const limiter = {
  blocked(ip, now = Date.now()) {
    if (now - lastSweep > 60e3) { lastSweep = now; for (const [k, f] of fails) if (now >= f.until) fails.delete(k); }
    globalFails = globalFails.filter((t) => now - t < LIMIT.window);
    const f = fails.get(ip);
    return (!!f && f.n >= LIMIT.perIp && now < f.until) || globalFails.length >= LIMIT.global;
  },
  fail(ip, now = Date.now()) {
    const f = fails.get(ip); const n = (f && now < f.until ? f.n : 0) + 1;
    fails.delete(ip); fails.set(ip, { n, until: now + LIMIT.window });
    while (fails.size > LIMIT.maxIps) fails.delete(fails.keys().next().value);   // oldest first
    globalFails.push(now); if (globalFails.length > LIMIT.global) globalFails.shift();
  },
  ok(ip) { fails.delete(ip); },
};
/** 'ok' | 'none' (no credentials) | 'bad' (wrong password) | 'limited' (too many wrong tries). */
function auth(req) {
  if (!PASSWORD) return 'ok';
  if (sessionOk(req)) return 'ok';
  const m = String(req.headers.authorization || '').match(/^Basic\s+(\S+)$/i);
  if (!m) return 'none';
  const ip = ipOf(req);
  if (limiter.blocked(ip)) return 'limited';
  const raw = Buffer.from(m[1], 'base64').toString('utf8'); const i = raw.indexOf(':');
  const pass = i >= 0 ? raw.slice(i + 1) : '';   // everything after the first ":" (passwords may contain ":")
  if (safeEqual(pass, PASSWORD)) { limiter.ok(ip); return 'ok'; }
  limiter.fail(ip); return 'bad';
}
const TOO_MANY = 'Too many wrong passwords. Wait 15 minutes.';
function loginPage(error = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Stock-out Watch</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap">
<style>
:root{--paper:#EEF3F8;--card:#FFFFFF;--ink:#0E1626;--soft:#5B6478;--line:#DDE3EC;--brand:#0978BE;--lost:#E0506E}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:16px}
form{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 18px 40px -22px rgba(14,22,38,.28);padding:28px;width:100%;max-width:360px;display:grid;gap:14px}
.b{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px}h1{margin:0;font-size:22px;font-weight:600;letter-spacing:-.02em}
label{font-size:13px;font-weight:600;color:var(--soft)}input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink)}input:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px #E9F4FB}
button{font:inherit;font-weight:700;padding:11px;border:0;border-radius:8px;background:var(--brand);color:#fff;cursor:pointer}.e{color:var(--lost);font-size:14px;margin:0}
</style></head><body><form method="post" action="/login">
<div class="b"><img src="/favicon.svg" alt="" width="28" height="28">Stock-out Watch</div><h1>Sign in</h1>
${error ? `<p class="e" role="alert">${error}</p>` : ''}
<div><label for="pw">Password</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus required></div>
<button type="submit">Sign in</button></form></body></html>`;
}
const publicSettings = (s) => ({ ...s });
/* The planning assumptions people can tweak. Same limits whether trying a value or saving it. */
const LIMITS = { leadDays: [0, 180], coverDays: [1, 365], safetyDays: [0, 60], demandWindowDays: [7, 90], smallTopUpDays: [1, 60], minPerDay: [0, 100], tzOffsetMin: [-720, 840] };
const clampSetting = (k, v) => (v == null || String(v).trim() === '' || !Number.isFinite(+v) ? undefined : Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], +v)));
/** Saved settings, with any ?leadDays=… style trial values on top (not saved). */
function settingsFor(url, saved) {
  const out = { ...saved };
  for (const k of Object.keys(LIMITS)) { const v = clampSetting(k, url.searchParams.get(k)); if (v !== undefined) out[k] = v; }
  return out;
}

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
      let parsed;
      try { parsed = rows.fromCsv(await r.text(), kind === 'stock' ? 'stock' : 'order', { tzOffsetMin: s.tzOffsetMin, keepDays: KEEP_DAYS }); }
      catch (e) { throw new Error(`${kind} sheet: ${e.message}`); }
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
  return { source: k.source, store: k.store, secretName: k.secretName || null, kind: k.kind || null, ready: k.ready, missing: k.missing,
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
        onPage: (names, rows, cursor) => { orders += store.replaceOrders(names, rows).added; if (cursor) store.setShopify({ ordersCursor: cursor }); },
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
const MAX_INGEST_ROWS = 500;   // Flow sends one change per request; a leaked key can't flood the store
let keyInUrlWarned = 0;
async function api(req, res, url) {
  const p = url.pathname;
  const d = store.load();
  const days = Number(url.searchParams.get('days')) || 30;

  /* Shopify Flow → "Send HTTP request" (no login; protected by the X-Ingest-Key header) */
  const ingest = p.match(/^\/ingest\/(stock|order)$/);
  if (ingest && req.method === 'POST') {
    let key = req.headers['x-ingest-key'];
    if (!key && url.searchParams.has('key')) {   // old URLs: still accepted, but the key ends up in proxy and Flow logs
      key = url.searchParams.get('key');
      if (Date.now() - keyInUrlWarned > 3600e3) { keyInUrlWarned = Date.now(); console.warn('ingest: key in the URL (?key=) is deprecated, send the X-Ingest-Key header instead'); }
    }
    if (!key || !safeEqual(key, d.settings.ingestKey)) return fail(res, 401, 'Wrong or missing ingest key');
    const raw = await readBody(req, 2e6);
    let body = raw; try { body = JSON.parse(raw); } catch { /* a plain comma-separated line */ }
    if (Array.isArray(body) && body.length > MAX_INGEST_ROWS) return fail(res, 413, `At most ${MAX_INGEST_ROWS} rows per request`);
    const list = (Array.isArray(body) ? body : [body]).flatMap((b) => rows.fromWebhook(b, ingest[1], { tzOffsetMin: d.settings.tzOffsetMin }));
    if (list.length > MAX_INGEST_ROWS) return fail(res, 413, `At most ${MAX_INGEST_ROWS} rows per request`);
    const n = store.add(ingest[1] === 'stock' ? 'stock' : 'orders', list);
    return send(res, 200, { ok: true, received: list.length, added: n });
  }

  const a = auth(req);
  if (a === 'limited') return send(res, 429, { ok: false, error: TOO_MANY }, undefined, { 'retry-after': '900' });
  if (a !== 'ok') return send(res, 401, { ok: false, error: 'Login needed' });

  if (p === '/api/report' && req.method === 'GET') {
    const r = engine.report(d.stock, d.orders, settingsFor(url, d.settings), { days });
    return send(res, 200, { ok: true, ...r, source: d.source, lastSync: d.lastSync, lastSyncError: d.lastSyncError, shopify: shopifyStatus() });
  }
  if (p.startsWith('/api/product/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/product/'.length));
    return send(res, 200, { ok: true, ...engine.productDetail(id, d.stock, d.orders, settingsFor(url, d.settings), { days }) });
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
    for (const k of Object.keys(LIMITS)) { const v = clampSetting(k, b[k]); if (v !== undefined) patch[k] = v; }
    if (typeof b.storeName === 'string') patch.storeName = b.storeName.slice(0, 60);
    for (const k of ['sheetStockCsv', 'sheetOrderCsv']) if (typeof b[k] === 'string') patch[k] = b[k].trim().slice(0, 500);
    if (b.newIngestKey === true) { patch.ingestKey = crypto.randomBytes(16).toString('hex'); patch.ingestKeyAt = Date.now(); }
    return send(res, 200, { ok: true, settings: store.setSettings(patch) });
  }
  if (p === '/api/import' && req.method === 'POST') {
    const kind = url.searchParams.get('kind') === 'order' ? 'order' : 'stock';
    // Throws status 400 naming any missing column, before anything is replaced or stored.
    const parsed = rows.fromCsv(await readBody(req), kind, { tzOffsetMin: d.settings.tzOffsetMin, keepDays: KEEP_DAYS });
    if (d.source === 'demo' && url.searchParams.get('replaceDemo') === '1') store.replaceAll([], [], 'empty');
    const added = store.add(kind === 'stock' ? 'stock' : 'orders', parsed.rows);
    return send(res, 200, { ok: true, read: parsed.rows.length, added, skipped: parsed.skipped, skips: parsed.skips });
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
    const r = engine.report(d.stock, d.orders, settingsFor(url, d.settings), { days });
    const head = ['Status', 'Product', 'SKU', 'Stock now', 'Sells per day', 'Days left', 'Order qty', 'Order value', 'Lost (₹)', 'Stock-outs'];
    const csv = [head, ...r.reorder.map((x) => [x.status, x.name, x.sku, x.stock, x.perDay, x.daysLeft ?? '', x.orderQty, x.orderValue, x.lost, x.outs])].map((l) => l.map(rows.csvCell).join(',')).join('\n');
    return send(res, 200, '﻿' + csv, 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="reorder-${new Date().toISOString().slice(0, 10)}.csv"` });
  }
  return fail(res, 404, 'Not found');
}

/* ---------- static ---------- */
function serveStatic(req, res, url) {
  if (auth(req) !== 'ok') {
    if (url.pathname === '/favicon.svg') { res.writeHead(200, { 'content-type': TYPES['.svg'] }); return fs.createReadStream(path.join(PUBLIC, 'favicon.svg')).pipe(res); }
    return send(res, 302, '', 'text/plain', { location: '/login' });
  }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

/* ---------- security headers + same-origin writes ---------- */
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
function securityHeaders(req, res) {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('strict-transport-security', 'max-age=15552000');
}
/** A browser write from another site (CSRF). Modern browsers say so in Sec-Fetch-Site; otherwise Origin must match
 *  our host (X-Forwarded-Host behind a proxy). Scripts (curl, Flow) send neither and pass. */
function crossSite(req) {
  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') return true;   // cross-site, or same-site (another *.up.railway.app app)
  const origin = req.headers.origin;
  if (!origin || site === 'same-origin') return false;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  try { return new URL(origin).host.toLowerCase() !== host; } catch { return true; }   // includes Origin: null
}
const isWrite = (req) => !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

const server = http.createServer(async (req, res) => {
  securityHeaders(req, res);
  const url = new URL(req.url, 'http://local');
  try {
    if (isWrite(req) && (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/logout') && crossSite(req)) {
      return fail(res, 403, 'Cross-site request refused');
    }
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname === '/login' && req.method === 'GET') {
      if (auth(req) === 'ok') return send(res, 302, '', 'text/plain', { location: '/' });
      return send(res, 200, loginPage(), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      if (!PASSWORD) return send(res, 303, '', 'text/plain', { location: '/' });
      const ip = ipOf(req);
      if (limiter.blocked(ip)) return send(res, 429, loginPage(TOO_MANY), 'text/html; charset=utf-8', { 'retry-after': '900' });
      const pass = new URLSearchParams(await readBody(req, 4096)).get('password') || '';
      if (!safeEqual(pass, PASSWORD)) { limiter.fail(ip); return send(res, 401, loginPage('Wrong password.'), 'text/html; charset=utf-8'); }
      limiter.ok(ip);
      const exp = Date.now() + SESSION_DAYS * 864e5;
      return send(res, 303, '', 'text/plain', { location: '/', 'set-cookie': `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req)}` });
    }
    if (url.pathname === '/logout') {   // POST only, so a link or image elsewhere can't sign people out
      if (req.method !== 'POST') return send(res, 303, '', 'text/plain', { location: '/' });
      return send(res, 303, '', 'text/plain', { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req)}` });
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ingest/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (e.status >= 400 && e.status < 500) return fail(res, e.status, e.message);
    console.error(e);
    return fail(res, 500, 'Something went wrong on the server');
  }
});

if (require.main === module) {
  if (PROD && PASSWORD.length < MIN_PASSWORD) {
    console.error(`Refusing to start: NODE_ENV=production needs ADMIN_PASSWORD set, at least ${MIN_PASSWORD} characters.`);
    process.exit(1);
  }
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
