#!/usr/bin/env bash
# Print the absolute path of the attic client binary to use, on stdout.
#
# The client is this repo's patched build (`packages.<system>.attic-client` in the
# root flake: stock attic plus the bounded-NAR-channel patch, zhaofengli/attic#362).
# Stock attic hands every NAR to the upload through an unbounded channel, so a
# multi-GiB path grows the client to that size and OOM-kills the runner pod
# (room-of-requirement/seven#378). Both nix-setup's `watch-store` and
# push-attic-cache's `attic push` resolve their client here.
#
# Where the flake comes from: the sector7 checkout at SECTOR7_ROOT when it holds
# flake.nix, else the same commit fetched from GitHub. The reusable workflows check
# sector7 out sparsely (/.github/actions/ only, zeus#5442), so the local tree has no
# flake: building `path:` there failed on every job from 2026-11-16 and fell back to
# stock attic unnoticed. The client is in the binary cache once sector7's own CI has
# built that commit, so this normally substitutes rather than compiles.
#
# If the patched client cannot be had, this FAILS (exit 1, ::error:: with nix's last
# error line), because the fallback brings back a known runner OOM. A warning on
# every run reads as normal, and that is how the fallback stayed on for three days.
# ATTIC_CLIENT_ALLOW_STOCK=1 is the emergency opt-out: fall back to nixpkgs'
# attic-client with a ::warning::.
#
# Environment (all optional):
#   SECTOR7_ROOT                   the sector7 checkout (default: three levels up)
#   ATTIC_CLIENT_ALLOW_STOCK=1     fall back to nixpkgs' attic-client instead of failing
#   ATTIC_PATCHED_BUILD_TIMEOUT    seconds allowed for the patched build (default 1800)
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${SECTOR7_ROOT:-$(cd "$here/../../.." && pwd)}"
timeout_s="${ATTIC_PATCHED_BUILD_TIMEOUT:-1800}"

# The installable for the patched client on stdout, or fail with build_why set.
build_why=""
patched_installable() {
  if [ -f "$root/flake.nix" ]; then
    printf 'path:%s#attic-client\n' "$root"
    return 0
  fi
  local url rev
  url="$(git -C "$root" config --get remote.origin.url 2>/dev/null)" || url=""
  rev="$(git -C "$root" rev-parse --verify HEAD 2>/dev/null)" || rev=""
  [[ $rev =~ ^[0-9a-f]{40}$ ]] || return 1
  # Match the URL last: each [[ =~ ]] overwrites BASH_REMATCH.
  # Trailing slashes on the remote URL (https://github.com/o/r/) are allowed.
  [[ $url =~ github\.com[:/]([^/]+)/([^/]+)/*$ ]] || return 1
  printf 'github:%s/%s/%s#attic-client\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]%.git}" "$rev"
}

# Sets build_why on failure, with nix's last error line.
build() { # <installable> [timeout seconds]
  local installable="$1" limit="${2:-}" out="" rc=0 tmp err last
  tmp="$(mktemp)"
  err="$(mktemp)"
  if [ -n "$limit" ] && command -v timeout >/dev/null 2>&1; then
    timeout "$limit" nix build --no-link --print-out-paths "$installable" >"$tmp" 2>"$err" || rc=$?
  else
    nix build --no-link --print-out-paths "$installable" >"$tmp" 2>"$err" || rc=$?
  fi
  out="$(head -n1 "$tmp")"
  # A literal ESC byte: `\x1b` in a sed pattern is a GNU extension, not POSIX.
  last="$(sed "s/$(printf '\033')\[[0-9;]*m//g" "$err" | grep -v '^[[:space:]]*$' | tail -n1 | cut -c1-300)"
  rm -f "$tmp" "$err"
  if [ "$rc" -eq 0 ] && [ -n "$out" ] && [ -x "$out/bin/attic" ]; then
    printf '%s\n' "$out/bin/attic"
    return 0
  fi
  if [ "$rc" -eq 124 ]; then
    build_why="$installable timed out after ${limit}s"
  elif [ "$rc" -ne 0 ]; then
    build_why="nix build $installable failed (rc=$rc): ${last:-no error output}"
  else
    build_why="nix build $installable printed no usable attic binary"
  fi
  return 1
}

if installable="$(patched_installable)"; then
  if build "$installable" "$timeout_s"; then
    exit 0
  fi
else
  build_why="no flake.nix in $root and no GitHub origin and commit to fetch one from"
fi

if [ "${ATTIC_CLIENT_ALLOW_STOCK:-}" != 1 ]; then
  echo "::error::attic client: patched attic-client unavailable: ${build_why}. Refusing nixpkgs' unpatched client, whose unbounded NAR buffering OOM-kills runners (seven#378); allow-unpatched-attic-client overrides this." >&2
  exit 1
fi
echo "::warning::attic client: patched attic-client unavailable: ${build_why}. ATTIC_CLIENT_ALLOW_STOCK=1, so using nixpkgs' unpatched attic-client (unbounded NAR buffering; seven#378)" >&2

if build "nixpkgs#attic-client"; then
  exit 0
fi
# Last resort: whatever is on PATH.
if command -v attic >/dev/null 2>&1; then
  command -v attic
  exit 0
fi
echo "::error::attic client: no attic client at all: ${build_why}" >&2
exit 1
