'use strict';
/* SW-058: DEVLOG rotation (scripts/rotate-devlog.js at the repo root): the newest 15 entries stay, older ones move to
 * docs/devlog/<YYYY-MM>.md, linked from the intro; the intro and every entry's text survive unchanged. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..', '..');
const R = require(path.join(ROOT, 'scripts', 'rotate-devlog.js'));

const doc = (n) => `# Dev log\n\nIntro line.\n\n${Array.from({ length: n }, (_, i) => `## 2026-${i < 3 ? '11' : '10'}-0${(i % 9) + 1} · entry ${i}\n- line ${i}\n`).join('\n')}`;

test('rotate: keeps the newest N, moves the rest by month, links them; nothing moves at N or fewer', () => {
  assert.deepEqual(R.rotate(doc(3), 3).archives, {});
  const { devlog, archives } = R.rotate(doc(6), 3);
  assert.deepEqual(R.split(devlog).entries.map((e) => e.title), ['## 2026-11-01 · entry 0', '## 2026-11-02 · entry 1', '## 2026-11-03 · entry 2']);
  assert.match(devlog, /^# Dev log\n\nIntro line\.\n\n<!-- devlog archive links/);
  assert.match(devlog, /Older entries: \[2026-10\]\(devlog\/2026-10\.md\)/);
  assert.deepEqual(Object.keys(archives), ['2026-10']);
  assert.deepEqual(R.split(archives['2026-10']).entries.map((e) => e.title.split(' · ')[1]), ['entry 3', 'entry 4', 'entry 5']);
  const again = R.rotate(devlog, 3);
  assert.equal(again.devlog, devlog, 'running again changes nothing');
});

test('docs/DEVLOG.md links its archive and every archive file exists', () => {
  const text = fs.readFileSync(path.join(ROOT, 'docs', 'DEVLOG.md'), 'utf8');
  for (const m of text.matchAll(/\]\((devlog\/[^)]+\.md)\)/g)) assert.ok(fs.existsSync(path.join(ROOT, 'docs', m[1])), m[1]);
});
