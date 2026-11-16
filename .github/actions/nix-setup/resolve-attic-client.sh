#!/usr/bin/env bash
# Print the absolute path of the attic client binary to use, on stdout.
#
# Order: this repo's patched build (`packages.<system>.attic-client` in the root
# flake: stock attic plus the bounded-NAR-channel patch, zhaofengli/attic#362),
# then nixpkgs' attic-client. Stock attic hands every NAR to the upload through
# an unbounded channel, so a multi-GiB path grows the client to that size and
# OOM-kills the runner pod (room-of-requirement/seven#378). Both nix-setup's
# `watch-store` and push-attic-cache's `attic push` resolve their client here.
#
# The patched build compiles attic once per node store (the runners use the host
# daemon, so its cost is the host's, not the pod's); it is bounded by a timeout
# and never fails the caller: if it cannot be had, the stock client is used and
# the supervisor's memory cap still protects the runner.
#
# Environment (all optional):
#   SECTOR7_ROOT                   repo root holding flake.nix (default: three levels up)
#   ATTIC_CLIENT_STOCK=1           skip the patched build
#   ATTIC_PATCHED_BUILD_TIMEOUT    seconds allowed for the patched build (default 900)
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${SECTOR7_ROOT:-$(cd "$here/../../.." && pwd)}"
timeout_s="${ATTIC_PATCHED_BUILD_TIMEOUT:-900}"

# Sets build_why on failure: "timed out after Ns" or "nix build failed (rc=N)".
build_why=""
build() { # <installable> [timeout seconds]
  local installable="$1" limit="${2:-}" out="" rc=0 tmp
  tmp="$(mktemp)"
  if [ -n "$limit" ] && command -v timeout >/dev/null 2>&1; then
    timeout "$limit" nix build --no-link --print-out-paths "$installable" >"$tmp" 2>/dev/null || rc=$?
  else
    nix build --no-link --print-out-paths "$installable" >"$tmp" 2>/dev/null || rc=$?
  fi
  out="$(head -n1 "$tmp")"
  rm -f "$tmp"
  if [ "$rc" -eq 0 ] && [ -n "$out" ] && [ -x "$out/bin/attic" ]; then
    printf '%s\n' "$out/bin/attic"
    return 0
  fi
  if [ "$rc" -eq 124 ]; then
    build_why="timed out after ${limit}s"
  elif [ "$rc" -ne 0 ]; then
    build_why="nix build failed (rc=$rc)"
  else
    build_why="nix build printed no usable attic binary"
  fi
  return 1
}

# Falling back is never silent: stock attic buffers a whole NAR in memory when
# the upload lags, which is what OOM-killed the runner pod (seven#378), so a job
# that runs on it must say so. A warning rather than a failure: the push is
# best-effort and the supervisor's memory cap still protects the runner, whereas
# failing here would turn a cold node's slow first compile into a failed job.
if [ "${ATTIC_CLIENT_STOCK:-}" = 1 ]; then
  echo "::warning::attic client: ATTIC_CLIENT_STOCK=1, using nixpkgs' unpatched attic-client (unbounded NAR buffering; seven#378)" >&2
else
  if build "path:${root}#attic-client" "$timeout_s"; then
    exit 0
  fi
  echo "::warning::attic client: patched attic-client unavailable (${build_why}); using nixpkgs' unpatched attic-client (unbounded NAR buffering; seven#378)" >&2
fi

if build "nixpkgs#attic-client"; then
  exit 0
fi
# Last resort: whatever is on PATH.
if command -v attic >/dev/null 2>&1; then
  command -v attic
  exit 0
fi
exit 1
