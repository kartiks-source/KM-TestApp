'use strict';
/*
 * Sprint 2 · D-helpers UI rules in a real browser (LOGIC.md §15): Status column only on Reorder → All,
 * Why dates agree with the tab, Pause/Push count line + Copy SKUs, Decide buttons hide and Undo, 44 px phone buttons.
 * Needs Playwright (no npm dependency): set PLAYWRIGHT_PATH to a playwright package, or have one resolvable;
 * PLAYWRIGHT_CHANNEL=chrome uses the installed Chrome instead of Playwright's own browser.
 * Skipped when it isn't there, so `npm test` stays dependency-free.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_PATH || 'playwright'); } catch { /* not installed: skip */ }
const opts = { skip: pw ? false : 'Playwright not found (set PLAYWRIGHT_PATH)' };

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-ui-'));
delete process.env.ADMIN_PASSWORD;
const { server } = require('../server');

let base, browser;
test.before(async () => {
  if (!pw) return;
  await new Promise((ok) => server.listen(0, ok));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/demo', { method: 'POST' })).status, 200);
  browser = await pw.chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
});
test.after(async () => { if (browser) await browser.close(); if (server.listening) await new Promise((ok) => server.close(ok)); });

async function page(width = 1440, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } } }); });
  const pg = await ctx.newPage();
  const errors = []; pg.on('pageerror', (e) => errors.push(e.message));
  pg.errors = errors;
  return pg;
}
const heads = (pg) => pg.$$eval('.tbl.desk table thead th', (th) => th.map((x) => x.textContent.replace(/[↑↓]/g, '').trim()));

