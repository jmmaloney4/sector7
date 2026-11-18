#!/usr/bin/env bash
# Split the computed matrix into the jobs nix.yml runs, each within GitHub's limit.
#
# stdin : matrix include JSON array from main.sh (.category, .name, and optionally
#         .first and .is_image)
# stdout: `key=value` lines for $GITHUB_OUTPUT, every value on one line:
#           first_matrix_include, first_has_work   the build-first stage
#           build_matrix_include, build_has_work   the main stage
#           image_matrix                           image names, as a JSON array
#           deferred_count                         entries left out of all three
#           deferred_names                         the first of them, comma-separated
#
# GitHub refuses a job whose matrix has more than 256 configurations, before any of it
# runs. Nothing would then reach the binary cache, so the next run would be just as
# large. So each matrix keeps what fits, and the rest is deferred: gate-verdict.sh fails
# the run, and the next run starts from what this one cached.
#
# The order decides what is built first when there is too much: the build-first stage
# keeps the caller's order, the main stage takes checks before packages and then sorts
# by name, and images sort by name. Every entry ends up in a matrix or deferred.
set -euo pipefail

readonly MATRIX_LIMIT=256
readonly DEFERRED_NAMES_SHOWN=50

jq -r --argjson limit "$MATRIX_LIMIT" --argjson shown "$DEFERRED_NAMES_SHOWN" '
  def has_work: if length > 0 then "true" else "false" end;
  def target_name: "\(.category).\(.name)";

  map(select(.is_image == true)) as $images_all
  | map(select(.is_image != true)) as $builds
  | ($builds | map(select(.first == true))) as $first_all
  | ($builds | map(select(.first != true)) | sort_by(.category != "checks", .category, .name)) as $build_all
  | ($images_all | sort_by(.name)) as $images_sorted
  | $first_all[:$limit] as $first
  | $build_all[:$limit] as $build
  | $images_sorted[:$limit] as $images
  | ($first_all[$limit:] + $build_all[$limit:] + $images_sorted[$limit:]) as $deferred
  | "first_matrix_include=\($first | tojson)",
    "first_has_work=\($first | has_work)",
    "build_matrix_include=\($build | tojson)",
    "build_has_work=\($build | has_work)",
    "image_matrix=\($images | map(.name) | tojson)",
    "deferred_count=\($deferred | length)",
    "deferred_names=\($deferred[:$shown] | map(target_name) | join(", "))"
'
