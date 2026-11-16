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

build() { # <installable> [timeout seconds]
  local installable="$1" limit="${2:-}" out=""
  if [ -n "$limit" ] && command -v timeout >/dev/null 2>&1; then
    out="$(timeout "$limit" nix build --no-link --print-out-paths "$installable" 2>/dev/null | head -n1 || true)"
  else
    out="$(nix build --no-link --print-out-paths "$installable" 2>/dev/null | head -n1 || true)"
  fi
  if [ -n "$out" ] && [ -x "$out/bin/attic" ]; then
    printf '%s\n' "$out/bin/attic"
    return 0
  fi
  return 1
}

if [ "${ATTIC_CLIENT_STOCK:-}" != 1 ]; then
  if build "path:${root}#attic-client" "$timeout_s"; then
    exit 0
  fi
  echo "patched attic-client unavailable; using nixpkgs' attic-client" >&2
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
