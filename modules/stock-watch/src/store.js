'use strict';
/*
 * Storage: one JSON file per store (DATA_DIR/store.json). Fine for a demo and for one
 * store with a few months of data; swap for Postgres when it grows (see README).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stockKey, orderKey } = require('./rows');
const { DEFAULT_SETTINGS } = require('./engine');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'store.json');
const KEEP_DAYS = 120;

let db = null;
let saveTimer = null;

const blankShopify = () => ({ lastQty: {}, ordersCursor: null, lastSync: null, lastError: null, lastTry: null });

function blank() {
  return { settings: { ...DEFAULT_SETTINGS, ingestKey: crypto.randomBytes(16).toString('hex'), sheetStockCsv: '', sheetOrderCsv: '' },
    stock: [], orders: [], source: 'empty', lastSync: null, lastSyncError: null, shopify: blankShopify() };
}

function load() {
  if (db) return db;
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { db = blank(); }
  db.settings = { ...blank().settings, ...db.settings };
  db.shopify = { ...blankShopify(), ...db.shopify };
  if (!db.settings.ingestKey) db.settings.ingestKey = crypto.randomBytes(16).toString('hex');
  db._stockKeys = new Set(db.stock.map(stockKey));
  db._orderKeys = new Set(db.orders.map(orderKey));
  return db;
}

function save(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const { _stockKeys, _orderKeys, ...plain } = db;
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(plain));
    fs.renameSync(tmp, FILE);
  };
  if (now) write(); else saveTimer = setTimeout(write, 500);
}

/** Add rows, skipping ones already stored. Returns how many were new. */
function add(kind, rows) {
  const d = load();
  const list = kind === 'stock' ? d.stock : d.orders;
  const keys = kind === 'stock' ? d._stockKeys : d._orderKeys;
  const keyOf = kind === 'stock' ? stockKey : orderKey;
  let n = 0;
  for (const r of rows) { const k = keyOf(r); if (keys.has(k)) continue; keys.add(k); list.push(r); n++; }
  if (n) { if (d.source === 'empty') d.source = 'live'; prune(); save(); }
  return n;
}

function prune() {
  const cut = Date.now() - KEEP_DAYS * 864e5;
  const d = load();
  if (d.stock.some((r) => r.t < cut)) { d.stock = d.stock.filter((r) => r.t >= cut); d._stockKeys = new Set(d.stock.map(stockKey)); }
  if (d.orders.some((r) => r.t < cut)) { d.orders = d.orders.filter((r) => r.t >= cut); d._orderKeys = new Set(d.orders.map(orderKey)); }
}

/** Replace every line of these orders with `rows` (a cancelled or fully refunded order ends up with none). */
function replaceOrders(names, rows) {
  const d = load(); const set = new Set(names);
  const before = d.orders.length;
  d.orders = d.orders.filter((r) => !set.has(r.order)).concat(rows);
  d._orderKeys = new Set(d.orders.map(orderKey));
  if (rows.length && d.source === 'empty') d.source = 'live';
  prune(); save();
  return { added: rows.length, removed: before - (d.orders.length - rows.length) };
}

function replaceAll(stock, orders, source) {
  const d = load();
  d.stock = stock; d.orders = orders; d.source = source;
  d._stockKeys = new Set(stock.map(stockKey)); d._orderKeys = new Set(orders.map(orderKey));
  d.shopify = blankShopify();   // re-read everything from Shopify on the next pull
  save(true);
}

function setSettings(patch) {
  const d = load();
  d.settings = { ...d.settings, ...patch };
  save(true);
  return d.settings;
}

function setSync(info) { Object.assign(load(), info); save(); }

function setShopify(patch) { const d = load(); d.shopify = { ...d.shopify, ...patch }; save(); return d.shopify; }

module.exports = { load, add, replaceAll, replaceOrders, setSettings, setSync, setShopify, save };
