'use strict';
/*
 * Role views smoke (SW-020). NOT part of `npm test`: it needs a browser. Run on demand:
 *
 *   node modules/stock-watch/test/smoke/roles-smoke.js
 *
 * Starts the app (demo data, temp DATA_DIR) on SMOKE_PORT (4805). For every role in public/roles.js, at
 * 1280, 1440, 1920 and 390×844 it opens /?role=<role> and the digest link /?role=<role>#<home>, checks both
 * land on the role's home page AND tab (e.g. marketing → Products → Order today), counts the visible UI pieces
 * there (rail items, tiles, panels, chips, headers, buttons; not data rows) and checks the count is LOWER than
 * the default view of the same page on the same tab (like for like; ADR-0006: roles only remove). Also: no
 * sideways scroll, no console errors, period buttons ≥ 44 px tall on phones (SW-023), ?role=all brings the
 * default back. Screenshots to SMOKE_OUT. Exit 1 on failure.
 *
 * Playwright: PLAYWRIGHT_PATH, a normal require, or the npx cache. Browser: CHROMIUM_PATH, else Playwright's
 * own, else the system Chrome (channel "chrome"). Not in `npm test`: CI has no browser and the module has no deps.
 */
if (process.env.NODE_TEST_CONTEXT) process.exit(0);   // never run by node --test

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROLES = require('../../public/roles');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_PATH, 'playwright'].filter(Boolean);
  const npx = path.join(os.homedir(), '.npm', '_npx');
  try { for (const d of fs.readdirSync(npx)) tries.push(path.join(npx, d, 'node_modules', 'playwright')); } catch { /* no npx cache */ }
  for (const t of tries) { try { return require(t); } catch { /* next */ } }
  console.error('Playwright not found. Set PLAYWRIGHT_PATH to a playwright package folder.');
  process.exit(2);
}

const APP = path.join(__dirname, '..', '..');
const PORT = Number(process.env.SMOKE_PORT) || 4805;
const BASE = `http://localhost:${PORT}`;
const OUT = process.env.SMOKE_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'sw-roles-'));
const VIEWPORTS = [[1280, 900], [1440, 900], [1920, 1080], [390, 844]];
const PIECES = '#tabs a, .top .range button, #view .tile, #view .panel, #view .chip, #view th, #view .plan, #view .headline > *, #view .toolbar > *, #view .btn';

const count = (page) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.checkVisibility()).length, PIECES);
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-roles-data-'));
  const app = spawn(process.execPath, ['server.js'], { cwd: APP, env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_PASSWORD: '' }, stdio: 'ignore' });
  const fails = [];
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
    /* one product marked ordered, so Reorder → Ordered (warehouse home, SW-012) has a row on every view */
    const rep = await (await fetch(BASE + '/api/report')).json();
    const pick = rep.reorder.find((p) => p.orderQty > 0);
    if (pick) await fetch(BASE + '/api/onorder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ id: pick.id, qty: pick.orderQty, eta: Date.now() + 7 * 864e5 }] }) });
    const { chromium } = loadPlaywright();
    const launch = async () => {
      if (process.env.CHROMIUM_PATH) return chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
      try { return await chromium.launch(); } catch (e) {
        try { return await chromium.launch({ channel: 'chrome' }); } catch { throw new Error(`No browser: ${e.message.split('\n')[0]}. Set CHROMIUM_PATH.`); }
      }
    };
    const browser = await launch();
    for (const [w, h] of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text())) errors.push(m.text()); });
      const open = async (url) => { await page.goto(BASE + url); await page.waitForSelector('#view .headline'); await page.waitForTimeout(300); };
      const tab = (v) => page.evaluate((x) => document.querySelector(`[data-filter-${x}].on`)?.dataset[`filter${x[0].toUpperCase()}${x.slice(1)}`] || '', v);
      const base = {};   // default view of each home page on the role's tab: like for like
      for (const [v, f] of [...new Set(ROLES.ORDER.map((r) => `${ROLES.ROLES[r].home}|${ROLES.ROLES[r].filter || ''}`))].map((k) => k.split('|'))) {
        await open(`/?role=all#${v}`);
        if (f && await tab(v) !== f) { await page.click(`[data-filter-${v}="${f}"]`); await page.waitForTimeout(150); }
        base[`${v}|${f}`] = await count(page);
      }
      for (const r of ROLES.ORDER) {
        const R = ROLES.ROLES[r], b = base[`${R.home}|${R.filter || ''}`];
        for (const url of [`/?role=${r}`, `/?role=${r}#${R.home}`]) {   // menu pick, digest link
          await open(url);
          const hash = await page.evaluate(() => location.hash), on = R.filter ? await tab(R.home) : '';
          const n = await count(page), sw = await sideways(page);
          const ok = hash === '#' + R.home && on === (R.filter || '') && n < b && sw <= 0;
          console.log(`${ok ? 'ok  ' : 'FAIL'} ${w}px ${url.padEnd(26)} lands ${(hash + (on ? ` › ${on}` : '')).padEnd(18)} ${n} pieces vs ${b} default, sideways ${sw}px`);
          if (!ok) fails.push(`${w} ${url}`);
        }
        await page.screenshot({ path: path.join(OUT, `role-${r}-${w}.png`) });
      }
      if (w < 760) {
        await open('/?role=all#overview');
        const short = await page.evaluate(() => [...document.querySelectorAll('.top .range button')].filter((e) => e.getBoundingClientRect().height < 44).length);
        if (short) fails.push(`${w} ${short} period buttons under 44 px`);
      }
      await open('/?role=all');
      const back = await page.evaluate(() => [document.documentElement.dataset.role, location.hash]);
      if (back[0] !== '' || !['', '#overview'].includes(back[1])) fails.push(`${w} ?role=all did not reset (${back})`);
      if (errors.length) { fails.push(`${w} console: ${errors.join(' | ')}`); }
      await ctx.close();
    }
    await browser.close();
  } finally { app.kill(); }
  console.log(`screenshots: ${OUT}`);
  if (fails.length) { console.error('FAILED:\n' + fails.join('\n')); process.exit(1); }
  console.log('roles smoke: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
