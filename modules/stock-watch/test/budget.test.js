'use strict';
/* SW-041 cash budget cut line (LOGIC.md §6d): profit kept per ₹, the ranking, one clear cut line, ?budget= on the PO CSV. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const B = require('../src/budget');

const SERVER = path.join(__dirname, '..', 'server.js');
const row = (id, o) => ({ id, stock: 0, perDay: 1, price: 1000, cost: 400, orderQty: 10, orderValue: 4000, ...o });

test('parse: blank, 0, junk = no budget; ₹ and commas fine', () => {
  for (const x of [null, '', '0', '-5', 'abc', 'Infinity']) assert.equal(B.parse(x), null, String(x));
  assert.equal(B.parse('₹2,00,000'), 200000);
  assert.equal(B.parse(' 1500.4 '), 1500);
});

test('annotate: the LOGIC worked example; unknown cost uses the store’s average margin; nothing to order = no ratio', () => {
  /* 2/day, lead 10 + cover 20 = 60 needed, 12 in stock → 48 short; order 60 at cost 450 (₹27,000); margin 1000−450 = 550 */
  const r = { settings: { leadDays: 10, coverDays: 20 }, products: [], reorder: [row('a', { perDay: 2, stock: 12, cost: 450, orderQty: 60, orderValue: 27000 })] };
  r.products = r.reorder.slice();
  B.annotate(r);
  assert.equal(r.reorder[0].protect, 26400);
  assert.equal(r.reorder[0].perRupee, 0.98);
  assert.equal(r.reorder[0].protectEst, false);
  /* the supplier’s lead time (row.leadDays) replaces the store’s; units on order that count are subtracted */
  const s = { settings: { leadDays: 10, coverDays: 20 }, products: [], reorder: [row('b', { perDay: 2, stock: 12, leadDays: 5, onOrder: { counts: true, remaining: 10 }, orderQty: 60, orderValue: 24000 })] };
  B.annotate(s);
  assert.equal(s.reorder[0].protect, (2 * 25 - 12 - 10) * 600);
  /* no cost: price × average margin % of costed products (60% here) */
  const u = { settings: { leadDays: 0, coverDays: 10 }, products: [row('c', { cost: 400 })], reorder: [row('d', { cost: null, orderQty: 5, orderValue: 5000 })] };
  B.annotate(u);
  assert.equal(u.reorder[0].protect, 5 * 600);
  assert.equal(u.reorder[0].protectEst, true);
  const z = { settings: {}, products: [], reorder: [row('e', { orderQty: 0, orderValue: 0 })] };
  B.annotate(z);
  assert.equal(z.reorder[0].perRupee, null);
});

test('cut: ranked by profit kept per ₹; first row that doesn’t fit draws the line; nothing below it fits', () => {
  const rows = [
    row('low', { perRupee: 0.5, protect: 1000, orderValue: 2000 }),
    row('top', { perRupee: 2, protect: 6000, orderValue: 3000 }),
    row('big', { perRupee: 1.5, protect: 15000, orderValue: 10000 }),
    row('none', { perRupee: null, protect: 0, orderQty: 0, orderValue: 0 }),
  ];
  const c = B.cut(rows, 5000);
  assert.deepEqual(c.rows.map((p) => p.id), ['top', 'big', 'low', 'none']);
  assert.deepEqual([...c.fit], ['top']);
  assert.equal(c.spent, 3000); assert.equal(c.protect, 6000);
  assert.equal(c.over, 2, '"low" would fit in the ₹2,000 left but sits below the line'); assert.equal(c.overValue, 12000);
  assert.equal(B.cut(rows, 1e6).over, 0);
  assert.equal(B.cut(rows, 100).fit.size, 0);
});

const ADMIN = 'admin password 123';
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }).on('error', reject); });
async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-budget-srv-'));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port), ADMIN_PASSWORD: ADMIN }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => { const on = (c) => { out += c; if (out.includes('Stock-out Watch on')) resolve(); }; child.stdout.on('data', on); child.stderr.on('data', on); exited.then(resolve); });
  const base = `http://127.0.0.1:${port}`;
  return { req: (p) => fetch(base + p, { headers: { authorization: 'Basic ' + Buffer.from(`x:${ADMIN}`).toString('base64') } }), stop: async () => { child.kill(); await exited; fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('routes: report rows carry profit kept per ₹; ?budget= keeps only the rows above the line; blank budget = the full list', async (t) => {
  const s = await start(); t.after(s.stop);
  const r = await (await s.req('/api/report?days=30')).json();
  const due = r.reorder.filter((p) => p.orderQty > 0);
  assert.ok(due.length > 5);
  assert.ok(due.every((p) => typeof p.perRupee === 'number' && p.protect >= 0));
  const csv = async (qs) => (await (await s.req(`/api/export/reorder.csv?days=30&filter=all${qs}`)).text()).replace(/^﻿/, '').trim().split('\n').slice(1);
  const all = await csv('');
  const ids = (lines) => lines.map((l) => l.split('","')[3]);   // the rows, not their dates ("order by" can tick over between two calls on a slow runner)
  assert.deepEqual(ids(await csv('&budget=')), ids(all), 'empty budget: same rows as before');
  const budget = Math.round(due.reduce((a, p) => a + p.orderValue, 0) / 3);
  const c = B.cut(r.reorder, budget);
  const cut = await csv(`&budget=${budget}`);
  assert.equal(cut.length, c.fit.size);
  assert.ok(cut.length > 0 && cut.length < all.length);
  assert.ok(cut.reduce((a, l) => a + +l.split('","')[6], 0) <= budget, 'the file fits the budget');
  assert.ok(cut.every((l) => c.fit.has(l.split('","')[3])), 'the same rows as the page');
});

test('a free gift (engine row.gift) is never ranked first by the budget (M4: Mystery Gift 460 pcs for ₹361)', () => {
  const r = { settings: { leadDays: 7, coverDays: 30 }, products: [], reorder: [row('gift', { price: 1, cost: null, orderQty: 460, orderValue: 361, perDay: 18, gift: true }), row('x', { cost: null })] };
  B.annotate(r);
  assert.equal(r.reorder[0].perRupee, null);
  assert.deepEqual(B.cut(r.reorder, 1e5).rows.map((p) => p.id), ['x', 'gift']);
});