test('Reorder: Status column only on All; Why dates agree with the tab', opts, async () => {
  const pg = await page();
  await pg.goto(base + '/#reorder'); await pg.waitForSelector('.tbl.desk table');
  assert.ok(await pg.$('[data-filter-reorder="all"].on'), 'Reorder opens on All (show everything)');
  await pg.click('[data-filter-reorder="today"]'); await pg.waitForSelector('[data-filter-reorder="today"].on');
  assert.equal((await heads(pg)).includes('Status'), false, 'Order today: no Status column');
  assert.ok((await heads(pg)).includes('Why'));
  const today = await pg.$$eval('.tbl.desk tbody .why', (w) => w.map((x) => x.textContent));
  assert.ok(today.length && today.every((t) => /^Out\b|order by today/.test(t)), 'Order today rows: out, or order by today');
  await pg.click('[data-filter-reorder="week"]');
  assert.equal((await heads(pg)).includes('Status'), false, 'This week: no Status column');
  const week = await pg.$$eval('.tbl.desk tbody .why', (w) => w.map((x) => x.textContent));
  assert.ok(week.length && week.every((t) => !/order by today/.test(t)), 'This week rows never say "order by today"');
  await pg.click('[data-filter-reorder="all"]');
  assert.ok((await heads(pg)).includes('Status'), 'All keeps Status');
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('Products: Pause / Push count line and Copy SKUs', opts, async () => {
  const pg = await page();
  await pg.goto(base + '/#products'); await pg.waitForSelector('[data-filter-products="pause"]');
  await pg.click('[data-filter-products="pause"]');
  const r = await (await fetch(base + '/api/report?days=30')).json();
  const pause = r.products.filter((p) => p.mkt === 'pause');
  const line = await pg.textContent('.mktbar > span');
  assert.equal(line, `${pause.filter((p) => p.orderQty > 0).length} to reorder · ${pause.filter((p) => p.status === 'Slow seller').length} slow`);
  assert.equal(await pg.textContent('#copy-skus'), `Copy ${pause.length} SKUs`);
  await pg.click('#copy-skus');
  const copied = (await pg.evaluate(() => window.__copied))[0].split('\n');
  assert.equal(copied.length, pause.length);
  assert.deepEqual(new Set(copied), new Set(pause.map((p) => p.sku || String(p.id))));
  await pg.click('[data-filter-products="push"]');
  assert.match(await pg.textContent('.mktbar > span'), /^₹[\d.,]+ ?(k|L|Cr)? stuck$/);
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('Products → Slow sellers to decide: Keep hides the row, Undo brings it back; no "₹0 lost"', opts, async () => {
  const pg = await page();
  await pg.goto(base + '/#products'); await pg.waitForSelector('#f-more');
  await pg.selectOption('#f-more', 'slow'); await pg.waitForSelector('.tbl.desk [data-decide]');
  if (await pg.$('[data-more="products"][data-all]')) await pg.click('[data-more="products"][data-all]');
  const zeroDrop = (await (await fetch(base + '/api/report')).json()).decide.some((x) => x.kind === 'drop' && !x.value);   // depends on the demo draw
  if (zeroDrop) assert.ok(await pg.$$eval('.tbl.desk .dec.drop', (d) => d.some((x) => x.textContent.trim() === 'Don’t reorder?')), 'a drop row with nothing lost reads "Don’t reorder?"');
  assert.equal(await pg.$$eval('.tbl.desk .dec', (d) => d.some((x) => /₹0\b/.test(x.textContent))), false);
  const id = await pg.$eval('.tbl.desk tbody tr', (tr) => tr.dataset.id);
  await pg.click(`.tbl.desk tr[data-id="${id}"] [data-decide$="|keep"]`);
  await pg.waitForSelector('details.decided');
  assert.equal(await pg.$(`.tbl.desk tr[data-id="${id}"]`), null, 'decided row hidden');
  await pg.click('details.decided summary');
  await pg.click(`details.decided [data-decide="${id}|"]`);
  await pg.waitForSelector(`.tbl.desk tr[data-id="${id}"]`);
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('Phone 390: new small buttons are at least 44 px tall; sort label names the list order', opts, async () => {
  const pg = await page(390, 844);
  await pg.goto(base + '/#products'); await pg.waitForSelector('[data-filter-products="pause"]');
  await pg.click('[data-filter-products="pause"]');
  const hs = await pg.$$eval('.mktbar .btn.xs', (b) => b.map((x) => x.getBoundingClientRect().height));
  assert.ok(hs.length && hs.every((h) => h >= 44), `button heights ${hs}`);
  assert.equal(await pg.$eval('.phone select[data-msort] option[value=""]', (o) => o.textContent), 'Out first, then fewest days left');
  assert.ok(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('Products filters: no duplicate lists; overstock tile opens Push these (critic r2 S1)', opts, async () => {
  const pg = await page();
  await pg.goto(base + '/#products'); await pg.waitForSelector('#f-more');
  const chips = await pg.$$eval('[data-filter-products]', (b) => b.map((x) => x.dataset.filterProducts));
  const more = await pg.$$eval('#f-more option', (o) => o.map((x) => x.value).filter(Boolean));
  assert.equal(chips.length, 6); assert.equal(more.length, 6, `More… options ${more}`);
  assert.ok(!more.includes('over') && !more.includes('decide'), 'Overstock = Push these; Slow sellers = Slow sellers to decide');
  await pg.selectOption('#f-more', 'slow'); await pg.waitForSelector('.tbl.desk');
  assert.ok((await heads(pg)).includes('Decide'), 'Slow sellers carries the Decide column');
  await pg.goto(base + '/#overview'); await pg.waitForSelector('.tile.plum');
  await pg.click('.tile.plum'); await pg.waitForSelector('[data-filter-products="push"].on');
  assert.match(await pg.textContent('.headline h1'), /^Push [\d,]+ overstocked products$/);
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('Marketing phone home leads with its decision: "Pause promotion on N products", cards lead with Back in stock (critic r2 M1)', opts, async () => {
  const pg = await page(390, 844);
  await pg.goto(base + '/?role=marketing'); await pg.waitForSelector('[data-filter-products="pause"].on');
  const r = await (await fetch(base + '/api/report?days=30')).json();
  const n = r.products.filter((p) => p.mkt === 'pause').length;
  assert.equal(await pg.textContent('.headline h1'), `Pause promotion on ${n.toLocaleString('en-IN')} products`);
  const card = await pg.$eval('.phone .mcard header', (h) => ({ st: h.querySelector('.st')?.textContent || '', order: !!h.querySelector('.st.g-today') }));
  assert.match(card.st, /^(Lands|Late|Not ordered|Slow seller)/, `card badge: ${card.st}`);
  assert.equal(card.order, false, 'no "Order today" badge on the marketing list');
  assert.ok(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
  assert.deepEqual(pg.errors, []);
  await pg.context().close();
});

test('Reorder: every tab fits its box at 1280 and 1400 (All keeps Sales lost on screen); no sideways page scroll (critic r2 UI-1)', opts, async () => {
  for (const w of [1280, 1400]) {
    const pg = await page(w, 900);
    await pg.goto(base + '/?role=all#reorder'); await pg.waitForSelector('.tbl.desk table');
    for (const f of ['today', 'week', 'all']) {
      await pg.click(`[data-filter-reorder="${f}"]`); await pg.waitForSelector(`[data-filter-reorder="${f}"].on`);
      const m = await pg.evaluate(() => { const b = document.querySelector('.tbl.desk'), t = b.querySelector('table'), lost = t.querySelector('th[data-k="lost"]');
        return { tw: t.getBoundingClientRect().width, bw: b.clientWidth, lostRight: lost.getBoundingClientRect().right, page: document.documentElement.scrollWidth - innerWidth }; });
      assert.ok(m.tw <= m.bw + 1, `${w} ${f}: table ${m.tw} in ${m.bw}`);
      assert.ok(m.lostRight <= w, `${w} ${f}: Sales lost header at ${m.lostRight}`);
      assert.equal(m.page, 0, `${w} ${f}: page scrolls sideways`);
    }
    assert.deepEqual(pg.errors, []);
    await pg.context().close();
  }
});

test('Columns: every optional column is on by default; ones that do not fit step aside (named in a note), never a sideways scroll; unticking is remembered', opts, async () => {
  const OPT = { reorder: ['In stock', 'Sells / day', 'Times out'], products: ['Category', 'Sells / day', 'Units sold', 'Share of demand lost', 'Times out', 'Overstock ₹', 'Profit lost', 'Margin'] };
  for (const w of [1280, 1440, 1920]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    const pg = await ctx.newPage(); const errors = []; pg.on('pageerror', (e) => errors.push(e.message));
    for (const view of ['products', 'reorder']) {
      await pg.goto(`${base}/?role=all#${view}`); await pg.waitForSelector('.tbl.desk table');
      const m = await pg.evaluate(() => { const b = document.querySelector('.tbl.desk'), t = b.querySelector('table');
        const shown = [...t.tHead.rows[0].cells].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.textContent.replace(/[↑↓]/g, '').trim());
        const aside = [...t.tHead.rows[0].cells].filter((c) => c.classList.contains('sq')).map((c) => c.textContent.replace(/[↑↓]/g, '').trim());
        return { shown, aside, tw: t.getBoundingClientRect().width, bw: b.clientWidth, scrollx: b.classList.contains('scrollx'), hint: document.querySelector('.sx-hint')?.textContent || '', page: document.documentElement.scrollWidth - innerWidth }; });
      assert.equal(m.page, 0, `${w} ${view}: the page never scrolls sideways`);
      assert.equal(m.scrollx, false, `${w} ${view}: no sideways scroll inside the table either`);
      assert.ok(m.tw <= m.bw + 1, `${w} ${view}: table ${m.tw} fits ${m.bw}`);
      for (const c of OPT[view]) assert.ok(m.shown.includes(c) || m.aside.includes(c), `${w} ${view}: ${c} is on (shown, or stepped aside for width)`);
      if (m.aside.length) assert.ok(m.aside.every((c) => m.hint.includes(c)), `${w} ${view}: the note names ${m.aside}`);
      else assert.equal(m.hint, '', `${w} ${view}: nothing aside, no note`);
      if (w === 1920 && view === 'reorder') assert.deepEqual(m.aside, [], '1920: every Reorder column fits');
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  // untick → hidden, and still hidden after a reload (this browser remembers)
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 900 } }); const pg = await ctx.newPage();
  await pg.goto(`${base}/#reorder`); await pg.waitForSelector('.tbl.desk table');
  await pg.click('#view .colpick.desk > summary'); await pg.uncheck('[data-col="reorder|outs"]');
  assert.equal((await heads(pg)).includes('Times out'), false);
  await pg.reload(); await pg.waitForSelector('.tbl.desk table');
  assert.equal((await heads(pg)).includes('Times out'), false, 'remembered');
  assert.ok((await heads(pg)).includes('In stock'), 'the others stay on');
  await ctx.close();
});
