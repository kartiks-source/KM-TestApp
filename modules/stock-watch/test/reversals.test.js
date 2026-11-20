'use strict';
/* 1.1.5 (LOGIC.md §9e): reversals (cancellations, refunds) with their own dates, as Shopify's reports book them.
 * Fake GraphQL orders, no network: refunds and cancels on orders placed before the period, a refund after a cancel,
 * de-duplication in the store, Cancel/refund % and Shopify-style net sales by reversal date. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../src/shopify');
const E = require('../src/engine');
const P = require('../src/period');

const gid = (k, n) => `gid://shopify/${k}/${n}`;
/** A line with GST inside the price (₹1,180 paid = ₹1,000 + ₹180 tax per unit). */
const line = (id, qty, v = 9, cur = qty) => ({ id: gid('LineItem', id), quantity: qty, currentQuantity: cur, sku: 'A', variant: { id: gid('ProductVariant', v) },
  discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '1180' } }, taxLines: [{ priceSet: { shopMoney: { amount: String(180 * qty) } } }] });
/** A refund at `at`; lines = [[rliId, lineId, qty, subtotal, tax, restockType]]. */
const refund = (id, at, lines) => ({ id: gid('Refund', id), createdAt: at, refundLineItems: { pageInfo: { hasNextPage: false }, nodes: lines.map(([rid, lid, q, sub, tax, type = 'RETURN']) => ({
  id: gid('RefundLineItem', rid), quantity: q, restockType: type, lineItem: { id: gid('LineItem', lid) }, subtotalSet: { shopMoney: { amount: String(sub) } }, totalTaxSet: { shopMoney: { amount: String(tax) } } })) } });
const order = (o) => ({ id: gid('Order', o.name.slice(1)), test: false, cancelledAt: null, taxesIncluded: true, refunds: [], updatedAt: o.createdAt, ...o });

test('reversal events: a refund on its refund date, ₹ ex GST; ids from the refund line', () => {
  const o = order({ name: '#1', createdAt: '2026-10-01T10:00:00Z', refunds: [refund(5, '2026-11-15T08:00:00Z', [[50, 1, 1, 1180, 180]])] });
  assert.deepEqual(S.reversalEvents(o, [line(1, 2)]), [{ id: '50', t: Date.parse('2026-11-15T08:00:00Z'), order: '#1', variantId: '9', qty: 1, value: 1000, kind: 'refund' }]);
  /* restock type CANCEL = removed before shipping: a cancel */
  const c = order({ name: '#2', createdAt: '2026-11-01T10:00:00Z', refunds: [refund(6, '2026-11-01T11:00:00Z', [[60, 1, 1, 1180, 180, 'CANCEL']])] });
  assert.equal(S.reversalEvents(c, [line(1, 2)])[0].kind, 'cancel');
  /* prices without tax inside: the subtotal is already ex tax */
  assert.equal(S.reversalEvents({ ...o, taxesIncluded: false }, [line(1, 2)])[0].value, 1180);
  assert.deepEqual(S.reversalEvents({ ...o, test: true }, [line(1, 2)]), [], 'test orders: none');
  /* a line without a variant (custom item) is left out, as its sales are */
  assert.deepEqual(S.reversalEvents(o, [{ ...line(1, 2), variant: null }]), []);
});

test('reversal events: a cancellation on its cancel date; units no refund covers at the price paid; a refund after the cancel moves money only', () => {
  /* cancelled with a refund made at the same moment (Shopify's usual cancel): the refund line, dated then */
  const a = order({ name: '#3', createdAt: '2026-09-10T10:00:00Z', cancelledAt: '2026-09-30T06:00:01Z', refunds: [refund(7, '2026-09-30T06:00:00Z', [[70, 1, 2, 2360, 360, 'CANCEL']])] });
  assert.deepEqual(S.reversalEvents(a, [line(1, 2), line(2, 1, 8)]).map((e) => [e.id, e.t, e.variantId, e.qty, e.value, e.kind]), [
    ['70', Date.parse('2026-09-30T06:00:00Z'), '9', 2, 2000, 'cancel'],
    ['c2', Date.parse('2026-09-30T06:00:01Z'), '8', 1, 1000, 'cancel'],   // line 2 had no refund line (unpaid): at its price paid, on the cancel date
  ]);
  /* Sammsara #92029: cancelled 29 Aug without a refund, refunded on 17 Nov. Shopify books the return on 29 Aug only */
  const b = order({ name: '#92029', createdAt: '2026-08-29T12:04:18Z', cancelledAt: '2026-08-29T12:18:51Z', refunds: [refund(8, '2026-11-17T22:43:24Z', [[80, 1, 1, 2600, 123.81, 'NO_RESTOCK']])] });
  assert.deepEqual(S.reversalEvents(b, [line(1, 1)]).map((e) => [e.id, new Date(e.t).toISOString(), e.qty]), [['c1', '2026-08-29T12:18:51.000Z', 1]]);
});

