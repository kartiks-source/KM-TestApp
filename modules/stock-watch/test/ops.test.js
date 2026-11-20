'use strict';
/* SW-055: one app per data folder (src/lock.js), KEEP_DAYS for backups, capacity warnings (src/capacity.js) on
 * /status and the Data page. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lock = require('../src/lock');
const capacity = require('../src/capacity');
const backup = require('../src/backup');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('lock: first takes it, second only reads and says why; stale after 2 minutes is taken over; release frees it', () => {
  const dir = tmp('sw-lock-');
  let now = 1e12; const clock = () => now;
  const a = lock.make(dir, { now: clock }), b = lock.make(dir, { now: clock });
  assert.equal(a.acquire(), true); assert.equal(a.reason(), null);
  assert.equal(b.acquire(), false);
  assert.match(b.reason(), /Another copy of the app is using this data folder/);
  assert.match(b.reason(), /only reads/);
  now += 90e3; assert.equal(a.beat(), true, 'heartbeat');
  now += 90e3; assert.equal(b.beat(), false, 'a beat 90 s ago: not stale yet');
  now += 31e3; assert.equal(b.beat(), true, 'no heartbeat for over 2 minutes: taken over');
  assert.equal(a.beat(), false, 'the old holder notices and stops writing');
  assert.equal(a.held(), false); assert.match(a.reason(), /Another copy/);
  b.release(); assert.ok(!fs.existsSync(b.file));
  assert.equal(a.acquire(), true, 'free again');
  const c = lock.make(dir, { now: clock });
  fs.writeFileSync(c.file, 'not json');
  assert.equal(c.acquire(), true, 'an unreadable lock file counts as free');
  if (process.getuid?.() !== 0) {
    const ro = tmp('sw-lock-ro-'); fs.chmodSync(ro, 0o555);
    try { const d = lock.make(ro); assert.equal(d.acquire(), true, 'a folder nobody can write: carry on, saving fails on its own'); assert.ok(d.failed()); }
    finally { fs.chmodSync(ro, 0o755); }
  }
});

test('KEEP_DAYS: 1–365, default 14', () => {
  assert.equal(backup.keepFrom(undefined), 14);
  assert.equal(backup.keepFrom(''), 14);
  assert.equal(backup.keepFrom('30'), 30);
  assert.equal(backup.keepFrom('0'), 1);
  assert.equal(backup.keepFrom('9999'), 365);
  assert.equal(backup.keepFrom('ten'), 14);
  const r = spawnSync(process.execPath, ['-e', "console.log(require('./src/backup').KEEP)"], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, KEEP_DAYS: '30', DATA_DIR: tmp('sw-keep-') } });
  assert.equal(String(r.stdout).trim(), '30');
});

test('capacity: warnings past 25 MB, 150k rows, 80% disk; none below', () => {
  assert.deepEqual(capacity.warnings({ storeBytes: 25 * 1024 * 1024, rows: 150000, disk: 0.8 }), []);
  const w = capacity.warnings({ storeBytes: 26 * 1024 * 1024, rows: 150001, disk: 0.81 });
  assert.deepEqual(w.map((x) => x.code), ['store-size', 'rows', 'disk']);
  assert.match(w[0].text, /26 MB/); assert.match(w[1].text, /1,50,001 rows/); assert.match(w[2].text, /81% full/);
  const d = capacity.diskUsed(os.tmpdir());
  assert.ok(d === null || (d >= 0 && d <= 1));
});

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject); });
async function start(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((r) => child.on('exit', r));
  let out = '';
  await new Promise((resolve) => { const on = (c) => { out += c; if (out.includes('Stock-out Watch on')) resolve(); }; child.stdout.on('data', on); child.stderr.on('data', on); exited.then(resolve); });
  const base = `http://127.0.0.1:${port}`;
  return { req: (p, o = {}) => fetch(base + p, o), log: () => out, stop: async () => { child.kill(); await exited; } };
}

test('server: a second copy on the same DATA_DIR reads but refuses writes (503, says why); the first stops cleanly and frees the lock', async (t) => {
  const dir = tmp('sw-lock-srv-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = await start(dir);
  let aStopped = false;
  t.after(async () => { if (!aStopped) await a.stop(); });
  const b = await start(dir); t.after(b.stop);
  assert.match(b.log(), /"msg":"read-only"/);
  assert.equal((await b.req('/api/report')).status, 200, 'reads still work');
  const w = await b.req('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"storeName":"x"}' });
  assert.equal(w.status, 503);
  assert.match((await w.json()).error, /Another copy of the app/);
  const st = await (await b.req('/status')).json();
  assert.equal(st.writing, false); assert.ok(Array.isArray(st.warnings));
  const set = await (await b.req('/api/settings')).json();
  assert.match(set.ops.readOnly, /only reads/);
  assert.equal((await a.req('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"storeName":"Mine"}' })).status, 200, 'the holder writes');
  const sa = await (await a.req('/api/settings')).json();
  assert.equal(sa.ops.readOnly, null); assert.ok(Array.isArray(sa.ops.warnings));
  assert.equal((await (await a.req('/status')).json()).writing, true);
  await a.stop(); aStopped = true;
  assert.ok(!fs.existsSync(path.join(dir, lock.FILE)), 'a clean stop removes the lock');
});
