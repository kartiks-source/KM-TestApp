'use strict';
/*
 * Stock-out engine. Pure functions, no I/O.
 *
 * Inputs (normalised rows):
 *   stock  { t, variantId, sku, product, variant, before, now, price }   one row per stock change
 *   orders { t, order, variantId, sku, qty, price }                      one row per order line
 *
 * Output: report() → totals, daily sold vs lost, reorder list, every stock-out, per-product summary.
 */

const HOUR = 36e5;
const DAY = 864e5;

const num = (x) => (Number.isFinite(+x) ? +x : 0);
const round = (x, d = 0) => { const p = 10 ** d; return Math.round(x * p) / p; };

/** Local calendar day (YYYY-MM-DD) for a UTC ms timestamp, at a fixed offset in minutes (India = 330). */
function dayKey(t, offMin) { return new Date(t + offMin * 60e3).toISOString().slice(0, 10); }
function localHour(t, offMin) { return new Date(t + offMin * 60e3).getUTCHours(); }
/** Start of the local hour after t, as a UTC timestamp. */
function nextLocalHour(t, offMin) { const off = offMin * 60e3; return Math.floor((t + off) / HOUR) * HOUR + HOUR - off; }

/**
 * How sales spread over the day: 24 weights with mean 1, from the order lines (plus one per hour
 * so quiet hours never count as zero). A stock-out at 2 pm costs more than one at 4 am.
 */
function hourProfile(orders, offMin) {
  const b = new Array(24).fill(1);
  for (const o of orders) b[localHour(o.t, offMin)] += num(o.qty);
  const mean = b.reduce((a, x) => a + x, 0) / 24;
  return b.map((x) => x / mean);
}

/** Selling hours in [a, b): clock hours weighted by the profile. Also returns the split by local day. */
function sellingHours(a, b, profile, offMin) {
  let total = 0; const byDay = {};
  for (let t = a; t < b;) {
    const next = Math.min(b, nextLocalHour(t, offMin));
    const w = ((next - t) / HOUR) * profile[localHour(t, offMin)];
    total += w; const k = dayKey(t, offMin); byDay[k] = (byDay[k] || 0) + w;
    t = next;
  }
  return { total, byDay };
}

/**
 * Stock-out episodes from one product's stock changes (oldest first).
 * Out when stock drops to 0 or below; back when it rises above 0. One still open ends at `now`.
 * topUp = stock right after it came back.
 */
function episodes(changes, now) {
  const out = []; let open = null;
  for (const c of changes) {
    const was = num(c.before), is = num(c.now);
    if (!open && is <= 0 && (was > 0 || out.length === 0)) open = { start: c.t };
    else if (open && is > 0) { out.push({ start: open.start, end: c.t, topUp: is, open: false }); open = null; }
  }
  if (open) out.push({ start: open.start, end: now, topUp: 0, open: true });
  return out;
}

const overlap = (a, b, from, to) => Math.max(0, Math.min(b, to) - Math.max(a, from));

/** Sales per day while the product could be bought: units ÷ in-stock days (at least one day). */
function demandPerDay(units, from, to, eps) {
  const outMs = eps.reduce((s, e) => s + overlap(e.start, e.end, from, to), 0);
  const days = Math.max(1, (to - from - outMs) / DAY);
  return { perDay: units / days, inStockDays: days };
}

/**
 * Trend, measured on demand rather than raw sales so a stock-out doesn't look like a slump.
 *   weeks: the last 8 rolling 7-day blocks ending now (oldest first): units sold and days out of stock.
 *   trendPct: sales per in-stock day in the last 14 days vs the 14 days before. null when there's
 *   too little to say (fewer than 6 units over those 28 days, or under 3 in-stock days in either half).
 *   since: when this product's data starts. Time before it is "no data", never "in stock, sold 0".
 *   trendNew: it was in stock for at least 7 of the earlier days and sold nothing, and has sold 3+ since.
 *   rateDelta: recent rate − earlier rate (units per in-stock day), when trendPct or trendNew is set.
 */