test('pullOrders backfill: orders placed before the 60 days but reversed in them give events only, never lines', async () => {
  const now = Date.parse('2026-11-20T16:00:00Z');
  const recent = order({ name: '#10', createdAt: '2026-11-10T05:00:00Z', updatedAt: '2026-11-12T05:00:00Z', refunds: [refund(11, '2026-11-12T05:00:00Z', [[110, 1, 1, 1180, 180]])] });
  const old = order({ name: '#9', createdAt: '2026-09-01T05:00:00Z', updatedAt: '2026-10-01T05:00:00Z', cancelledAt: '2026-10-01T05:00:00Z' });
  const wrap = (o, lines) => ({ ...o, lineItems: { pageInfo: { hasNextPage: false }, nodes: lines } });
  let filter; const pages = [];
  const q = async (doc, v) => { S.assertReadOnly(doc); filter = v.q; return { orders: { pageInfo: { hasNextPage: false }, nodes: [wrap(old, [line(1, 3, 7)]), wrap(recent, [line(1, 2)])] } }; };
  await S.pullOrders(null, { q, now, onPage: (names, rows, cursor, rv) => pages.push({ names, rows, rv }) });
  assert.match(filter, /^created_at:>='2026-09-21T16:00:00.000Z' OR updated_at:>='2026-09-21T16:00:00.000Z'$/);
  const [p] = pages;
  assert.deepEqual(p.names, ['#10'], 'only orders placed in the 60 days have their lines replaced');
  assert.deepEqual(p.rows.map((r) => r.order), ['#10']);
  assert.deepEqual(p.rv.orders, ['#9', '#10'], 'every order read has its events replaced');
  assert.deepEqual(p.rv.events.map((e) => [e.order, e.variantId, e.qty, e.kind]), [['#9', '7', 3, 'cancel'], ['#10', '9', 1, 'refund']]);
  /* later runs (changed orders only): an older order is read whole, as before */
  const inc = [];
  await S.pullOrders(Date.parse('2026-11-20T00:00:00Z'), { q, now, onPage: (names, rows, cursor, rv) => inc.push({ names, rv }) });
  assert.deepEqual(inc[0].names, ['#9', '#10']);
  assert.equal(inc[0].rv.events.length, 2);
});

test('store: events replaced per order, one per id, older than 120 days dropped; demo and Clear remove them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rev-'));
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../src/store')];
  require('../src/scope').useDir(dir);
  const store = require('../src/store');
  const t = Date.now() - 864e5, ev = (id, order, extra = {}) => ({ id, t, order, variantId: '9', qty: 1, value: 1000, kind: 'refund', ...extra });
  assert.equal(store.load().reversals, undefined, 'absent until the first pull that reads them');
  store.replaceReversals(['#1', '#2'], [ev('a', '#1'), ev('b', '#2'), ev('b', '#2')]);
  assert.deepEqual(store.load().reversals.map((e) => e.id), ['a', 'b'], 'the same id twice on a page: once');
  store.replaceReversals(['#1', '#2'], [ev('a', '#1'), ev('b', '#2')]);   // read again
  assert.deepEqual(store.load().reversals.map((e) => e.id).sort(), ['a', 'b'], 're-reads never double count');
  store.replaceReversals(['#1'], [ev('a2', '#1', { qty: 2 })]);           // the refund was edited in Shopify
  assert.deepEqual(store.load().reversals.map((e) => [e.id, e.qty]).sort(), [['a2', 2], ['b', 1]]);
  store.replaceReversals(['#2'], []);                                     // refund removed
  assert.deepEqual(store.load().reversals.map((e) => e.id), ['a2']);
  store.replaceReversals(['#3'], [ev('old', '#3', { t: Date.now() - 121 * 864e5 })]);
  assert.deepEqual(store.load().reversals.map((e) => e.id), ['a2'], 'older than the 120 days kept: not stored');
  store.load().reversals.push(ev('aging', '#4', { t: Date.now() - 125 * 864e5 }));
  store.prune(true);
  assert.deepEqual(store.load().reversals.map((e) => e.id), ['a2'], 'pruned with the order lines');
  store.replaceAll([], [], 'empty');
  assert.equal(store.load().reversals, undefined, 'Clear all data: gone, read again on the next pull');
});

