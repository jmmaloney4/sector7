#!/usr/bin/env bash
# Tests for mark-build-first.sh. Needs only bash and jq; no Nix, no GitHub.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
order="$here/mark-build-first.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
names() { jq -r 'map("\(.category).\(.name)") | join(" ")'; }
firsts() { jq -r 'map(.first | tostring) | join(" ")'; }

m='[
 {"category":"checks","name":"a-tests"},
 {"category":"checks","name":"b-lint"},
 {"category":"packages","name":"rust-test-deps"},
 {"category":"checks","name":"c-tests"},
 {"category":"packages","name":"other"}
]'

got="$(BUILD_FIRST=$'packages.rust-test-deps' "$order" <<<"$m" 2>/dev/null | names)"
[ "$got" = "packages.rust-test-deps checks.a-tests checks.b-lint checks.c-tests packages.other" ] ||
  fail "exact pattern: $got"

# earlier pattern wins; glob spans entries; unmatched keep original order
got="$(BUILD_FIRST=$'packages.rust-test-deps\nchecks.*-tests' "$order" <<<"$m" 2>/dev/null | names)"
[ "$got" = "packages.rust-test-deps checks.a-tests checks.c-tests checks.b-lint packages.other" ] ||
  fail "glob ordering: $got"

# the first flag is true exactly for matched entries
got="$(BUILD_FIRST=$'packages.rust-test-deps\nchecks.*-tests' "$order" <<<"$m" 2>/dev/null | firsts)"
[ "$got" = "true true true false false" ] || fail "first flags: $got"

# no patterns: identical bytes in, identical value out
[ "$(BUILD_FIRST= "$order" <<<"$m" | jq -c .)" = "$(jq -c . <<<"$m")" ] || fail "empty patterns changed matrix"
[ "$(env -u BUILD_FIRST "$order" <<<"$m" | jq -c .)" = "$(jq -c . <<<"$m")" ] || fail "unset patterns changed matrix"

# empty matrix stays empty
[ "$(BUILD_FIRST=x "$order" <<<'[]')" = "[]" ] || fail "empty matrix"

# only reorders: same multiset of entries
a="$(jq -c 'sort_by(.category,.name)' <<<"$m")"
b="$(BUILD_FIRST=$'checks.*-tests' "$order" <<<"$m" 2>/dev/null | jq -c 'map(del(.first)) | sort_by(.category,.name)')"
[ "$a" = "$b" ] || fail "entries were added, dropped or edited"

# dots in a pattern are literal; whitespace and blank lines are tolerated
got="$(BUILD_FIRST=$'  \n  packages.other  \r\n' "$order" <<<"$m" 2>/dev/null | names)"
[ "$got" = "packages.other checks.a-tests checks.b-lint packages.rust-test-deps checks.c-tests" ] ||
  fail "whitespace handling: $got"

# a pattern matching nothing warns on stderr but succeeds
err="$(BUILD_FIRST='packages.nope' "$order" <<<"$m" 2>&1 >/dev/null)"
case $err in *"matched no entry"*) ;; *) fail "no warning for unmatched pattern" ;; esac

echo "ok"
