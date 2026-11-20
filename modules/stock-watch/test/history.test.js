'use strict';
/* SW-063: stock history rebuilt from Shopify's change log (src/history.js, LOGIC.md §1c). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('../src/history');
const TZ = require('../src/tz');
const engine = require('../src/engine');
const { assertReadOnly } = require('../src/gql-guard');

const DAY = 864e5, HOUR = 36e5;
const ZONE = 'Asia/Kolkata';

test('history: the ShopifyQL query passes the read-only guard and asks for available stock only', () => {
  assert.doesNotThrow(() => assertReadOnly(H.HISTORY_Q));
  const ql = H.qlFor(60, 54);
  assert.match(ql, /inventory_state = 'available'/);
  assert.match(ql, /GROUP BY hour, product_variant_id SINCE -60d UNTIL -54d/);
  assert.match(H.qlFor(3, 0, 'day'), /GROUP BY day, product_variant_id SINCE -3d UNTIL today ORDER BY day ASC LIMIT 1000/);
});

test('history: times with an offset, without one (store time) and day-only', () => {
  assert.equal(H.parseTime('2026-11-10T14:00:00+05:30', ZONE), Date.parse('2026-11-10T08:30:00Z'));
  assert.equal(H.parseTime('2026-11-10T14:00:00Z', ZONE), Date.parse('2026-11-10T14:00:00Z'));
  assert.equal(H.parseTime('2026-11-10T14:00:00', ZONE), Date.parse('2026-11-10T08:30:00Z'));
  assert.equal(H.parseTime('2026-11-10', ZONE), Date.parse('2026-11-09T18:30:00Z'));
  assert.ok(Number.isNaN(H.parseTime('soon', ZONE)));
});

test('history: table rows as objects or arrays; committed, zero and junk rows ignored', () => {
  const a = H.parseTable({ columns: [{ name: 'hour' }, { name: 'product_variant_id' }, { name: 'inventory_adjustment_change' }],
    rows: [{ hour: '2026-11-10T14:00:00', product_variant_id: 11, inventory_adjustment_change: '-2' }, { hour: '2026-11-10T15:00:00', product_variant_id: '11', inventory_adjustment_change: '0' }, { hour: 'x', product_variant_id: 11, inventory_adjustment_change: '1' }] }, ZONE);
  assert.deepEqual(a.changes, [{ t: Date.parse('2026-11-10T08:30:00Z'), variantId: '11', delta: -2 }]);
  assert.equal(a.count, 3);
  const b = H.parseTable({ columns: [{ name: 'day' }, { name: 'inventory_state' }, { name: 'product_variant_id' }, { name: 'inventory_adjustment_change' }],
    rows: [['2026-11-10', 'committed', '11', '5'], ['2026-11-10', 'available', 'gid://shopify/ProductVariant/12', '3']] }, ZONE);
  assert.deepEqual(b.changes.map((c) => [c.variantId, c.delta]), [['12', 3]]);
});

test('history: rebuild walks back from the first snapshot; negative dropped; no changes stays flat; later changes ignored', () => {
  const first = Date.parse('2026-11-20T06:00:00Z'), since = first - 10 * DAY;
  const changes = [
    { t: first - 5 * DAY, variantId: '1', delta: 4 },      // restock of 4 five days ago
    { t: first - 2 * DAY, variantId: '1', delta: -3 },     // sold 3
    { t: first - 2 * DAY, variantId: '1', delta: -1 },     // same hour: summed
    { t: first + HOUR, variantId: '1', delta: -9 },         // after the snapshot: ignored
    { t: first - 20 * DAY, variantId: '1', delta: 50 },     // before since: ignored
    { t: first - 3 * DAY, variantId: '2', delta: 5 },       // would need -3 before: dropped
    { t: first - 3 * DAY, variantId: '9', delta: -5 },      // not in the snapshot: ignored
  ];
  const meta = { 1: { sku: 'A', product: 'Lamp', variant: '', price: 999, type: 'Decor', cost: 400 } };
  const out = H.rebuild(changes, { 1: 2, 2: 2, 3: 0 }, first, { since, meta });
  assert.deepEqual(out.dropped, ['2']);
  assert.equal(out.total, 3); assert.equal(out.kept, 2); assert.equal(out.changed, 1); assert.equal(out.flat, 1);
  const v1 = out.rows.filter((r) => r.variantId === '1');
  assert.deepEqual(v1.map((r) => [r.t, r.before, r.now]), [[since, null, 2], [first - 5 * DAY, 2, 6], [first - 2 * DAY, 6, 2]]);
  assert.deepEqual(Object.keys(v1[0]), ['t', 'variantId', 'sku', 'product', 'variant', 'before', 'now', 'price', 'type', 'cost']);   // pullStock's shape
  assert.deepEqual(out.rows.filter((r) => r.variantId === '3').map((r) => [r.t, r.now]), [[since, 0]]);   // flat at 0: out the whole time
  assert.ok(out.rows.every((r) => r.t < first));
});

/* A fake gql that answers ShopifyQL like Shopify: day offsets in store time, at most 1,000 rows. */
function fakeShop(changes, { now, cap = 1000, failWith = null } = {}) {
  const calls = [];
  const today = TZ.dayStart(now, ZONE);
  const off = (t) => Math.round((today - TZ.dayStart(t, ZONE)) / DAY);
  const q = async (doc, vars) => {
    assert.doesNotThrow(() => assertReadOnly(doc));
    calls.push(vars.q);
    if (failWith) { if (failWith instanceof Error) throw failWith; return failWith; }
    const m = vars.q.match(/GROUP BY (hour|day), product_variant_id SINCE (today|-(\d+)d) UNTIL (today|-(\d+)d)/);
    const a = m[3] ? +m[3] : 0, b = m[5] ? +m[5] : 0, grain = m[1];
    const hit = changes.filter((c) => off(c.t) <= a && off(c.t) >= b && c.state !== 'committed');
    const bucket = new Map();
    for (const c of hit) {
      const t = grain === 'hour' ? Math.floor(c.t / HOUR) * HOUR : TZ.dayStart(c.t, ZONE);
      const k = `${t}|${c.variantId}`; bucket.set(k, (bucket.get(k) || 0) + c.delta);
    }
    const rows = [...bucket].map(([k, d]) => { const [t, id] = k.split('|'); const iso = new Date(+t).toISOString().replace('.000Z', 'Z');
      return { [grain]: grain === 'hour' ? iso : TZ.dayKey(+t, ZONE), product_variant_id: id, inventory_adjustment_change: String(d) }; }).slice(0, cap);
    return { shopifyqlQuery: { tableData: { columns: [{ name: grain }, { name: 'product_variant_id' }, { name: 'inventory_adjustment_change' }], rows }, parseErrors: [] } };
  };
  return { q, calls };
}

