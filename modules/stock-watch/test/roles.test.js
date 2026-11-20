'use strict';
/* SW-020: role home views only remove UI (ADR-0006, docs/RACI.md). Roles are switched off in the UI since
 * 20 Nov 2026 (brand switch only); these pure functions are kept in case they come back. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../public/roles');

const VIEWS = ['overview', 'reorder', 'stockouts', 'products', 'data'];
const RACI = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'RACI.md'), 'utf8');

test('the seven RACI roles, each with a home page that exists', () => {
  assert.deepEqual(R.ORDER, ['ceo', 'founder', 'ops', 'buyer', 'marketing', 'finance', 'warehouse']);
  for (const k of R.ORDER) {
    const r = R.ROLES[k];
    assert.ok(VIEWS.includes(r.home), k);
    assert.ok(RACI.includes(`| ${r.name.split(' /')[0]}`), `${r.name} is a row in docs/RACI.md`);
  }
});

test('every role removes at least one thing from its own home page, and only known things', () => {
  for (const k of R.ORDER) {
    const r = R.ROLES[k];
    for (const h of r.hide) assert.ok(R.PARTS[h], `${k}: unknown part ${h}`);
    assert.ok(r.hide.some((h) => ['*', r.home].includes(R.PARTS[h][0])), `${k} hides nothing on ${r.home}`);
    assert.ok(!r.hide.includes(`rail:${r.home}`), `${k} hides its own home page`);
  }
});

test('no role hides Data & settings (it holds the "Show me" switch back)', () => {
  for (const k of R.ORDER) assert.ok(!R.ROLES[k].hide.some((h) => h === 'rail:data'), k);
});

test('no role, or an unknown one, removes nothing (default = today’s view)', () => {
  assert.equal(R.css(''), '');
  assert.equal(R.css('intern'), '');
  assert.equal(R.hides('', 'chart'), false);
  assert.equal(R.valid('__proto__'), false);
});

test('show everything by default: "All" is the no-role choice, not a role, and ?role=all lands nowhere special', () => {
  assert.equal(R.ALL, 'All');
  assert.equal(R.valid('all'), false); assert.equal(R.valid('All'), false);
  assert.equal(R.css('all'), '');
  assert.equal(R.landing('all', ''), null, 'no role → the page asked for, Reorder on its All tab');
});

test('css removes exactly the role’s parts and re-flows the tiles', () => {
  const ceo = R.css('ceo');
  assert.match(ceo, /#tabs a\[data-view="reorder"\]/);
  assert.match(ceo, /\.tile\[data-go="reorder"\]/);
  assert.match(ceo, /repeat\(2, minmax/);                    // 2 tiles left: lost + overstock
  assert.match(ceo, /#view > \.grid2 \{ display: none; \}/);  // both lists gone
  assert.doesNotMatch(ceo, /data-view="stockouts"/);
  const fin = R.css('finance');
  assert.match(fin, /\.grid2 \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);   // one list left + Moving, side by side
  const founder = R.css('founder');
  assert.doesNotMatch(founder, /tiles/);                     // all 4 tiles stay
});

test('phones: an odd number of tiles (3) lets the last one span the row, so no half-empty row (critic M7)', () => {
  const mkt = R.css('marketing');                             // lost, best sellers at risk, overstock
  assert.match(mkt, /@media \(max-width: 760px\) \{ #view > \.tiles\.t4 > \.tile\[data-filter="push"\] \{ grid-column: 1 \/ -1; \} \}/);
  assert.doesNotMatch(R.css('ceo'), /grid-column: 1 \/ -1/);  // 2 tiles: even
  for (const r of R.ORDER) {
    const kept = ['tile:lost', 'tile:order', 'tile:bestrisk', 'tile:over'].filter((k) => !R.ROLES[r].hide.includes(k)).length;
    assert.equal(/grid-column: 1 \/ -1/.test(R.css(r)), kept === 3, r);
  }
});

test('digest cadence follows the RACI "Pushed to them" column', () => {
  const c = Object.fromEntries(R.ORDER.map((k) => [k, R.ROLES[k].digest]));
  assert.deepEqual(c, { ceo: 'monday', founder: 'daily', ops: 'daily', buyer: null, marketing: 'daily', finance: 'monday', warehouse: null });
});

test('landing: a role link with or without #<its home> applies the role’s tab; another #page opens as asked', () => {
  // digest links carry the hash (/?role=marketing#products): the Order today tab must still apply
  assert.deepEqual(R.landing('marketing', 'products'), { view: 'products', filter: 'pause', setHash: false });
  assert.deepEqual(R.landing('marketing', ''), { view: 'products', filter: 'pause', setHash: true });
  assert.deepEqual(R.landing('ceo', 'overview'), { view: 'overview', filter: null, setHash: false });
  assert.equal(R.landing('marketing', 'data'), null);
  assert.equal(R.landing('', 'products'), null);
  assert.equal(R.landing('intern', ''), null);
  for (const k of R.ORDER) assert.equal(R.landing(k, R.ROLES[k].home).view, R.ROLES[k].home, k);
});

test('RACI "A’s number first": a role that hides the order tile also drops "Order ₹X today" from the headline', () => {
  for (const k of R.ORDER) {
    const h = R.ROLES[k].hide;
    assert.equal(h.includes('head:order'), h.includes('tile:order'), k);
  }
  assert.match(R.css('ceo'), /\.headline h1 \.h-order/);
  assert.match(R.css('ceo'), /\.h-lost::first-letter \{ text-transform: uppercase; \}/);
  assert.doesNotMatch(R.css('founder'), /h-order/);
});

test('RACI tile count: CEO lands on Overview with 2 tiles (sales lost, overstock) + the daily chart', () => {
  const tiles = ['tile:lost', 'tile:order', 'tile:bestrisk', 'tile:over'].filter((t) => !R.ROLES.ceo.hide.includes(t));
  assert.deepEqual(tiles, ['tile:lost', 'tile:over']);
  assert.ok(!R.ROLES.ceo.hide.includes('chart'));
  assert.match(RACI, /\| CEO \| Overview, 2 tiles \+ daily chart \|/);
});

test('Sprint 1 + 2 controls follow RACI: Mark ordered only for the PO roles; warehouse lands on Ordered, marketing on Pause promotion', () => {
  const marks = R.ORDER.filter((k) => !R.ROLES[k].hide.includes('mark'));
  assert.deepEqual(marks, ['founder', 'ops', 'buyer'], 'Place the PO: A founder, R buyer, C ops (RACI "Also sees: Mark ordered")');
  assert.ok(R.PARTS.mark[1].includes('.poform .porow') && R.PARTS.mark[1].includes('.poform:not(.has-order)') && !/\.poform(,|$)/.test(R.PARTS.mark[1]), 'the drawer keeps the on-order facts, only the form goes');
  assert.deepEqual([R.ROLES.warehouse.home, R.ROLES.warehouse.filter], ['reorder', 'ordered']);
  assert.ok(!R.ROLES.warehouse.hide.includes('tab:ordered'));
  assert.deepEqual([R.ROLES.marketing.home, R.ROLES.marketing.filter], ['products', 'pause']);
  for (const k of ['buyer', 'finance', 'warehouse']) assert.ok(R.ROLES[k].hide.includes('chip:pause') || R.ROLES[k].hide.includes('rail:products'), `${k}: Pause / push ads is "–"`);
  assert.ok(!R.ROLES.marketing.hide.some((h) => h.startsWith('chip:')), 'marketing keeps Pause / Push');
  assert.match(R.css('ceo'), /\[data-filter-reorder="ordered"\]/);
});
