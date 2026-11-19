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

/* ============================== PURE LOGIC (no Apps Script calls; mirrors modules/stock-watch/src/engine.js — not yet covered by tests) ============================== */
const SW = (() => {
  const HOUR = 36e5, DAY = 864e5;
  const num = (x) => (Number.isFinite(+x) ? +x : 0);
  /** Stock-out episodes from one variant's stock changes (sorted by time). An episode starts when stock
   * drops to 0 or below and ends when it rises above 0; one still open ends "now". */
  function episodes(changes, now) {
    const out = []; let open = null;
    for (const c of changes) {
      const was = num(c.before), is = num(c.now);
      if (!open && is <= 0 && (was > 0 || !out.length)) open = { start: c.t };
      else if (open && is > 0) { out.push({ start: open.start, end: c.t, topUp: is, open: false }); open = null; }
    }
    if (open) out.push({ start: open.start, end: now, topUp: 0, open: true });
    return out;
  }
  /** Hours of [a,b) inside [from,to). */
  const overlap = (a, b, from, to) => Math.max(0, Math.min(b, to) - Math.max(a, from));
  /** Daily rate = units sold ÷ days the product could be bought (stock-out time removed). */
  function rate(units, from, now, eps) {
    const outMs = eps.reduce((s, e) => s + overlap(e.start, e.end, from, now), 0);
    const days = Math.max(1, (now - from - outMs) / DAY);
    return units / days;
  }
  /** Reorder status and quantity. */
  function plan({ stock, perDay, lead, cover, safety }) {
    const daysLeft = perDay > 0 ? Math.max(0, stock) / perDay : Infinity;
    const status = stock <= 0 ? 'Out now' : daysLeft <= 3 ? 'Critical' : daysLeft <= lead + safety ? 'Order now' : daysLeft <= lead + safety + 7 ? 'Order this week' : 'OK';
    const qty = Math.max(0, Math.ceil(perDay * (lead + cover + safety) - Math.max(0, stock)));
    return { daysLeft, status, qty };
  }
  /** Split an episode's lost value across calendar days (keys from dayKey). */
  function lostByDay(e, lostPerHour, dayKey, from) {
    const m = {};
    for (let t = Math.max(e.start, from); t < e.end; t += HOUR) {      // hour by hour (±1 h at day edges)
      const k = dayKey(t); m[k] = (m[k] || 0) + (Math.min(HOUR, e.end - t) / HOUR) * lostPerHour;
    }
    return m;
  }
  return { episodes, rate, plan, lostByDay, overlap, HOUR, DAY };
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
const vid_ = (x) => String(x || '').replace(/\D/g, '');

/* ============================== COMPUTE + WRITE ============================== */
function refresh() {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(20000)) return;
  try {
    const cfg = settings_(), now = Date.now(), from = now - cfg.window * SW.DAY;
    const stock = readLog_(TABS.STOCK, STOCK_HEAD.length), orders = readLog_(TABS.ORDERS, ORDER_HEAD.length);
    const V = {};   // variant id → info
    const v = (id) => (V[id] = V[id] || { id, sku: '', name: '', price: 0, changes: [], units: 0, revenue: 0, stock: null });
    stock.sort((a, b) => a[0] - b[0]).forEach((r) => {
      const x = v(vid_(r[1])); x.sku = String(r[2] || x.sku); x.name = [r[3], r[4] && r[4] !== 'Default Title' ? r[4] : ''].filter(Boolean).join(' · ') || x.name;
      x.price = +r[7] || x.price; x.changes.push({ t: r[0], before: r[5], now: r[6] }); x.stock = +r[6];
    });
    const firstOrder = orders.length ? Math.min.apply(null, orders.map((r) => r[0])) : now;
    const salesByDay = {};
    orders.forEach((r) => {
      const qty = +r[4] || 0, price = +r[5] || 0; if (r[0] < from - 30 * SW.DAY) return;
      const k = dayKey_(r[0]); salesByDay[k] = (salesByDay[k] || 0) + qty * price;
      if (r[0] < from) return;
      const x = v(vid_(r[2])); x.sku = x.sku || String(r[3] || ''); x.units += qty; x.revenue += qty * price;
    });
    const rateFrom = Math.max(from, firstOrder);
    const lostByDay = {}, lostRows = [], reorderRows = [];
    Object.values(V).forEach((x) => {
      const eps = SW.episodes(x.changes, now);
      const perDay = SW.rate(x.units, rateFrom, now, eps);
      const price = x.units ? x.revenue / x.units : x.price;
      const lostPerHour = (perDay / 24) * price;
      let lost30 = 0;
      eps.forEach((e, i) => {
        if (e.end < now - 30 * SW.DAY) return;
        const hours = (e.end - e.start) / SW.HOUR, lost = hours * lostPerHour; lost30 += lost;
        const m = SW.lostByDay(e, lostPerHour, dayKey_, now - 30 * SW.DAY); Object.keys(m).forEach((k) => (lostByDay[k] = (lostByDay[k] || 0) + m[k]));
        const small = !e.open && perDay > 0 && e.topUp < perDay * cfg.smallTopUp;
        const again = eps[i + 1] && eps[i + 1].start - e.end < 7 * SW.DAY;
        lostRows.push([x.name || x.sku, x.sku, new Date(e.start), e.open ? 'Still out' : new Date(e.end), round_(hours, 1), round_(hours / 24 * perDay, 1), Math.round(lost),
          e.open ? '' : e.topUp, small ? `Small: ${e.topUp} pcs ≈ ${round_(e.topUp / perDay, 1)} days` : '', again ? 'Went out again within a week' : '']);
      });
      if (perDay < cfg.minRate || x.stock == null) return;
      const p = SW.plan({ stock: x.stock, perDay, lead: cfg.lead, cover: cfg.cover, safety: cfg.safety });
      if (p.status === 'OK') return;
      reorderRows.push([p.status, x.name || x.sku, x.sku, x.stock, round_(perDay, 1), p.daysLeft === Infinity ? '' : round_(p.daysLeft, 1), p.qty, Math.round(p.qty * price), Math.round(lost30), eps.filter((e) => e.end > now - 30 * SW.DAY).length]);
    });
    const RANK = { 'Out now': 0, Critical: 1, 'Order now': 2, 'Order this week': 3 };
    reorderRows.sort((a, b) => RANK[a[0]] - RANK[b[0]] || b[8] - a[8] || b[4] - a[4]);
    lostRows.sort((a, b) => b[6] - a[6]);
    const days = [];
    for (let t = now; t > now - 30 * SW.DAY; t -= SW.DAY) { const k = dayKey_(t); const s = salesByDay[k] || 0, l = lostByDay[k] || 0; days.push([fmtDay_(k), Math.round(s), Math.round(l), s + l ? round_((l / (s + l)) * 100, 1) : 0]); }
    const tot = days.reduce((a, d) => [a[0] + d[1], a[1] + d[2]], [0, 0]);
    const stamp = Utilities.formatDate(new Date(), tz_(), 'dd MMM HH:mm');
    write_(TABS.REORDER, `Reorder before they run out · ${stamp} · lead ${cfg.lead} d, cover ${cfg.cover} d, safety ${cfg.safety} d`,
      ['Status', 'Product', 'SKU', 'Stock now', 'Sells / day', 'Days left', 'Order qty', 'Order value ₹', 'Lost ₹ (30 d)', 'Stock-outs (30 d)'], reorderRows, 0,
      { 'Out now': '#fde4e4', Critical: '#fde4e4', 'Order now': '#fff1d6', 'Order this week': '#fffbd1' });
    write_(TABS.LOST, `Every stock-out of a selling product, last 30 days · ₹ lost = hours out × sales per hour × price · ${stamp}`,
      ['Product', 'SKU', 'Went out', 'Back in', 'Hours out', 'Units lost', '₹ lost', 'Topped up with', 'Top-up', 'Pattern'], lostRows, -1, null);
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
