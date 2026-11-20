'use strict';
/* SW-062 per-store access (ADR-0016): src/people.js on its own, then through the real server (two demo stores):
 * the owner makes people, a person sees only their stores (403 outside, /api/stores filtered), viewer can't write,
 * reset / remove end sessions, the change log names the person, the owner and VIEW_PASSWORD behave as before. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-people-unit-'));
process.env.DATA_DIR = unitDir;
const P = require('../src/people');

const sign = (t) => require('node:crypto').createHmac('sha256', 'k').update(t).digest('base64url');
const eq = (a, b) => a === b;
const registry = (ids) => ({
  list: () => ids.map((id) => ({ id })),
  pick: (asked, cookie) => (asked ? (ids.includes(asked) ? { id: asked } : { error: 404, message: 'Unknown store' }) : { id: ids.includes(cookie) ? cookie : ids[0] }),
});

test('create: password shown once, 16+ chars, only a scrypt hash on disk (mode 600); find() by password', () => {
  P._reset();
  const { person, password } = P.create({ name: ' Asha ', role: 'view', stores: ['b', 'B'] }, ['a', 'b']);
  assert.equal(person.name, 'Asha'); assert.deepEqual(person.stores, ['b']); assert.ok(!('hash' in person));
  assert.ok(password.length >= 16 && password.startsWith(person.id + '-'));
  const raw = fs.readFileSync(P.file(), 'utf8');
  assert.ok(!raw.includes(password.slice(9)), 'password not stored');
  assert.match(JSON.parse(raw).people[0].hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(JSON.parse(raw).schemaVersion, 1);
  assert.equal(fs.statSync(P.file()).mode & 0o777, 0o600);
  assert.equal(P.find(password).id, person.id);
  assert.equal(P.find(password).id, person.id, 'cached second time');
  for (const bad of ['', password + 'x', password.slice(0, -1) + (password.endsWith('A') ? 'B' : 'A'), 'nobodyyy-aaaaaaaaaaaaaaaaaaaa', 'x'.repeat(40)]) assert.equal(P.find(bad), null, bad);
});

test('create refuses no name, a bad role, no store or an unknown store', () => {
  P._reset();
  for (const b of [{ role: 'view', stores: ['a'] }, { name: 'X', role: 'owner', stores: ['a'] }, { name: 'X', role: 'admin', stores: [] }, { name: 'X', role: 'admin', stores: ['zzz'] }, { name: 'X', role: 'admin', stores: 'a' }]) {
    assert.throws(() => P.create(b, ['a']), (e) => e.status === 400, JSON.stringify(b));
  }
});

test('cookie: names the person; removed, reset, expired, edited or forged → null', () => {
  P._reset();
  const { person } = P.create({ name: 'Ravi', role: 'admin', stores: ['a'] }, ['a']);
  const p = P.byId(person.id), exp = Date.now() + 1e6;
  const c = P.cookieValue(exp, p, sign);
  assert.equal(P.fromCookie(c, sign, eq).id, p.id);
  assert.equal(P.fromCookie(c.replace(/^\d+/, String(exp + 1)), sign, eq), null, 'edited expiry');
  assert.equal(P.fromCookie(P.cookieValue(Date.now() - 1, p, sign), sign, eq), null, 'expired');
  assert.equal(P.fromCookie(c, (t) => sign(t) + 'x', eq), null, 'other key');
  assert.equal(P.fromCookie(`${exp}.${sign(String(exp))}`, sign, eq), null, 'an owner cookie is not a person cookie');
  P.reset(p.id);
  assert.equal(P.fromCookie(c, sign, eq), null, 'new password ends old sessions');
  const c2 = P.cookieValue(exp, P.byId(p.id), sign);
  assert.equal(P.fromCookie(c2, sign, eq).id, p.id);
  P.remove(p.id);
  assert.equal(P.fromCookie(c2, sign, eq), null, 'removed');
});

test('pick: a person gets only their stores (403 outside, even for unknown ids); cookie falls back to their first', () => {
  const R = registry(['a', 'b', 'c']), me = { stores: ['b', 'c'] };
  assert.deepEqual(P.pick(R, 'a', '', null), { id: 'a' }, 'owner: as before');
  assert.deepEqual(P.pick(R, 'b', '', me), { id: 'b' });
  assert.equal(P.pick(R, 'a', '', me).error, 403);
  assert.equal(P.pick(R, 'nope', '', me).error, 403);
  assert.deepEqual(P.pick(R, '', 'c', me), { id: 'c' });
  assert.deepEqual(P.pick(R, '', 'a', me), { id: 'b' }, 'cookie on someone else’s store → their first');
  assert.equal(P.pick(R, '', '', { stores: ['gone'] }).error, 403);
});

test('a broken access.json: nobody from it signs in and nothing is written over it', () => {
  fs.writeFileSync(P.file(), '{not json');
  P._reset();
  assert.equal(P.find('abcdefgh-aaaaaaaaaaaaaaaaaaaa'), null);
  assert.throws(() => P.create({ name: 'X', role: 'view', stores: ['a'] }, ['a']), (e) => e.status === 409);
  assert.equal(fs.readFileSync(P.file(), 'utf8'), '{not json');
  fs.rmSync(P.file()); P._reset();
});

/* ---------- through the server ---------- */
const MOD = path.join(__dirname, '..');
const A = 'sammsara-demo', B = 'second-demo';
const PW = 'people-owner-password', VIEW = 'people-view-password';
const basic = (p) => ({ authorization: 'Basic ' + Buffer.from('u:' + p).toString('base64') });
let srv, dir;
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-people-'));
  srv = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], { cwd: MOD, env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: '0', ADMIN_PASSWORD: PW, VIEW_PASSWORD: VIEW } });
    let out = '';
    child.stdout.on('data', (b) => { out += b; const m = out.match(/localhost:(\d+)/); if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}`, get out() { return out; } }); });
    child.stderr.on('data', (b) => { out += b; });
    child.on('exit', (c) => reject(new Error(`server exited ${c}: ${out}`)));
  });
});
test.after(async () => {
  srv.child.removeAllListeners('exit');
  await new Promise((r) => { srv.child.on('exit', r); srv.child.kill(); });
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(unitDir, { recursive: true, force: true });
});
const call = (p, { as = PW, method = 'GET', body, headers = {} } = {}) => fetch(srv.base + p, { method, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body), headers: { ...(as ? basic(as) : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } });
async function login(password) {
  const r = await fetch(srv.base + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 303);
  return { cookie: r.headers.get('set-cookie').split(';')[0] };
}
const withCookie = (p, cookie, opt = {}) => call(p, { ...opt, as: null, headers: { cookie, ...(opt.headers || {}) } });

test('server: only the owner manages people; view password, person admins and cross-site writes are refused', async () => {
  assert.equal((await call('/api/people', { as: VIEW })).status, 403);
  assert.equal((await call('/api/people', { as: VIEW, method: 'POST', body: { name: 'X', role: 'view', stores: [A] } })).status, 403);
  const r = await call('/api/people', { method: 'POST', body: { name: 'Store B admin', role: 'admin', stores: [B] } });
  assert.equal(r.status, 201);
  const { person, password } = await r.json();
  assert.equal((await call('/api/people', { as: password })).status, 403, 'a person admin is not the owner');
  assert.equal((await call('/api/people', { method: 'POST', body: { name: 'X', role: 'view', stores: [A] }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const g = await (await call('/api/people')).json();
  assert.deepEqual(g.stores.map((s) => s.id), [A, B]);
  assert.ok(g.people.some((x) => x.id === person.id) && g.people.every((x) => !('hash' in x)));
  assert.ok(!srv.out.includes(password), 'password never logged');
  assert.ok(!srv.out.includes('Store B admin'), 'names stay out of the log');
  assert.equal((await call(`/api/people/${person.id}`, { method: 'DELETE' })).status, 200);
});

test('server: a viewer for store B sees only B (403 on A, /api/stores filtered, cookie falls back), never writes', async () => {
  const { password } = await (await call('/api/people', { method: 'POST', body: { name: 'Viewer B', role: 'view', stores: [B] } })).json();
  const { cookie } = await login(password);
  const st = await (await withCookie('/api/stores', cookie)).json();
  assert.deepEqual(st.stores.map((s) => s.id), [B]); assert.equal(st.current, B);
  assert.equal((await withCookie(`/api/report?store=${B}`, cookie)).status, 200);
  for (const p of ['/api/report', '/api/settings', '/api/digest', '/api/export/reorder.csv', '/api/groups']) assert.equal((await withCookie(`${p}?store=${A}`, cookie)).status, 403, p);
  assert.equal((await withCookie('/api/report?store=nope', cookie)).status, 403, 'unknown id: same 403');
  assert.equal((await (await withCookie('/api/report', cookie, { headers: { cookie: `${cookie}; sw_store=${A}` } })).json()).store.id, B);
  assert.equal((await withCookie(`/api/settings?store=${B}`, cookie, { method: 'PUT', body: { leadDays: 9 } })).status, 403, 'viewer');
  assert.equal((await withCookie(`/api/export/backup.json?store=${B}`, cookie)).status, 403, 'viewer: no backup');
  assert.equal((await call(`/api/report?store=${A}`, { as: password })).status, 403, 'Basic auth with the person password: same rules');
  assert.equal((await call(`/api/report?store=${B}`, { as: password })).status, 200);
});

test('server: a person admin changes their store, the change log names them; reset and remove end sessions', async () => {
  const { person, password } = await (await call('/api/people', { method: 'POST', body: { name: 'Meera', role: 'admin', stores: [A] } })).json();
  const { cookie } = await login(password);
  assert.equal((await withCookie(`/api/settings?store=${A}`, cookie, { method: 'PUT', body: { leadDays: 11 } })).status, 200);
  assert.equal((await withCookie(`/api/settings?store=${B}`, cookie, { method: 'PUT', body: { leadDays: 11 } })).status, 403);
  const log = (await (await call(`/api/settings?store=${A}`)).json()).changes;
  assert.equal(log[0].by, 'Meera'); assert.equal(log[0].key, 'leadDays');
  // stores change applies on the next request
  assert.equal((await call(`/api/people/${person.id}`, { method: 'PUT', body: { stores: [B] } })).status, 200);
  assert.equal((await withCookie(`/api/report?store=${A}`, cookie)).status, 403);
  assert.equal((await withCookie(`/api/report?store=${B}`, cookie)).status, 200);
  // a new password ends the old session and the old password
  const r = await (await call(`/api/people/${person.id}/reset`, { method: 'POST' })).json();
  assert.ok(r.password && r.password !== password);
  assert.equal((await withCookie(`/api/report?store=${B}`, cookie)).status, 401);
  assert.equal((await call(`/api/report?store=${B}`, { as: password })).status, 401);
  const s2 = await login(r.password);
  assert.equal((await withCookie(`/api/report?store=${B}`, s2.cookie)).status, 200);
  assert.ok((await (await call('/api/people')).json()).people.find((x) => x.id === person.id).lastSignInAt > 0);
  assert.equal((await call(`/api/people/${person.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await withCookie(`/api/report?store=${B}`, s2.cookie)).status, 401, 'removed: signed out');
  assert.equal((await call(`/api/people/${person.id}`, { method: 'DELETE' })).status, 404);
  const disk = fs.readFileSync(path.join(dir, 'access.json'), 'utf8');
  assert.ok(!disk.includes(r.password.slice(9)));
});

test('server: the owner and VIEW_PASSWORD still open every store', async () => {
  for (const as of [PW, VIEW]) {
    assert.deepEqual((await (await call('/api/stores', { as })).json()).stores.map((s) => s.id), [A, B]);
    for (const id of [A, B]) assert.equal((await call(`/api/report?store=${id}`, { as })).status, 200);
  }
  assert.equal((await call('/api/people', { method: 'POST', body: { name: 'X', role: 'view', stores: ['nope'] } })).status, 400);
  assert.equal((await call('/api/people', { method: 'POST', body: '[' })).status, 400);
});