const TREND_MIN_UNITS = 6;
function trend(lines, eps, now, since = -Infinity) {
  const weeks = [];
  for (let w = 7; w >= 0; w--) {
    const a = now - (w + 1) * 7 * DAY, b = now - w * 7 * DAY;
    if (b <= since) { weeks.push({ units: null, outDays: 0 }); continue; }
    const units = lines.reduce((s, o) => s + (o.t >= a && o.t < b ? num(o.qty) : 0), 0);
    const out = eps.reduce((s, e) => s + overlap(e.start, e.end, Math.max(a, since), b), 0);
    weeks.push({ units, outDays: round(out / DAY, 1) });
  }
  const half = (a0, b) => {
    const a = Math.max(a0, since);
    if (b <= a) return { units: 0, inDays: 0, rate: 0 };
    const units = lines.reduce((s, o) => s + (o.t >= a && o.t < b ? num(o.qty) : 0), 0);
    const inDays = (b - a - eps.reduce((s, e) => s + overlap(e.start, e.end, a, b), 0)) / DAY;
    return { units, inDays, rate: inDays > 0 ? units / inDays : 0 };
  };
  const recent = half(now - 14 * DAY, now), before = half(now - 28 * DAY, now - 14 * DAY);
  let trendPct = null;
  if (recent.units + before.units >= TREND_MIN_UNITS && recent.inDays >= 3 && before.inDays >= 3 && before.rate > 0) {
    trendPct = round(((recent.rate - before.rate) / before.rate) * 100, 1);
  }
  const trendNew = before.inDays >= 7 && before.units === 0 && recent.units >= 3;
  /* rateDelta: change in sales per in-stock day behind the % (null when there's no trend to call) */
  const rateDelta = trendPct != null || trendNew ? round(recent.rate - before.rate, 3) : null;
  return { weeks, trendPct, trendNew, rateDelta };
}

/** The baseline to read a product's trend against: the median trend of all products that have one.
 *  Same measure (sales per in-stock day), so store-wide stock-outs don't drag it down. */
function storeTrend(products) {
  const v = products.map((p) => p.trendPct).filter((x) => x != null).sort((a, b) => a - b);
  if (v.length < 5) return null;
  const m = Math.floor(v.length / 2);
  return round(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2, 1);
}

const STATUS = ['Out now', 'Critical', 'Order now', 'Order this week', 'Ordered', 'OK'];
/** Reorder status and quantity for one product. */
function plan({ stock, perDay, lead, cover, safety }) {
  const have = Math.max(0, stock);
  const daysLeft = perDay > 0 ? have / perDay : Infinity;
  const status = stock <= 0 ? 'Out now'
    : daysLeft <= 3 ? 'Critical'
      : daysLeft <= lead + safety ? 'Order now'
        : daysLeft <= lead + safety + 7 ? 'Order this week' : 'OK';
  const qty = Math.max(0, Math.ceil(perDay * (lead + cover + safety) - have));
  return { daysLeft, status, qty };
}

/**
 * A purchase order already placed ("Mark ordered", LOGIC.md §6b). rec = { qty, eta, at, by }.
 * Units received = stock increases recorded after `at`; still to come = qty − received (done at 90% received).
 * It counts toward the plan while it's due (eta not past) and lands before the shelf empties,
 * or no later than an order placed today could (now + lead time), a day's grace either way since dates are whole
 * days. Past eta with units still to come = late.
 */
