#!/usr/bin/env node
'use strict';
/*
 * DEVLOG rotation (SW-058): docs/DEVLOG.md keeps the newest KEEP entries ("## " headings); older ones move, newest
 * first, to docs/devlog/<YYYY-MM>.md by the month in their heading date, and DEVLOG links each archive file.
 * Run: npm run devlog:rotate (repo root). Safe to run again: nothing moves while DEVLOG has KEEP entries or fewer.
 */
const fs = require('node:fs');
const path = require('node:path');

const KEEP = 15;
const LINKS = '<!-- devlog archive links (scripts/rotate-devlog.js) -->';

/** Split a DEVLOG text into { head, entries: [{ title, month, text }] }. */
function split(text) {
  const lines = text.split('\n'), head = [], entries = [];
  for (const l of lines) {
    if (l.startsWith('## ')) { const m = l.match(/^## (\d{4})-(\d{2})-\d{2}/); entries.push({ title: l, month: m ? `${m[1]}-${m[2]}` : 'undated', lines: [l] }); }
    else if (entries.length) entries[entries.length - 1].lines.push(l);
    else head.push(l);
  }
  return { head, entries: entries.map((e) => ({ ...e, text: e.lines.join('\n').replace(/\n+$/, '') })) };
}

/** → { devlog, archives: { 'YYYY-MM': text to put at the top of that archive } } (pure). */
function rotate(text, keep = KEEP) {
  const { head, entries } = split(text);
  if (entries.length <= keep) return { devlog: text, archives: {} };
  const kept = entries.slice(0, keep), old = entries.slice(keep), archives = {};
  for (const e of old) (archives[e.month] = archives[e.month] || []).push(e.text);
  const months = Object.keys(archives).sort().reverse();
  let h = head.join('\n').replace(/\n+$/, '');
  const linkLine = (ms) => `${LINKS}\nOlder entries: ${ms.map((m) => `[${m}](devlog/${m}.md)`).join(' · ')}`;
  const have = h.match(new RegExp(`${LINKS}\\nOlder entries: (.*)`));
  const all = [...new Set([...months, ...(have ? [...have[1].matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]) : [])])].sort().reverse();
  h = have ? h.replace(have[0], linkLine(all)) : `${h}\n\n${linkLine(all)}`;
  return { devlog: `${h}\n\n${kept.map((e) => e.text).join('\n\n')}\n`, archives: Object.fromEntries(months.map((m) => [m, archives[m].join('\n\n')])) };
}

function run(root = path.join(__dirname, '..')) {
  const file = path.join(root, 'docs', 'DEVLOG.md');
  const { devlog, archives } = rotate(fs.readFileSync(file, 'utf8'));
  for (const [m, text] of Object.entries(archives)) {
    const a = path.join(root, 'docs', 'devlog', `${m}.md`);
    fs.mkdirSync(path.dirname(a), { recursive: true });
    const prev = fs.existsSync(a) ? fs.readFileSync(a, 'utf8').replace(/^# [^\n]*\n+(?:[^\n#][^\n]*\n+)*/, '') : '';
    fs.writeFileSync(a, `# Dev log archive: ${m}\n\nOlder entries moved from \`docs/DEVLOG.md\` (newest first). Newer ones: [DEVLOG](../DEVLOG.md).\n\n${text}\n${prev ? `\n${prev}` : ''}`);
  }
  fs.writeFileSync(file, devlog);
  return Object.keys(archives);
}

module.exports = { rotate, split, KEEP };
if (require.main === module) { const m = run(); console.log(m.length ? `moved older entries to docs/devlog/${m.join('.md, docs/devlog/')}.md` : `nothing to move (${KEEP} entries or fewer)`); }
