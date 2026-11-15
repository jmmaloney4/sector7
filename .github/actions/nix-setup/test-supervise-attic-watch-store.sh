#!/usr/bin/env bash
# Tests for supervise-attic-watch-store.sh with a stub attic client: the data
# cap reaches the watcher, a crashed watcher is restarted, and the supervisor
# gives up after the restart budget. Does not talk to a server.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
supervisor="${here}/supervise-attic-watch-store.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Stub: records `ulimit -d` and its arguments, crashes (rc 134, as an abort
# does) until the counter file reaches $STUB_CRASHES, then exits cleanly.
cat >"$work/attic" <<'EOF'
#!/usr/bin/env bash
n=$(($(cat "$STUB_COUNT" 2>/dev/null || echo 0) + 1))
echo "$n" >"$STUB_COUNT"
echo "run $n limit=$(ulimit -d) args=$*"
if [ "$n" -le "$STUB_CRASHES" ]; then exit 134; fi
exit 0
EOF
chmod +x "$work/attic"

run() { # crashes max_restarts
  rm -f "$work/count" "$work/log"
  STUB_COUNT="$work/count" STUB_CRASHES="$1" \
    ATTIC_BIN="$work/attic" ATTIC_TARGET="ci:cache" ATTIC_LOG="$work/log" \
    ATTIC_WATCH_MAX_DATA_KB=1234567 ATTIC_WATCH_MAX_RESTARTS="$2" ATTIC_WATCH_RESTART_DELAY=0 \
    bash "$supervisor"
}

run 2 5
[ "$(cat "$work/count")" = 3 ] || fail "2 crashes should give 3 runs, got $(cat "$work/count")"
grep -q 'args=watch-store -j 1 ci:cache' "$work/log" || fail "watcher should run with -j 1: $(cat "$work/log")"
if [ "$(uname -s)" = Linux ]; then
  # Only Linux enforces RLIMIT_DATA; macOS refuses ulimit -d, which the script
  # reports and survives (the other branch).
  grep -q 'run 1 limit=1234567 ' "$work/log" || fail "watcher should run with the data cap: $(cat "$work/log")"
else
  grep -q 'runs uncapped' "$work/log" || fail "a refused ulimit should be reported: $(cat "$work/log")"
fi
grep -q 'exited rc=134 (restart 2 of 5' "$work/log" || fail "restarts should be logged: $(cat "$work/log")"
grep -q 'exited cleanly' "$work/log" || fail "clean exit should be logged"

run 99 3
[ "$(cat "$work/count")" = 3 ] || fail "restart budget 3 should stop after 3 runs, got $(cat "$work/count")"
grep -q 'gave up after 3 restarts' "$work/log" || fail "give-up should be logged: $(cat "$work/log")"

# The start script must hand the watcher to the supervisor, not run it bare.
grep -F 'supervise-attic-watch-store.sh' "${here}/start-attic-watch-store.sh" >/dev/null ||
  fail "start-attic-watch-store.sh should launch the supervisor"
# shellcheck disable=SC2016
if grep -F 'setsid "$attic" watch-store' "${here}/start-attic-watch-store.sh" >/dev/null; then
  fail "start-attic-watch-store.sh must not run attic watch-store uncapped"
fi

echo "supervise-attic-watch-store ok"
