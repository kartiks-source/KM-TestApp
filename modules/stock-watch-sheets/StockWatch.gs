/**
 * Stock Watch — the no-keys version of Inventory Intelligence.
 *
 * Reorder bestsellers before they run out, and show in ₹ what every stock-out cost.
 * The store's own Shopify Flow writes two logs into this sheet; this script only reads the
 * sheet. It never talks to Shopify, so there is no app to install and no API key anywhere.
 *
 *   Flow 1 "Product variant inventory quantity changed" → Add row to tab  Stock log
 *   Flow 2 "Order created" → For each line item       → Add row to tab  Order log
 *   (exact Flow setup: SETUP.md in this folder)
 *
 * Tabs it writes:  🚨 Reorder now · 💸 Lost sales · 📅 Daily ·  (⚙️ Settings is yours to edit)
 * Menu: 📦 Stock Watch → Set up (once) · Refresh now.  Refreshes itself every 15 minutes.
 */

const TABS = { STOCK: 'Stock log', ORDERS: 'Order log', REORDER: '🚨 Reorder now', LOST: '💸 Lost sales', DAILY: '📅 Daily', SET: '⚙️ Settings' };
const STOCK_HEAD = ['Time', 'Variant ID', 'SKU', 'Product', 'Variant', 'Stock before', 'Stock now', 'Price'];
const ORDER_HEAD = ['Time', 'Order', 'Variant ID', 'SKU', 'Qty', 'Unit price'];
const DEFAULTS = [
  ['Lead time (days)', 7, 'Days from placing a supplier order to stock being sellable'],
  ['Cover after reorder (days)', 30, 'How many days of sales a reorder should last'],
  ['Safety stock (days)', 3, 'Extra days of stock kept for bad days'],
  ['Demand window (days)', 28, 'Sales history used for the daily rate'],
  ['Small top-up (days of sales)', 7, 'A top-up smaller than this many days of sales is flagged'],
  ['Ignore below (units/day)', 0.2, 'Slower sellers are left out of alerts'],
  ['Daily email to', '', 'Optional: comma-separated emails for a 9 am summary'],
];

/* ============================== PURE LOGIC ==============================
 * No Apps Script calls, so it can be tested: modules/stock-watch/test/parity.test.js loads this file
 * and runs the same data through SW.compute() and the web app's engine.js. Mirror any rule change there. */
