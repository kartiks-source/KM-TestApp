'use strict';
/*
 * Demo data: 45 days of a made-up store. Every product, price and order is invented.
 * Some bestsellers are run the way the agency described: they sell out, someone adds
 * ~10 pieces by hand, they sell out again, and only later get a proper restock.
 */
const { HOUR, DAY } = require('./engine');

function rng(seed) {      // mulberry32: same demo every time
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function poisson(lambda, r) { let L = Math.exp(-lambda), k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }

// name, variant, price ₹, units/day, how the team runs its stock
const CATALOG = [
  ['Vitamin C Face Serum', '30 ml', 599, 22, 'trickle'],
  ['Onion Hair Oil', '200 ml', 449, 18, 'trickle'],
  ['Daily Sunscreen SPF 50', '50 g', 499, 15, 'late'],
  ['Niacinamide Toner', '100 ml', 399, 12, 'good'],
  ['Peptide Night Cream', '50 g', 899, 9, 'trickle'],
  ['Rice Water Shampoo', '250 ml', 349, 14, 'good'],
  ['Aloe Vera Gel', '150 g', 249, 16, 'late'],
  ['Charcoal Face Wash', '100 ml', 299, 11, 'good'],
  ['Retinol Night Serum', '30 ml', 799, 6, 'good'],
  ['Lip Balm Trio', 'Pack of 3', 299, 8, 'late'],
  ['Clay Face Pack', '100 g', 349, 5, 'good'],
  ['Hyaluronic Moisturiser', '50 g', 549, 10, 'good'],
  ['Biotin Hair Gummies', '30 pcs', 699, 7, 'trickle'],
  ['Tea Tree Spot Gel', '15 g', 279, 4, 'good'],
  ['Body Lotion Cocoa', '400 ml', 449, 6, 'good'],
  ['Under Eye Cream', '20 g', 499, 5, 'late'],
  ['Hair Serum Argan', '100 ml', 399, 4, 'good'],
  ['Foot Cream Repair', '50 g', 249, 2, 'good'],
  ['Beard Oil', '30 ml', 349, 1.5, 'good'],
  ['Gift Box Glow Kit', 'Kit', 1499, 1, 'good'],
];
// share of a day's orders by local hour (IST): quiet nights, lunch bump, evening peak
const HOURLY = [0.6, 0.4, 0.3, 0.2, 0.2, 0.3, 0.6, 1, 1.3, 1.5, 1.6, 1.7, 1.8, 1.7, 1.5, 1.4, 1.4, 1.5, 1.7, 1.9, 2.0, 1.8, 1.3, 0.9];
const HSUM = HOURLY.reduce((a, b) => a + b, 0);

function generate({ now = Date.now(), days = 45, seed = 7 } = {}) {
  const r = rng(seed);
  const start = Math.floor((now - days * DAY) / HOUR) * HOUR;
  const stock = [], orders = [];
  let orderNo = 41000;
  const items = CATALOG.map(([product, variant, price, perDay, style], i) => ({
    id: String(70100000 + i * 37), sku: `DS-${String(i + 1).padStart(3, '0')}`, product, variant, price, perDay, style,
    qty: Math.round(perDay * (14 + r() * 10)), outSince: null, nextBigRestock: null, trickles: 0,
  }));
  const change = (it, t, delta) => {
    const before = it.qty; it.qty = Math.max(0, it.qty + delta);
    if (it.qty !== before) stock.push({ t, variantId: it.id, sku: it.sku, product: it.product, variant: it.variant, before, now: it.qty, price: it.price });
  };
  for (const it of items) stock.push({ t: start, variantId: it.id, sku: it.sku, product: it.product, variant: it.variant, before: it.qty, now: it.qty, price: it.price });

  for (let t = start; t < now; t += HOUR) {
    const h = new Date(t + 330 * 60e3).getUTCHours();
    const weekend = [0, 6].includes(new Date(t + 330 * 60e3).getUTCDay());
    for (const it of items) {
      /* restocking, the way each style is run */
      if (it.qty <= 0 && it.outSince == null) it.outSince = t;
      if (it.qty > 0) it.outSince = null;
      if (it.outSince != null) {
        const outH = (t - it.outSince) / HOUR;
        if (it.style === 'trickle' && it.trickles < 3 && outH >= 6 + r() * 20) { change(it, t, 8 + Math.round(r() * 6)); it.trickles++; it.outSince = null; }
        else if (it.style === 'trickle' && it.trickles >= 3 && outH >= 30) { change(it, t, Math.round(it.perDay * 25)); it.trickles = 0; it.outSince = null; }
        else if (it.style === 'late' && outH >= 40 + r() * 50) { change(it, t, Math.round(it.perDay * 20)); it.outSince = null; }
        else if (it.style === 'good' && outH >= 12) { change(it, t, Math.round(it.perDay * 30)); it.outSince = null; }
      }
      if (it.style === 'good' && it.qty > 0 && it.qty < it.perDay * 6 && r() < 0.04) change(it, t, Math.round(it.perDay * 30));
      /* selling */
      const lambda = (it.perDay * HOURLY[h]) / HSUM * (weekend ? 1.15 : 1) * (0.85 + r() * 0.3);
      let want = poisson(lambda, r);
      while (want > 0 && it.qty > 0) {
        const q = Math.min(it.qty, want > 1 && r() < 0.3 ? 2 : 1);
        const tt = t + Math.floor(r() * HOUR);
        const paid = Math.round(it.price * (r() < 0.35 ? 0.85 : 1));
        orders.push({ t: tt, order: `#${orderNo++}`, variantId: it.id, sku: it.sku, qty: q, price: paid });
        change(it, tt, -q);
        want -= q;
      }
    }
  }
  stock.sort((a, b) => a.t - b.t); orders.sort((a, b) => a.t - b.t);
  return { stock, orders };
}

module.exports = { generate };