function onOrderNow(rec, changes, now, stock, perDay, lead) {
  if (!rec || !(num(rec.qty) > 0)) return null;
  const received = changes.reduce((s, c) => s + (c.t > num(rec.at) ? Math.max(0, num(c.now) - num(c.before)) : 0), 0);
  const remaining = Math.max(0, Math.round(num(rec.qty) - received));
  if (received >= 0.9 * num(rec.qty)) return null;   // received (a short shipment of up to 10% counts as complete)
  const eta = num(rec.eta), late = eta < now;
  const outAt = perDay > 0 ? now + (Math.max(0, stock) / perDay) * DAY : Infinity;
  const counts = !late && eta <= Math.max(outAt, now + lead * DAY) + DAY;   // + 1 day: dates are whole days
  return { qty: num(rec.qty), remaining, eta, at: num(rec.at) || null, by: rec.by || null, late, counts };
}
/** plan() with an on-order record: units that count are added to stock; if that covers the need, status is "Ordered". */
function planWithOrder(args, oo) {
  const base = plan(args);
  if (!oo || !oo.counts) return base;
  const withPo = plan({ ...args, stock: Math.max(0, args.stock) + oo.remaining });
  return { daysLeft: base.daysLeft, status: withPo.status === 'OK' ? 'Ordered' : withPo.status, qty: withPo.qty };
}

const DEFAULT_SETTINGS = {
  storeName: 'Demo Store',
  tzOffsetMin: 330,          // India
  leadDays: 7,               // supplier order → sellable
  coverDays: 30,             // a reorder should last this long
  safetyDays: 3,
  demandWindowDays: 28,
  smallTopUpDays: 7,         // a top-up under this many days of sales is "small"
  minPerDay: 0.2,            // slower sellers are left out of alerts
};

/**
 * The whole report.
 * opts.days = range shown (7–90), opts.now = "now" (ms), opts.onOrder = { variantId: { qty, eta, at, by } } (§6b).
 */
