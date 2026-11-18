#!/usr/bin/env bash
# Print how many resources a `pulumi preview --json` file would change. Every
# changeSummary key counts except `same`, `read` and `refresh` (bookkeeping: real
# drift found by a refresh shows up as an update, replace or delete), so a new
# kind of change is never silently treated as no change. Exits non-zero, printing nothing, when
# the file is missing or has no usable changeSummary.
set -euo pipefail

jq -er '
  .changeSummary
  | select(type == "object" and length > 0)
  | [to_entries[] | select(.key != "same" and .key != "read" and .key != "refresh") | .value]
  | add // 0
' "$1" 2>/dev/null
