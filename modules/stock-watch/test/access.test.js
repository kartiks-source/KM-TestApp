'use strict';
/* SW-029: view-only password, server-side write refusal, settings change log. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../src/access');
const L = require('../src/audit');

const eq = (a, b) => a === b;
const sign = (x) => crypto.createHmac('sha256', 'k').update(String(x)).digest('base64url');

test('access: password → role, admin first; config problems stop the start', () => {
  const P = { admin: 'admin-pass-123', view: 'view-pass-456' };
  assert.equal(A.roleForPassword('admin-pass-123', P, eq), 'admin');
  assert.equal(A.roleForPassword('view-pass-456', P, eq), 'view');
  assert.equal(A.roleForPassword('nope', P, eq), null);
  assert.equal(A.roleForPassword('', { admin: 'a', view: '' }, eq), null);   // empty view password never matches
  assert.equal(A.configProblem({ admin: 'a', view: '' }), null);
  assert.equal(A.configProblem({ admin: 'a', view: 'b' }), null);
  assert.match(A.configProblem({ admin: '', view: 'b' }), /ADMIN_PASSWORD/);
  assert.match(A.configProblem({ admin: 'same', view: 'same' }), /differ/);
});

test('access: session cookie carries the role, signed; view sessions die when VIEW_PASSWORD changes', () => {
  const exp = Date.now() + 1e6;
  const admin = A.cookieValue(exp, 'admin', sign, 'v1');
  const view = A.cookieValue(exp, 'view', sign, 'v1');
  assert.equal(admin, `${exp}.${sign(String(exp))}`);   // old admin cookies keep working
  assert.equal(A.cookieRole(admin, sign, eq, { view: 'v1' }), 'admin');
  assert.equal(A.cookieRole(view, sign, eq, { view: 'v1' }), 'view');
  assert.equal(A.cookieRole(view, sign, eq, { view: 'v2' }), null);          // VIEW_PASSWORD changed
  assert.equal(A.cookieRole(view, sign, eq, { view: '' }), null);            // VIEW_PASSWORD removed
  const [e, , sig] = view.split('.');
  assert.equal(A.cookieRole(`${e}.${sig}`, sign, eq, { view: 'v1' }), null); // a view signature can't pass as admin
  assert.equal(A.cookieRole(`${e}.admin.${sig}`, sign, eq, { view: 'v1' }), null);
  assert.equal(A.cookieRole(A.cookieValue(Date.now() - 1, 'admin', sign), sign, eq), null);   // expired
  assert.equal(A.cookieRole('', sign, eq), null);
  assert.equal(A.cookieRole('abc.def', sign, eq), null);
});

test('access: view role refused on every write to /api, reads allowed; ingest key hidden from view', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(A.refused('view', m, '/api/settings'), true, m);
  assert.equal(A.refused('view', 'GET', '/api/report'), false);
  assert.equal(A.refused('view', 'HEAD', '/api/report'), false);
  assert.equal(A.refused('admin', 'POST', '/api/clear'), false);
  assert.equal(A.refused('view', 'POST', '/login'), false);
  assert.equal(A.visibleSettings({ leadDays: 14, ingestKey: 'k' }, 'view').ingestKey, undefined);
  assert.equal(A.visibleSettings({ leadDays: 14, ingestKey: 'k' }, 'admin').ingestKey, 'k');
});

test('audit: only changed settings logged, as {at, by, key, old, new}; ingest key masked; newest first, capped', () => {
  const before = { leadDays: 14, coverDays: 30, storeName: 'A', ingestKey: 'key-old-123' };
  const ch = L.diff(before, { leadDays: 14, coverDays: 45, storeName: 'B', ingestKey: 'key-new-456' });
  assert.deepEqual(ch, [{ key: 'coverDays', old: 30, new: 45 }, { key: 'storeName', old: 'A', new: 'B' }, { key: 'ingestKey', old: '(old key)', new: '(new key)' }]);
  assert.deepEqual(L.diff({ leadDays: '14' }, { leadDays: 14 }), []);   // same number, stored as text
  const db = {};
  L.record(db, ch, 'admin', 1000);
  L.record(db, [{ key: 'leadDays', old: 14, new: 21 }], 'admin (script)', 2000);
  assert.deepEqual(db.settingsLog[0], { at: 2000, by: 'admin (script)', key: 'leadDays', old: 14, new: 21 });
  assert.equal(db.settingsLog.length, 4);
  assert.ok(!JSON.stringify(db).includes('key-'));
  assert.equal(L.lastOf(db, ['coverDays', 'safetyDays']).new, 45);
  assert.equal(L.lastOf(db, ['safetyDays']), null);
  assert.deepEqual(L.record(db, [], 'admin'), []);
  for (let i = 0; i < L.MAX + 10; i++) L.record(db, [{ key: 'leadDays', old: i, new: i + 1 }], 'admin', 3000 + i);
  assert.equal(db.settingsLog.length, L.MAX);
  assert.equal(db.settingsLog[0].at, 3000 + L.MAX + 9);
});

/* ---------- routes: the real server on a free port ---------- */
const SERVER = path.join(__dirname, '..', 'server.js');
const ADMIN = 'admin password 123';
const VIEW = 'view password 456';
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject);
});
async function start(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-access-'));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const ready = await new Promise((resolve) => {
    const on = (c) => { out += c; if (out.includes('Stock-out Watch on')) resolve(true); };
    child.stdout.on('data', on); child.stderr.on('data', on); exited.then(() => resolve(false));
  });
  const base = `http://127.0.0.1:${port}`;
  return { ready, exited, log: () => out, req: (p, opt = {}) => fetch(base + p, { redirect: 'manual', ...opt }),
    stop: async () => { child.kill(); await exited; fs.rmSync(dir, { recursive: true, force: true }); } };
}
const basic = (pass) => ({ authorization: 'Basic ' + Buffer.from(`x:${pass}`).toString('base64') });
async function signIn(s, pass) {
  const r = await s.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: pass }).toString() });
  assert.equal(r.status, 303);
  return { cookie: r.headers.get('set-cookie').split(';')[0] };
}

