'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/groups');
const E = require('../src/engine');
const demo = require('../src/demo');

const NOW = Date.parse('2026-11-19T06:00:00Z');
const g = demo.generate({ now: NOW });
const rep = E.report(g.stock, g.orders, {}, { now: NOW, days: 30 });
const cat = demo.catalog();

test('parent-product lens sums to the report totals', () => {
  const b = G.build(rep.products, cat, 'product');
  const sum = (k) => b.groups.reduce((s, x) => s + x[k], 0);
  assert.equal(b.overlap, false);
  assert.equal(sum('n'), rep.products.length);
  assert.equal(sum('sold'), rep.totals.sold);
  assert.equal(sum('lost'), rep.totals.lost);
  assert.equal(sum('needOrder'), rep.totals.orderToday);
  assert.equal(sum('orderValue'), rep.totals.orderValueNow);
  assert.equal(sum('excessValue'), rep.totals.excessValue);
  assert.equal(b.groups.reduce((s, x) => s + (x.lostProfit || 0), 0), rep.totals.lostProfit);
  assert.deepEqual({ sold: b.total.sold, lost: b.total.lost, n: b.total.n }, { sold: rep.totals.sold, lost: rep.totals.lost, n: rep.products.length });
  assert.ok(b.groups.length < rep.products.length, 'variants of one product roll up together');
});

test('category lens: every variant in exactly one group, sums to the totals', () => {
  const b = G.build(rep.products, cat, 'type');
  assert.equal(b.groups.reduce((s, x) => s + x.n, 0), rep.products.length);
  assert.equal(b.total.sold, rep.totals.sold); assert.equal(b.total.lost, rep.totals.lost);
  assert.ok(b.groups.find((x) => x.key === 'Candle Holders'));
});

test('tag and collection lenses: overlap, no grand total, distinct store total', () => {
  for (const lens of ['tag', 'collection']) {
    const b = G.build(rep.products, cat, lens);
    assert.equal(b.overlap, true); assert.equal(b.total, null);
    assert.equal(b.store.sold, rep.totals.sold); assert.equal(b.store.lost, rep.totals.lost); assert.equal(b.store.n, rep.products.length);
    const covered = new Set(b.groups.flatMap((x) => x.ids));
    assert.equal(covered.size, rep.products.length, `${lens}: every variant shows up somewhere (a "no tag" group catches the rest)`);
  }
  const tags = G.build(rep.products, cat, 'tag');
  assert.ok(tags.groups.reduce((s, x) => s + x.n, 0) > rep.products.length, 'products with two tags count in both rows');
});

test('catch-all collections (≥ 80% of products) are hidden by default, shown on request', () => {
  const b = G.build(rep.products, cat, 'collection');
  assert.deepEqual(b.hidden.map((h) => h.label), ['All products']);
  assert.ok(!b.groups.some((x) => x.label === 'All products'));
  const all = G.build(rep.products, cat, 'collection', { showAll: true });
  assert.equal(all.hidden.length, 0);
  assert.ok(all.groups.some((x) => x.label === 'All products'));
});

test('keys are IDs, never titles', () => {
  const pids = new Set(Object.values(cat.variants).map((v) => v.productId));
  for (const x of G.build(rep.products, cat, 'product').groups) assert.ok(pids.has(x.key), `${x.key} is a product ID`);
  for (const x of G.build(rep.products, cat, 'collection', { showAll: true }).groups) assert.ok(x.key in cat.collections, `${x.key} is a collection ID`);
  /* two products with the same title stay two groups */
  const rows = [{ id: 'v1', name: 'Vase', sold: 100, lost: 0, status: 'OK' }, { id: 'v2', name: 'Vase', sold: 50, lost: 0, status: 'OK' }];
  const c = { variants: { v1: { productId: 'p1', product: 'Vase' }, v2: { productId: 'p2', product: 'Vase' } } };
  assert.deepEqual(G.build(rows, c, 'product').groups.map((x) => [x.key, x.sold]), [['p1', 100], ['p2', 50]]);
});

test('tags are case-folded; a variant the catalog does not know keys on its variant ID', () => {
  const rows = [{ id: 'a', name: 'A', sold: 10, lost: 5, status: 'Out now', orderValue: 300 }, { id: 'b', name: 'B', sold: 20, lost: 0, status: 'OK' }, { id: 'c', name: 'C', sold: 1, lost: 0, status: 'OK' }];
  const c = { variants: { a: { productId: 'p1', tags: ['Gold', 'gold '] }, b: { productId: 'p2', tags: ['GOLD'] } } };
  const t = G.build(rows, c, 'tag');
  assert.deepEqual(t.groups.map((x) => [x.key, x.label, x.n]), [['gold', 'Gold', 2], ['', 'No tag', 1]]);
  assert.equal(t.groups[0].needOrder, 1); assert.equal(t.groups[0].orderValue, 300);
  assert.deepEqual(G.build(rows, c, 'product').groups.map((x) => x.key).sort(), ['p1', 'p2', 'variant:c']);
});

test('group trend: summed sales per in-stock day, last 14 days vs the 14 before', () => {
  const wk = (u) => u.map((units, i) => ({ units, outDays: i === 6 ? 3.5 : 0 }));
  const rows = [
    { id: 'a', sold: 0, lost: 0, weeks: wk([null, null, null, null, 7, 7, 7, 7]) },   // 1/day before; 14 units over 10.5 in-stock days after
    { id: 'b', sold: 0, lost: 0, weeks: wk([0, 0, 0, 0, 0, 0, 0, 0]) },
    { id: 'c', sold: 0, lost: 0, weeks: wk([null, null, null, null, null, null, 3, 3]) },  // too new: left out
  ];
  const c = { variants: { a: { productId: 'p' }, b: { productId: 'p' }, c: { productId: 'p' } } };
  const [x] = G.build(rows, c, 'product').groups;
  assert.equal(x.trendPct, Math.round(((14 / 10.5 - 1) / 1) * 1000) / 10);
  const few = G.build([{ id: 'a', sold: 0, lost: 0, weeks: wk([0, 0, 0, 0, 1, 1, 1, 1]) }], c, 'product').groups[0];
  assert.equal(few.trendPct, null, 'under 6 units: no trend');
});

test('lenses on offer follow the catalog; unknown lens refused', () => {
  assert.deepEqual(G.lensesFor({}), ['product', 'type']);
  assert.deepEqual(G.lensesFor(cat), ['product', 'type', 'collection', 'tag']);
  assert.throws(() => G.build([], {}, 'title'), /Unknown group/);
});
