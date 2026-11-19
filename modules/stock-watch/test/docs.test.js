'use strict';
/* SW-015: every Markdown file in the repo has balanced code fences. An unclosed ``` swallows the rest of
 * the file (ORCA.md had one: the critic prompts after it rendered as code and agents copied them wrong). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SKIP = new Set(['node_modules', '.git', 'data', '.playwright-cli']);

function markdownFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) markdownFiles(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** Unclosed fences in Markdown text, as [{ line }] (CommonMark: a fence closes with the same character, at least as long, and no info string). */
function openFences(text) {
  let open = null;
  text.split(/\r?\n/).forEach((l, i) => {
    const m = l.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!m) return;
    if (!open) open = { ch: m[1][0], len: m[1].length, line: i + 1 };
    else if (m[1][0] === open.ch && m[1].length >= open.len && !m[2].trim()) open = null;
  });
  return open ? [open] : [];
}

test('doc fences: the checker itself', () => {
  assert.deepEqual(openFences('a\n```bash\nx\n```\nb'), []);
  assert.equal(openFences('```bash\nx\n```bash\ny').length, 1, 'a fence with an info string does not close one');
  assert.deepEqual(openFences('````\n```\n````'), [], 'a shorter fence inside a longer one is content');
});

test('doc fences: every .md file closes every code fence', () => {
  const files = markdownFiles(ROOT);
  assert.ok(files.length > 10, `found ${files.length} Markdown files`);
  const bad = files.flatMap((f) => openFences(fs.readFileSync(f, 'utf8')).map((o) => `${path.relative(ROOT, f)}:${o.line} opens a code fence that never closes`));
  assert.deepEqual(bad, []);
});
