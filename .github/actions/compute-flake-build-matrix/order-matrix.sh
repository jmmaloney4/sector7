#!/usr/bin/env bash
# Reorder a build matrix so the caller's priority targets are dispatched first.
#
# stdin : matrix include JSON array (objects with .category and .name)
# env   : BUILD_FIRST  newline-delimited shell globs, matched against
#                      "<category>.<name>" (e.g. "packages.rust-test-deps",
#                      "checks.*-tests"). `*` matches any characters, dots included.
# stdout: the same array, stably sorted: entries matching an earlier pattern
#         come first, unmatched entries keep their original relative order last.
#
# Why: with strategy.max-parallel, GitHub starts matrix jobs in array order. A
# check that depends on a shared, expensive derivation (a Rust dependency
# build) blocks on the daemon's lock for it, holding a runner slot idle. Putting
# the shared build first means the dependents start once it is already built.
#
# Only order changes: never drops, duplicates or edits an entry. A pattern that
# matches nothing is reported on stderr and is not an error: an uncached-only
# matrix legitimately omits a target that is already cached.
set -euo pipefail

matrix="$(cat)"
patterns=()
while IFS= read -r line; do
  line="${line//$'\r'/}"
  # trim surrounding whitespace
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -n "$line" ] && patterns+=("$line")
done <<<"${BUILD_FIRST:-}"

if [ "${#patterns[@]}" -eq 0 ] || [ "$(jq 'length' <<<"$matrix")" -eq 0 ]; then
  printf '%s\n' "$matrix"
  exit 0
fi

none=${#patterns[@]}
ranks=()
matched=()
for ((i = 0; i < none; i++)); do matched[i]=0; done
while IFS= read -r key; do
  rank=$none
  for ((i = 0; i < none; i++)); do
    # shellcheck disable=SC2053 # unquoted on purpose: the pattern is a glob
    if [[ $key == ${patterns[i]} ]]; then
      rank=$i
      matched[i]=1
      break
    fi
  done
  ranks+=("$rank")
done < <(jq -r '.[] | "\(.category).\(.name)"' <<<"$matrix")

for ((i = 0; i < none; i++)); do
  if [ "${matched[i]}" -eq 0 ]; then
    echo "build-first: pattern '${patterns[i]}' matched no entry in this matrix (already cached or misspelled)" >&2
  fi
done

ranks_json="$(printf '%s\n' "${ranks[@]}" | jq -s -c .)"
jq -c --argjson ranks "$ranks_json" '[., $ranks] | transpose | sort_by(.[1]) | map(.[0])' <<<"$matrix"
