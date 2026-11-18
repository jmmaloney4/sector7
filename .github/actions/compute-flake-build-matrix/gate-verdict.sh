#!/usr/bin/env bash
# Decide `✅ nix gate`: pass only if every job succeeded or was skipped and detect
# deferred nothing.
#
# env : NEEDS  the workflow's `toJSON(needs)`
# exit: 0 to pass, 1 to fail, with the reasons on stderr
#
# A deferred target was never built, so its check says nothing: a run that left any out
# (split-matrix.sh) must not read as green. A successful detect that reports no count
# fails too, so a missing output cannot pass as "nothing deferred".
set -euo pipefail

failed=0

bad="$(jq -r 'to_entries[] | select(.value.result != "success" and .value.result != "skipped") | "\(.key)=\(.value.result)"' <<<"$NEEDS")"
if [ -n "$bad" ]; then
  echo "nix gate failed: $bad" >&2
  failed=1
fi

if [ "$(jq -r '.detect.result' <<<"$NEEDS")" = "success" ]; then
  count="$(jq -r '.detect.outputs.deferred_count // ""' <<<"$NEEDS")"
  if ! [[ $count =~ ^[0-9]+$ ]]; then
    echo "nix gate failed: detect succeeded but reported no deferred count (got '$count')" >&2
    failed=1
  elif [ "$count" -gt 0 ]; then
    names="$(jq -r '.detect.outputs.deferred_names // ""' <<<"$NEEDS")"
    {
      echo "nix gate failed: $count target(s) were deferred, over GitHub's matrix limit, and not built."
      echo "What this run built is in the binary cache, so the next run has less to do."
      echo "To continue, use 'Re-run all jobs' or push: 'Re-run failed jobs' only repeats this gate."
      echo "Deferred (first 50 at most): $names"
    } >&2
    failed=1
  fi
fi

[ "$failed" -eq 0 ] || exit 1
echo "nix gate: all jobs succeeded or were skipped, nothing deferred"
