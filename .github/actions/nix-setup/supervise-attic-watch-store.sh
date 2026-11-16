#!/usr/bin/env bash
# Run `attic watch-store` under a memory cap, restarting it when the cap kills it.
#
# Why: the attic client hands each NAR from the Nix C++ side to the HTTP upload
# through an unbounded channel (attic/src/nix_store/bindings/mod.rs,
# AsyncWriteAdapter), so when the upload is slower than the NAR dump a whole
# large path piles up in the client's heap. Upstream tracks the growth as
# zhaofengli/attic#233 (watch-store memory grows with bytes uploaded) and has
# no fix. In a job that builds a multi-GiB output the watcher reached the
# runner pod's memory.max (about 5 GiB) and the kernel's memory-cgroup OOM kill
# took Runner.Listener and Runner.Worker with it: GitHub reports "runner lost
# communication" (room-of-requirement/seven#378, zeus#4776).
#
# What this does: `ulimit -d` caps the watcher's data segment (brk plus private
# writable mappings, which Linux enforces since 4.7). Hitting the cap makes
# allocation fail and the Rust client aborts, so only the watcher dies, never
# the runner. The loop then starts a new watcher. A new watcher only sees paths
# that appear afterwards, so the path that blew the cap is not pushed by this
# job: acceptable because watch-store is best-effort and the per-job attic probe
# caches a path the next run needs.
#
# Environment (all set by start-attic-watch-store.sh):
#   ATTIC_BIN      absolute path of the attic client
#   ATTIC_TARGET   "<server>:<cache>"
#   ATTIC_LOG      file the watcher's output is appended to
#   ATTIC_WATCH_MAX_DATA_KB     cap per watcher in KiB (default 2 GiB)
#   ATTIC_WATCH_MAX_RESTARTS    give up after this many restarts (default 20)
#   ATTIC_WATCH_RESTART_DELAY   seconds between restarts (default 5)
set -u

attic="${ATTIC_BIN:?ATTIC_BIN not set}"
target="${ATTIC_TARGET:?ATTIC_TARGET not set}"
log="${ATTIC_LOG:?ATTIC_LOG not set}"
limit_kb="${ATTIC_WATCH_MAX_DATA_KB:-2097152}"
max_restarts="${ATTIC_WATCH_MAX_RESTARTS:-20}"
delay="${ATTIC_WATCH_RESTART_DELAY:-5}"

restarts=0
while :; do
  (
    # A failed ulimit means the cap is not in force; start uncapped rather
    # than not at all, and say so, because the cap is the point of this script.
    ulimit -d "$limit_kb" || echo "could not set ulimit -d $limit_kb; attic watch-store runs uncapped" >&2
    exec "$attic" watch-store -j 1 "$target"
  ) </dev/null >>"$log" 2>&1
  rc=$?
  # Exit 0 means the watcher ended on its own (not a crash): nothing to restart.
  if [ "$rc" -eq 0 ]; then
    echo "attic watch-store exited cleanly" >>"$log"
    exit 0
  fi
  restarts=$((restarts + 1))
  echo "attic watch-store exited rc=$rc (restart $restarts of $max_restarts; cap ${limit_kb} KiB)" >>"$log"
  if [ "$restarts" -ge "$max_restarts" ]; then
    echo "attic watch-store gave up after $restarts restarts" >>"$log"
    exit 0
  fi
  sleep "$delay"
done