test('history: fetchChanges pages by week, splits a capped window in half, reads a capped day by day', async () => {
  const now = Date.parse('2026-11-20T06:00:00Z');
  const changes = [];
  for (let i = 0; i < 40; i++) changes.push({ t: now - 30 * DAY + i * HOUR, variantId: String(100 + i), delta: -1 });   // 40 in ~2 days
  changes.push({ t: now - 3 * DAY, variantId: '5', delta: 2, state: 'committed' });
  const big = fakeShop(changes, { now, cap: 25 });
  const got = await H.fetchChanges(big.q, 60, { zone: ZONE, cap: 25 });
  assert.equal(got.changes.length, 40);
  assert.ok(big.calls.some((c) => /SINCE -60d UNTIL -54d/.test(c)));
  assert.ok(big.calls.some((c) => / UNTIL today/.test(c)));
  assert.ok(big.calls.length > 9, 'a capped window was split');
  /* one day with more than the cap even by hour: read by day (40 variants, 1 row each) */
  const oneDay = []; for (let h = 0; h < 24; h++) for (let v = 0; v < 2; v++) oneDay.push({ t: TZ.dayStart(now - 10 * DAY, ZONE) + h * HOUR, variantId: String(v + 1), delta: -1 });   // 48 hour rows, 2 day rows
  const d = fakeShop(oneDay, { now, cap: 25 });
  const got2 = await H.fetchChanges(d.q, 20, { zone: ZONE, cap: 25 });
  assert.ok(d.calls.some((c) => /GROUP BY day/.test(c)));
  assert.equal(got2.changes.reduce((s, c) => s + c.delta, 0), -48);
  /* still capped by day → HistoryError('cap') */
  const many = []; for (let v = 0; v < 30; v++) many.push({ t: now - 10 * DAY, variantId: String(v + 1), delta: -1 });
  await assert.rejects(H.fetchChanges(fakeShop(many, { now, cap: 25 }).q, 20, { zone: ZONE, cap: 25 }), (e) => e.code === 'cap');
});

