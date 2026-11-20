'use strict';
/* SW-049: one IANA time zone per store (public/tz.js via src/tz.js), used by rows, engine, period, Mark ordered,
 * helpers, digest, backups and the settings route. LOGIC.md §0a. Checked in India (no daylight saving) and in
 * New York and London (clocks change), where a store day can be 23 or 25 hours long. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tz-test-'));
for (const k of Object.keys(process.env)) if (k.startsWith('DIGEST_WEBHOOK_URL')) delete process.env[k];
process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example.com/digest';
delete process.env.ADMIN_PASSWORD; delete process.env.SHOPIFY_STORE; delete process.env.AZURE_KEY_VAULT_URL;

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const TZ = require('../src/tz');
const E = require('../src/engine');
const P = require('../src/period');
const R = require('../src/rows');
const O = require('../src/onorder');
const H = require('../src/helpers');
const D = require('../src/digest');
const store = require('../src/store');
const backup = require('../src/backup');
const S = require('../src/digest-service');
require('../src/scope').useDir(path.join(process.env.DATA_DIR, 'stores', 'tz-test'));

const NY = 'America/New_York', LON = 'Europe/London', IN = 'Asia/Kolkata';
const HOUR = 36e5, DAY = 864e5;
const iso = (t) => new Date(t).toISOString();

test('offset per moment: India fixed, New York and London follow daylight saving', () => {
  assert.equal(TZ.offsetAt(IN, Date.parse('2026-01-15T12:00:00Z')), 330);
  assert.equal(TZ.offsetAt(IN, Date.parse('2026-07-15T12:00:00Z')), 330);
  assert.equal(TZ.offsetAt(NY, Date.parse('2026-01-15T12:00:00Z')), -300);
  assert.equal(TZ.offsetAt(NY, Date.parse('2026-07-15T12:00:00Z')), -240);
  assert.equal(TZ.offsetAt(LON, Date.parse('2026-07-15T12:00:00Z')), 60);
  /* the change itself: 8 Mar 2026, 2:00 EST → 3:00 EDT = 07:00 UTC */
  assert.equal(TZ.offsetAt(NY, Date.parse('2026-03-08T06:59:59Z')), -300);
  assert.equal(TZ.offsetAt(NY, Date.parse('2026-03-08T07:00:00Z')), -240);
  assert.equal(TZ.offsetAt(330, 0), 330, 'old minutes setting still works');
  assert.equal(TZ.offsetAt('+05:45', 0), 345);
});

test('zone of a store: timeZone wins; an old store keeps its minutes (330 = Asia/Kolkata, else a fixed offset)', () => {
  assert.equal(TZ.zoneOf({ timeZone: NY, tzOffsetMin: 330 }), NY);
  assert.equal(TZ.zoneOf({ tzOffsetMin: 330 }), IN);
  assert.equal(TZ.zoneOf({ tzOffsetMin: -300 }), '-05:00');
  assert.equal(TZ.zoneOf({ tzOffsetMin: 345 }), '+05:45');
  assert.equal(TZ.zoneOf({}), IN);
  assert.equal(TZ.zoneOf({ timeZone: 'Mars/Base', tzOffsetMin: 0 }), '+00:00', 'unknown zone: the saved minutes');
  assert.equal(TZ.canonical('asia/kolkata'), IN);
  assert.equal(TZ.canonical('Asia/Calcutta'), IN, 'old ICU name → today’s');
  assert.equal(TZ.canonical('Not/AZone'), null);
  assert.equal(TZ.canonical('+25:00'), null);
  assert.ok(TZ.all().includes(NY) && TZ.all().includes(IN));
  assert.equal(TZ.hasDst(NY), true); assert.equal(TZ.hasDst(IN), false);
});

