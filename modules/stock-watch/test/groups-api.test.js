'use strict';
/* GET /api/groups (SW-022): starts the real server (node server.js) on a free port with a temp DATA_DIR and demo data. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const PASSWORD = 'group-test-pass';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject);
});
async function start(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-groups-'));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  let out = '';
  const ready = await new Promise((resolve) => {
    const on = (c) => { out += c; if (out.includes('Stock-out Watch on')) resolve(true); };
    child.stdout.on('data', on); child.stderr.on('data', on);
    exited.then(() => resolve(false));
  });
  assert.ok(ready, out);
  const base = `http://127.0.0.1:${port}`;
  return {
    get: (p, headers = {}) => fetch(base + p, { headers }),
    json: async (p, headers = {}) => { const r = await fetch(base + p, { headers }); return { status: r.status, body: await r.json() }; },
    stop: async () => { child.kill(); await exited; fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('GET /api/groups: lens list, each lens, unknown lens 400, all=1, click ids = product rows', async (t) => {
  const s = await start(); t.after(s.stop);

  const list = await s.json('/api/groups');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.lenses, ['product', 'type', 'collection', 'tag'], 'demo offers all four lenses');
  assert.equal(list.body.catalog.demo, true);

  assert.equal((await s.json('/api/groups?lens=title')).status, 400);
  assert.equal((await s.json('/api/groups?lens=title')).body.ok, false);

  const rep = (await s.json('/api/report?days=30')).body;
  const ids = new Set(rep.products.map((p) => p.id));
  for (const lens of ['product', 'type', 'collection', 'tag']) {
    const { status, body } = await s.json(`/api/groups?lens=${lens}&days=30`);
    assert.equal(status, 200, lens);
    assert.ok(body.groups.length > 0, lens);
    assert.equal(body.overlap, lens === 'collection' || lens === 'tag', lens);
    for (const g of body.groups) {
      // a click filters Products to g.ids: every id is a Products row, and the count shown is that many rows
      assert.equal(g.ids.length, g.n, `${lens} ${g.label}`);
      assert.ok(g.ids.every((id) => ids.has(id)), `${lens} ${g.label}`);
      assert.ok(g.needOrder <= g.n);
    }
    if (body.overlap) assert.equal(body.store.n, rep.products.length, `${lens}: distinct store total counts each variant once`);
    else assert.equal(body.groups.reduce((a, g) => a + g.n, 0), rep.products.length, `${lens}: every variant in one group`);
  }

  // catch-all collections: hidden by default, listed in `hidden`, shown with all=1
  const def = (await s.json('/api/groups?lens=collection')).body;
  const all = (await s.json('/api/groups?lens=collection&all=1')).body;
  assert.ok(def.hidden.length >= 1, 'demo "All products" is hidden');
  const hiddenKeys = def.hidden.map((h) => h.key);
  assert.ok(hiddenKeys.every((k) => !def.groups.some((g) => g.key === k)));
  assert.ok(hiddenKeys.every((k) => all.groups.some((g) => g.key === k)));
});

test('GET /api/groups needs login when a password is set', async (t) => {
  const s = await start({ ADMIN_PASSWORD: PASSWORD }); t.after(s.stop);
  assert.equal((await s.get('/api/groups?lens=tag')).status, 401);
  const auth = { authorization: 'Basic ' + Buffer.from(`x:${PASSWORD}`).toString('base64') };
  assert.equal((await s.get('/api/groups?lens=tag', auth)).status, 200);
});