test('Cancel/refund % = reversed units dated in the period ÷ units ordered in the period (Shopify\'s definition); ₹ reversed by reversal date', () => {
  const now = Date.parse('2026-11-20T16:00:00Z'), span = P.range('30', now, 'Asia/Kolkata');   // 22 Oct – 20 Nov
  const D = E.DAY, day = (s) => Date.parse(`${s}T12:00:00+05:30`);
  const orders = [
    { t: day('2026-11-01'), order: '#1', variantId: '9', sku: 'A', qty: 8, price: 1000, ordered: 10, returned: 2, refund: 2000 },
    { t: day('2026-11-05'), order: '#2', variantId: '9', sku: 'A', qty: 0, price: 1000, ordered: 5, returned: 5, cancelled: 5, refund: 5000 },   // cancelled order: ordered counts
    { t: day('2026-10-10'), order: '#0', variantId: '9', sku: 'A', qty: 0, price: 1000, ordered: 3, returned: 3, cancelled: 3, refund: 3000 },   // placed before the period
  ];
  const reversals = [
    { id: 'r1', t: day('2026-12-01') - 30 * D, order: '#1', variantId: '9', qty: 1, value: 1000, kind: 'refund' },   // 1 Nov
    { id: 'r2', t: now + 3600e3, order: '#1', variantId: '9', qty: 1, value: 1000, kind: 'refund' },                  // after now: not yet
    { id: 'c2', t: day('2026-11-06'), order: '#2', variantId: '9', qty: 5, value: 5000, kind: 'cancel' },
    { id: 'c0', t: day('2026-10-25'), order: '#0', variantId: '9', qty: 3, value: 3000, kind: 'cancel' },              // an older order cancelled in the period: counts
    { id: 'cx', t: day('2026-10-21'), order: '#0', variantId: '9', qty: 1, value: 1000, kind: 'cancel' },              // the day before the period: out
  ];
  const r = E.report([], orders, { timeZone: 'Asia/Kolkata' }, { now, ...span, reversals });
  const p = r.products.find((x) => x.id === '9');
  assert.deepEqual([p.unitsOrdered, p.unitsReturned, p.unitsCancelled, p.refundValue, p.returnPct], [15, 9, 8, 9000, 60]);
  assert.deepEqual([r.totals.unitsOrdered, r.totals.unitsReturned, r.totals.returnPct], [15, 9, 60]);
  /* Shopify-style net sales: gross − discounts of the orders placed in the period (cancelled included) − reversals dated in it */
  assert.deepEqual(r.totals.shopifyNet, { gross: 15000, returns: 9000, net: 6000 });
  /* ₹ sold stays by order date, units kept (₹8,000) */
  assert.equal(r.totals.sold, 8000);
  /* without events (Flow / CSV, or before the re-read): by order date from the lines, no Shopify check */
  const old = E.report([], orders, { timeZone: 'Asia/Kolkata' }, { now, ...span });
  assert.deepEqual([old.totals.unitsOrdered, old.totals.unitsReturned, old.totals.shopifyNet], [15, 7, null]);
  /* the 7 days before (digest): events after that moment don't count */
  const past = E.report([], orders, { timeZone: 'Asia/Kolkata' }, { now: day('2026-11-05') + 3600e3, from: span.from, reversals });
  assert.equal(past.totals.unitsReturned, 4);
});
