'use strict';
/* SW-053: runs the POSIX shell test of the container entrypoint (stubs for id, stat, chown, su-exec). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const sh = ['/bin/sh', '/usr/bin/sh'].find((p) => fs.existsSync(p));
test('container entrypoint: root chowns DATA_DIR once and drops to node; non-root just runs', { skip: !sh && 'no /bin/sh' }, () => {
  const r = spawnSync(sh, [path.join(__dirname, 'entrypoint.test.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /3 cases pass/);
});

test('Dockerfile: base image pinned by digest, entrypoint under tini, no USER root left running the app', () => {
  const df = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Dockerfile'), 'utf8');
  assert.match(df, /^FROM node:22\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}$/m);
  assert.match(df, /apk add --no-cache tini su-exec/);
  assert.match(df, /ENTRYPOINT \["\/sbin\/tini", "--", "\/app\/entrypoint\.sh"\]/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'entrypoint.sh'), 'utf8'), /exec su-exec node "\$@"/);
});