test('store days at a daylight saving change: 23- and 25-hour days, each counted once', () => {
  const spring = TZ.dayStart(Date.parse('2026-03-08T15:00:00Z'), NY);
  assert.equal(iso(spring), '2026-03-08T05:00:00.000Z');
  assert.equal(TZ.nextDayStart(spring, NY) - spring, 23 * HOUR);
  const fall = TZ.dayStart(Date.parse('2026-11-01T15:00:00Z'), NY);
  assert.equal(TZ.nextDayStart(fall, NY) - fall, 25 * HOUR);
  assert.deepEqual(TZ.dayKeys(Date.parse('2026-03-06T23:30:00Z'), Date.parse('2026-03-10T03:00:00Z'), NY), ['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09']);
  assert.deepEqual(TZ.dayKeys(Date.parse('2026-10-31T04:30:00Z'), Date.parse('2026-11-03T04:00:00Z'), NY), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(iso(TZ.monthStart(Date.parse('2026-11-15T12:00:00Z'), NY)), '2026-11-01T04:00:00.000Z', '1 Nov 00:00 is still EDT');
  /* wall times: skipped (spring) → the moment the clock jumps; twice (autumn) → the first */
  assert.equal(iso(TZ.fromLocal(Date.UTC(2026, 2, 8, 2, 30), NY)), '2026-03-08T07:30:00.000Z');
  assert.equal(iso(TZ.fromLocal(Date.UTC(2026, 10, 1, 1, 30), NY)), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(TZ.fromLocal(Date.UTC(2026, 10, 1, 12, 0), NY)), '2026-11-01T17:00:00.000Z');
  assert.equal(iso(TZ.fromLocal(Date.UTC(2026, 6, 1, 12, 0), IN)), '2026-07-01T06:30:00.000Z');
  /* store clock hours step one by one across the change */
  let t = Date.parse('2026-03-08T05:00:00Z'); const hours = [];
  while (t < TZ.nextDayStart(spring, NY)) { hours.push(TZ.hour(t, NY)); t = TZ.nextHour(t, NY); }
  assert.equal(hours.length, 23); assert.ok(!hours.includes(2));
});

test('rows: a time without a zone is store time, daylight saving included', () => {
  assert.equal(iso(R.toTime('2026-03-07 12:00', NY)), '2026-03-07T17:00:00.000Z');   // EST
  assert.equal(iso(R.toTime('2026-03-09 12:00', NY)), '2026-03-09T16:00:00.000Z');   // EDT
  assert.equal(iso(R.toTime('09/07/2026 12:00', LON)), '2026-07-09T11:00:00.000Z');   // BST, day first
  assert.equal(iso(R.toTime('2026-07-09T12:00:00Z', NY)), '2026-07-09T12:00:00.000Z'); // a zone in the text wins
  assert.equal(iso(R.toTime('2026-11-15', IN)), '2026-11-14T18:30:00.000Z');
  const csv = 'Time,Order,Variant ID,SKU,Qty,Unit price\n2026-07-01 09:00,#1,7,S,1,100';
  assert.equal(iso(R.fromCsv(csv, 'order', { now: Date.parse('2026-07-02T00:00:00Z'), timeZone: NY }).rows[0].t), '2026-07-01T13:00:00.000Z');
});

test('engine: daily chart in a daylight-saving store adds up to the totals; sales land on their store day', () => {
  const now = Date.parse('2026-11-04T17:00:00Z');   // Wed 4 Nov, 12:00 EST
  const orders = [];
  /* one sale at 23:30 store time every night from 25 Oct to 3 Nov (EDT before 1 Nov, EST after) */
  for (let d = 25; d <= 34; d++) {
    const wall = Date.UTC(2026, 9, d, 23, 30);
    orders.push({ t: TZ.fromLocal(wall, NY), order: `#${d}`, variantId: 'v1', sku: 'S', qty: 1, price: 100 });
  }
  const stock = [{ t: now - 40 * DAY, variantId: 'v1', sku: 'S', product: 'P', variant: '', before: 100, now: 100, price: 100 }];
  const r = E.report(stock, orders, { timeZone: NY }, { now, days: 14 });
  assert.equal(r.settings.timeZone, NY);
  assert.equal(r.settings.tzOffsetMin, -300, 'today’s offset, for older readers');
  const days = r.daily.map((x) => x.day);
  assert.equal(new Set(days).size, days.length, 'no day twice');
  assert.ok(days.includes('2026-11-01'));
  const sold = (k) => r.daily.find((x) => x.day === k).sold;
  for (const k of ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']) assert.equal(sold(k), 100, k);   // never slips to the next day
  assert.equal(r.daily.reduce((a, x) => a + x.sold, 0), r.totals.sold);
  /* same rows read as India: the 23:30 New York sales fall on the next Indian day */
  const ri = E.report(stock, orders, { timeZone: IN }, { now, days: 14 });
  assert.equal(ri.daily.find((x) => x.day === '2026-11-04').sold, 100);
  const pd = E.productDetail('v1', stock, orders, { timeZone: NY }, { now, days: 14 });
  assert.equal(pd.dailyUnits.length, new Set(pd.dailyUnits.map((x) => x.day)).size);
});

test('period: yesterday after the autumn change is the whole 25-hour day; This month starts at store midnight', () => {
  const now = Date.parse('2026-11-02T15:00:00Z');   // Mon 2 Nov, 10:00 EST
  const orders = [
    { t: Date.parse('2026-11-01T04:30:00Z'), order: '#a', variantId: 'v', sku: 'S', qty: 1, price: 10 },    // 00:30 EDT, 1 Nov
    { t: Date.parse('2026-11-02T04:30:00Z'), order: '#b', variantId: 'v', sku: 'S', qty: 1, price: 20 },    // 23:30 EST, 1 Nov (the 25th hour)
    { t: Date.parse('2026-11-02T05:30:00Z'), order: '#c', variantId: 'v', sku: 'S', qty: 1, price: 40 },    // 00:30 EST, 2 Nov
  ];
  const stock = [{ t: now - 30 * DAY, variantId: 'v', sku: 'S', product: 'P', before: 50, now: 50, price: 10 }];
  const r = E.report(stock, orders, { timeZone: NY }, { now, days: 7 });
  const y = P.yesterdayFor(stock, orders, { timeZone: NY }, r);
  assert.deepEqual([y.day, y.sold], ['2026-11-01', 30]);
  assert.deepEqual(P.range('month', now, NY), { period: 'month', from: Date.parse('2026-11-01T04:00:00Z') });
});

test('Mark ordered ETA, PO dates, digest dates and backup names use the store zone', () => {
  const now = Date.parse('2026-06-20T12:00:00Z');
  assert.equal(iso(O.parseEta('2026-07-01', now, NY)), '2026-07-02T03:59:00.000Z');   // 23:59 EDT
  assert.equal(iso(O.parseEta('2026-07-01', now, IN)), '2026-07-01T18:29:00.000Z');
  assert.equal(iso(O.parseEta('2026-07-01', now, 330)), '2026-07-01T18:29:00.000Z', 'old minutes still work');
  const late = Date.parse('2026-07-02T02:00:00Z');                                   // 22:00 EDT on 1 Jul
  assert.equal(H.dateShort(late, NY), '1 Jul');
  assert.equal(H.dateShort(late, IN), '2 Jul');
  assert.equal(H.fileDate(late, NY), '2026-07-01');
  /* the digest title date (src/digest.js) at a New York store */
  const r = E.report([], [], { timeZone: NY }, { now: late, days: 7 });
  assert.match(D.build({ report: r, storeName: 'S' }).title, /Wed 1 Jul$/, 'digest title date: 1 Jul in New York (2 Jul in India)');
  store.replaceAll([{ t: late - DAY, variantId: 'v', sku: 'S', product: 'P', before: 1, now: 1, price: 1 }], [], 'csv');
  store.setSettings({ timeZone: NY });
  const file = backup.daily(late);
  assert.ok(file && path.basename(file) === 'store-20260701.json', String(file));
  const snap = backup.snapshot('before-test', late);
  assert.match(path.basename(snap), /^store-20260701-220000-before-test\.json$/);
});

test('digest schedule: the set hour is store wall-clock time on both sides of a daylight saving change', () => {
  store.setSettings({ timeZone: NY });
  S.applyPatch({ hour: 9, roles: ['ops'], paused: false });
  store.load().digest.lastSent = {};
  const at = (wall) => TZ.fromLocal(wall, NY);
  assert.deepEqual(S.due(at(Date.UTC(2026, 2, 6, 9, 10))), [{ role: 'ops', day: '2026-03-06' }]);   // EST
  assert.deepEqual(S.due(at(Date.UTC(2026, 2, 9, 9, 10))), [{ role: 'ops', day: '2026-03-09' }]);   // EDT
  assert.deepEqual(S.due(at(Date.UTC(2026, 2, 9, 8, 50))), []);
  assert.equal(S.publicConf().timeZone, NY);
});

/* ---------- the settings route ---------- */
const SERVER = path.join(__dirname, '..', 'server.js');
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject); });
async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tz-srv-')), port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((r) => child.on('exit', r));
  let out = '';
  await new Promise((resolve) => { const on = (c) => { out += c; if (out.includes('Stock-out Watch on')) resolve(); }; child.stdout.on('data', on); child.stderr.on('data', on); exited.then(resolve); });
  const base = `http://127.0.0.1:${port}`;
  return { req: (p, o = {}) => fetch(base + p, o), stop: async () => { child.kill(); await exited; fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('PUT /api/settings: a known IANA zone is saved and used by the report; an unknown one is 400; old minutes become a zone', async (t) => {
  const s = await start(); t.after(s.stop);
  const put = (b) => s.req('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal((await (await s.req('/api/report')).json()).settings.timeZone, IN, 'default: India');
  const ok = await put({ timeZone: 'america/new_york' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).settings.timeZone, NY);
  const r = await (await s.req('/api/report')).json();
  assert.equal(r.settings.timeZone, NY);
  assert.ok([-300, -240].includes(r.settings.tzOffsetMin));
  const set = await (await s.req('/api/settings')).json();
  assert.ok(set.changes.some((c) => c.key === 'timeZone' && c.new === NY), 'in the change log');
  const bad = await put({ timeZone: 'Mars/Base' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /time zone/i);
  assert.equal((await (await put({ tzOffsetMin: 345 })).json()).settings.timeZone, '+05:45');
  /* a trial zone on the report (not saved) */
  assert.equal((await (await s.req('/api/report?timeZone=Europe/London')).json()).settings.timeZone, LON);
  assert.equal((await (await s.req('/api/settings')).json()).settings.timeZone, '+05:45');
});