function report(stock, orders, settings = {}, opts = {}) {
  const S = { ...DEFAULT_SETTINGS, ...settings };
  const now = opts.now || Date.now();
  const days = Math.max(1, Math.min(90, Math.round(opts.days || 30)));
  const from = now - days * DAY;
  const off = S.tzOffsetMin;
  const profile = hourProfile(orders.filter((o) => o.t >= now - 60 * DAY), off);

  /* group by product (variant) */
  const P = new Map();
  const get = (id) => {
    if (!P.has(id)) P.set(id, { id, sku: '', product: '', variant: '', price: 0, changes: [], lines: [], stock: null });
    return P.get(id);
  };
  const stockSorted = stock.slice().sort((a, b) => a.t - b.t);
  for (const r of stockSorted) {
    const p = get(String(r.variantId));
    p.sku = r.sku || p.sku; p.product = r.product || p.product; p.variant = r.variant || p.variant; p.type = r.type || p.type || '';
    if (num(r.cost)) p.cost = num(r.cost);
    if (num(r.price)) p.price = num(r.price);
    p.changes.push(r); p.stock = num(r.now);
  }
  for (const o of orders) {
    const p = get(String(o.variantId));
    p.sku = p.sku || o.sku || '';
    p.lines.push(o);
  }

  const firstOrder = orders.length ? Math.min(...orders.map((o) => o.t)) : now;
  const demandFrom = Math.max(now - S.demandWindowDays * DAY, firstOrder);
  /* a product's data starts at its first stock record or first order; before that it didn't exist for us */
  for (const p of P.values()) p.first = Math.min(p.changes.length ? p.changes[0].t : Infinity, ...p.lines.map((o) => o.t));

  /* one bucket per local day touched by the period, the partial first day included, so the daily
     chart adds up to the same totals as the product rows */
  const daily = {};
  const lastKey = dayKey(now, off);
  for (let t = from; ; t += DAY) { const k = dayKey(Math.min(t, now), off); daily[k] = daily[k] || { sold: 0, lost: 0, units: 0, unitsLost: 0, outSkus: new Set() }; if (k === lastKey || t >= now) break; }
  for (const o of orders) {
    if (o.t < from) continue;
    const d = daily[dayKey(o.t, off)]; if (!d) continue;
    d.sold += num(o.qty) * num(o.price); d.units += num(o.qty);
  }

  const products = [], reorder = [], stockouts = [];
  for (const p of P.values()) {
    const name = [p.product, p.variant && p.variant !== 'Default Title' ? p.variant : ''].filter(Boolean).join(' · ') || p.sku || p.id;
    const eps = episodes(p.changes, now);
    const pFrom = Math.max(demandFrom, Number.isFinite(p.first) ? p.first : demandFrom);   // a new launch isn't diluted by days before it existed
    const recent = p.lines.filter((o) => o.t >= pFrom);
    const units = recent.reduce((s, o) => s + num(o.qty), 0);
    const revenue = recent.reduce((s, o) => s + num(o.qty) * num(o.price), 0);
    const price = units ? revenue / units : p.price;
    const { perDay } = demandPerDay(units, pFrom, now, eps);
    const perSellingHour = perDay / 24;

    let lost = 0, unitsLost = 0, outs = 0, smallTopUps = 0, repeats = 0;
    eps.forEach((e, i) => {
      if (e.end <= from) return;
      const a = Math.max(e.start, from);
      const h = sellingHours(a, e.end, profile, off);
      const uLost = h.total * perSellingHour;
      const vLost = uLost * price;
      lost += vLost; unitsLost += uLost; outs++;
      for (const [k, w] of Object.entries(h.byDay)) {
        const d = daily[k]; if (!d) continue;
        d.lost += w * perSellingHour * price; d.unitsLost += w * perSellingHour; d.outSkus.add(p.id);
      }
      const small = !e.open && perDay > 0 && e.topUp < perDay * S.smallTopUpDays;
      const next = eps[i + 1];
      const repeat = !!next && next.start - e.end < 7 * DAY;
      if (small) smallTopUps++;
      if (repeat) repeats++;
      stockouts.push({
        id: p.id, name, sku: p.sku, start: e.start, end: e.open ? null : e.end, open: e.open,
        hours: round((e.end - e.start) / HOUR, 1), hoursInPeriod: round((e.end - a) / HOUR, 1), unitsLost: round(uLost, 1), lost: Math.round(vLost),
        topUp: e.open ? null : e.topUp, topUpDays: !e.open && perDay > 0 ? round(e.topUp / perDay, 1) : null,
        small, repeat, perDay: round(perDay, 2),
      });
    });

    const oo = p.stock == null ? null : onOrderNow((opts.onOrder || {})[p.id], p.changes, now, p.stock, perDay, S.leadDays);
    const pl = p.stock == null ? null : planWithOrder({ stock: p.stock, perDay, lead: S.leadDays, cover: S.coverDays, safety: S.safetyDays }, oo);
    const selling = perDay > 0 && perDay >= S.minPerDay;
    const row = {
      id: p.id, name, sku: p.sku, stock: p.stock, perDay: round(perDay, 2), price: Math.round(price),
      daysLeft: pl && Number.isFinite(pl.daysLeft) ? round(pl.daysLeft, 1) : null,
      status: pl ? (selling ? pl.status : 'Slow seller') : 'No stock data',
      orderQty: pl && selling ? pl.qty : 0, orderValue: pl && selling ? Math.round(pl.qty * (p.cost || price)) : 0,   // cash to commit: unit cost when known
      lost: Math.round(lost), unitsLost: round(unitsLost, 1), outs, smallTopUps, repeats,
      sold: Math.round(p.lines.filter((o) => o.t >= from).reduce((s, o) => s + num(o.qty) * num(o.price), 0)),
      unitsSold: p.lines.filter((o) => o.t >= from).reduce((s, o) => s + num(o.qty), 0),
      type: p.type || '', onOrder: oo,
    };
    Object.defineProperty(row, '_plan', { value: { pl, perDay, unitValue: p.cost || price }, enumerable: false });
    row.lostPct = row.sold + row.lost ? round((row.lost / (row.sold + row.lost)) * 100, 1) : 0;
    /* profit: needs a unit cost (Shopify's inventory item cost, or a cost column) */
    row.cost = p.cost ? Math.round(p.cost) : null;
    row.margin = p.cost && price ? round(((price - p.cost) / price) * 100, 1) : null;
    row.lostProfit = p.cost ? Math.round(unitsLost * Math.max(0, price - p.cost)) : null;
    /* excess stock: pieces beyond what the next lead + cover + safety days need; "overstocked" when
       stock covers more than twice that, or the product hasn't sold at all */
    const need = perDay * (S.leadDays + S.coverDays + S.safetyDays);
    const have = p.stock > 0 ? p.stock : 0;
    row.excessUnits = Math.max(0, Math.floor(have - need));
    row.excessValue = Math.round(row.excessUnits * (p.cost || price || 0));
    row.overstock = have > 0 && (perDay === 0 || have > 2 * need);
    Object.assign(row, trend(p.lines, eps, now, p.first));
    /* ₹ effect of the trend (Overview "Moving"): the change in daily rate × average price × 30 = ₹ a month at the new pace */
    row.trendValue = row.rateDelta == null ? null : Math.round(row.rateDelta * price * 30);
    products.push(row);
    if (pl && selling && row.status !== 'OK') reorder.push(row);
  }

  /* best sellers (ABC by revenue in the period): A = the products making the first 80% of sales,
     B = the next 15%, C = the rest and anything that didn't sell */
  const bySold = products.slice().sort((a, b) => b.sold - a.sold);
  const allSold = bySold.reduce((s, p) => s + p.sold, 0);
  let run = 0;
  for (const p of bySold) {
    const before = allSold ? run / allSold : 1; run += p.sold;
    p.abc = !p.sold ? 'C' : before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C';
  }
  /* a best seller is never "slow": it earns its place by ₹ even when it sells few units (e.g. furniture) */
  for (const p of products) {
    const { pl, perDay, unitValue } = p._plan;
    if (p.abc === 'A' && p.status === 'Slow seller' && pl && perDay > 0) {
      p.status = pl.status; p.orderQty = pl.qty; p.orderValue = Math.round(pl.qty * unitValue);
      if (p.status !== 'OK') reorder.push(p);
    }
  }

  /* an order quantity only where an order is due (Order today / This week); "OK" never asks you to order */
  for (const p of products) if (!['Out now', 'Critical', 'Order now', 'Order this week'].includes(p.status)) { p.orderQty = 0; p.orderValue = 0; }

  const rank = (s) => STATUS.indexOf(s);
  reorder.sort((a, b) => rank(a.status) - rank(b.status) || (a.abc || 'C').localeCompare(b.abc || 'C') || b.lost - a.lost || b.perDay - a.perDay);
  stockouts.sort((a, b) => b.lost - a.lost);
  products.sort((a, b) => b.lost - a.lost || b.sold - a.sold);

  const dailyRows = Object.entries(daily).map(([day, d]) => ({
    day, sold: Math.round(d.sold), lost: Math.round(d.lost), units: d.units, unitsLost: round(d.unitsLost, 1), outSkus: d.outSkus.size,
  }));
  /* totals come from the product rows, so they always equal what the Products page adds up to */
  const sold = products.reduce((s, p) => s + p.sold, 0);
  const lost = products.reduce((s, p) => s + p.lost, 0);

  return {
    generatedAt: now, days, from, settings: S,
    totals: {
      sold, lost, lostPct: sold + lost ? round((lost / (sold + lost)) * 100, 1) : 0,
      unitsLost: round(dailyRows.reduce((s, d) => s + d.unitsLost, 0), 0),
      outNow: products.filter((p) => p.status === 'Out now' || (p.status === 'Ordered' && p.stock <= 0)).length,
      ordered: products.filter((p) => p.status === 'Ordered').length,
      orderNow: products.filter((p) => ['Critical', 'Order now'].includes(p.status)).length,
      orderToday: products.filter((p) => ['Out now', 'Critical', 'Order now'].includes(p.status)).length,
      stillOut: stockouts.filter((s) => s.open).length,
      orderWeek: products.filter((p) => p.status === 'Order this week').length,
      stockouts: stockouts.length,
      smallTopUps: stockouts.filter((s) => s.small).length,
      repeats: stockouts.filter((s) => s.repeat).length,
      products: products.length,
      lostProfit: products.some((p) => p.lostProfit != null) ? products.reduce((s, p) => s + (p.lostProfit || 0), 0) : null,
      hasCost: products.some((p) => p.cost != null),
      bestsellers: products.filter((p) => p.abc === 'A').length,
      bestAtRisk: products.filter((p) => p.abc === 'A' && ['Out now', 'Critical', 'Order now'].includes(p.status)).length,
      orderValueNow: reorder.filter((p) => ['Out now', 'Critical', 'Order now'].includes(p.status)).reduce((s, p) => s + p.orderValue, 0),
      orderValueAll: reorder.reduce((s, p) => s + p.orderValue, 0),
      overstocked: products.filter((p) => p.overstock).length,
      excessValue: products.filter((p) => p.overstock).reduce((s, p) => s + p.excessValue, 0),
      storeTrendPct: storeTrend(products),
      costed: products.filter((p) => p.cost != null && (p.sold || p.lost)).length,
      active: products.filter((p) => p.sold || p.lost).length,
    },
    daily: dailyRows, reorder, stockouts, products,
    data: {
      stockRows: stock.length, orderRows: orders.length,
      firstStock: stock.length ? Math.min(...stock.map((r) => r.t)) : null,
      lastStock: stock.length ? Math.max(...stock.map((r) => r.t)) : null,
      firstOrder: orders.length ? firstOrder : null,
      lastOrder: orders.length ? Math.max(...orders.map((o) => o.t)) : null,
    },
  };
}

