#!/bin/sh
# SW-053: the container entrypoint's logic, with id / stat / chown / su-exec stubbed (no docker needed).
# Run: sh test/entrypoint.test.sh (npm test runs it through test/entrypoint.test.js). Exit 0 = pass.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
EP="$HERE/../scripts/entrypoint.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
# stubs: FAKE_UID = who we are; FAKE_OWNER = owner uid of DATA_DIR; each call is logged to $T/calls
cat > "$T/bin/id" <<'S'
#!/bin/sh
if [ "${2:-}" = "node" ]; then echo 1000; else echo "$FAKE_UID"; fi
S
cat > "$T/bin/stat" <<'S'
#!/bin/sh
echo "$FAKE_OWNER"
S
cat > "$T/bin/chown" <<'S'
#!/bin/sh
echo "chown $*" >> "$CALLS"
S
cat > "$T/bin/su-exec" <<'S'
#!/bin/sh
echo "su-exec $*" >> "$CALLS"
S
cat > "$T/bin/app" <<'S'
#!/bin/sh
echo "app $*" >> "$CALLS"
S
chmod +x "$T/bin/"*
fail() { echo "FAIL: $1"; echo "--- calls:"; cat "$CALLS" 2>/dev/null || true; exit 1; }
run() { CALLS="$T/calls"; : > "$CALLS"; export CALLS; PATH="$T/bin:$PATH" DATA_DIR="$T/data" sh "$EP" app server.js 2>/dev/null; }

# 1. root, volume owned by root: chown once, then drop to node
FAKE_UID=0 FAKE_OWNER=0; export FAKE_UID FAKE_OWNER; run
grep -qx "chown -R node:node $T/data" "$CALLS" || fail "root + root-owned volume: chown expected"
grep -qx "su-exec node app server.js" "$CALLS" || fail "root: su-exec node expected"
grep -q "^app " "$CALLS" && fail "root: must not run the app as root"
[ -d "$T/data" ] || fail "root: DATA_DIR made"

# 2. root, volume already node's: no chown, still drops
FAKE_UID=0 FAKE_OWNER=1000; run
grep -q "^chown" "$CALLS" && fail "already node's: no chown"
grep -qx "su-exec node app server.js" "$CALLS" || fail "already node's: su-exec expected"

# 3. not root: just run, no chown, no su-exec
FAKE_UID=1000 FAKE_OWNER=0; run
grep -qx "app server.js" "$CALLS" || fail "non-root: app runs as is"
grep -q "^chown\|^su-exec" "$CALLS" && fail "non-root: no chown, no su-exec"

echo "entrypoint: 3 cases pass"
