'use strict';
/*
 * Role views smoke (SW-020). NOT part of `npm test`: it needs a browser. Run on demand:
 *
 *   node modules/stock-watch/test/smoke/roles-smoke.js
 *
 * Starts the app (demo data, temp DATA_DIR) on SMOKE_PORT (4805). For every role in public/roles.js, at
 * 1280, 1440, 1920 and 390×844 it opens /?role=<role>, checks it landed on the role's home page, counts the
 * visible UI pieces there (rail items, tiles, panels, chips, headers, buttons; not data rows) and checks the
 * count is LOWER than the default view of the same page (ADR-0006: roles only remove). Also: no sideways
 * scroll, no console errors, ?role=all brings the default back. Screenshots to SMOKE_OUT. Exit 1 on failure.
 *
 * Playwright: PLAYWRIGHT_PATH, a normal require, or the npx cache. CHROMIUM_PATH = a browser binary when the
 * installed Playwright's own browser isn't downloaded.
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
    const { chromium } = loadPlaywright();
    const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
    for (const [w, h] of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text())) errors.push(m.text()); });
      const open = async (url) => { await page.goto(BASE + url); await page.waitForSelector('#view .headline'); await page.waitForTimeout(300); };
      const base = {};
      for (const v of new Set(ROLES.ORDER.map((r) => ROLES.ROLES[r].home))) { await open(`/?role=all#${v}`); base[v] = await count(page); }
      for (const r of ROLES.ORDER) {
        const R = ROLES.ROLES[r];
        await open(`/?role=${r}`);
        const hash = await page.evaluate(() => location.hash);
        const n = await count(page), sw = await sideways(page);
        const ok = hash === '#' + R.home && n < base[R.home] && sw <= 0;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${w}px ${r.padEnd(9)} lands ${hash.padEnd(10)} ${n} pieces vs ${base[R.home]} default, sideways ${sw}px`);
        if (!ok) fails.push(`${w} ${r}`);
        await page.screenshot({ path: path.join(OUT, `role-${r}-${w}.png`) });
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
