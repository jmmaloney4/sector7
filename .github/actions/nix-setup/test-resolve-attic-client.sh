#!/usr/bin/env bash
# Tests for resolve-attic-client.sh with a stub `nix`: the patched client is built
# from the local flake or, on a sparse checkout, from the same commit on GitHub;
# when it cannot be had the resolver and both callers fail unless the opt-out is set.
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

# Stub nix: `nix build --no-link --print-out-paths <installable>`. The patched
# installable builds only when FAKE_PATCHED=ok; otherwise it fails as nix would.
{
  printf '#!%s\n' "$BASH"
  cat <<'STUB'
echo "$*" >>"$FAKE_CALLS"
case "$4" in
  path:*#attic-client | github:*#attic-client)
    if [ "${FAKE_PATCHED:-}" = ok ]; then echo "$FAKE_ROOT/patched"; else
      printf 'warning: noise\n\033[31;1merror:\033[0m unable to download the flake tarball\n\n' >&2
      exit 1
    fi ;;
  nixpkgs#attic-client) echo "$FAKE_ROOT/stock" ;;
  *) exit 2 ;;
esac
STUB
} >"$work/bin/nix"
chmod +x "$work/bin/nix"

# A full checkout (has flake.nix) and a sparse one (git checkout, no flake.nix).
mkdir -p "$work/full" "$work/sparse/.github/actions"
touch "$work/full/flake.nix"
git -C "$work/sparse" init -q
git -C "$work/sparse" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --allow-empty -m sparse
git -C "$work/sparse" remote add origin https://github.com/jmmaloney4/sector7
rev="$(git -C "$work/sparse" rev-parse HEAD)"
mkdir -p "$work/nothing"

run() { # <root> <command...>: extra env as VAR=value before the command
  local root="$1"
  shift
  : >"$work/calls"
  env -u ATTIC_CLIENT_ALLOW_STOCK PATH="$work/bin:$PATH" FAKE_ROOT="$work" FAKE_CALLS="$work/calls" \
    SECTOR7_ROOT="$root" "$@" 2>"$work/stderr"
}
resolve() { # <root> [VAR=value ...]
  local root="$1"
  shift
  run "$root" "$@" bash "$resolver"
}

# Full checkout: the local flake.
[ "$(resolve "$work/full" FAKE_PATCHED=ok)" = "$work/patched/bin/attic" ] || fail "patched client from the local flake"
grep -q "path:$work/full#attic-client" "$work/calls" || fail "should build the local flake: $(cat "$work/calls")"
if grep -q '::' "$work/stderr"; then fail "no annotation when the patched client resolves: $(cat "$work/stderr")"; fi

# Sparse checkout: the same commit from GitHub.
[ "$(resolve "$work/sparse" FAKE_PATCHED=ok)" = "$work/patched/bin/attic" ] || fail "patched client on a sparse checkout: $(cat "$work/stderr") calls: $(cat "$work/calls")"
grep -q "github:jmmaloney4/sector7/$rev#attic-client" "$work/calls" || fail "should fetch the checkout's commit: $(cat "$work/calls")"
for url in https://github.com/jmmaloney4/sector7.git git@github.com:jmmaloney4/sector7.git; do
  git -C "$work/sparse" remote set-url origin "$url"
  resolve "$work/sparse" FAKE_PATCHED=ok >/dev/null || fail "origin $url"
  grep -q "github:jmmaloney4/sector7/$rev#attic-client" "$work/calls" || fail "origin $url: $(cat "$work/calls")"
done

# Negative control: the flake cannot be fetched. The resolver fails, names nix's
# error, prints no client and never builds the unpatched one.
if out="$(resolve "$work/sparse" FAKE_PATCHED=no)"; then fail "an unfetchable flake must fail, got '$out'"; fi
[ -z "$out" ] || fail "no client path on failure: $out"
grep -q '^::error::attic client: patched attic-client unavailable: nix build github:.*(rc=1): error: unable to download the flake tarball' "$work/stderr" ||
  fail "the error must carry nix's last error line: $(cat "$work/stderr")"
if grep -q 'nixpkgs#attic-client' "$work/calls"; then fail "must not build the unpatched client without the opt-out"; fi

# No flake and no commit to fetch: fails too.
if resolve "$work/nothing" FAKE_PATCHED=ok >/dev/null; then fail "nowhere to get the flake must fail"; fi
grep -q '::error::.*no flake.nix' "$work/stderr" || fail "should say there is no flake: $(cat "$work/stderr")"

# Opt-out: falls back with a warning naming the reason.
[ "$(resolve "$work/sparse" FAKE_PATCHED=no ATTIC_CLIENT_ALLOW_STOCK=1)" = "$work/stock/bin/attic" ] || fail "opt-out falls back to nixpkgs"
grep -q '^::warning::attic client: patched attic-client unavailable: .*unable to download the flake tarball.*ATTIC_CLIENT_ALLOW_STOCK=1' "$work/stderr" ||
  fail "opt-out must warn with the reason: $(cat "$work/stderr")"
[ "$(resolve "$work/sparse" FAKE_PATCHED=ok ATTIC_CLIENT_ALLOW_STOCK=1)" = "$work/patched/bin/attic" ] || fail "opt-out still prefers the patched client"

# Both callers fail the step when the patched client cannot be had, before logging in.
watch="${here}/start-attic-watch-store.sh"
push="${here}/../push-attic-cache/main.sh"
grep -F 'resolve-attic-client.sh' "$watch" >/dev/null || fail "start-attic-watch-store.sh should use the resolver"
grep -F 'resolve-attic-client.sh' "$push" >/dev/null || fail "push-attic-cache/main.sh should use the resolver"
creds=(INPUT_ATTIC_ENDPOINT=http://cache.invalid INPUT_ATTIC_CACHE=c INPUT_ATTIC_CACHE_NAME=c INPUT_ATTIC_TOKEN=t INPUT_FLAKE_ATTR=.#x HOME="$work")
if run "$work/sparse" FAKE_PATCHED=no "${creds[@]}" bash "$watch" >/dev/null; then fail "watch-store must fail without a patched client"; fi
grep -q '::error::attic client' "$work/stderr" || fail "watch-store failure must say why: $(cat "$work/stderr")"
if run "$work/sparse" FAKE_PATCHED=no "${creds[@]}" bash "$push" >/dev/null; then fail "push-attic-cache must fail without a patched client"; fi
grep -q '::error::attic client' "$work/stderr" || fail "push failure must say why: $(cat "$work/stderr")"
for f in "$watch" "$push"; do
  # shellcheck disable=SC2016 # a literal $( in the pattern
  if grep -q '\$(bash .*resolve-attic-client.sh.*|| true' "$f"; then fail "$f swallows a resolver failure"; fi
done

echo "resolve-attic-client ok"
