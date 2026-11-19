'use strict';
/* SW-020: role home views only remove UI (ADR-0006, docs/RACI.md). The browser check (fewer visible
 * elements than the default, no sideways scroll) is test/smoke/roles-smoke.js. */
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

test('css removes exactly the role’s parts and re-flows the tiles', () => {
  const ceo = R.css('ceo');
  assert.match(ceo, /#tabs a\[data-view="reorder"\]/);
  assert.match(ceo, /\.tile\[data-go="reorder"\]/);
  assert.match(ceo, /repeat\(2, minmax/);                    // 2 tiles left: lost + overstock
  assert.match(ceo, /#view > \.grid2 \{ display: none; \}/);  // both lists gone
  assert.doesNotMatch(ceo, /data-view="stockouts"/);
  const fin = R.css('finance');
  assert.match(fin, /\.grid2 \{ grid-template-columns: minmax\(0, 1fr\); max-width: 880px; \}/);   // one list left, full width
  const founder = R.css('founder');
  assert.doesNotMatch(founder, /tiles/);                     // all 4 tiles stay
});

test('digest cadence follows the RACI "Pushed to them" column', () => {
  const c = Object.fromEntries(R.ORDER.map((k) => [k, R.ROLES[k].digest]));
  assert.deepEqual(c, { ceo: 'monday', founder: 'daily', ops: 'daily', buyer: null, marketing: 'daily', finance: 'monday', warehouse: null });
});
