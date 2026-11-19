'use strict';
/* Route tests: each block starts the real server (node server.js) on a free port with a temp DATA_DIR. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const PASSWORD = 'correct horse battery';
const DAY = 864e5;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject);
});

/** Start the server with a clean environment (no Shopify keys from the shell). Resolves once it listens, or with its exit code. */
async function start(env = {}, { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-')) } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const ready = await new Promise((resolve) => {
    const on = (c) => { out += c; if (out.includes('Stock-out Watch on')) resolve(true); };
    child.stdout.on('data', on); child.stderr.on('data', on);
    exited.then(() => resolve(false));
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    ready, base, dir, exited, log: () => out,
    req: (p, opt = {}) => fetch(base + p, { redirect: 'manual', ...opt }),
    stop: async ({ keep = false } = {}) => { child.kill(); await exited; if (!keep) fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const basic = (pass, user = 'x') => ({ authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') });

test('CSV exports: formula-looking SKU is quoted (SW-017)', async (t) => {
  const s = await start(); t.after(s.stop);
  const now = Date.now();
  const ts = (d) => new Date(now - d * DAY).toISOString();
  const stock = ['Time,Variant ID,SKU,Product,Variant,Stock before,Stock now,Price', `${ts(25)},777,=1+1,Evil lamp,,0,40,1000`, `${ts(1)},777,=1+1,Evil lamp,,2,0,1000`].join('\n');
  const orders = ['Time,Order,Variant ID,SKU,Qty,Unit price', ...Array.from({ length: 20 }, (_, i) => `${ts(i + 2)},#9${i},777,=1+1,2,1000`)].join('\n');
  assert.equal((await s.req('/api/import?kind=stock&replaceDemo=1', { method: 'POST', body: stock })).status, 200);
  assert.equal((await s.req('/api/import?kind=order', { method: 'POST', body: orders })).status, 200);
  const csv = await (await s.req('/api/export/reorder.csv')).text();
  assert.match(csv, /"'=1\+1"/);
  assert.doesNotMatch(csv, /,"=1\+1"/);
});

test('login: one limiter for Basic + form, keyed on the last X-Forwarded-For hop (SW-008)', async (t) => {
  const s = await start({ ADMIN_PASSWORD: PASSWORD }); t.after(s.stop);
  assert.equal((await s.req('/api/settings')).status, 401);
  for (let i = 1; i <= 10; i++) {
    // the client-set first hop changes every time; the proxy-added last hop is the real client
    const r = await s.req('/api/settings', { headers: { ...basic('wrong' + i), 'x-forwarded-for': `10.9.9.${i}, 203.0.113.7` } });
    assert.equal(r.status, 401, `try ${i}`);
  }
  const r11 = await s.req('/api/settings', { headers: { ...basic('wrong'), 'x-forwarded-for': '1.1.1.1, 203.0.113.7' } });
  assert.equal(r11.status, 429);
  assert.equal(r11.headers.get('retry-after'), '900');
  // the right password from that IP is refused too while it's locked, and the sign-in form shares the limit
  assert.equal((await s.req('/api/settings', { headers: { ...basic(PASSWORD), 'x-forwarded-for': '203.0.113.7' } })).status, 429);
  const form = await s.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.7' }, body: 'password=' + encodeURIComponent(PASSWORD) });
  assert.equal(form.status, 429);
  // another IP is unaffected
  assert.equal((await s.req('/api/settings', { headers: { ...basic(PASSWORD), 'x-forwarded-for': '203.0.113.8' } })).status, 200);
});

test('login: global cap of 100 wrong passwords per 15 minutes across all IPs (SW-008)', async (t) => {
  const s = await start({ ADMIN_PASSWORD: PASSWORD }); t.after(s.stop);
  for (let i = 0; i < 100; i++) {
    const r = await s.req('/api/settings', { headers: { ...basic('guess' + i), 'x-forwarded-for': `198.51.${i >> 8}.${i & 255}` } });
    assert.equal(r.status, 401, `try ${i}`);
  }
  assert.equal((await s.req('/api/settings', { headers: { ...basic('guess'), 'x-forwarded-for': '192.0.2.200' } })).status, 429);
});

test('login: passwords with ":" work in Basic auth; form sign-in sets a cookie; logout is POST only (SW-008)', async (t) => {
  const pw = 'colon:in:the:password';
  const s = await start({ ADMIN_PASSWORD: pw }); t.after(s.stop);
  assert.equal((await s.req('/api/settings', { headers: basic(pw) })).status, 200);
  assert.equal((await s.req('/api/settings', { headers: basic('colon') })).status, 401);
  const login = await s.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(pw) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await s.req('/api/settings', { headers: { cookie } })).status, 200);
  const get = await s.req('/logout', { headers: { cookie } });
  assert.equal(get.status, 303); assert.equal(get.headers.get('set-cookie'), null, 'GET /logout does nothing');
  const post = await s.req('/logout', { method: 'POST', headers: { cookie } });
  assert.equal(post.status, 303); assert.match(post.headers.get('set-cookie'), /Max-Age=0/);
});

test('session: signed with DATA_DIR/secret (mode 600) + password; survives restart, password change signs out (SW-008)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const signIn = async (s, pw) => (await s.req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=' + encodeURIComponent(pw) })).headers.get('set-cookie').split(';')[0];
  let s = await start({ ADMIN_PASSWORD: PASSWORD }, { dir });
  const cookie = await signIn(s, PASSWORD);
  const secret = path.join(dir, 'secret');
  assert.ok(fs.readFileSync(secret, 'utf8').trim().length >= 32);
  if (process.platform !== 'win32') assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
  await s.stop({ keep: true });
  s = await start({ ADMIN_PASSWORD: PASSWORD }, { dir });
  assert.equal((await s.req('/api/settings', { headers: { cookie } })).status, 200, 'same password: still signed in after restart');
  await s.stop({ keep: true });
  s = await start({ ADMIN_PASSWORD: PASSWORD + '!' }, { dir });
  assert.equal((await s.req('/api/settings', { headers: { cookie } })).status, 401, 'password changed: signed out');
  await s.stop({ keep: true });
  // a cookie forged with the old scheme (HMAC keyed by the password) is refused
  const crypto = require('node:crypto');
  const exp = Date.now() + DAY;
  const forged = `sw_session=${exp}.${crypto.createHmac('sha256', 'stock-watch-session|' + PASSWORD).update(String(exp)).digest('base64url')}`;
  s = await start({ ADMIN_PASSWORD: PASSWORD }, { dir });
  assert.equal((await s.req('/api/settings', { headers: { cookie: forged } })).status, 401);
  await s.stop({ keep: true });
});

test('production never runs open: no or short ADMIN_PASSWORD → exit 1 (SW-008)', async () => {
  for (const pw of [undefined, 'short-pw-11']) {
    const s = await start({ NODE_ENV: 'production', ...(pw ? { ADMIN_PASSWORD: pw } : {}) });
    assert.equal(s.ready, false); assert.equal(await s.exited, 1); assert.match(s.log(), /at least 12 characters/);
    await s.stop();
  }
  const ok = await start({ NODE_ENV: 'production', ADMIN_PASSWORD: 'twelve-chars' });
  assert.equal(ok.ready, true);
  assert.equal((await ok.req('/api/settings')).status, 401);
  await ok.stop();
});
