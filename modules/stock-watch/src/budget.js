'use strict';
/*
 * Cash budget cut line (SW-041, LOGIC.md §6d). Pure functions, no I/O: tested in test/budget.test.js.
 *   annotate(report)  adds to every reorder row: protect (₹ profit an order keeps), perRupee (protect ÷ order cost),
 *                     protectEst (true when the margin is the store's average, not the product's own cost)
 *   cut(rows, budget) ranks rows by perRupee and draws one line: the rows above it fit the budget, the rest don't
 *   parse(x)          a budget from the page or ?budget= (blank, 0 or junk = no budget = today's behaviour)
 * public/money.js mirrors cut() for the page; the PO CSV (?budget=) uses this one, so both cut at the same row.
 */

const MAX_BUDGET = 1e12;

/** ₹ budget or null (off). Commas, spaces and a leading ₹ are ignored. */
function parse(x) {
  if (x == null) return null;
  const n = Number(String(x).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) && n > 0 && n <= MAX_BUDGET ? Math.round(n) : null;
}

/**
 * profit kept by ordering = units you'd fail to sell over lead time + cover without the order × margin per unit
 *   units short = min(order qty, max(0, sales/day × (lead + cover) − stock now − units on order that count))
 *   margin per unit = average price paid − unit cost; unknown cost → price × the store's average margin %
 *   (products with a cost); no product has a cost → price (then it ranks ₹ sales kept per ₹, protectEst true)
 * perRupee = protect ÷ order cost (2 decimals). Rows with nothing to order get protect 0, perRupee null.
 */
function annotate(r) {
  const S = r.settings || {};
  const costed = (r.products || []).filter((p) => p.cost > 0 && p.price > 0);
  const avgPct = costed.length ? costed.reduce((s, p) => s + Math.max(0, p.price - p.cost) / p.price, 0) / costed.length : 1;
  for (const p of r.reorder || []) {
    if (!(p.orderQty > 0) || !(p.orderValue > 0)) { p.protect = 0; p.perRupee = null; continue; }
    const lead = +(p.leadDays ?? S.leadDays) || 0, cover = +S.coverDays || 0;
    const coming = p.onOrder && p.onOrder.counts ? +p.onOrder.remaining || 0 : 0;
    const short = Math.min(p.orderQty, Math.max(0, (+p.perDay || 0) * (lead + cover) - Math.max(0, +p.stock || 0) - coming));
    const est = !(p.cost > 0);
    const unit = est ? (+p.price || 0) * avgPct : Math.max(0, (+p.price || 0) - p.cost);
    p.protect = Math.round(short * unit);
    p.perRupee = Math.round((p.protect / p.orderValue) * 100) / 100;
    p.protectEst = est;
  }
  return r;
}

/** Highest profit kept per ₹ first; ties: more profit kept, then the existing order (stable). Rows with nothing to order last. */
function rank(rows) {
  return rows.map((p, i) => [p, i]).sort(([a, i], [b, j]) => {
    const x = a.perRupee == null ? -1 : a.perRupee, y = b.perRupee == null ? -1 : b.perRupee;
    return y - x || (b.protect || 0) - (a.protect || 0) || i - j;
  }).map(([p]) => p);
}

/**
 * One cut line: walk the ranked rows adding order cost; the first row that would go over the budget and every row
 * after it are over budget (a clear line, never "skip the big one, take a smaller one below": the page reads top-down).
 * Returns { rows (ranked), fit: Set of ids, spent, protect, over (count), overValue }. Rows with nothing to order are
 * in neither group.
 */
function cut(rows, budget) {
  const ranked = rank(rows), fit = new Set();
  let spent = 0, protect = 0, over = 0, overValue = 0, open = true;
  for (const p of ranked) {
    if (!(p.orderQty > 0) || !(p.orderValue > 0)) continue;
    if (open && spent + p.orderValue <= budget) { fit.add(String(p.id)); spent += p.orderValue; protect += p.protect || 0; continue; }
    open = false; over++; overValue += p.orderValue;
  }
  return { rows: ranked, fit, spent, protect, over, overValue };
}

module.exports = { parse, annotate, rank, cut, MAX_BUDGET };
