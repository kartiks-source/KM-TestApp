#!/bin/sh
# Stock-out Watch container entrypoint (SW-053). Runs under tini (Dockerfile ENTRYPOINT), then the CMD.
# Started as root (Railway sets RAILWAY_RUN_UID=0; its volumes mount root-owned): make DATA_DIR belong to the
# `node` user once (only while the folder isn't node's yet), then drop to `node` with su-exec.
# Started as any other user: just run the command.
set -eu
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
    echo "entrypoint: giving $DATA_DIR to user node (once)" >&2
    chown -R node:node "$DATA_DIR"
  fi
  exec su-exec node "$@"
fi
exec "$@"
