'use strict';
/* Critic r2 X1: Mark-ordered records (onorder.json) and slow-seller decisions (decisions.json) are kept as safely as
 * store.json: a bad file is quarantined and never overwritten or read as empty, and backups, the export and restore
 * carry them, so Clear followed by restore brings them back. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-side-'));
process.env.DATA_DIR = DATA;
process.env.ADMIN_PASSWORD = 'side-file-test-password';
const store = require('../src/store');
const backup = require('../src/backup');
const OO = require('../src/onorder');
const DC = require('../src/decide');
const { server } = require('../server');

const MOD = path.join(__dirname, '..');
const F = (n) => path.join(DATA, n);
const AUTH = { authorization: 'Basic ' + Buffer.from('x:side-file-test-password').toString('base64') };
const eta = () => new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
const runToExit = (dir) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['server.js'], { cwd: MOD, env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: '0' } });
  let out = ''; child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { out += b; });
  const t = setTimeout(() => child.kill('SIGTERM'), 8000);
  child.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
});
const corrupt = (n) => fs.readdirSync(DATA).filter((x) => x.startsWith(n + '.corrupt-'));

test('a corrupt onorder.json with no .bak: read refuses, the file is never overwritten, a .corrupt copy is kept', () => {
  OO.reset(); fs.writeFileSync(F('onorder.json'), '{"123": {"qty": 5');
  assert.throws(() => OO.all(), /onorder\.json can't be read/);
  assert.throws(() => OO.mark([{ id: '9', qty: 3, eta: eta() }]), /can't be read/, 'a mark never writes over it');
  assert.equal(fs.readFileSync(F('onorder.json'), 'utf8'), '{"123": {"qty": 5');
  assert.equal(corrupt('onorder.json').length, 1);
  fs.rmSync(F('onorder.json')); corrupt('onorder.json').forEach((n) => fs.rmSync(F(n))); OO.reset();
});

test('a corrupt decisions.json with a good .bak: the .bak is used; the next save keeps the good .bak', () => {
  DC.reset();
  assert.equal(DC.set('p1', 'keep', 1).ok, true);
  assert.equal(DC.set('p2', 'drop', 1).ok, true);           // decisions.json.bak now holds p1
  fs.writeFileSync(F('decisions.json'), 'garbage'); DC.reset();
  assert.deepEqual(Object.keys(DC.all()), ['p1'], 'loaded from decisions.json.bak');
  assert.equal(corrupt('decisions.json').length, 1);
  assert.equal(DC.set('p3', 'clear', 1).ok, true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(F('decisions.json.bak'), 'utf8'))), ['p1'], 'garbage never became the .bak');
  DC.clear(); DC.reset();
});

test('server: a corrupt onorder.json and no .bak → refuses to start, file untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-side-boot-'));
  fs.writeFileSync(path.join(dir, 'onorder.json'), 'not json');
  const r = await runToExit(dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Refusing to start: onorder\.json can't be read/);
  assert.equal(fs.readFileSync(path.join(dir, 'onorder.json'), 'utf8'), 'not json');
});

test('Clear, then restore the before-clear backup: Mark-ordered records and decisions come back; export carries them', async () => {
  backup.start({ everyMs: 864e5 });
  const now = Date.now();
  store.replaceAll([{ t: now - 864e5, variantId: '123', sku: 'S', product: 'P', variant: '', before: 2, now: 0, price: 100 }], [{ t: now - 2 * 864e5, order: '#1', variantId: '123', sku: 'S', qty: 1, price: 100 }], 'live');
  assert.equal(OO.mark([{ id: '123', qty: 40, eta: eta() }], { by: 'Asha' }).ok, true);
  assert.equal(DC.set('123', 'keep', 0.5).ok, true);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ex = await (await fetch(`${base}/api/export/backup.json`, { headers: AUTH })).json();
    assert.equal(ex.sideFiles['onorder.json']['123'].qty, 40, 'export has the marks');
    assert.equal(ex.sideFiles['decisions.json']['123'].d, 'keep', 'export has the decisions');
    assert.equal((await fetch(`${base}/api/clear`, { method: 'POST', headers: AUTH })).status, 200);
  } finally { await new Promise((r) => server.close(r)); }
  assert.deepEqual(OO.all(), {}); assert.deepEqual(DC.all(), {});
  const snap = fs.readdirSync(backup.DIR).filter((n) => n.endsWith('-before-clear.json')).sort().pop();
  assert.ok(snap, 'Clear took a backup first');
  fs.copyFileSync(path.join(backup.DIR, snap), F('restore.json'));
  const r = backup.restorePending();
  assert.equal(r.restored, true);
  assert.deepEqual(r.sideFiles.sort(), ['decisions.json', 'onorder.json']);
  assert.equal(OO.all()['123'].qty, 40, 'the PO mark is back');
  assert.equal(OO.all()['123'].by, 'Asha');
  assert.equal(DC.all()['123'].d, 'keep', 'the decision is back');
  const disk = JSON.parse(fs.readFileSync(F('store.json'), 'utf8'));
  assert.equal(disk.stock.length, 1, 'rows back');
  assert.equal(disk.sideFiles, undefined, 'side files are not left inside store.json');
  const kept = JSON.parse(fs.readFileSync(r.kept, 'utf8'));
  assert.deepEqual(kept.sideFiles['onorder.json'], {}, 'the before-restore copy holds the side files as they were');
});

test('an older backup without sideFiles leaves the current marks alone', () => {
  assert.equal(OO.mark([{ id: '77', qty: 9, eta: eta() }]).ok, true);
  fs.writeFileSync(F('restore.json'), JSON.stringify({ settings: {}, stock: [], orders: [], source: 'live' }));
  const r = backup.restorePending();
  assert.equal(r.restored, true); assert.deepEqual(r.sideFiles, []);
  OO.reset(); assert.equal(OO.all()['77'].qty, 9);
});

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
