'use strict';
/*
 * Periods (SW-027): "This month" in the period picker, and the Yesterday strip on the Overview.
 * Pure functions, no I/O. Rules: LOGIC.md §5a.
 */
const { report, dayKey, DAY } = require('./engine');

/** Start of the local calendar month that `now` falls in, as a UTC timestamp. offMin = store time zone (India = 330). */
function monthStart(now, offMin) {
  const d = new Date(now + offMin * 60e3);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - offMin * 60e3;
}
/** Start of the local calendar day that `t` falls in, as a UTC timestamp. */
function dayStart(t, offMin) {
  const off = offMin * 60e3;
  return Math.floor((t + off) / DAY) * DAY - off;
}

/**
 * What the `days` query value asks for: a number of days (7, 14, 30, 60; 30 when missing), or
 * "month" = from the 1st of this month (store time) until now. Returns engine options.
 */
function range(daysParam, now, offMin) {
  if (String(daysParam) === 'month') return { period: 'month', from: monthStart(now, offMin) };
  return { period: 'days', days: Number(daysParam) || 30 };
}

/** Rows as they stood at time t (for "the 7 days before" comparisons): nothing recorded after t. */
function asOf(stock, orders, t) {
  return { stock: stock.filter((r) => r.t <= t), orders: orders.filter((o) => o.t <= t) };
}

/**
 * Yesterday, from a report that covers it: ₹ sold and lost on yesterday's local calendar day (the same
 * numbers as that day's bar on the Overview chart), how many products ran out (a stock-out started) and
 * how many came back (a stock-out ended). A product counts once even if it ran out twice.
 * Returns null when the report doesn't reach back to the start of yesterday.
 */
function yesterday(r, offMin) {
  const now = r.generatedAt;
  const end = dayStart(now, offMin), start = end - DAY;
  if (r.from > start) return null;
  const key = dayKey(start, offMin);
  const d = r.daily.find((x) => x.day === key) || { sold: 0, lost: 0 };
  const ranOut = new Set(), back = new Set();
  for (const s of r.stockouts) {
    if (s.start >= start && s.start < end) ranOut.add(s.id);
    if (!s.open && s.end >= start && s.end < end) back.add(s.id);
  }
  return { day: key, sold: d.sold, lost: d.lost, ranOut: ranOut.size, back: back.size };
}

/** Yesterday for any report: uses it when it covers yesterday, else works out a 2-day report.
 *  The page's own period (from / days) is dropped from `extra`: `from` would override days: 2 (engine) and
 *  bring back the same window that didn't reach yesterday (This month on the 1st). */
function yesterdayFor(stock, orders, settings, r, extra = {}) {
  const off = r.settings.tzOffsetMin;
  const { from, days, period, ...rest } = extra;
  return yesterday(r, off) || yesterday(report(stock, orders, settings, { ...rest, now: r.generatedAt, days: 2 }), off);
}

module.exports = { monthStart, dayStart, range, asOf, yesterday, yesterdayFor };
