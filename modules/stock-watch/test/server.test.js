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
    stop: async () => { child.kill(); await exited; fs.rmSync(dir, { recursive: true, force: true }); },
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
