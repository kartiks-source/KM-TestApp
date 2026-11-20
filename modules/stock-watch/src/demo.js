'use strict';
/*
 * Demo data: 60 days of a busy home-décor store, built on Sammsara's public product list
 * (names, variants, prices from sammsara.com/products.json, saved in demo-catalog.json).
 * Every stock level, order and stock-out is invented.
 *
 * What makes it realistic enough to show:
 *   - long tail: a few bestsellers sell 5–10 a day, most items under one a day
 *   - Diwali gifting peak (gift sets, candle holders, platters) then a post-festive dip
 *   - weekends a little busier; evenings busiest
 *   - baskets: about a quarter of orders carry a second item
 *   - restocking habits per product: proper restocks, late restocks, "add 10 pieces by hand"
 *     top-ups, slow movers sitting on too much stock, and a few left out of stock for weeks
 */
const { HOUR, DAY } = require('./engine');
const TZ = require('./tz');   // the demo brand is in India
const CATALOG = require('./demo-catalog.json').items;

const VERSION = 'sammsara-7';           // bump to make running servers rebuild their demo data (7: vendors, SW-040)
const STORE_NAME = 'Sammsara (demo)';
/* the demo stores shown when no Shopify key is set (multi-store, ADR-0015): id, name, generate() options */
const STORES = [
  { id: 'sammsara-demo', name: STORE_NAME, opts: { seed: 11 } },
  { id: 'second-demo', name: 'Second store (demo)', opts: { seed: 29, priceMix: 0.6, every: 3 } },
];

const variantId = (i) => String(4710000000 + i * 97);   // demo variant IDs, shared with catalog()

/* SW-040: invented vendors (Shopify product.vendor) by product type, named after Indian craft towns, and their
   terms (lead time, MOQ, case pack) seeded into suppliers.json with the demo. Not Sammsara's real suppliers. */
const VENDORS = [
  [/table$|console|ottoman/i, 'Jodhpur Furniture Co.'],
  [/candle|hurricane|lamp/i, 'Moradabad Metal Arts'],
  [/platter|tray|bar set|gift/i, 'Agra Marble Works'],
  [/bath|tissue|basket|planter|vase/i, 'Khurja Ceramics'],
  [/cushion/i, 'Panipat Textiles'],
];
const vendorOf = (type) => (VENDORS.find(([re]) => re.test(type || '')) || [null, 'Jaipur Décor House'])[1];
const SUPPLIERS = [
  { name: 'Jodhpur Furniture Co.', leadDays: 21, moq: 2, pack: null },
  { name: 'Moradabad Metal Arts', leadDays: 12, moq: 12, pack: 6 },
  { name: 'Agra Marble Works', leadDays: 14, moq: null, pack: 4 },
  { name: 'Khurja Ceramics', leadDays: 9, moq: 12, pack: 12 },
  { name: 'Panipat Textiles', leadDays: 7, moq: 20, pack: 10 },
  { name: 'Jaipur Décor House', leadDays: null, moq: 6, pack: 6 },
];

