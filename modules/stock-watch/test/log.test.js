'use strict';
/* SW-054: one-line JSON logs (src/log.js), tokens scrubbed in every line, a request line per API call without the
 * query string or cookies, and one boot line that names which variables are set, never their values. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const log = require('../src/log');
const scope = require('../src/scope');

test('scrub: Shopify tokens, Bearer, X-Api-Key and key= values never reach a log line', () => {
  const s = log.scrub('token shpat_abc123DEF and shpss_zz9 · Authorization: Bearer eyJhbGciOi.J9.x-y · X-Api-Key: k3y-VALUE-1 · {"x-api-key":"abcd1234"} · /x?key=deadbeef00&password=hunter22');
  for (const bad of ['abc123DEF', 'zz9', 'eyJhbGciOi', 'k3y-VALUE-1', 'abcd1234', 'deadbeef00', 'hunter22']) assert.ok(!s.includes(bad), `${bad} left in: ${s}`);
  assert.match(s, /shpat_\*\*\*/); assert.match(s, /Bearer \*\*\*/);
  assert.equal(log.scrub('key in the URL (?key=) is deprecated'), 'key in the URL (?key=) is deprecated', 'plain words stay');
});

test('line: one JSON object with time, level, msg, store and fields; scrubbed after JSON encoding', () => {
  const l = log.line('warn', 'pull failed: Bearer abcdefgh', { store: 's1', status: 401, err: new Error('X-Api-Key=secretvalue1') });
  assert.ok(!l.includes('\n'));
  const o = JSON.parse(l);
  assert.equal(o.level, 'warn'); assert.equal(o.store, 's1'); assert.equal(o.status, 401);
  assert.ok(Date.parse(o.time) > 0);
  assert.equal(o.msg, 'pull failed: Bearer ***');
  assert.ok(!l.includes('secretvalue1'));
  assert.equal(scope.run('store-a', () => JSON.parse(log.line('info', 'x')).store), 'store-a', 'the current store when none is named');
  assert.equal(JSON.parse(log.line('info', 'x')).store, undefined);
});

test('captureConsole: console.* lines become scrubbed JSON (stdout for info, stderr for warn/error)', () => {
  const got = [];
  log.useSink((lvl, l) => got.push([lvl, l]));
  log.captureConsole();
  try {
    console.log('hello', { token: 'shpat_0123456789' });
    console.error(new Error('boom Bearer qwertyuiop'));
  } finally { log.releaseConsole(); log.useSink(null); }
  assert.equal(got.length, 2);
  assert.equal(got[0][0], 'info'); assert.equal(got[1][0], 'err');
  const a = JSON.parse(got[0][1]), b = JSON.parse(got[1][1]);
  assert.match(a.msg, /hello/); assert.ok(!got[0][1].includes('0123456789'));
  assert.equal(b.level, 'error'); assert.match(b.msg, /boom Bearer \*\*\*/); assert.ok(b.stack && !b.stack.includes('qwertyuiop'));
});

test('setVars: names only, true when set', () => {
  assert.deepEqual(log.setVars(['A', 'B', 'C'], { A: 'shpat_x', B: '  ' }), { A: true, B: false, C: false });
});

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject); });

test('server: boot line names set variables without values; one request line per API call, no query string or cookie', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-log-')), port = await freePort();
  const secretPass = 'correct horse battery staple';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: secretPass, ALERT_WEBHOOK_URL: 'https://hooks.example.com/shpat_hooksecret' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((r) => child.on('exit', r));
  t.after(async () => { child.kill(); await exited; fs.rmSync(dir, { recursive: true, force: true }); });
  let out = '';
  await new Promise((resolve) => { const on = (c) => { out += c; if (out.includes('Stock-out Watch on')) resolve(); }; child.stdout.on('data', on); child.stderr.on('data', on); exited.then(resolve); });
  const auth = { authorization: 'Basic ' + Buffer.from(`x:${secretPass}`).toString('base64'), cookie: 'sw_session=cookievalue123' };
  await fetch(`http://127.0.0.1:${port}/api/report?days=7&key=querysecret99`, { headers: auth });
  await new Promise((r) => setTimeout(r, 150));
  const lines = out.trim().split('\n');
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), `not JSON: ${l}`);
  const recs = lines.map((l) => JSON.parse(l));
  const boot = recs.find((r) => r.msg === 'boot');
  assert.ok(boot, 'boot line');
  assert.equal(boot.set.ADMIN_PASSWORD, true); assert.equal(boot.set.VIEW_PASSWORD, false); assert.equal(boot.set.ALERT_WEBHOOK_URL, true);
  assert.equal(boot.source, 'none');
  const req = recs.find((r) => r.msg === 'request' && r.path === '/api/report');
  assert.ok(req, 'request line');
  assert.equal(req.method, 'GET'); assert.equal(req.status, 200); assert.ok(req.ms >= 0); assert.ok(req.store);
  for (const bad of [secretPass, 'hooksecret', 'querysecret99', 'cookievalue123', 'days=7']) assert.ok(!out.includes(bad), `${bad} in the log`);
});