const SW = (() => {
  const HOUR = 36e5, DAY = 864e5;
  const num = (x) => (Number.isFinite(+x) ? +x : 0);
  const vid = (x) => String(x || '').replace(/\D/g, '');
  /** Stock-out episodes from one variant's stock changes (sorted by time). An episode starts when stock
   * drops to 0 or below and ends when it rises above 0; one still open ends "now". A blank "Stock before" is
   * read as the previous row's "Stock now", never as 0 (as the web app). */
  function episodes(changes, now) {
    const out = []; let open = null;
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i], gap = c.before == null || String(c.before).trim() === '';
      const was = gap && i > 0 ? num(changes[i - 1].now) : num(c.before), is = num(c.now);
      if (!open && is <= 0 && (was > 0 || !out.length)) open = { start: c.t };
      else if (open && is > 0) { out.push({ start: open.start, end: c.t, topUp: is, open: false }); open = null; }
    }
    if (open) out.push({ start: open.start, end: now, topUp: 0, open: true });
    return out;
  }
  /** Hours of [a,b) inside [from,to). */
  const overlap = (a, b, from, to) => Math.max(0, Math.min(b, to) - Math.max(a, from));
  /** Daily rate = units sold ÷ days the product could be bought (stock-out time removed, at least 1 day). */
  function rate(units, from, now, eps) {
    const outMs = eps.reduce((s, e) => s + overlap(e.start, e.end, from, now), 0);
    const days = Math.max(1, (now - from - outMs) / DAY);
    return units / days;
  }
  const inStockDays = (from, to, eps) => Math.max(0, (to - from - eps.reduce((s, e) => s + overlap(e.start, e.end, from, to), 0)) / DAY);
  const KEEP_DAYS = 120, MIN_IN_STOCK_DAYS = 7;   // same as the web app (engine.js)
  /** Earliest t ≥ histFrom such that [t, to) holds `wantMs` of in-stock time (eps oldest first); histFrom when there isn't that much. */
  function inStockStart(eps, histFrom, to, wantMs) {
    let need = wantMs, t = to;
    for (let i = eps.length - 1; i >= -1 && t > histFrom; i--) {
      const e = eps[i];
      const gapFrom = Math.max(histFrom, e ? e.end : -Infinity);
      if (gapFrom < t) { if (t - gapFrom >= need) return t - need; need -= t - gapFrom; }
      t = e ? Math.min(t, e.start) : histFrom;
    }
    return histFrom;
  }
  /** The rate a product's numbers rest on, as the web app (its LOGIC.md §3): the window; under 7 in-stock days
   * there (a long stock-out), the latest `wantDays` in-stock days within the last 120 days; never in stock in
   * that history, the `wantDays` before the stock-out began. Returns { perDay, units, revenue, basis }. */
  function demandRate(lines, eps, o) {
    const measure = (a, b, hi) => {
      let units = 0, revenue = 0;
      for (const l of lines) if (l.t >= a && l.t < (hi == null ? Infinity : hi)) { units += l.qty; revenue += l.qty * l.price; }
      return { perDay: rate(units, a, b, eps), units, revenue, raw: inStockDays(a, b, eps) };
    };
    const win = measure(o.winFrom, o.now);
    if (win.raw >= MIN_IN_STOCK_DAYS || o.histFrom >= o.winFrom) return Object.assign(win, { basis: 'window' });
    const hist = measure(inStockStart(eps, o.histFrom, o.now, o.wantDays * DAY), o.now);
    if (hist.raw > 0) return Object.assign(hist, { basis: 'history' });
    const cur = eps[eps.length - 1];
    if (cur) {
      const a = Math.max(cur.start - o.wantDays * DAY, o.first);
      if (a < cur.start) { const pre = measure(a, cur.start, cur.start); if (pre.raw > 0) return Object.assign(pre, { basis: 'before-out' }); }
    }
    return Object.assign(win, { basis: 'window' });
  }
  /** Reorder status and quantity. */
  function plan({ stock, perDay, lead, cover, safety }) {
    const daysLeft = perDay > 0 ? Math.max(0, stock) / perDay : Infinity;
    const status = stock <= 0 ? 'Out now' : daysLeft <= 3 ? 'Critical' : daysLeft <= lead + safety ? 'Order now' : daysLeft <= lead + safety + 7 ? 'Order this week' : 'OK';
    const qty = Math.max(0, Math.ceil(perDay * (lead + cover + safety) - Math.max(0, stock)));
    return { daysLeft, status, qty };
  }
  /** Split an episode's lost value across calendar days (keys from dayKey), counting only time after `from`. */
  function lostByDay(e, lostPerHour, dayKey, from) {
    const m = {};
    for (let t = Math.max(e.start, from); t < e.end; t += HOUR) {      // hour by hour (±1 h at day edges)
      const k = dayKey(t); m[k] = (m[k] || 0) + (Math.min(HOUR, e.end - t) / HOUR) * lostPerHour;
    }
    return m;
  }
  const RANK = { 'Out now': 0, Critical: 1, 'Order now': 2, 'Order this week': 3 };
  /**
   * Everything the three tabs show, from the two logs.
   *   stock:  [time ms, variant ID, SKU, product, variant, stock before, stock now, price]
   *   orders: [time ms, order, variant ID, SKU, qty, unit price]
   *   cfg: settings_() · now: ms · dayKey: time → 'yyyy-MM-dd' in the sheet's time zone
   * ₹ lost counts only the part of each stock-out inside the last 30 days (max(start, now − 30 d)),
   * the same as the web app; "Hours out" still shows the whole stock-out.
   */
  function compute(stock, orders, cfg, now, dayKey) {
    const from = now - cfg.window * DAY, lostFrom = now - 30 * DAY;
    const V = {};   // variant id → info
    const v = (id) => (V[id] = V[id] || { id, sku: '', name: '', price: 0, changes: [], lines: [], stock: null, first: Infinity });
    stock.slice().sort((a, b) => a[0] - b[0]).forEach((r) => {
      const x = v(vid(r[1])); x.sku = String(r[2] || x.sku); x.name = [r[3], r[4] && r[4] !== 'Default Title' ? r[4] : ''].filter(Boolean).join(' · ') || x.name;
      x.price = +r[7] || x.price; x.changes.push({ t: r[0], before: r[5], now: r[6] }); x.stock = +r[6]; x.first = Math.min(x.first, r[0]);
    });
    let firstOrder = orders.length ? Infinity : now;
    for (const r of orders) if (r[0] < firstOrder) firstOrder = r[0];   // a loop, not Math.min(...): no limit on rows
    const salesByDay = {};
    orders.forEach((r) => {
      const qty = num(r[4]), price = num(r[5]);
      const x = v(vid(r[2])); x.first = Math.min(x.first, r[0]); x.sku = x.sku || String(r[3] || '');
      if (r[0] >= lostFrom) { const k = dayKey(r[0]); salesByDay[k] = (salesByDay[k] || 0) + qty * price; }
      x.lines.push({ t: r[0], qty, price });
    });
    const rateFrom = Math.max(from, firstOrder);
    const lostDay = {}, lost = [], reorder = [];
    Object.keys(V).forEach((id) => {
      const x = V[id];
      const eps = episodes(x.changes, now);
      /* a new launch is measured from its first record; a long stock-out looks further back (web LOGIC.md §3) */
      const dr = demandRate(x.lines, eps, { winFrom: Math.max(rateFrom, x.first), histFrom: Math.max(now - KEEP_DAYS * DAY, firstOrder, x.first), now, wantDays: cfg.window, first: x.first });
      const perDay = dr.perDay;
      const price = dr.units ? dr.revenue / dr.units : x.price;
      const lostPerHour = (perDay / 24) * price;
      let lost30 = 0, outs = 0;
      eps.forEach((e, i) => {
        if (e.end <= lostFrom) return;
        const hoursIn = overlap(e.start, e.end, lostFrom, now) / HOUR, value = hoursIn * lostPerHour;
        lost30 += value; outs++;
        const m = lostByDay(e, lostPerHour, dayKey, lostFrom); Object.keys(m).forEach((k) => (lostDay[k] = (lostDay[k] || 0) + m[k]));
        const small = !e.open && perDay > 0 && e.topUp < perDay * cfg.smallTopUp;
        const again = !!eps[i + 1] && eps[i + 1].start - e.end < 7 * DAY;
        lost.push({ id, name: x.name || x.sku, sku: x.sku, start: e.start, end: e.open ? null : e.end, hours: (e.end - e.start) / HOUR,
          unitsLost: hoursIn / 24 * perDay, lost: value, topUp: e.open ? null : e.topUp, small, again, perDay });
      });
      if (perDay < cfg.minRate || perDay <= 0 || x.stock == null) return;
      const p = plan({ stock: x.stock, perDay, lead: cfg.lead, cover: cfg.cover, safety: cfg.safety });
      if (p.status === 'OK') return;
      reorder.push({ id, status: p.status, name: x.name || x.sku, sku: x.sku, stock: x.stock, perDay, daysLeft: p.daysLeft, qty: p.qty, value: p.qty * price, lost: lost30, outs });
    });
    reorder.sort((a, b) => RANK[a.status] - RANK[b.status] || b.lost - a.lost || b.perDay - a.perDay);
    lost.sort((a, b) => b.lost - a.lost);
    const days = [], seen = {};   // newest first; the last row is the partial day the 30 days start in
    for (let t = now; t > lostFrom - DAY; t -= DAY) { const k = dayKey(Math.max(t, lostFrom)); if (seen[k]) continue; seen[k] = 1; days.push({ day: k, sold: salesByDay[k] || 0, lost: lostDay[k] || 0 }); }
    const sold = days.reduce((s, d) => s + d.sold, 0), lostAll = days.reduce((s, d) => s + d.lost, 0);
    return { reorder, lost, days, totals: { sold, lost: lostAll } };
  }
  return { episodes, rate, demandRate, inStockStart, plan, lostByDay, overlap, compute, HOUR, DAY };
})();
if (typeof module !== 'undefined') module.exports = { SW };

