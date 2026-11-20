'use strict';
/* SW-056: which build is running. Version from package.json; commit from RAILWAY_GIT_COMMIT_SHA, BUILD_SHA env, or a
 * BUILD_SHA file; shown by /health, /status, /api/report (`app`) and the footer (test/ui-helpers.test.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const V = require('../src/version');

const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const SHA = '0123456789abcdef0123456789abcdef01234567';
const dirWith = (sha) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ver-'));
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  if (sha != null) fs.writeFileSync(path.join(d, 'BUILD_SHA'), sha + '\n');
  return d;
};

test('version: package.json version; no SHA anywhere → null ("dev" in the footer)', () => {
  assert.deepEqual(V.info({}, dirWith(null)), { version: '9.9.9', sha: null, short: null });
  assert.equal(V.info({}).version, PKG.version);
});

test('version: Railway SHA wins, then BUILD_SHA env, then the BUILD_SHA file; short = 7 characters', () => {
  const dir = dirWith('fedcba9876543210');
  assert.equal(V.info({ RAILWAY_GIT_COMMIT_SHA: SHA, BUILD_SHA: 'aaaaaaa' }, dir).sha, SHA);
  assert.equal(V.info({ BUILD_SHA: 'AAAAAAAB' }, dir).sha, 'aaaaaaab');
  const f = V.info({}, dir);
  assert.equal(f.sha, 'fedcba9876543210'); assert.equal(f.short, 'fedcba9');
});

test('version: only a hex SHA is shown (nothing else reaches the open /status)', () => {
  assert.equal(V.clean('main'), null); assert.equal(V.clean('abc'), null);
  assert.equal(V.clean('<script>abcdef1'), null); assert.equal(V.clean(SHA + 'ff'), null);
  assert.equal(V.info({ BUILD_SHA: 'not a sha' }, dirWith('also bad')).sha, null);
});

test('server: /health, /status and /api/report carry the version and the SHA', async () => {
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ver-srv-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: '0', BUILD_SHA: SHA }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((ok, no) => { let out = ''; child.stdout.on('data', (b) => { out += b; const m = out.match(/http:\/\/localhost:(\d+)/); if (m) ok(`http://127.0.0.1:${m[1]}`); }); child.on('exit', (c) => no(new Error(`exit ${c}: ${out}`))); });
    const h = await (await fetch(base + '/health')).json();
    assert.deepEqual(h, { ok: true, version: PKG.version, sha: SHA.slice(0, 7) });
    const st = await (await fetch(base + '/status')).json();
    assert.equal(st.version, PKG.version); assert.equal(st.sha, SHA.slice(0, 7));
    const r = await (await fetch(base + '/api/report')).json();
    assert.deepEqual(r.app, { version: PKG.version, sha: SHA, short: SHA.slice(0, 7) });
  } finally { child.removeAllListeners('exit'); child.kill('SIGTERM'); }
});
