#!/usr/bin/env bash
# Tests for split-matrix.sh and gate-verdict.sh. Needs only bash and jq.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
split() { bash "$here/split-matrix.sh"; }
gate() { bash "$here/gate-verdict.sh"; }

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# entries <count> <category> [extra jq object]: names sort in creation order
entries() {
  jq -nc --argjson n "$1" --arg c "$2" --argjson extra "${3:-{\}}" \
    '[range($n) | {category: $c, system: "x", name: "t\(. + 100000)", flake_attr: "a"} + $extra]'
}
output() { sed -n "s/^$2=//p" <<<"$1"; }
len() { jq 'length' <<<"$1"; }

for case in "255 255 0" "256 256 0" "257 256 1"; do
  read -r total kept deferred <<<"$case"
  out="$(split <<<"$(entries "$total" checks)")"
  [ "$(len "$(output "$out" build_matrix_include)")" = "$kept" ] || fail "$total: kept"
  [ "$(output "$out" deferred_count)" = "$deferred" ] || fail "$total: deferred count"
  [ "$(output "$out" build_has_work)" = true ] || fail "$total: has work"
done

# The real shape: 204 checks and 57 packages. Every check fits; packages take the rest.
packages="$(entries 57 packages)"
checks="$(entries 204 checks)"
out="$(split <<<"$(jq -c --argjson c "$checks" '. + $c' <<<"$packages")")"
build="$(output "$out" build_matrix_include)"
[ "$(jq '[.[] | select(.category == "checks")] | length' <<<"$build")" = 204 ] || fail "checks first"
[ "$(jq '[.[] | select(.category == "packages")] | length' <<<"$build")" = 52 ] || fail "packages after checks"
[ "$(jq -r '.[0].category, .[203].category, .[204].category' <<<"$build" | tr '\n' ' ')" = "checks checks packages " ] ||
  fail "check order"
[ "$(output "$out" deferred_count)" = 5 ] || fail "261 defers 5"
[ "$(output "$out" deferred_names)" = "packages.t100052, packages.t100053, packages.t100054, packages.t100055, packages.t100056" ] ||
  fail "deferred names: $(output "$out" deferred_names)"

# The order does not depend on the input's.
a="$(jq -c 'reverse' <<<"$checks" | split | grep '^build_matrix_include=')"
b="$(split <<<"$checks" | grep '^build_matrix_include=')"
[ "$a" = "$b" ] || fail "order depends on input order"

# No target is lost: kept and deferred add up, with a limit per matrix, not overall.
mixed="$(jq -nc --argjson a "$(entries 300 checks)" --argjson f "$(entries 258 packages '{"first":true}')" \
  --argjson i "$(entries 257 packages '{"is_image":true}')" '$a + $f + $i')"
out="$(split <<<"$mixed")"
[ "$(len "$(output "$out" first_matrix_include)")" = 256 ] || fail "first capped"
[ "$(len "$(output "$out" build_matrix_include)")" = 256 ] || fail "build capped"
[ "$(len "$(output "$out" image_matrix)")" = 256 ] || fail "images capped"
[ "$(output "$out" deferred_count)" = $((2 + 44 + 1)) ] || fail "deferred across matrices"
[ "$(tr -cd ',' <<<"$(output "$out" deferred_names)" | wc -c | tr -d ' ')" = 46 ] || fail "47 names"
[ "$(jq -r '.[0] | type' <<<"$(output "$out" image_matrix)")" = string ] || fail "images are names"

# Build-first keeps the caller's order; it is not re-sorted.
out="$(split <<<"$(jq -c 'reverse' <<<"$(entries 3 packages '{"first":true}')")")"
[ "$(jq -r 'map(.name) | join(" ")' <<<"$(output "$out" first_matrix_include)")" = "t100002 t100001 t100000" ] ||
  fail "first-stage order"

# Empty matrix: nothing to do, nothing deferred.
out="$(split <<<'[]')"
for k in first_matrix_include build_matrix_include image_matrix; do
  [ "$(output "$out" "$k")" = "[]" ] || fail "empty $k"
done
[ "$(output "$out" build_has_work)" = false ] || fail "empty has_work"
[ "$(output "$out" deferred_count)" = 0 ] || fail "empty deferred"

# Input that is not a matrix fails instead of producing empty outputs.
if split <<<'{"not":"an array"}' >/dev/null 2>&1; then fail "accepted a non-array"; fi

# Every value stays on one line, as $GITHUB_OUTPUT needs.
[ "$(split <<<"$checks" | wc -l | tr -d ' ')" = 7 ] || fail "seven output lines"

needs() {
  jq -nc --arg d "$1" --arg b "$2" --argjson o "$3" \
    '{detect: {result: $d, outputs: $o}, "build-first": {result: "skipped", outputs: {}}, build: {result: $b, outputs: {}}}'
}
passes() { NEEDS="$1" gate >/dev/null 2>&1; }

passes "$(needs success success '{"deferred_count":"0"}')" || fail "clean run must pass"
passes "$(needs success skipped '{"deferred_count":"0"}')" || fail "nothing to build must pass"

# The negative control: every job green, but something was left out.
deferred="$(needs success success '{"deferred_count":"5","deferred_names":"packages.a, packages.b"}')"
if passes "$deferred"; then fail "a deferred run passed the gate"; fi
err="$(NEEDS="$deferred" gate 2>&1 >/dev/null || true)"
case $err in *"5 target(s)"*) ;; *) fail "count not named: $err" ;; esac
case $err in *"packages.a, packages.b"*) ;; *) fail "names not listed: $err" ;; esac
case $err in *"Re-run all jobs"*) ;; *) fail "no way forward: $err" ;; esac

if passes "$(needs success success '{}')"; then fail "a missing count passed"; fi
if passes "$(needs success success '{"deferred_count":"many"}')"; then fail "a non-number passed"; fi
if passes "$(needs success failure '{"deferred_count":"0"}')"; then fail "a failed build passed"; fi
if passes "$(needs failure skipped '{}')"; then fail "a failed detect passed"; fi
err="$(NEEDS="$(needs failure skipped '{}')" gate 2>&1 >/dev/null || true)"
case $err in *"detect=failure"*) ;; *) fail "failed job not named: $err" ;; esac

echo "ok"