test('history: parse errors and a missing scope are clean errors with a plain note', async () => {
  const now = Date.now();
  await assert.rejects(H.fetchChanges(fakeShop([], { now, failWith: { shopifyqlQuery: { tableData: null, parseErrors: ['bad token at 1:5'] } } }).q, 7), (e) => e.code === 'parse');
  assert.match(H.noteFor(new Error('The token lacks a read permission (needs read_products, read_inventory, read_orders)')), /read_reports/);
  assert.match(H.noteFor(new H.HistoryError('parse', 'Shopify didn’t accept')), /^Past stock-outs not rebuilt: Shopify didn’t accept/);
});

/* run(): on a real store file in a temp folder */
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-hist-'));
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../src/store')];
  require('../src/scope').useDir(dir);
  return { store: require('../src/store'), dir };
}

test('history: run() stores rebuilt rows before the first read, feeds ₹ lost, re-runs replace; a failure only leaves a note', async (t) => {
  const { store, dir } = freshStore(); t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); require('../src/scope').useDir(null); });
  const now = Date.now(), first = now - HOUR;
  const live = [
    { t: first, variantId: '1', sku: 'A', product: 'Lamp', variant: '', before: null, now: 5, price: 1000 },
    { t: first, variantId: '2', sku: 'B', product: 'Rug', variant: '', before: null, now: 3, price: 500 },
  ];
  store.add('stock', live, 'shopify');
  /* Lamp: sold out 20 days ago (−4), restocked +5 ten days ago → out for 10 days. Rug: no changes → flat at 3. */
  const changes = [{ t: now - 20 * DAY, variantId: '1', delta: -4 }, { t: now - 10 * DAY, variantId: '1', delta: 5 }];
  const orders = []; for (let i = 21; i < 50; i++) orders.push({ t: now - i * DAY, order: `#${i}`, line: String(i), variantId: '1', sku: 'A', qty: 1, price: 1000 });
  store.replaceOrders(orders.map((o) => o.order), orders, 'shopify');

  const fx = fakeShop(changes, { now });
  const info = await H.run({ q: fx.q, now });
  assert.equal(info.ok, true); assert.equal(info.kept, 2); assert.equal(info.total, 2); assert.equal(info.dropped, 0);
  const d = store.load();
  const rb = d.stock.filter((r) => r.src === 'rebuilt');
  assert.ok(rb.length === 4 && rb.every((r) => r.t < first));
  assert.equal(d.shopify.historyRebuiltAt, now);
  const r = engine.report(d.stock, d.orders, d.settings, { days: 30, now });
  const lamp = r.stockouts.find((s) => s.id === '1');
  assert.ok(lamp && !lamp.open && Math.abs(lamp.hours - 240) < 2, 'a 10-day stock-out rebuilt');
  assert.ok(r.totals.lost > 3000, `₹ lost from the rebuilt stock-out: ${r.totals.lost}`);   // ~10 days × the in-stock rate (7 sold ÷ 18 in-stock days) × ₹1,000

  await H.run({ q: fx.q, now });   // again: same rows, not doubled
  assert.equal(store.load().stock.filter((x) => x.src === 'rebuilt').length, 4);

  const bad = await H.run({ q: fakeShop([], { now, failWith: new Error('The token lacks a read permission (needs read_products, read_inventory, read_orders)') }).q, now });
  assert.equal(bad.ok, true, 'the earlier rebuild still stands'); assert.match(bad.note, /read_reports/);
  assert.equal(store.load().shopify.history.note, bad.note);
  assert.equal(store.load().stock.filter((x) => x.src === 'rebuilt').length, 4, 'a failed re-run keeps the earlier rebuild');
});

test('history: run() with no live read, or a missing scope on a first run, never throws and stores no rows', async (t) => {
  const { store, dir } = freshStore(); t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); require('../src/scope').useDir(null); });
  const none = await H.run({ q: async () => { throw new Error('not called'); } });
  assert.equal(none.ok, false); assert.match(none.note, /no Shopify stock read/);
  store.add('stock', [{ t: Date.now(), variantId: '1', sku: 'A', product: 'Lamp', variant: '', before: null, now: 5, price: 1 }], 'shopify');
  const r = await H.run({ q: fakeShop([], { now: Date.now(), failWith: { shopifyqlQuery: { tableData: null, parseErrors: ['no such table'] } } }).q });
  assert.equal(r.ok, false); assert.match(r.note, /didn’t accept/);
  assert.equal(store.load().stock.filter((x) => x.src === 'rebuilt').length, 0);
});
