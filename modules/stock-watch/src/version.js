'use strict';
/*
 * Which build is running (SW-056): the app version from package.json and the git commit it was built from.
 * Shown by /health, /status, /api/report (`app`) and the page footer, so after a deploy anyone can check the
 * live SHA against docs/DEVLOG.md.
 *
 * Commit, first found wins:
 *   1. RAILWAY_GIT_COMMIT_SHA  Railway sets it on deploys from GitHub
 *   2. BUILD_SHA               env, e.g. set by hand on a Railway service
 *   3. BUILD_SHA file          next to package.json, written at deploy: `npm run stamp` at the repo root (refuses a
 *                              tree with uncommitted changes), `railway up`, then delete it (docs/RUNBOOK.md). Not in
 *                              .gitignore on purpose: `railway up` leaves out ignored files. The Dockerfile copies it.
 *   none                       sha null, the footer says "dev"
 * Only hex is kept (a SHA, nothing else ends up in an open endpoint); 7..40 characters, shown as 7.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const clean = (x) => { const m = String(x || '').trim().match(/^[0-9a-f]{7,40}$/i); return m ? m[0].toLowerCase() : null; };
function fileSha(dir = ROOT) { try { return clean(fs.readFileSync(path.join(dir, 'BUILD_SHA'), 'utf8')); } catch { return null; } }

/** { version, sha (full, or null), short (7 characters, or null) } for this process. env and dir for tests. */
function info(env = process.env, dir = ROOT) {
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  const sha = clean(env.RAILWAY_GIT_COMMIT_SHA) || clean(env.BUILD_SHA) || fileSha(dir);
  return { version, sha, short: sha ? sha.slice(0, 7) : null };
}

let cached = null;
/** Read once per process: a build doesn't change while it runs. */
const current = () => cached || (cached = info());

module.exports = { info, current, clean };
