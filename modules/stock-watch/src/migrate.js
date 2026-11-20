'use strict';
/*
 * One-time move of a single-store DATA_DIR into the first store's folder (multi-store, ADR-0015):
 *
 *   DATA_DIR/store.json, onorder.json, decisions.json (+ .bak, .corrupt-*), catalog.json, restore.json, backups/
 *     → DATA_DIR/stores/<first store id>/
 *
 * Crash-safe and idempotent:
 *   1. copy every old file into DATA_DIR/stores/.migrating-<id>/ and check each copy's SHA-256 against the original;
 *   2. write a marker listing every file and its hash, fsync;
 *   3. rename the folder to stores/<id> (one atomic step: before it, nothing moved; after it, the copy is whole);
 *   4. remove each old file whose content still matches the marker's hash.
 * A crash before 3 leaves the old files as they were (the half copy is thrown away next start); a crash during 4
 * is finished on the next start. An old file that changed after the copy is left in place, with a warning.
 * If stores/<id> already holds data and was not made by this move, nothing is touched and the server refuses to start.
 * secret (sign-in) and stores.json (the registry) stay where they are: they are for every store.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MARKER = '.migrated-from-data-dir.json';
const FILES = /^(?:(?:store|onorder|decisions)\.json(?:\.bak|\.corrupt-.+)?|catalog\.json|restore\.json(?:\.rejected-.+)?)$/;
const DIRS = new Set(['backups']);

class MigrationError extends Error {}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fsyncPath(p) { try { const fd = fs.openSync(p, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* not every OS can fsync a folder */ } }

/** Old single-store entries at the top of DATA_DIR (names only). */
function legacy(root) {
  let ents; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return ents.filter((e) => (e.isFile() && FILES.test(e.name)) || (e.isDirectory() && DIRS.has(e.name))).map((e) => e.name);
}
/** Every file under `rel` (a file, or a folder walked recursively), as paths relative to root. */
function walk(root, rel) {
  const p = path.join(root, rel);
  const st = fs.statSync(p);
  if (!st.isDirectory()) return [rel];
  return fs.readdirSync(p).flatMap((n) => walk(root, path.join(rel, n)));
}

/**
 * Move old files into stores/<id>. Returns { migrated: false } when there is nothing to move, else
 * { migrated: true, id, files, removed, kept } (kept = old files left because they changed after the copy).
 */
function run(root, id) {
  const names = legacy(root);
  const storesDir = path.join(root, 'stores');
  const target = path.join(storesDir, id);
  const marker = path.join(target, MARKER);
  if (!names.length) return { migrated: false };
  if (!fs.existsSync(marker)) {
    if (fs.existsSync(target) && fs.readdirSync(target).length) {
      throw new MigrationError(`DATA_DIR holds single-store files (${names.join(', ')}) and stores/${id} already holds data. Not moving anything: move or remove one of them by hand (docs/RUNBOOK.md).`);
    }
    const staging = path.join(storesDir, `.migrating-${id}`);
    fs.rmSync(staging, { recursive: true, force: true });   // a half copy from a crash: start again from the originals
    const files = names.flatMap((n) => walk(root, n));
    const list = [];
    for (const rel of files) {
      const src = path.join(root, rel), dst = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      fsyncPath(dst);
      const h = sha(src);
      if (sha(dst) !== h) throw new MigrationError(`Copy of ${rel} doesn't match the original; nothing moved`);
      list.push({ path: rel, sha256: h });
    }
    const m = path.join(staging, MARKER);
    fs.writeFileSync(m, JSON.stringify({ from: 'DATA_DIR', id, at: new Date().toISOString(), files: list }, null, 1));
    fsyncPath(m); fsyncPath(staging);
    if (fs.existsSync(target)) fs.rmdirSync(target);      // an empty folder only (checked above)
    fs.renameSync(staging, target);
    fsyncPath(storesDir);
    console.log(`migrate: moved ${list.length} file(s) from DATA_DIR into stores/${id}`);
  }
  /* remove the originals that match what was copied */
  const done = JSON.parse(fs.readFileSync(marker, 'utf8'));
  let removed = 0; const kept = [];
  for (const f of done.files || []) {
    const src = path.join(root, f.path);
    if (!fs.existsSync(src)) continue;
    if (sha(src) === f.sha256) { fs.rmSync(src); removed++; } else kept.push(f.path);
  }
  for (const n of names) {   // folders left empty, deepest first
    const p = path.join(root, n);
    if (!DIRS.has(n) || !fs.existsSync(p)) continue;
    const dirs = walkDirs(p).sort((a, b) => b.length - a.length);
    for (const d of dirs) { try { fs.rmdirSync(d); } catch { /* not empty */ } }
  }
  const listed = new Set((done.files || []).map((f) => f.path.split(path.sep)[0]));
  const extra = legacy(root).filter((n) => !listed.has(n) || kept.some((k) => k.split(path.sep)[0] === n));
  if (kept.length || extra.length) console.warn(`migrate: left in DATA_DIR (changed or new since the move to stores/${id}): ${[...new Set([...kept, ...extra])].join(', ')}`);
  return { migrated: true, id, files: (done.files || []).length, removed, kept };
}
function walkDirs(p) {
  let out = [p];
  for (const e of fs.readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) out = out.concat(walkDirs(path.join(p, e.name)));
  return out;
}

module.exports = { run, legacy, MARKER, MigrationError };
