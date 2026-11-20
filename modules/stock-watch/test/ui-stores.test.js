'use strict';
/*
 * Several stores in the browser (ADR-0015, LOGIC.md §18) and "show everything by default" (ADR-0006 amended):
 * the store pill is the picker (dot per store, keyboard, phones), choosing sets ?store= + localStorage + the
 * sw_store cookie and reloads, every page call names the store, one store = the plain name; no role, Reorder → All,
 * every Overview panel. Needs Playwright (PLAYWRIGHT_PATH; PLAYWRIGHT_CHANNEL=chrome); skipped without it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_PATH || 'playwright'); } catch { /* not installed: skip */ }
const opts = { skip: pw ? false : 'Playwright not found (set PLAYWRIGHT_PATH)' };

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ui-stores-'));
for (const k of ['ADMIN_PASSWORD', 'VIEW_PASSWORD', 'SHOPIFY_STORE', 'STORES', 'PERFORMITY_POC_API_URL', 'PERFORMITY_POC_API_KEY']) delete process.env[k];
const { server } = require('../server');

let base, browser;
test.before(async () => {
  if (!pw) return;
  await new Promise((ok) => server.listen(0, ok));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const id of ['sammsara-demo', 'second-demo']) assert.equal((await fetch(`${base}/api/demo?store=${id}`, { method: 'POST' })).status, 200);
  browser = await pw.chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
});
test.after(async () => { if (browser) await browser.close(); if (server.listening) await new Promise((ok) => server.close(ok)); });

async function open(width, height, url, ready = '#view .headline h1') {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const pg = await ctx.newPage();
  pg.errors = []; pg.on('pageerror', (e) => pg.errors.push(e.message));
  pg.calls = []; pg.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && u.pathname !== '/api/stores') pg.calls.push(u); });
  await pg.goto(base + url); await pg.waitForSelector(ready);
  return pg;
}
const headline = (pg) => pg.textContent('#view .headline h1');

