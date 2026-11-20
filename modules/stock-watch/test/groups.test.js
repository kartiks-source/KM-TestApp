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

test('group trend colour follows the product rule: a fall is never green, a rise never red (critic r2 UI-3)', () => {
  const wk = (b, r) => [0, 0, 0, 0, b / 2, b / 2, r / 2, r / 2].map((units) => ({ units, outDays: 0 }));
  const rows = [
    { id: 'a', name: 'a', type: 'Baskets', weeks: wk(100, 20), trendPct: -80 },
    { id: 'b', name: 'b', type: 'Ottomans', weeks: wk(100, 105), trendPct: 5 },
    { id: 'c', name: 'c', type: 'Lamps', weeks: wk(100, 150), trendPct: 50 },
    ...[1, 2, 3, 4, 5].map((i) => ({ id: `z${i}`, name: `z${i}`, type: 'Rugs', weeks: wk(100, 60), trendPct: -40 })),
  ];
  const r = G.build(rows, {}, 'type');
  assert.equal(r.storeTrendPct, -40, 'baseline = the typical product (median product trend), as on Products');
  const by = Object.fromEntries(r.groups.map((g) => [g.label, g]));
  assert.equal(by.Baskets.trendCall, 'down', '−80% vs typical −40%: falling and 40 points worse');
  assert.equal(by.Ottomans.trendCall, 'up', '+5% vs typical −40%: rising and 45 points better (was grey, tooltip said "Falling…")');
  assert.equal(by.Lamps.trendCall, 'up');
  assert.equal(by.Rugs.trendCall, 'flat', 'in line with the typical product');
  for (const g of r.groups) {
    if (g.trendPct < 0) assert.notEqual(g.trendCall, 'up', g.label);
    if (g.trendPct > 0) assert.notEqual(g.trendCall, 'down', g.label);
  }
});

test('group spark (SW-021): weekly units = the sum of its variants’ weeks; rose when a variant was out; no data stays null', () => {
  for (const lens of ['product', 'type', 'tag']) {
    const b = G.build(rep.products, cat, lens);
    for (const grp of b.groups) {
      assert.equal(grp.weeks.length, 8, `${lens} ${grp.label}`);
      const rows = rep.products.filter((p) => grp.ids.includes(p.id));
      grp.weeks.forEach((w, i) => {
        const have = rows.filter((p) => p.weeks[i].units != null);
        assert.equal(w.units, have.length ? have.reduce((s, p) => s + p.weeks[i].units, 0) : null, `${lens} ${grp.label} week ${i}`);
        assert.equal(w.outProducts, have.filter((p) => p.weeks[i].outDays > 0).length);
        assert.equal(w.outDays > 0, w.outProducts > 0, 'rose base exactly when a variant was out');
      });
    }
  }
  /* parent products add up to the store's weekly units */
  const b = G.build(rep.products, cat, 'product');
  for (let i = 0; i < 8; i++) assert.equal(b.groups.reduce((s, x) => s + (x.weeks[i].units || 0), 0), rep.products.reduce((s, p) => s + (p.weeks[i].units || 0), 0));
  assert.equal('weeks' in b.store, false, 'store total carries no spark');
});

test('group spark: a week before any variant has data is "no data"; a variant without weeks adds nothing', () => {
  const nd = { units: null, outDays: 0 }, w = (u, o = 0) => ({ units: u, outDays: o });
  const rows = [
    { id: 'a', name: 'A', weeks: [nd, nd, w(1), w(2), w(3), w(4), w(5), w(6, 2)] },
    { id: 'b', name: 'B', weeks: [nd, w(5), w(0), w(0), w(1), w(1), w(1), w(1)] },
    { id: 'c', name: 'C' },
  ];
  const [g1] = G.build(rows, { variants: { a: { productId: 'P' }, b: { productId: 'P' }, c: { productId: 'P' } } }, 'product').groups;
  assert.deepEqual(g1.weeks.map((x) => x.units), [null, 5, 1, 2, 4, 5, 6, 7]);
  assert.deepEqual(g1.weeks[7], { units: 7, outDays: 1, outProducts: 1, products: 2 });
  assert.equal(g1.n, 3);
});
