#!/usr/bin/env bash
# Mark the caller's priority targets in a build matrix so nix.yml can build them
# in a first stage.
#
# stdin : matrix include JSON array (objects with .category and .name)
# env   : BUILD_FIRST  newline-delimited shell globs, matched against
#                      "<category>.<name>" (e.g. "packages.rust-test-deps",
#                      "checks.*-tests"). `*` matches any characters, dots included.
# stdout: the same array. With patterns set, every entry gains `first`
#         (true when it matches a pattern), and entries matching earlier
#         patterns come first (stable; unmatched keep their relative order).
#         With no patterns, the array is passed through untouched.
#
# Why a stage and not just an order: GitHub does not start matrix jobs in
# `include` order (zeus run 43747395023 started jobs 3, 7, 2, 6, 8 of a matrix
# whose job 1 was still queued 45 minutes later). A check that depends on a
# shared, expensive derivation (a Rust dependency build) blocks on the nix
# daemon's lock for it, holding a runner slot idle. Building the shared
# derivation in its own job stage, before the rest, is the only deterministic
# way to keep dependents from taking a slot while it builds.
#
# Marks and orders only: never drops, duplicates or edits an entry otherwise. A
# pattern that matches nothing is reported on stderr and is not an error: an
# uncached-only matrix legitimately omits a target that is already cached.
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
jq -c --argjson ranks "$ranks_json" --argjson none "$none" \
  '[., $ranks] | transpose | sort_by(.[1]) | map(.[0] + {first: (.[1] < $none)})' <<<"$matrix"
