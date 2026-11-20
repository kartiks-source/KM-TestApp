'use strict';
/*
 * The small JSON files kept next to store.json: onorder.json ("Mark ordered", LOGIC.md §6b) and decisions.json
 * (slow-seller decisions, §15d). Kept as safely as store.json (SW-004, critic r2 X1):
 *   - only a missing file starts empty;
 *   - a file that can't be read is copied aside (<name>.corrupt-<time>) and never overwritten; the last good save
 *     (<name>.bak) is used instead; with no good .bak, read() throws, the server refuses to start, nothing is written;
 *   - writes go through a temp file, fsync, rename; the file it replaces stays as <name>.bak.
 * Backups, the backup export and restore carry both files (src/backup.js, `sideFiles`).
 */
const fs = require('node:fs');
const path = require('node:path');

class SideFileError extends Error {}
const dataDir = () => process.env.DATA_DIR || path.join(__dirname, '..', 'data');

/** A side file's content: a plain JSON object, or null when the file doesn't exist. Anything else throws. */
function parse(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const j = JSON.parse(raw);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not a JSON object');
  return j;
}

/** Write via a temp file, fsync, rename. keepBak: the file it replaces becomes <file>.bak (a hard link, else a copy). */
function writeAtomic(file, text, keepBak = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (keepBak && fs.existsSync(file)) {
    try { fs.rmSync(file + '.bak', { force: true }); fs.linkSync(file, file + '.bak'); } catch { try { fs.copyFileSync(file, file + '.bak'); } catch { /* best effort */ } }
  }
  fs.renameSync(tmp, file);
}

/** One side file, DATA_DIR/<name>. read() → the object (cached); write() saves it; reset() forgets the cache (tests, restore). */
function sideFile(name) {
  let data = null, error = null, mainBad = false;
  const file = () => path.join(dataDir(), name);
  function read() {
    if (data) return data;
    if (error) throw error;
    const f = file();
    try { data = parse(f) || {}; } catch (e) {
      const aside = `${f}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try { fs.copyFileSync(f, aside); } catch { /* unreadable: it stays where it is, untouched */ }
      let bak = null;
      try { bak = parse(f + '.bak'); } catch { /* the backup is bad too */ }
      if (!bak) {
        error = new SideFileError(`${name} can't be read (${e.message}) and there is no good ${name}.bak; copied to ${path.basename(aside)}. Not starting, so nothing is overwritten.`);
        throw error;
      }
      console.error(`${name} can't be read (${e.message}); copied to ${path.basename(aside)} and loaded ${name}.bak instead.`);
      data = bak; mainBad = true;
    }
    return data;
  }
  function write(next) {
    if (next !== undefined) data = next;
    if (!data) data = {};
    writeAtomic(file(), JSON.stringify(data), !mainBad);   // never make the bad file the .bak
    mainBad = false;
  }
  const reset = () => { data = null; error = null; mainBad = false; };
  return { name, file, read, write, reset };
}

module.exports = { sideFile, parse, writeAtomic, SideFileError, dataDir };
