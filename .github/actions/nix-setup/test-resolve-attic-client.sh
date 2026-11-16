#!/usr/bin/env bash
# Tests for resolve-attic-client.sh with a stub `nix`: the patched client is
# preferred, the stock one is the fallback, and callers use the resolver.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
resolver="${here}/resolve-attic-client.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir -p "$work/bin" "$work/patched/bin" "$work/stock/bin"
for d in patched stock; do
  printf '#!/bin/sh\nexit 0\n' >"$work/$d/bin/attic"
  chmod +x "$work/$d/bin/attic"
done

# Stub nix: `nix build --no-link --print-out-paths <installable>`; the patched
# installable builds only when FAKE_PATCHED=ok.
{
  printf '#!%s\n' "$BASH"
  cat <<'EOF'
echo "$*" >>"$FAKE_CALLS"
case "$4" in
  path:*#attic-client) [ "${FAKE_PATCHED:-}" = ok ] && echo "$FAKE_ROOT/patched" || exit 1 ;;
  nixpkgs#attic-client) echo "$FAKE_ROOT/stock" ;;
  *) exit 2 ;;
esac
EOF
} >"$work/bin/nix"
chmod +x "$work/bin/nix"

resolve() { # extra env as VAR=value args
  : >"$work/calls"
  env "$@" PATH="$work/bin:$PATH" FAKE_ROOT="$work" FAKE_CALLS="$work/calls" SECTOR7_ROOT=/repo \
    bash "$resolver" 2>/dev/null
}

[ "$(resolve FAKE_PATCHED=ok)" = "$work/patched/bin/attic" ] || fail "patched client should win when it builds"
grep -q 'path:/repo#attic-client' "$work/calls" || fail "patched build should target the root flake: $(cat "$work/calls")"

[ "$(resolve FAKE_PATCHED=no)" = "$work/stock/bin/attic" ] || fail "a failed patched build should fall back to nixpkgs"
grep -q 'nixpkgs#attic-client' "$work/calls" || fail "fallback should build nixpkgs#attic-client"

[ "$(resolve FAKE_PATCHED=ok ATTIC_CLIENT_STOCK=1)" = "$work/stock/bin/attic" ] || fail "ATTIC_CLIENT_STOCK=1 should skip the patched build"
if grep -q 'path:' "$work/calls"; then fail "ATTIC_CLIENT_STOCK=1 must not build the patched client"; fi

# Both callers resolve through the shared script.
grep -F 'resolve-attic-client.sh' "${here}/start-attic-watch-store.sh" >/dev/null ||
  fail "start-attic-watch-store.sh should use the resolver"
grep -F 'resolve-attic-client.sh' "${here}/../push-attic-cache/main.sh" >/dev/null ||
  fail "push-attic-cache/main.sh should use the resolver"

echo "resolve-attic-client ok"
