'use strict';
/* Sprint 2 · D-helpers through the HTTP server: PO CSV (SW-025), decisions (SW-032), why on the report and drawer (SW-024). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-helpers-'));
delete process.env.ADMIN_PASSWORD;
const { server } = require('../server');

let base;
test.before(() => new Promise((ok) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; ok(); })));
test.after(() => new Promise((ok) => server.close(ok)));
const get = (p) => fetch(base + p);
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('demo loads; report rows carry why, totals carry still-out cost per day', async () => {
  assert.equal((await post('/api/demo', {})).status, 200);
  const r = await (await get('/api/report?days=30')).json();
  assert.ok(r.reorder.length > 0);
  assert.ok(r.reorder.every((p) => p.why));
  assert.ok(r.totals.stillOut > 0 && r.totals.stillOutPerDay > 0);
  const out = r.products.find((p) => p.stock <= 0 && p.perDay > 0);
  const d = await (await get(`/api/product/${encodeURIComponent(out.id)}?days=30`)).json();
  assert.equal(d.product.why, out.why, 'drawer and table say the same thing');
});

test('reorder CSV: filter + search respected, PO columns, store-time file name', async () => {
  const r = await (await get('/api/report?days=30')).json();
  const today = r.reorder.filter((p) => ['Out now', 'Critical', 'Order now'].includes(p.status));
  const res = await get('/api/export/reorder.csv?days=30&filter=today');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /reorder-\d{4}-\d{2}-\d{2}\.csv/);
  const text = await res.text();
  const lines = text.replace(/^﻿/, '').split('\n');
  assert.match(lines[0], /^"Vendor","Product","SKU","Variant ID","Order qty","Unit cost","Order value","Status"/);
  assert.equal(lines.length - 1, today.length);
  assert.ok(lines.slice(1).every((l) => l.includes('"Order today"')));
  const one = today[0];
  const q = await (await get(`/api/export/reorder.csv?days=30&filter=all&q=${encodeURIComponent(one.name)}`)).text();
  const ql = q.replace(/^﻿/, '').split('\n');
  assert.ok(ql.length >= 2 && ql.slice(1).every((l) => l.toLowerCase().includes(one.name.toLowerCase())));
  assert.ok(ql.some((l) => l.includes(`"${one.id}"`)), 'variant ID column');
});

test('decide: store, hide, undo; bad input → 400 / 404', async () => {
  const r = await (await get('/api/report?days=30')).json();
  const x = r.decide[0];
  assert.ok(x, 'demo has slow sellers to decide');
  assert.equal((await post('/api/decide', { id: x.id, decision: 'keep' })).status, 200);
  let r2 = await (await get('/api/report?days=30')).json();
  assert.equal(r2.decide.some((y) => y.id === x.id), false);
  assert.ok(r2.decided.some((y) => y.id === x.id && y.decision === 'keep'));
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'decisions.json'), 'utf8'));
  assert.equal(saved[x.id].d, 'keep');
  assert.equal(typeof saved[x.id].base, 'number');
  assert.equal((await post('/api/decide', { id: x.id, decision: null })).status, 200);
  r2 = await (await get('/api/report?days=30')).json();
  assert.ok(r2.decide.some((y) => y.id === x.id), 'undo puts it back');
  assert.equal((await post('/api/decide', { id: x.id, decision: 'sell' })).status, 400);
  assert.equal((await post('/api/decide', { id: 'no-such-variant', decision: 'keep' })).status, 404);
  assert.equal((await fetch(base + '/api/decide', { method: 'POST', body: '{nope' })).status, 400);
  assert.equal((await post('/api/decide', { decision: 'keep' })).status, 404);
});

test('decide: trial values never bring a decided item back; loading demo data wipes decisions', async () => {
  const r = await (await get('/api/report?days=30')).json();
  for (const x of r.decide) assert.equal((await post('/api/decide', { id: x.id, decision: 'keep' })).status, 200);
  for (const w of [7, 90]) {
    const t = await (await get(`/api/report?days=30&demandWindowDays=${w}`)).json();
    assert.equal(t.decide.filter((y) => r.decide.some((x) => x.id === y.id)).length, 0, `trial window ${w} d: decisions checked on saved-settings rates`);
  }
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'decisions.json'), 'utf8'))).length > 0);
  assert.equal((await post('/api/demo', {})).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'decisions.json'), 'utf8')), {});
});
