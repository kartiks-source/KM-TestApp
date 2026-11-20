'use strict';
/* Sprint 3 B-review routes, against the real server (node server.js) on a free port with a temp DATA_DIR and demo data:
 * GET /api/review (SW-043), /api/targets (SW-042), /api/lists (SW-044). Viewer can read, never write. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const ADMIN = 'review-admin-pass-1';
const VIEW = 'review-view-pass-22';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject);
});
async function start(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-review-'));
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
  const call = async (method, p, { body, pass, headers = {} } = {}) => {
    const h = { ...headers };
    if (pass) h.authorization = 'Basic ' + Buffer.from(`x:${pass}`).toString('base64');
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, body: j };
  };
  return { base, dir, call, stop: async () => { child.kill(); await exited; fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('GET /api/review: demo data gives 14 days of snapshots, this week vs last week, movers; POST refused', async (t) => {
  const s = await start(); t.after(s.stop);
  const r = await s.call('GET', '/api/review');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.ready, true);
  assert.equal(r.body.days, 7);
  assert.equal(r.body.prevDays, 7);
  assert.equal(r.body.complete, true);
  assert.ok(r.body.thisWeek.lost >= 0 && r.body.lastWeek.lost >= 0);
  assert.ok(r.body.movers.length <= 5);
  const stores = fs.readdirSync(path.join(s.dir, 'stores'));
  const snap = JSON.parse(fs.readFileSync(path.join(s.dir, 'stores', stores[0], 'snapshots.json'), 'utf8'));
  assert.equal(snap.basis, 'demo');
  assert.equal(Object.keys(snap.days).length, 14);
  assert.equal((await s.call('POST', '/api/review', { body: {} })).status, 405);
});

test('GET /api/review needs login; a viewer can read it', async (t) => {
  const s = await start({ ADMIN_PASSWORD: ADMIN, VIEW_PASSWORD: VIEW }); t.after(s.stop);
  assert.equal((await s.call('GET', '/api/review')).status, 401);
  assert.equal((await s.call('GET', '/api/review', { pass: VIEW })).status, 200);
});

module.exports = { start, ADMIN, VIEW };
