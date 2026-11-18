#!/usr/bin/env bash
# Print how many resources a `pulumi preview --json` file would change. Every
# changeSummary key counts except `same` and `read`, so a new kind of change is
# never silently treated as no change. Exits non-zero, printing nothing, when
# the file is missing or has no usable changeSummary.
set -euo pipefail

jq -er '
  .changeSummary
  | select(type == "object" and length > 0)
  | [to_entries[] | select(.key != "same" and .key != "read") | .value]
  | add // 0
' "$1" 2>/dev/null
