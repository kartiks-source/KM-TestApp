'use strict';
/* Storage and the server routes that write to it: run on throwaway DATA_DIRs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MOD = path.join(__dirname, '..');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sw-store-'));

/** A fresh copy of src/store.js reading from `dir` (the module keeps its state at file level). */
function freshStore(dir) {
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../src/store')];
  return require('../src/store');
}

/** Start server.js as its own process on a free port. Resolves once it's listening. */
function startServer(dir, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: MOD, env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let up = false;
    child.stdout.on('data', (b) => {
      out += b;
      const m = !up && out.match(/http:\/\/localhost:(\d+)/);
      if (m) { up = true; resolve({ child, port: +m[1], base: `http://127.0.0.1:${m[1]}`, log: () => out }); }
    });
    child.stderr.on('data', (b) => { out += b; });
    child.on('exit', (code) => reject(Object.assign(new Error(`server exited ${code}: ${out}`), { code, out })));
  });
}
/** SIGTERM and wait for the exit code. */
const stop = (s) => new Promise((resolve) => { s.child.removeAllListeners('exit'); s.child.on('exit', (code) => resolve(code)); s.child.kill('SIGTERM'); });
/** Run server.js expecting it to exit by itself. */
const runToExit = (dir, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['server.js'], { cwd: MOD, env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: '0', ...env } });
  let out = ''; child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { out += b; });
  child.on('exit', (code) => resolve({ code, out }));
});

/* ---------- SW-004: a bad file is never silently replaced ---------- */

test('missing store.json → blank store', () => {
  const s = freshStore(tmpDir());
  const d = s.load();
  assert.equal(d.source, 'empty'); assert.deepEqual(d.stock, []);
  assert.equal(s.health().ok, true);
});

test('corrupt store.json with no backup → quarantined copy, load throws, original untouched', () => {
  const dir = tmpDir(); const file = path.join(dir, 'store.json');
  fs.writeFileSync(file, '{"stock": [1, 2');
  const s = freshStore(dir);
  assert.throws(() => s.load(), s.StoreLoadError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"stock": [1, 2');
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith('store.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"stock": [1, 2');
  assert.equal(s.health().ok, false);
});

test('corrupt store.json with a good .bak → loads the backup, corrupt copy kept', () => {
  const dir = tmpDir();
  const s1 = freshStore(dir);
  s1.add('stock', [{ t: Date.now(), variantId: '1', before: 1, now: 2 }]); s1.save(true);
  s1.add('stock', [{ t: Date.now() + 1, variantId: '1', before: 2, now: 3 }]); s1.save(true);   // first file becomes .bak
  assert.ok(fs.existsSync(path.join(dir, 'store.json.bak')));
  fs.writeFileSync(path.join(dir, 'store.json'), 'garbage');
  const s2 = freshStore(dir);
  const d = s2.load();
  assert.equal(d.stock.length, 1);   // the save before the last one
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('store.json.corrupt-')).length, 1);
});

test('a save that fails is reported and retried, never thrown', () => {
  if (process.getuid?.() === 0) return;   // root ignores folder permissions
  const dir = tmpDir();
  const s = freshStore(dir);
  s.load();
  fs.chmodSync(dir, 0o555);
  try {
    assert.equal(s.save(true), false);
    const h = s.health();
    assert.equal(h.ok, false); assert.ok(h.lastSaveError.message); assert.equal(h.pendingSave, true);
    fs.chmodSync(dir, 0o755);
    assert.equal(s.save(true), true);
    assert.equal(s.health().ok, true);
  } finally { fs.chmodSync(dir, 0o755); }
});

test('server: corrupt store.json and no backup → exits 1 without writing', async () => {
  const dir = tmpDir(); const file = path.join(dir, 'store.json');
  fs.writeFileSync(file, 'not json');
  const r = await runToExit(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /Refusing to start/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json');
});

test('server: read-only DATA_DIR → keeps running, /health 503', async () => {
  if (process.getuid?.() === 0) return;
  const dir = tmpDir(); fs.chmodSync(dir, 0o555);
  const s = await startServer(dir);
  try {
    const r = await fetch(s.base + '/health');
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /Saving data fails/);
    assert.equal((await fetch(s.base + '/api/settings')).status, 200);   // still serving
  } finally { fs.chmodSync(dir, 0o755); await stop(s); }
});

test('server: SIGTERM saves and exits 0', async () => {
  const dir = tmpDir();
  const s = await startServer(dir);
  assert.equal((await fetch(s.base + '/health')).status, 200);
  const code = await stop(s);
  assert.equal(code, 0);
  assert.match(s.log(), /SIGTERM: stopping/);
  assert.ok(fs.existsSync(path.join(dir, 'store.json')));
});