/* ============================== MENU / SETUP ============================== */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('📦 Stock Watch').addItem('Set up (once)', 'setup').addItem('Refresh now', 'refresh').addToUi();
}
function setup() {
  const ss = SpreadsheetApp.getActive();
  head_(ss, TABS.STOCK, STOCK_HEAD); head_(ss, TABS.ORDERS, ORDER_HEAD);
  const set = ss.getSheetByName(TABS.SET) || ss.insertSheet(TABS.SET);
  if (set.getLastRow() < 2) { set.getRange(1, 1, 1, 3).setValues([['Setting', 'Value', 'What it means']]).setFontWeight('bold'); set.getRange(2, 1, DEFAULTS.length, 3).setValues(DEFAULTS); set.autoResizeColumns(1, 3); }
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refresh').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('dailyEmail').timeBased().atHour(9).everyDays(1).create();
  refresh();
  SpreadsheetApp.getUi().alert('Stock Watch is set up. Now create the two Shopify Flows (see the guide). Tabs fill in as stock changes and orders come in.');
}
function head_(ss, name, head) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

/* ============================== READ ============================== */
function settings_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(TABS.SET); const v = {};
  (sh ? sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 2).getValues() : DEFAULTS).forEach((r) => { v[r[0]] = r[1]; });
  const n = (k, d) => (Number.isFinite(+v[k]) && v[k] !== '' ? +v[k] : d);
  return { lead: n('Lead time (days)', 7), cover: n('Cover after reorder (days)', 30), safety: n('Safety stock (days)', 3), window: n('Demand window (days)', 28),
    smallTopUp: n('Small top-up (days of sales)', 7), minRate: n('Ignore below (units/day)', 0.2), email: String(v['Daily email to'] || '').trim() };
}
/** Rows Flow wrote. A row whose time Flow could not fill gets the time this script first sees it (≤ 15 min late). */
function readLog_(name, width) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const rng = sh.getRange(2, 1, sh.getLastRow() - 1, width); const rows = rng.getValues(); let stamped = false;
  const now = new Date();
  rows.forEach((r) => { if (String(r[1]).trim() && !toTime_(r[0])) { r[0] = now; stamped = true; } });
  if (stamped) sh.getRange(2, 1, rows.length, 1).setValues(rows.map((r) => [r[0]]));
  return rows.filter((r) => String(r[1]).trim()).map((r) => [toTime_(r[0])].concat(r.slice(1)));
}
function toTime_(x) {
  if (x instanceof Date && !isNaN(x)) return x.getTime();
  const t = Date.parse(String(x || '').trim().replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

/* ============================== COMPUTE + WRITE ============================== */
function refresh() {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(20000)) return;
  try {
    const cfg = settings_(), now = Date.now();
    const r = SW.compute(readLog_(TABS.STOCK, STOCK_HEAD.length), readLog_(TABS.ORDERS, ORDER_HEAD.length), cfg, now, dayKey_);
    const reorderRows = r.reorder.map((x) => [x.status, x.name, x.sku, x.stock, round_(x.perDay, 1), x.daysLeft === Infinity ? '' : round_(x.daysLeft, 1), x.qty, Math.round(x.value), Math.round(x.lost), x.outs]);
    const lostRows = r.lost.map((e) => [e.name, e.sku, new Date(e.start), e.end == null ? 'Still out' : new Date(e.end), round_(e.hours, 1), round_(e.unitsLost, 1), Math.round(e.lost),
      e.topUp == null ? '' : e.topUp, e.small ? `Small: ${e.topUp} pcs ≈ ${round_(e.topUp / e.perDay, 1)} days` : '', e.again ? 'Went out again within a week' : '']);
    const days = r.days.map((d) => [fmtDay_(d.day), Math.round(d.sold), Math.round(d.lost), d.sold + d.lost ? round_((d.lost / (d.sold + d.lost)) * 100, 1) : 0]);
    const tot = [r.totals.sold, r.totals.lost];
    const stamp = Utilities.formatDate(new Date(), tz_(), 'dd MMM HH:mm');
    write_(TABS.REORDER, `Reorder before they run out · ${stamp} · lead ${cfg.lead} d, cover ${cfg.cover} d, safety ${cfg.safety} d`,
      ['Status', 'Product', 'SKU', 'Stock now', 'Sells / day', 'Days left', 'Order qty', 'Order value ₹', 'Lost ₹ (30 d)', 'Stock-outs (30 d)'], reorderRows, 0,
      { 'Out now': '#fde4e4', Critical: '#fde4e4', 'Order now': '#fff1d6', 'Order this week': '#fffbd1' });
    write_(TABS.LOST, `Every stock-out of the last 30 days · ₹ lost = hours out inside the 30 days × sales per hour × price · ${stamp}`,
      ['Product', 'SKU', 'Went out', 'Back in', 'Hours out', 'Units lost (30 d)', '₹ lost (30 d)', 'Topped up with', 'Top-up', 'Pattern'], lostRows, -1, null);
    write_(TABS.DAILY, `Last 30 days: sold ₹${fmtN_(tot[0])}, lost ₹${fmtN_(tot[1])} to stock-outs (${tot[0] + tot[1] ? round_((tot[1] / (tot[0] + tot[1])) * 100, 1) : 0}% of demand) · ${stamp}`,
      ['Day', 'Sold ₹', 'Lost to stock-outs ₹', 'Lost % of demand'], days, -1, null);
  } finally { lock.releaseLock(); }
}
function write_(name, title, head, rows, toneCol, tones) {
  const ss = SpreadsheetApp.getActive(); const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear(); sh.getRange(1, 1).setValue(title).setFontWeight('bold').setFontSize(12);
  sh.getRange(3, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e2e8f0');
  if (rows.length) {
    sh.getRange(4, 1, rows.length, head.length).setValues(rows);
    if (tones) sh.getRange(4, 1, rows.length, head.length).setBackgrounds(rows.map((r) => head.map(() => tones[r[toneCol]] || '#ffffff')));
  } else sh.getRange(4, 1).setValue('Nothing here right now.');
  sh.setFrozenRows(3); sh.autoResizeColumns(1, head.length);
}
function dailyEmail() {
  const cfg = settings_(); if (!cfg.email) return;
  refresh();
  const ss = SpreadsheetApp.getActive(); const r = ss.getSheetByName(TABS.REORDER).getDataRange().getValues().slice(3).filter((x) => x[0] && x[0] !== 'Nothing here right now.');
  const d = ss.getSheetByName(TABS.DAILY).getRange(1, 1).getValue();
  const rows = r.slice(0, 15).map((x) => `<tr><td>${x[0]}</td><td>${x[1]}</td><td>${x[3]}</td><td>${x[5]}</td><td>${x[6]}</td></tr>`).join('');
  MailApp.sendEmail({ to: cfg.email, subject: `Stock Watch: ${r.filter((x) => x[0] === 'Out now').length} out, ${r.filter((x) => x[0] === 'Critical').length} critical`,
    htmlBody: `<p>${d}</p><table border="1" cellpadding="4" style="border-collapse:collapse"><tr><th>Status</th><th>Product</th><th>Stock</th><th>Days left</th><th>Order qty</th></tr>${rows}</table><p><a href="${ss.getUrl()}">Open the sheet</a></p>` });
}

/* ============================== HELPERS ============================== */
function tz_() { return Session.getScriptTimeZone() || 'Asia/Kolkata'; }
function dayKey_(t) { return Utilities.formatDate(new Date(t), tz_(), 'yyyy-MM-dd'); }
function fmtDay_(k) { return Utilities.formatDate(new Date(k + 'T12:00:00'), tz_(), 'EEE dd MMM'); }
function round_(x, d) { const p = Math.pow(10, d); return Math.round(x * p) / p; }
function fmtN_(x) { return Math.round(x).toLocaleString('en-IN'); }
