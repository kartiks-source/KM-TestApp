'use strict';
/* SW-005: daily and before-replace backups, rotation, restore on boot, authed export. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-backup-'));
process.env.DATA_DIR = DATA;
process.env.ADMIN_PASSWORD = 'backup-test-password';
const store = require('../src/store');
const backup = require('../src/backup');
const scope = require('../src/scope');
const { server } = require('../server');
/* the first store's folder (the server's default store): direct module calls and requests share it */
const SD = path.join(DATA, 'stores', 'sammsara-demo');
scope.useDir(SD);

const ls = () => { try { return fs.readdirSync(backup.dir()).sort(); } catch { return []; } };
const clean = () => fs.rmSync(backup.dir(), { recursive: true, force: true });
const T = Date.parse('2026-11-19T06:30:00Z');   // 12:00 India time
const stockRow = (i) => ({ t: Date.now() - i * 36e5, variantId: String(i), sku: `S${i}`, product: 'P', variant: '', before: 1, now: 0, price: 100 });

test('restore on boot: a valid restore.json replaces store.json and the old store is kept', () => {
  fs.mkdirSync(SD, { recursive: true });
  fs.writeFileSync(path.join(SD, 'store.json'), JSON.stringify({ settings: {}, stock: [{ old: 1 }], orders: [], source: 'live' }));
  fs.writeFileSync(path.join(SD, 'restore.json'), JSON.stringify({ settings: {}, stock: [], orders: [{ restored: 1 }], source: 'live' }));
  const r = backup.restorePending(T);
  assert.equal(r.restored, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(SD, 'store.json'), 'utf8')).orders, [{ restored: 1 }]);
  assert.ok(!fs.existsSync(path.join(SD, 'restore.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(r.kept, 'utf8')).stock, [{ old: 1 }]);
  assert.match(path.basename(r.kept), /^store-20261119-120000-before-restore\.json$/);
});

test('restore on boot: a file that is not a store is rejected and the current store stays', () => {
  const before = fs.readFileSync(path.join(SD, 'store.json'), 'utf8');
  fs.writeFileSync(path.join(SD, 'restore.json'), '{"hello":1}');
  const r = backup.restorePending(T);
  assert.equal(r.restored, false);
  assert.ok(fs.existsSync(r.rejected));
  assert.equal(fs.readFileSync(path.join(SD, 'store.json'), 'utf8'), before);
  fs.rmSync(path.join(SD, 'store.json')); clean();
});

test('empty and demo stores are not backed up', () => {
  store.replaceAll([], [], 'empty');
  assert.equal(backup.daily(T), null);
  store.replaceAll([stockRow(1)], [], 'demo');
  assert.equal(backup.daily(T), null);
  assert.equal(backup.snapshot('before-clear', T), null);
  assert.deepEqual(ls(), []);
});

test('daily backup: one file per local day, named store-YYYYMMDD.json, holding the rows', () => {
  store.replaceAll([stockRow(1), stockRow(2)], [], 'live');
  const f = backup.daily(T);
  assert.equal(path.basename(f), 'store-20261119.json');
  assert.equal(backup.daily(T + 3600e3), null, 'same day: not written twice');
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(saved.stock.length, 2);
  assert.ok(!('_stockKeys' in saved), 'in-memory indexes are not written');
  assert.equal(path.basename(backup.daily(T + 864e5)), 'store-20261120.json');
});

test('start(): every replaceAll (Clear, demo → live) snapshots the old data first', () => {
  clean();
  backup.start({ everyMs: 864e5, each: (fn) => fn() });          // also takes today's daily backup
  const daily = ls().filter((n) => /^store-\d{8}\.json$/.test(n));
  assert.equal(daily.length, 1);
  store.replaceAll([], [], 'empty');          // what /api/clear does
  const snap = ls().filter((n) => n.endsWith('-before-clear.json'));
  assert.equal(snap.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup.dir(), snap[0]), 'utf8')).stock.length, 2);
  store.replaceAll([], [], 'empty');          // nothing left to lose: no second snapshot
  assert.equal(ls().filter((n) => n.endsWith('-before-clear.json')).length, 1);
});

test('rotation keeps the newest 14 of each kind', () => {
  clean(); fs.mkdirSync(backup.dir(), { recursive: true });
  for (let i = 1; i <= 20; i++) {
    const dd = String(i).padStart(2, '0');
    fs.writeFileSync(path.join(backup.dir(), `store-202611${dd}.json`), '{}');
    fs.writeFileSync(path.join(backup.dir(), `store-202611${dd}-120000-before-clear.json`), '{}');
  }
  fs.writeFileSync(path.join(backup.dir(), 'notes.txt'), 'not a backup');
  backup.rotate();
  const left = ls();
  assert.equal(left.filter((n) => /^store-\d{8}\.json$/.test(n)).length, backup.KEEP);
  assert.equal(left.filter((n) => n.includes('-before-')).length, backup.KEEP);
  assert.ok(left.includes('store-20261120.json') && !left.includes('store-20261106.json'), 'oldest dropped');
  assert.ok(left.includes('notes.txt'), 'other files untouched');
});

test('GET /api/export/backup.json needs a login and returns the whole store', async () => {
  store.replaceAll([stockRow(3)], [{ t: Date.now(), order: '#1', variantId: '3', sku: 'S3', qty: 1, price: 100 }], 'live');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const no = await fetch(`${base}/api/export/backup.json`);
    assert.equal(no.status, 401);
    const yes = await fetch(`${base}/api/export/backup.json`, { headers: { authorization: 'Basic ' + Buffer.from('x:backup-test-password').toString('base64') } });
    assert.equal(yes.status, 200);
    assert.match(yes.headers.get('content-disposition'), /attachment; filename="stock-watch-store-\d{8}-\d{6}\.json"/);
    const body = await yes.json();
    assert.equal(body.stock.length, 1); assert.equal(body.orders.length, 1); assert.equal(body.source, 'live');
    assert.ok(body.settings.ingestKey, 'settings included, so a restore keeps the Flow key');
  } finally { await new Promise((r) => server.close(r)); }
});

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
