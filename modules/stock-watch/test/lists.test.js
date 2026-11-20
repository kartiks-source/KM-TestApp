'use strict';
/* SW-044: paste-a-list lookup (public/lists.js match, pure) and saved lists (src/lists.js, lists.json). LOGIC.md §9d. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-lists-'));
require('../src/scope').useDir(path.join(process.env.DATA_DIR, 'one'));
const L = require('../src/lists');
const P = require('../public/lists.js');
const backup = require('../src/backup');

const products = [
  { id: '101', sku: 'LAMP-BR', name: 'Lamp · Brass' },
  { id: '102', sku: 'LAMP-SL', name: 'Lamp · Silver' },
  { id: '201', sku: 'VASE-1', name: 'Vase' },
  { id: '301', sku: '', name: 'Tray Gold' },
];

test('split: new lines, commas, tabs, semicolons; trimmed; blanks and repeats (any case) dropped', () => {
  assert.deepEqual(P.split('LAMP-BR\r\n vase-1 ,\t101;;\nlamp-br\n'), ['LAMP-BR', 'vase-1', '101']);
  assert.deepEqual(L.split('a\tb,c;d\ne\n\nA'), ['a', 'b', 'c', 'd', 'e']);
});

test('match: SKU, variant ID or full name exactly (any case), else contains (3+ characters); not found listed', () => {
  assert.equal(P.match('lamp', products), null, 'no separator: plain search');
  const m = P.match('lamp-br, 201\nTray gold\tnope-9, la', products);
  assert.deepEqual([...m.ids].sort(), ['101', '201', '301']);
  assert.deepEqual(m.notFound, ['nope-9', 'la'], '2 characters never match by part');
  const part = P.match('silver,', products);
  assert.deepEqual([...part.ids], ['102'], 'contains: name');
  assert.deepEqual(P.match('lamp,', products).ids.size, 2, 'a part can name several products');
  assert.equal(P.match(', ,', products), null, 'only separators: plain search');
});

test('saved lists: save by name (replace same name), validation, delete, newest first; backups carry lists.json', () => {
  assert.equal(L.save('', ['a']).ok, false);
  assert.equal(L.save('x'.repeat(61), ['a']).ok, false);
  assert.equal(L.save('Diwali', []).ok, false);
  assert.equal(L.save('Diwali', ['x'.repeat(201)]).ok, false);
  assert.equal(L.save('Diwali', Array.from({ length: 2001 }, (_, i) => `s${i}`)).ok, false);
  assert.deepEqual(L.save(' Diwali  top ', 'A1\nB2, a1', 'admin', 1000), { ok: true, id: 'diwali-top' });
  assert.deepEqual(L.list()[0], { id: 'diwali-top', name: 'Diwali top', items: ['A1', 'B2'], at: 1000, by: 'admin' });
  L.save('diwali TOP', ['C3'], 'admin', 2000);
  assert.equal(L.list().length, 1, 'same name (any case) replaces');
  assert.deepEqual(L.list()[0].items, ['C3']);
  L.save('Vendor B', ['X'], null, 3000);
  assert.deepEqual(L.list().map((x) => x.id), ['vendor-b', 'diwali-top']);
  assert.equal(L.remove('nope').ok, false);
  assert.equal(L.remove('vendor-b').ok, true);
  assert.equal(L.remove('__proto__').ok, false);
  assert.ok(backup.SIDES['lists.json']);
});
