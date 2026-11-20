'use strict';
/* SW-045 through the real server: POST /api/import/preview writes nothing; POST /api/import?map= reads through the mapping
 * and remembers it per store and header set; Shopify exports import out of the box (no ?map=) and join each other on SKU;
 * view-only and cross-site writes are refused. Real-shaped samples: test/fixtures/shopify-*.csv (dates moved to recent days). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MOD = path.join(__dirname, '..');
const A = 'sammsara-demo', B = 'second-demo';
const PW = 'import-admin-password', VIEW = 'import-view-password';
const basic = (p) => ({ authorization: 'Basic ' + Buffer.from('u:' + p).toString('base64') });
let srv, dir;

/** The fixture with its Shopify dates (2026-11-15 … 19, +0530) moved so the newest is yesterday. */
function recent(name) {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const shift = Date.now() - 864e5 - Date.parse('2026-11-19T23:59:00+05:30');
  return text.replace(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+0530/g, (_, d, t) => new Date(Date.parse(`${d}T${t}+05:30`) + shift).toISOString());
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-import-'));
  srv = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: MOD, env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: PW, VIEW_PASSWORD: VIEW } });
    let out = '';
    child.stdout.on('data', (b) => { out += b; const m = out.match(/localhost:(\d+)/); if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}` }); });
    child.stderr.on('data', (b) => { out += b; });
    child.on('exit', (c) => reject(new Error(`server exited ${c}: ${out}`)));
  });
});
test.after(async () => {
  srv.child.removeAllListeners('exit');
  await new Promise((r) => { srv.child.on('exit', r); srv.child.kill(); });
  fs.rmSync(dir, { recursive: true, force: true });
});
const req = (p, opt = {}, pw = PW) => fetch(srv.base + p, { ...opt, headers: { ...basic(pw), ...(opt.headers || {}) } });
const post = (p, body, opt = {}) => req(p, { method: 'POST', body, headers: { 'content-type': 'text/csv' }, ...opt });
const json = async (r) => ({ status: r.status, ...(await r.json()) });

test('preview: detects a Shopify orders export, 5 rows, mapping; writes nothing (the demo stays)', async () => {
  const before = await json(await req(`/api/report?store=${B}`));
  const v = await json(await post(`/api/import/preview?store=${B}`, recent('shopify-orders.csv')));
  assert.equal(v.status, 200);
  assert.equal(v.format, 'shopify-orders'); assert.equal(v.kind, 'order'); assert.equal(v.remembered, false);
  assert.equal(v.map.sku, 'Lineitem sku'); assert.equal(v.map['variant id'], '@sku');
  assert.equal(v.sample.length, 5); assert.deepEqual(v.missing, []);
  assert.equal(typeof v.tzOffsetMin, 'number');
  const after = await json(await req(`/api/report?store=${B}`));
  assert.equal(after.source, 'demo'); assert.equal(after.data.orderRows, before.data.orderRows);
  assert.ok(!fs.existsSync(path.join(dir, 'stores', B, 'mappings.json')), 'preview remembers nothing');
});

test('Shopify products + orders exports import with no mapping (scripts) and join on SKU: stock, sales, ₹', async () => {
  const s = await json(await post(`/api/import?kind=stock&store=${B}`, recent('shopify-products.csv')));
  assert.equal(s.status, 200, JSON.stringify(s));
  assert.deepEqual({ read: s.read, format: s.format, ignored: s.ignored, untracked: s.skips.untracked, inactive: s.skips.inactive }, { read: 3, format: 'shopify-products', ignored: 1, untracked: 1, inactive: 1 });
  const o = await json(await post(`/api/import?kind=order&store=${B}`, recent('shopify-orders.csv')));
  assert.equal(o.status, 200, JSON.stringify(o));
  assert.deepEqual({ read: o.read, added: o.added, cancelled: o.skips.cancelled, noId: o.skips.noId }, { read: 5, added: 5, cancelled: 2, noId: 1 });
  const again = await json(await post(`/api/import?kind=order&store=${B}`, recent('shopify-orders.csv')));
  assert.equal(again.added, 0, 'the same export twice adds nothing');
  const r = await json(await req(`/api/report?store=${B}`));
  assert.equal(r.source, 'live', 'demo replaced');
  const nt = r.products.find((p) => p.id === 'NT-BLK-L');
  assert.equal(nt.stock, 4); assert.equal(nt.sold, 2 * 13999, 'price after the line discount');
  assert.equal(r.products.find((p) => p.id === 'BL-01').sold, 2 * 4499, 'voided and refunded orders left out');
  assert.ok(!fs.existsSync(path.join(dir, 'stores', B, 'mappings.json')), 'no ?map=: nothing remembered');
  const po = await (await req(`/api/export/reorder.csv?store=${B}`)).text();
  assert.ok(!po.includes('Kaveri') || po.includes('Kaveri Metals'), 'vendor kept for the PO when listed');
});

test('import with ?map=: the chosen columns are read and remembered for that store and header set only', async () => {
  const csv = 'Date;Item code;On hand;MRP\n' + `${new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10)};AB-1;7;"1,299"\n`;
  const v = await json(await post(`/api/import/preview?store=${A}`, csv));
  assert.equal(v.format, null); assert.deepEqual(v.missing, ['Variant ID', 'Stock now']);
  const map = { time: 'Date', 'variant id': '@sku', sku: 'Item code', 'stock now': 'On hand', price: 'MRP' };
  const bad = await json(await post(`/api/import?kind=stock&store=${A}&map=${encodeURIComponent(JSON.stringify({ ...map, price: 'Nope' }))}`, csv));
  assert.equal(bad.status, 400); assert.match(bad.error, /“Nope” is not in the file/);
  const missing = await json(await post(`/api/import?kind=stock&store=${A}&map=${encodeURIComponent(JSON.stringify({ ...map, 'stock now': '' }))}`, csv));
  assert.equal(missing.status, 400); assert.match(missing.error, /Choose a column for Stock now/);
  const ok = await json(await post(`/api/import?kind=stock&store=${A}&map=${encodeURIComponent(JSON.stringify(map))}`, csv));
  assert.equal(ok.status, 200, JSON.stringify(ok)); assert.equal(ok.read, 1);
  const r = await json(await req(`/api/report?store=${A}`));
  assert.equal(r.products.find((p) => p.id === 'AB-1').price, 1299);
  const again = await json(await post(`/api/import/preview?store=${A}`, 'On hand;MRP;Item code;Date\n7;10;AB-1;2026-11-19\n'));
  assert.equal(again.remembered, true, 'same headers in another order'); assert.equal(again.map.sku, 'Item code');
  const other = await json(await post(`/api/import/preview?store=${B}`, csv));
  assert.equal(other.remembered, false, 'another store does not get it');
});

test('preview: bad input → 400; view-only and cross-site → 403; a 4 MB cap', async () => {
  assert.equal((await post(`/api/import/preview?store=${A}`, '')).status, 400);
  assert.equal((await post(`/api/import/preview?store=${A}&map=%7B`, 'a,b\n1,2\n')).status, 400);
  assert.equal((await req(`/api/import/preview?store=${A}`, { method: 'POST', body: 'a,b\n', headers: { 'content-type': 'text/csv' } }, VIEW)).status, 403);
  assert.equal((await req(`/api/import?kind=order&store=${A}`, { method: 'POST', body: recent('shopify-orders.csv') }, VIEW)).status, 403);
  assert.equal((await post(`/api/import/preview?store=${A}`, 'a,b\n', { headers: { 'content-type': 'text/csv', 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await post(`/api/import/preview?store=${A}`, 'a,b\n' + 'x'.repeat(4.1e6))).status, 413);
});