test('routes: VIEW_PASSWORD session reads everything, every write route is 403 and changes nothing', async (t) => {
  const s = await start({ ADMIN_PASSWORD: ADMIN, VIEW_PASSWORD: VIEW }); t.after(s.stop);
  assert.ok(s.ready, s.log());
  const view = await signIn(s, VIEW);
  assert.match(view.cookie, /^sw_session=\d+\.view\./);
  for (const p of ['/api/report', '/api/product/x', '/api/settings', '/api/export/reorder.csv', '/']) assert.equal((await s.req(p, { headers: view })).status, 200, p);
  const set = await (await s.req('/api/settings', { headers: view })).json();
  assert.equal(set.role, 'view');
  assert.equal(set.settings.ingestKey, undefined);
  assert.deepEqual(set.changes, []);   // the log holds sheet links; viewers have no Data page
  const key = (await (await s.req('/api/settings', { headers: basic(ADMIN) })).json()).settings.ingestKey;
  assert.ok(key);
  for (const p of ['/api/report', '/api/product/x', '/api/export/reorder.csv']) assert.ok(!(await (await s.req(p, { headers: view })).text()).includes(key), `no ingest key in ${p}`);
  assert.equal((await (await s.req('/api/report', { headers: view })).json()).settings.ingestKey, undefined);
  const writes = [['PUT', '/api/settings', '{"leadDays":99}'], ['POST', '/api/import?kind=stock', 'Time,Variant ID\n'], ['POST', '/api/sync'], ['POST', '/api/demo'], ['POST', '/api/clear'], ['POST', '/api/shopify/sync'], ['POST', '/api/onorder', '{}'], ['DELETE', '/api/onorder/1'],
    ['POST', '/api/decide', '{"id":"1","decision":"keep"}'], ['PUT', '/api/digest/settings', '{"hour":8}'], ['POST', '/api/digest/send?role=ops']];   // Sprint 2 writes too
  for (const [method, p, body] of writes) {
    const r = await s.req(p, { method, headers: view, body });
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.match((await r.json()).error, /View-only/);
  }
  for (const h of [basic(VIEW)]) assert.equal((await s.req('/api/clear', { method: 'POST', headers: h })).status, 403);   // Basic with the view password too
  const after = await (await s.req('/api/settings', { headers: view })).json();
  assert.equal(after.settings.leadDays, set.settings.leadDays);
  assert.ok((await (await s.req('/api/report', { headers: view })).json()).data.orderRows > 0, 'clear was refused');
  assert.equal((await s.req('/api/export/backup.json', { headers: view })).status, 403, 'backup holds the ingest key and change log: admin only');
  assert.equal((await s.req('/api/export/backup.json', { headers: basic(ADMIN) })).status, 200);
});

test('routes: admin writes are logged with who/when/old→new; last plan change shown to every role', async (t) => {
  const s = await start({ ADMIN_PASSWORD: ADMIN, VIEW_PASSWORD: VIEW }); t.after(s.stop);
  const admin = await signIn(s, ADMIN);
  assert.match(admin.cookie, /^sw_session=\d+\.[^.]+$/);
  const before = (await (await s.req('/api/settings', { headers: admin })).json()).settings;
  const put = await s.req('/api/settings', { method: 'PUT', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ coverDays: before.coverDays + 5, leadDays: before.leadDays }) });
  assert.equal(put.status, 200);
  await s.req('/api/settings', { method: 'PUT', headers: { ...basic(ADMIN), 'content-type': 'application/json' }, body: JSON.stringify({ newIngestKey: true }) });
  const view = await signIn(s, VIEW);
  const v = await (await s.req('/api/settings', { headers: view })).json();
  assert.deepEqual(v.changes, []);   // the full log is admin-only (Data page)
  assert.equal(v.lastPlanChange.key, 'coverDays');   // "Last changed" under Plan settings is for every role
  const j = await (await s.req('/api/settings', { headers: admin })).json();
  assert.equal(j.changes.length, 2);   // leadDays didn't change, so it isn't logged
  assert.deepEqual({ ...j.changes[1], at: 0 }, { at: 0, by: 'admin', key: 'coverDays', old: before.coverDays, new: before.coverDays + 5 });
  assert.ok(Math.abs(j.changes[1].at - Date.now()) < 60e3);
  assert.deepEqual([j.changes[0].by, j.changes[0].key, j.changes[0].new], ['admin (script)', 'ingestKey', '(new key)']);
  assert.equal(j.lastPlanChange.key, 'coverDays');
  assert.ok(!JSON.stringify(j).includes(before.ingestKey), 'no key in the log');
});

test('routes: wrong password still 401; VIEW_PASSWORD without ADMIN_PASSWORD refuses to start', async (t) => {
  const s = await start({ ADMIN_PASSWORD: ADMIN, VIEW_PASSWORD: VIEW }); t.after(s.stop);
  assert.equal((await s.req('/api/settings', { headers: basic('wrong') })).status, 401);
  assert.equal((await s.req('/login', { method: 'POST', body: new URLSearchParams({ password: 'wrong' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 401);
  const bad = await start({ VIEW_PASSWORD: VIEW });
  assert.equal(bad.ready, false);
  assert.equal(await bad.exited, 1);
  assert.match(bad.log(), /ADMIN_PASSWORD/);
  await bad.stop();
});
