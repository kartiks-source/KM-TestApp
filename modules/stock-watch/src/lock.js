'use strict';
/*
 * One app per data folder (SW-055, ADR-0012). DATA_DIR/instance.lock holds { id, pid, host, startedAt, beatAt }.
 * The holder rewrites beatAt every 30 s. A lock with no heartbeat for 2 minutes is stale and the next instance takes it
 * over; a clean stop (SIGTERM) removes it, so a redeploy takes over at once. Until it holds the lock, an instance only
 * reads: server.js refuses every write with 503 and the reason, and starts no pulls, backups or digests.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const STALE_MS = 2 * 60e3;
const BEAT_MS = 30e3;
const FILE = 'instance.lock';

function make(dir, { now = () => Date.now() } = {}) {
  const file = path.join(dir, FILE);
  const me = { id: crypto.randomBytes(8).toString('hex'), pid: process.pid, host: os.hostname(), startedAt: now() };
  let held = false, other = null, failed = null;
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const write = () => {
    const tmp = `${file}.${me.id}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...me, beatAt: now() }));
    fs.renameSync(tmp, file);
  };

  /** Take the lock when it is free, stale or ours. Returns true when this instance holds it. */
  function acquire() {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the write below says why */ }
    const cur = read();
    if (cur && cur.id !== me.id && now() - (+cur.beatAt || 0) < STALE_MS) { held = false; other = cur; return false; }
    try {
      if (!cur && !fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ ...me, beatAt: now() }), { flag: 'wx' });
      else write();
    } catch (e) {
      if (e.code === 'EEXIST') return acquire();
      held = true; failed = e.code || e.message;   // the folder can't be written at all: no other copy can write either; saving fails on its own and /health says so
      return true;
    }
    const after = read();   // two starting at once: the last rename wins, the other sees it and stays read-only
    held = !!after && after.id === me.id; other = held ? null : after;
    return held;
  }
  /** Heartbeat: rewrite beatAt while we hold it; if another instance took it over, stop writing. Not holding: try again. */
  function beat() {
    if (!held) return acquire();
    const cur = read();
    if (cur && cur.id !== me.id) { held = false; other = cur; return false; }
    try { write(); } catch (e) { failed = e.code || e.message; }
    return true;
  }
  function release() {
    if (!held) return;
    const cur = read();
    if (cur && cur.id === me.id) { try { fs.unlinkSync(file); } catch { /* gone already */ } }
    held = false;
  }
  /** Plain words for the page, the log and the 503: why this instance doesn't write. Never a path or a secret. */
  function reason() {
    if (held) return null;
    const o = other || read();
    if (!o) return 'Starting: waiting for the data folder lock';
    const ago = Math.max(0, Math.round((now() - (+o.beatAt || 0)) / 1000));
    return `Another copy of the app is using this data folder (process ${o.pid} on ${String(o.host).slice(0, 40)}, seen ${ago} s ago). This copy only reads until that one stops or goes quiet for 2 minutes.`;
  }
  return { acquire, beat, release, reason, held: () => held, failed: () => failed, file, me };
}

module.exports = { make, STALE_MS, BEAT_MS, FILE };