test('desktop: the store pill is a picker with a dot per store; keyboard picks the second store; every call names it', opts, async () => {
  const pg = await open(1440, 900, '/#overview');
  assert.match(pg.url(), /[?&]store=sammsara-demo\b/, 'address names the store (shareable)');
  assert.equal(await pg.$eval('#store-name', (e) => e.textContent), 'Up to date: Sammsara (demo)');
  assert.ok(await pg.$('#store-name .sdot.ok'), 'status dot on the pill');
  assert.match(await pg.title(), /^Sammsara \(demo\) · Stock-out Watch$/);
  const first = await headline(pg);
  assert.ok(pg.calls.length && pg.calls.every((u) => u.searchParams.get('store') === 'sammsara-demo'), 'every call carries ?store=');

  await pg.focus('.top .store-pill'); await pg.keyboard.press('Enter');
  await pg.waitForSelector('details.rolepick[open] #store-menu [data-store]');
  await pg.waitForFunction(() => document.activeElement.dataset.store === 'sammsara-demo', null, { timeout: 3000 });   // focus on the current store
  const opts2 = await pg.$$eval('#store-menu [data-store]', (b) => b.map((x) => [x.dataset.store, x.getAttribute('aria-current'), !!x.querySelector('.sdot')]));
  assert.deepEqual(opts2, [['sammsara-demo', 'true', true], ['second-demo', 'false', true]]);
  pg.calls = [];
  await pg.keyboard.press('ArrowDown');
  await Promise.all([pg.waitForURL(/store=second-demo/), pg.keyboard.press('Enter')]);
  await pg.waitForSelector('.tiles');
  assert.equal(await pg.$eval('#store-name', (e) => e.textContent), 'Up to date: Second store (demo)');
  assert.notEqual(await headline(pg), first, 'the second demo store has its own numbers');
  assert.ok(pg.calls.length && pg.calls.every((u) => u.searchParams.get('store') === 'second-demo'));
  const kept = await pg.evaluate(() => ({ ls: localStorage.getItem('sw-store'), cookie: document.cookie }));
  assert.equal(kept.ls, 'second-demo'); assert.match(kept.cookie, /(^|; )sw_store=second-demo/);

  await pg.goto(base + '/#overview'); await pg.waitForSelector('.tiles');   // no ?store=: the one last chosen
  assert.match(pg.url(), /store=second-demo/);
  await pg.click('.top .store-pill'); await pg.keyboard.press('Escape');
  assert.equal(await pg.$('details.rolepick[open]'), null, 'Escape closes');
  assert.ok(await pg.evaluate(() => document.activeElement.classList.contains('store-pill')), 'focus back on the pill');
  assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('phone 390 and 360: a store bar under the top bar, 44 px targets, no sideways scroll; tapping a store switches', opts, async () => {
  for (const [w, h] of [[390, 844], [360, 740]]) {
    const pg = await open(w, h, '/?store=sammsara-demo#reorder');
    const bar = await pg.$eval('#storebar summary', (s) => ({ h: s.getBoundingClientRect().height, text: s.textContent, vis: getComputedStyle(s.closest('#storebar')).display !== 'none' }));
    assert.ok(bar.vis, `${w}: store bar shown`); assert.ok(bar.h >= 44, `${w}: bar ${bar.h}px`); assert.match(bar.text, /Sammsara \(demo\).*2 stores/);
    await pg.click('#storebar summary');
    const items = await pg.$$eval('#storebar [data-store]', (b) => b.map((x) => x.getBoundingClientRect().height));
    assert.equal(items.length, 2); assert.ok(items.every((x) => x >= 44), `${w}: items ${items}`);
    assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${w}: no sideways scroll`);
    await Promise.all([pg.waitForURL(/store=second-demo/), pg.click('#storebar [data-store="second-demo"]')]);
    await pg.waitForSelector('#view .headline h1');
    assert.match(pg.url(), /#reorder$/, 'stays on the same page');
    assert.match(await pg.textContent('#storebar summary'), /Second store \(demo\)/);
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
});

test('one store: the pill is the plain name (no dot, no store menu, no store bar)', opts, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/api/stores', async (route) => {
    const j = await (await route.fetch()).json();
    await route.fulfill({ json: { ...j, stores: j.stores.slice(0, 1) } });
  });
  const pg = await ctx.newPage(); const errors = []; pg.on('pageerror', (e) => errors.push(e.message));
  await pg.goto(base + '/#overview'); await pg.waitForSelector('.tiles');
  assert.equal(await pg.$eval('#store-name', (e) => e.innerHTML), 'Sammsara (demo)');
  assert.equal(await pg.$eval('#store-menu', (e) => e.innerHTML), '');
  assert.equal(await pg.$eval('#storebar', (e) => e.hidden), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('show everything by default: no role, Reorder opens on All, every Overview panel', opts, async () => {
  const pg = await open(1440, 900, '/#overview');
  assert.equal(await pg.evaluate(() => document.documentElement.dataset.role), '');
  assert.equal(await pg.$eval('#role-css', (s) => s.textContent), '', 'nothing removed');
  const vis = (sel) => pg.$$eval(sel, (els) => els.filter((e) => e.offsetParent && getComputedStyle(e).display !== 'none').length);
  assert.equal(await vis('#view > .tiles.t4 > .tile'), 4, 'four tiles');
  assert.equal(await vis('#view > .grid2 > .panel'), 3, 'Order today, Biggest losses, Moving');
  assert.equal(await vis('#view > .panel.chart'), 1, 'daily chart');
  await pg.click('.top .store-pill');
  assert.equal(await pg.$eval('#role-menu [data-role=""]', (b) => [b.getAttribute('aria-pressed'), b.querySelector('b').textContent].join()), 'true,All');
  await pg.goto(base + '/#reorder');   await pg.waitForSelector('.tbl.desk table');
  assert.ok(await pg.$('[data-filter-reorder="all"].on'), 'Reorder → All');
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('viewer address: an unknown or unsafe ?store= falls back to a listed store, never an error page', opts, async () => {
  const pg = await open(1440, 900, '/?store=..%2F..%2Fetc#overview');
  assert.match(pg.url(), /store=(sammsara-demo|second-demo)/);
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});
