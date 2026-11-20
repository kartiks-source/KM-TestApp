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
  assert.ok(await pg.$('#store-name .sdot.s-ok'), 'status dot on the pill');
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

test('one store: the pill is the plain name (no dot, no store menu); phones show the name in the store bar, whose menu is the role picker (final critic M1)', opts, async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    await ctx.route('**/api/stores', async (route) => {
      const j = await (await route.fetch()).json();
      await route.fulfill({ json: { ...j, stores: j.stores.slice(0, 1) } });
    });
    const pg = await ctx.newPage(); const errors = []; pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(base + '/#overview'); await pg.waitForSelector('.tiles');
    assert.equal(await pg.$eval('#store-name', (e) => e.innerHTML), 'Sammsara (demo)');
    assert.equal(await pg.$eval('#store-menu', (e) => e.innerHTML), '');
    const bar = await pg.$eval('#storebar', (e) => ({ shown: getComputedStyle(e).display !== 'none', text: e.querySelector('summary').textContent, dot: !!e.querySelector('.sdot'), stores: e.querySelectorAll('[data-store]').length, roles: e.querySelectorAll('#role-menu-m [data-role]').length }));
    assert.deepEqual(bar, { shown: w <= 760, text: 'Sammsara (demo)', dot: false, stores: 0, roles: 8 }, `${w}: store bar (UI-5, M1)`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
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

/* ---------- critic round (UI-1 … UI-6) ---------- */

/** A context whose /api/stores lists n stores (the real first one, then fakes), every one in `state`. */
async function many(w, h, n, state, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  let calls = 0;
  await ctx.route('**/api/stores', async (route) => {
    const j = await (await route.fetch()).json();
    const st = typeof state === 'function' ? state(++calls) : state;
    const s0 = j.stores[0];
    const stores = Array.from({ length: n }, (_, i) => ({ ...s0, id: i ? `store-${i}` : s0.id, name: i ? `Store ${i}` : s0.name, status: { ...s0.status, state: st } }));
    await route.fulfill({ json: { ...j, stores } });
  });
  if (extra.init) await ctx.addInitScript(extra.init);
  const pg = await ctx.newPage(); pg.errors = []; pg.on('pageerror', (e) => pg.errors.push(e.message));
  await pg.goto(base + (extra.url || '/#overview')); await pg.waitForSelector('.tiles');
  return pg;
}
const box = (pg, sel) => pg.$$eval(sel, (els) => els.map((e) => { const b = e.getBoundingClientRect(); return [b.width, b.height]; }));

test('status dot is an 8 px dot in every state, on the pill, in the menu and in the phone store bar (UI-1)', opts, async () => {
  for (const state of ['ok', 'stale', 'error']) {
    for (const [w, h] of [[1280, 800], [360, 740]]) {
      const pg = await many(w, h, 2, state);
      if (w > 760) await pg.click('.top .store-pill'); else await pg.click('#storebar summary');
      const sel = w > 760 ? '#store-name .sdot, #store-menu .sdot' : '#storebar .sdot';
      const dots = await box(pg, sel);
      assert.ok(dots.length >= 3, `${state} ${w}: ${dots.length} dots`);
      assert.ok(dots.every(([dw, dh]) => dw === 8 && dh === 8), `${state} ${w}: ${JSON.stringify(dots)}`);
      assert.equal(await pg.$eval(sel, (e) => e.classList.contains(`s-${e.className.match(/s-(\w+)/)[1]}`)), true);
      assert.deepEqual(pg.errors, []);
      await pg.context().close();
    }
  }
});

test('store + view menu: every store and role reachable on a short laptop (8 stores at 1280x720) (UI-2)', opts, async () => {
  const pg = await many(1280, 720, 8, 'ok');
  await pg.click('.top .store-pill');
  await pg.mouse.wheel(0, 20000);
  const m = await pg.$eval('details.rolepick .menu', (e) => { const b = e.getBoundingClientRect(); return { bottom: b.bottom, vh: innerHeight, scrolls: e.scrollHeight > e.clientHeight }; });
  assert.ok(m.bottom <= m.vh, `menu ends at ${m.bottom}, window ${m.vh}`);
  assert.ok(m.scrolls, 'the menu scrolls inside itself');
  await pg.$eval('#role-menu button:last-child', (b) => b.scrollIntoView({ block: 'nearest' }));
  const last = await pg.$eval('#role-menu button:last-child', (b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  assert.ok(last, 'last role in view');
  await pg.context().close();
});

test('phone store bar with a role: the store name wins over the role and the store count (final r2 M7)', opts, async () => {
  for (const [w, h] of [[360, 740], [390, 844]]) {
    const pg = await open(w, h, '/?store=second-demo&role=founder#overview', '.tiles');
    const r = await pg.evaluate(() => {
      const nm = document.querySelector('#storebar .sm-name'), n = [...document.querySelectorAll('#storebar .sm-n:not(.sm-role)')];
      return { name: nm.scrollWidth <= nm.clientWidth, role: document.querySelector('#storebar .sm-role').textContent, count: n.every((x) => getComputedStyle(x).display === 'none') };
    });
    assert.deepEqual(r, { name: true, role: r.role, count: true }, `${w}: "Second store (demo)" whole, "2 stores" hidden with a role`);
    assert.ok(r.role, `${w}: role shown`);
    await pg.context().close();
  }
  const pg = await open(360, 740, '/?store=second-demo&role=#overview', '.tiles');
  assert.match(await pg.textContent('#storebar summary'), /2 stores/, 'no role: the count is back');
  await pg.context().close();
});

test('long store name: ellipsis on the pill (full name in its title); at 1280 with a role the range and role stay whole (UI-3, UI-4)', opts, async () => {
  const LONG = 'Sammsara Luxury Home Decor and Gifting Company India';
  const put = (name) => fetch(`${base}/api/settings?store=second-demo`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ storeName: name }) });
  assert.equal((await put(LONG)).status, 200);
  try {
    for (const [w, h] of [[1280, 800], [1440, 900]]) {
      const pg = await open(w, h, '/?store=second-demo&role=ops#overview', '.tiles');
      const r = await pg.evaluate(() => {
        const nm = document.querySelector('#store-name'), cs = getComputedStyle(nm), role = document.querySelector('#role-name');
        return { ellipsis: cs.textOverflow === 'ellipsis' && cs.display === 'block', cut: nm.scrollWidth > nm.clientWidth, title: document.querySelector('.store-pill').title,
          range: [...document.querySelectorAll('.top .range button')].every((b) => b.scrollWidth <= b.clientWidth + 1 && b.getBoundingClientRect().right <= innerWidth),
          roleOneLine: role.textContent !== '' && role.getBoundingClientRect().height <= 20, sx: document.documentElement.scrollWidth - innerWidth };
      });
      assert.deepEqual(r, { ellipsis: true, cut: true, title: r.title, range: true, roleOneLine: true, sx: 0 }, `${w}`);
      assert.ok(r.title.startsWith(LONG), `${w}: title ${r.title}`);
      await pg.context().close();
    }
  } finally { await put('Second store (demo)'); }
});

test('the picker reads the store list again every minute: a store that starts failing turns red without a reload (UI-6)', opts, async () => {
  const pg = await many(1440, 900, 2, (n) => (n === 1 ? 'ok' : 'error'), { init: 'window.SW_STORES_REFRESH_MS = 300' });
  assert.ok(await pg.$('#store-name .sdot'), 'a dot');
  await pg.waitForSelector('#store-name .sdot.s-error', { timeout: 5000 });
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('several stores: the product drawer names the store (UI-5)', opts, async () => {
  const pg = await open(390, 844, '/?store=sammsara-demo#overview', '.tiles');
  await pg.click('[data-product]');
  await pg.waitForSelector('#drawer-title');
  assert.equal(await pg.textContent('#drawer .dstore'), 'Sammsara (demo)');
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});