/** One product: stock over time, daily units, its stock-outs. */
function productDetail(id, stock, orders, settings = {}, opts = {}) {
  const S = { ...DEFAULT_SETTINGS, ...settings };
  const now = opts.now || Date.now();
  const days = Math.max(1, Math.min(90, Math.round(opts.days || 30)));
  const from = now - days * DAY;
  const changes = stock.filter((r) => String(r.variantId) === String(id)).sort((a, b) => a.t - b.t);
  const lines = orders.filter((o) => String(o.variantId) === String(id));
  const before = changes.filter((c) => c.t < from).pop();
  const timeline = [];
  if (before) timeline.push({ t: from, stock: num(before.now) });
  for (const c of changes) if (c.t >= from) timeline.push({ t: c.t, stock: num(c.now) });
  if (timeline.length) timeline.push({ t: now, stock: timeline[timeline.length - 1].stock });
  const units = {};
  for (let t = now - (days - 1) * DAY; t <= now; t += DAY) units[dayKey(t, S.tzOffsetMin)] = 0;
  for (const o of lines) if (o.t >= from) { const k = dayKey(o.t, S.tzOffsetMin); if (k in units) units[k] += num(o.qty); }
  /* same numbers as the main report (the store-wide hourly pattern), this product only */
  const r = report(stock, orders, S, { now, days, onOrder: opts.onOrder });
  return { id, product: r.products.find((p) => String(p.id) === String(id)) || null, timeline,
    dailyUnits: Object.entries(units).map(([day, u]) => ({ day, units: u })),
    stockouts: r.stockouts.filter((s) => String(s.id) === String(id)).sort((a, b) => a.start - b.start) };
}

module.exports = {
  trend, TREND_MIN_UNITS, report, productDetail, episodes, demandPerDay, plan, onOrderNow, hourProfile, sellingHours, dayKey, DEFAULT_SETTINGS, HOUR, DAY };
