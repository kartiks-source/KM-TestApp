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

/* Critic r2 X2: SECURITY.md lists every secret the code reads and every route that changes data, and keeps no
 * stale "planned" auth text. Secret-like variables are found by scanning the code, so a new one fails here. */
test('SECURITY.md names every secret variable the code reads and every write route; no stale auth text', () => {
  const MOD = path.join(__dirname, '..');
  const sec = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
  const code = ['server.js', ...fs.readdirSync(path.join(MOD, 'src')).filter((f) => f.endsWith('.js')).map((f) => path.join('src', f))]
    .map((f) => fs.readFileSync(path.join(MOD, f), 'utf8')).join('\n');
  const names = new Set();
  for (const m of code.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|\benv\(\s*'([A-Z][A-Z0-9_]+)'\s*\)|\benv\(`([A-Z][A-Z0-9_]+)_\$\{/g)) names.add(m[1] || m[2] || m[3]);
  const secrets = [...names].filter((n) => /PASSWORD|SECRET|KEY|TOKEN|WEBHOOK/.test(n) && n !== 'AZURE_KEY_VAULT_URL');
  assert.ok(secrets.length >= 8, `found ${secrets}`);
  for (const n of secrets) assert.ok(sec.includes('`' + n), `SECURITY.md is missing ${n}`);
  for (const r of ['POST /api/clear', 'POST /api/demo', 'POST /api/import', 'PUT /api/settings', 'POST /api/onorder', 'POST /api/decide', 'PUT /api/digest/settings', 'POST /api/digest/send', 'POST /ingest/stock', 'GET /api/export/backup.json']) {
    assert.ok(sec.includes(r), `SECURITY.md endpoints table is missing ${r}`);
  }
  assert.doesNotMatch(sec, /Planned hardening|Known gaps|SW-008 makes it|Hardening to a random key|when they land/, 'auth text describes the code as it is');
});

/* SW-056: the version people see (/health, /status, footer) is the one the CHANGELOG describes. */
test('CHANGELOG.md top heading = package.json version', () => {
  const MOD = path.join(__dirname, '..');
  const v = JSON.parse(fs.readFileSync(path.join(MOD, 'package.json'), 'utf8')).version;
  const top = fs.readFileSync(path.join(MOD, 'CHANGELOG.md'), 'utf8').match(/^## (\S+) · /m);
  assert.ok(top, 'CHANGELOG has a "## <version> · <date>" heading');
  assert.equal(top[1], v);
});