function rng(seed) {      // mulberry32: same demo every time
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function poisson(lambda, r) { let L = Math.exp(-lambda), k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }

// share of a day's orders by local hour (IST): quiet nights, lunch bump, evening peak
const HOURLY = [0.5, 0.3, 0.2, 0.15, 0.15, 0.25, 0.5, 0.9, 1.2, 1.4, 1.5, 1.6, 1.7, 1.6, 1.4, 1.3, 1.4, 1.5, 1.8, 2.0, 2.2, 2.0, 1.4, 0.9];
const HSUM = HOURLY.reduce((a, b) => a + b, 0);
const FESTIVE = /gift|candle|platter|tray|hurricane|incense|diya|lantern|decorative/i;
const DIWALI = Date.parse('2026-11-08T00:00:00+05:30');

/** Demand multiplier for a product type on a day: build-up to Diwali, the peak, then a dip. */
function season(type, t) {
  const d = (t - DIWALI) / DAY;
  const festive = FESTIVE.test(type);
  if (d >= -18 && d < -4) return festive ? 1.9 : 1.25;
  if (d >= -4 && d <= 0) return festive ? 2.6 : 1.4;
  if (d > 0 && d <= 6) return 0.7;
  return 1;
}

const STYLES = [['good', 0.42], ['trickle', 0.26], ['late', 0.18], ['heavy', 0.1], ['abandoned', 0.04]];
function pickStyle(r) { let x = r(); for (const [s, p] of STYLES) { if ((x -= p) < 0) return s; } return 'good'; }

/*
 * A second demo store (multi-store, ADR-0015): same public catalog, every `every`-th product left out, prices
 * × priceMix, its own seed, so its numbers clearly differ from the first. Defaults give the first demo, unchanged.
 */
function generate({ now = Date.now(), days = 60, seed = 11, priceMix = 1, every = 0 } = {}) {
  const r = rng(seed);
  const start = Math.floor((now - days * DAY) / HOUR) * HOUR;
  const stock = [], orders = [];
  let orderNo = seed === 11 ? 58200 : 10000 + (seed % 89) * 1000;
  const list = CATALOG.map((c, i) => ({ c: priceMix === 1 ? c : { ...c, price: Math.max(99, Math.round(c.price * priceMix)) }, i })).filter(({ i }) => !every || i % every !== 0);

  /* demand by popularity rank (Zipf), nudged by price: cheaper décor sells more */
  const order = list.map(({ c, i }) => ({ c, i, k: r() })).sort((a, b) => a.k - b.k);
  const items = order.map(({ c, i }, rank) => {
    const priceFactor = Math.min(1.6, Math.max(0.35, 3500 / c.price) ** 0.5);
    const perDay = Math.max(0.04, (9 / (rank + 1) ** 0.9) * priceFactor);
    const style = rank < 6 ? (['trickle', 'late', 'good'][rank % 3]) : pickStyle(r);
    const cover = style === 'heavy' ? 110 + r() * 140 : style === 'abandoned' ? 4 + r() * 6 : 12 + r() * 22;
    return {
      id: variantId(i), sku: c.sku || `SAM-${String(i + 1).padStart(4, '0')}`, product: c.product, variant: c.variant,
      type: c.type, vendor: vendorOf(c.type), price: c.price, cost: Math.round(c.price * (0.38 + r() * 0.17)), perDay, style, qty: Math.max(1, Math.round(perDay * cover)), outSince: null, trickles: 0,
    };
  });

  const change = (it, t, delta) => {
    const before = it.qty; it.qty = Math.max(0, it.qty + delta);
    if (it.qty !== before) stock.push({ t, variantId: it.id, sku: it.sku, product: it.product, variant: it.variant, before, now: it.qty, price: it.price, type: it.type, vendor: it.vendor, cost: it.cost });
  };
  for (const it of items) stock.push({ t: start, variantId: it.id, sku: it.sku, product: it.product, variant: it.variant, before: it.qty, now: it.qty, price: it.price, type: it.type, vendor: it.vendor, cost: it.cost });

  const sell = (it, t, q) => Math.min(it.qty, q);
  const paidFor = (it) => Math.round(it.price * (r() < 0.3 ? 0.9 : r() < 0.08 ? 0.8 : 1));

  for (let t = start; t < now; t += HOUR) {
    const local = TZ.local(t, 'Asia/Kolkata');
    const h = local.getUTCHours();
    const weekend = [0, 6].includes(local.getUTCDay());
    for (const it of items) {
      /* restocking, the way each product is run */
      if (it.qty <= 0 && it.outSince == null) it.outSince = t;
      if (it.qty > 0) it.outSince = null;
      if (it.outSince != null) {
        const outH = (t - it.outSince) / HOUR;
        const proper = Math.max(3, Math.round(it.perDay * (25 + r() * 15)));
        if (it.style === 'trickle' && it.trickles < 3 && outH >= 8 + r() * 30) { change(it, t, Math.max(2, Math.round(it.perDay * (1.5 + r() * 2)))); it.trickles++; it.outSince = null; }
        else if (it.style === 'trickle' && it.trickles >= 3 && outH >= 36) { change(it, t, proper); it.trickles = 0; it.outSince = null; }
        else if (it.style === 'late' && outH >= 60 + r() * 120) { change(it, t, proper); it.outSince = null; }
        else if ((it.style === 'good' || it.style === 'heavy') && outH >= 18) { change(it, t, proper); it.outSince = null; }
        // 'abandoned': never restocked
      }
      if (it.style === 'good' && it.qty > 0 && it.qty < it.perDay * 9 && r() < 0.03) change(it, t, Math.max(3, Math.round(it.perDay * 30)));
      if (r() < 0.0004) change(it, t, -1);                                                     // damaged / stock count fix
      if (r() < 0.0002 && it.qty > 0) change(it, t, 1 + Math.floor(r() * 2));                  // customer return

      /* selling */
      const lambda = (it.perDay * HOURLY[h]) / HSUM * season(it.type, t) * (weekend ? 1.15 : 1) * (0.8 + r() * 0.4);
      let want = poisson(lambda, r);
      while (want > 0 && it.qty > 0) {
        const q = sell(it, t, want > 1 && r() < 0.25 ? 2 : 1);
        const tt = t + Math.floor(r() * HOUR);
        const name = `#${orderNo++}`;
        orders.push({ t: tt, order: name, variantId: it.id, sku: it.sku, qty: q, price: paidFor(it) });
        change(it, tt, -q);
        want -= q;
        if (r() < 0.25) {                                                                       // a second item in the basket
          const other = items[Math.floor(r() ** 2 * items.length)];
          if (other !== it && other.qty > 0) {
            orders.push({ t: tt, order: name, variantId: other.id, sku: other.sku, qty: 1, price: paidFor(other) });
            change(other, tt, -1);
          }
        }
      }
    }
  }
  stock.sort((a, b) => a.t - b.t); orders.sort((a, b) => a.t - b.t);
  return { stock, orders };
}

/*
 * Product IDs, tags and collections for the demo (SW-022), set up the way a décor store would:
 * variants of one product share a product ID; tags for furniture vs décor, finish, motif, festive
 * gifting and price band; collections built on those, plus one "All products" catch-all.
 * Derived from the catalog's product types and names; same every time. Shape: see src/catalog.js.
 */
const FURNITURE = /table$|console|ottoman/i;                    // by product type ('Table top & decorative accents' is décor)
const GIFTING = /gift|candle|hurricane|platter|tray|incense|diya|lantern/i;
const TAG_RULES = [[/gold/i, 'Gold'], [/silver/i, 'Silver'], [/brass/i, 'Brass'], [/marble/i, 'Marble'], [/glass/i, 'Glass'], [/wood|teak|mango/i, 'Wood'],
  [/elephant|peacock|parrot|\bbee\b|bumble|butterfly|rabbit|zebra|leopard|tiger|swan|bird|horse|owl|fish|deer|monkey|flamingo|camel|lion/i, 'Animal motif'],
  [/floral|flower|lotus|rose|magnolia|palm|leaf|petal/i, 'Floral']];
function demoTags(c) {
  const name = `${c.product} ${c.variant || ''}`;
  const tags = [FURNITURE.test(c.type) ? 'Furniture' : 'Decor'];
  for (const [re, tag] of TAG_RULES) if (re.test(name)) tags.push(tag);
  if (GIFTING.test(c.type) || /gift|incense|diya|lantern/i.test(name)) tags.push('Diwali gifting');
  if (c.price < 3000) tags.push('Under 3000');
  if (c.price >= 8000) tags.push('Premium');
  return tags;
}
const COLLECTIONS = [
  ['All products', () => true],
  ['Furniture', (c, tags) => tags.includes('Furniture')],
  ['Home décor', (c, tags) => tags.includes('Decor')],
  ['Tables', (c) => /table$|console/i.test(c.type)],
  ['Candles & lighting', (c) => /candle|hurricane|lamp/i.test(c.type)],
  ['Serveware', (c) => /platter|tray|bar set/i.test(c.type)],
  ['Diwali gifting', (c, tags) => tags.includes('Diwali gifting')],
  ['Gifts under ₹3,000', (c, tags) => tags.includes('Under 3000') && !tags.includes('Furniture')],
  ['The gold edit', (c, tags) => tags.includes('Gold')],
  ['New arrivals', (c, tags, n) => n % 9 === 4],
];
let demoCatalog = null;
function catalog() {
  if (demoCatalog) return demoCatalog;
  const pid = new Map(); const variants = {}; const members = COLLECTIONS.map(() => new Set());
  CATALOG.forEach((c, i) => {
    if (!pid.has(c.product)) pid.set(c.product, String(8120000000 + pid.size * 13));
    const productId = pid.get(c.product); const tags = demoTags(c);
    variants[variantId(i)] = { productId, product: c.product, type: c.type, tags };
    COLLECTIONS.forEach(([, rule], k) => { if (rule(c, tags, pid.size - 1)) members[k].add(productId); });
  });
  const collections = Object.fromEntries(COLLECTIONS.map(([title], k) => [String(298400000 + k * 7), { title, productIds: [...members[k]] }]));
  demoCatalog = { variants, collections, variantsAt: null, collectionsAt: null, demo: true };
  return demoCatalog;
}

module.exports = { generate, catalog, VERSION, STORE_NAME, STORES, SUPPLIERS, vendorOf };
