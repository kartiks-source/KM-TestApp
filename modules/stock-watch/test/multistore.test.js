'use strict';
/* Multi-store (ADR-0015) through the real server (node server.js, two demo stores): stores never mix (report, groups,
 * digest, on-order, decide, settings + audit, backups, ingest), bad store ids are 404, cookie default, view-only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MOD = path.join(__dirname, '..');
const A = 'sammsara-demo', B = 'second-demo';
const PW = 'multi-store-admin-pw', VIEW = 'multi-store-view-pw';
const basic = (p) => ({ authorization: 'Basic ' + Buffer.from('u:' + p).toString('base64') });
let srv, dir;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-multi-'));
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
  await new Promise((r) => { srv.child.on('exit', r); srv.child.kill(); });   // it saves every store on SIGTERM: wait, then clean up
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (p, opt = {}) => fetch(srv.base + p, { ...opt, headers: { ...basic(PW), ...(opt.body && typeof opt.body === 'string' && opt.json !== false ? { 'content-type': 'application/json' } : {}), ...(opt.headers || {}) } });
const get = async (p, opt) => (await req(p, opt)).json();
const post = (p, body, opt = {}) => req(p, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...opt });

test('GET /api/stores: both demo stores with names and a status; the first is the default', async () => {
  const j = await get('/api/stores');
  assert.deepEqual(j.stores.map((s) => [s.id, s.name, s.status.state]), [[A, 'Sammsara (demo)', 'ok'], [B, 'Second store (demo)', 'ok']]);
  assert.equal(j.current, A);
  assert.ok(j.stores.every((s) => 'lastSync' in s.status && 'lastError' in s.status));
});

test('a store id not in the list, or one that could leave the folder, is 404 on every route', async () => {
  for (const id of ['nope', '..%2F..%2Fetc', '..', 'SAMMSARA-DEMO%2F..', '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90', '%00']) {
    for (const p of ['/api/report', '/api/settings', '/api/digest', '/api/export/backup.json', '/api/onorder']) {
      const r = await req(`${p}?store=${id}`);
      assert.equal(r.status, 404, `${p}?store=${id}`);
    }
    assert.equal((await fetch(`${srv.base}/ingest/order?store=${id}`, { method: 'POST', body: '{}' })).status, 404);
  }
  assert.equal(fs.readdirSync(path.join(dir, 'stores')).sort().join(), [A, B].join(), 'no folder made for a bad id');
});

test('report and groups: each store its own numbers; group totals add up to their own store only', async () => {
  const [ra, rb] = [await get(`/api/report?store=${A}`), await get(`/api/report?store=${B}`)];
  assert.deepEqual([ra.store.id, rb.store.id], [A, B]);
  assert.notEqual(ra.products.length, rb.products.length);
  assert.notEqual(ra.totals.sold, rb.totals.sold);
  for (const [id, r] of [[A, ra], [B, rb]]) {
    const g = await get(`/api/groups?lens=type&store=${id}`);
    assert.equal(Math.round(g.total.sold), Math.round(r.totals.sold), `${id} groups = its report`);
  }
});

test('cookie sw_store picks the store when there is no ?store=; ?store= wins over it', async () => {
  assert.equal((await get('/api/report', { headers: { cookie: `sw_store=${B}` } })).store.id, B);
  assert.equal((await get(`/api/report?store=${A}`, { headers: { cookie: `sw_store=${B}` } })).store.id, A);
  assert.equal((await get('/api/report', { headers: { cookie: 'sw_store=gone' } })).store.id, A);
});

test('Mark ordered and Decide stay in their store', async () => {
  const ra = await get(`/api/report?store=${A}`);
  const p = ra.reorder.find((x) => x.orderQty > 0);
  const eta = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  assert.equal((await post(`/api/onorder?store=${A}`, { items: [{ id: p.id, qty: 7, eta }], by: 'Asha' })).status, 200);
  assert.equal((await get(`/api/onorder?store=${A}`)).onOrder[p.id].qty, 7);
  assert.deepEqual((await get(`/api/onorder?store=${B}`)).onOrder, {});
  assert.equal((await get(`/api/report?store=${B}`)).products.filter((x) => x.onOrder).length, 0);
  const slow = (ra.decide || [])[0];
  assert.ok(slow, 'the demo has slow sellers to decide');
  assert.equal((await post(`/api/decide?store=${A}`, { id: slow.id, decision: 'keep' })).status, 200);
  assert.deepEqual(Object.keys((await get(`/api/decide?store=${A}`)).decisions), [slow.id]);
  assert.deepEqual((await get(`/api/decide?store=${B}`)).decisions, {});
  assert.ok(fs.existsSync(path.join(dir, 'stores', A, 'onorder.json')) && !fs.existsSync(path.join(dir, 'stores', B, 'onorder.json')));
});

test('settings and the change log are per store; the digest names its store and links to it', async () => {
  assert.equal((await req(`/api/settings?store=${B}`, { method: 'PUT', body: JSON.stringify({ leadDays: 21 }) })).status, 200);
  const [sa, sb] = [await get(`/api/settings?store=${A}`), await get(`/api/settings?store=${B}`)];
  assert.equal(sb.settings.leadDays, 21); assert.notEqual(sa.settings.leadDays, 21);
  assert.equal(sb.changes[0].key, 'leadDays'); assert.equal(sa.changes.length, 0);
  assert.deepEqual([sa.store.name, sb.store.name], ['Sammsara (demo)', 'Second store (demo)']);
  const d = await get(`/api/digest?store=${B}&role=ops`);
  assert.match(d.title, /Second store \(demo\)/);
  assert.match(d.link, /\?store=second-demo&role=ops#reorder$/);
  assert.notEqual(sa.settings.ingestKey, sb.settings.ingestKey, 'each store has its own Flow key');
});

test('Flow ingest goes to ?store= with that store’s key only; CSV import + Clear back up that store only', async () => {
  const sb = (await get(`/api/settings?store=${B}`)).settings, sa = (await get(`/api/settings?store=${A}`)).settings;
  const row = JSON.stringify({ order: '#MS1', variant_id: '999001', qty: 2, price: 300 });
  assert.equal((await fetch(`${srv.base}/ingest/order?store=${B}`, { method: 'POST', headers: { 'x-ingest-key': sa.ingestKey }, body: row })).status, 401, 'A’s key never writes to B');
  assert.equal((await fetch(`${srv.base}/ingest/order?store=${B}`, { method: 'POST', headers: { 'x-ingest-key': sb.ingestKey }, body: row })).status, 200);
  const [ra, rb] = [await get(`/api/report?store=${A}`), await get(`/api/report?store=${B}`)];
  assert.deepEqual([ra.source, rb.source], ['demo', 'live'], 'real data in B cleared B’s demo only');
  assert.equal(rb.data.orderRows, 1);
  assert.equal((await post(`/api/clear?store=${B}`, {})).status, 200);
  const bak = (id) => { try { return fs.readdirSync(path.join(dir, 'stores', id, 'backups')); } catch { return []; } };
  assert.equal(bak(B).filter((n) => n.endsWith('-before-clear.json')).length, 1);
  assert.equal(bak(A).length, 0, 'A (demo) has nothing to back up');
  const ex = await get(`/api/export/backup.json?store=${A}`);
  assert.equal(ex.source, 'demo'); assert.ok(ex.orders.length > 100, 'the export is A’s whole store');
});

test('view-only sign-in: reads every store, changes none', async () => {
  const v = (p, opt = {}) => fetch(srv.base + p, { ...opt, headers: { ...basic(VIEW), 'content-type': 'application/json', ...(opt.headers || {}) } });
  assert.equal((await v('/api/stores')).status, 200);
  assert.equal((await v(`/api/report?store=${B}`)).status, 200);
  assert.equal((await v(`/api/onorder?store=${B}`, { method: 'POST', body: JSON.stringify({ items: [{ id: '1', qty: 1, eta: '2026-12-01' }] }) })).status, 403);
  assert.equal((await v(`/api/settings?store=${A}`, { method: 'PUT', body: JSON.stringify({ leadDays: 3 }) })).status, 403);
  assert.equal((await v(`/api/export/backup.json?store=${A}`)).status, 403);
});

test('/status totals every store; /health ok', async () => {
  const s = await (await fetch(srv.base + '/status')).json();
  assert.equal(s.stores, 2); assert.equal(s.ok, true);
  assert.doesNotMatch(JSON.stringify(s), /sammsara|second/i, 'no store names or ids on the open status');
  assert.equal((await fetch(srv.base + '/health')).status, 200);
});
