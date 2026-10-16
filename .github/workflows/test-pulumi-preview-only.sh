#!/usr/bin/env bash
# Assert the reusable Pulumi workflow cannot pulumi-up unless the caller
# opts in with preview_only: false. Does not invoke GitHub or Pulumi.
set -euo pipefail

workflow="${PULUMI_WORKFLOW:-$(cd "$(dirname "$0")" && pwd)/pulumi.yml}"
actions_root="${PULUMI_ACTIONS_ROOT:-$(cd "$(dirname "$0")/../actions" && pwd)}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f $workflow ]] || fail "workflow not found: $workflow"

step_if() {
  local name="$1"
  awk -v name="$name" '
    index($0, "- name: " name) {found=1}
    found && /if:/ {print; exit}
  ' "$workflow"
}

# Input exists, boolean, default true (safe until a consumer opts into deploys).
grep -q '^      preview_only:' "$workflow" || fail "missing workflow_call input preview_only"
awk '
  /^      preview_only:/ {in_input=1; next}
  in_input && /^      [a-z_]+:/ {exit}
  in_input {print}
' "$workflow" | grep -q 'type: boolean' || fail "preview_only must be type: boolean"
awk '
  /^      preview_only:/ {in_input=1; next}
  in_input && /^      [a-z_]+:/ {exit}
  in_input {print}
' "$workflow" | grep -Eq 'default:[[:space:]]*true' || fail "preview_only must default to true"

stage_if="$(step_if 'pulumi up (stage)')"
[[ -n $stage_if ]] || fail "pulumi up (stage) has no if:"
[[ $stage_if == *'!inputs.preview_only'* ]] || fail "pulumi up (stage) if: missing !inputs.preview_only: $stage_if"

prod_if="$(step_if 'pulumi up (prod)')"
[[ -n $prod_if ]] || fail "pulumi up (prod) has no if:"
[[ $prod_if == *'!inputs.preview_only'* ]] || fail "pulumi up (prod) if: missing !inputs.preview_only: $prod_if"

# github.event_name in a called workflow is the *caller* event (push, pull_request,
# workflow_dispatch, …), never workflow_call. The old check never selected the
# deploy group. Gate on !inputs.preview_only so preview-only main/tag runs stay
# on the preview group.
concurrency="$(awk '/^    concurrency:/{c=1} c{print} c && /^    [a-z]/ && !/^    concurrency:/{exit}' "$workflow")"
[[ $concurrency == *'!inputs.preview_only'* ]] || fail "concurrency group must key off !inputs.preview_only"
[[ $concurrency != *'github.event_name == '\''workflow_call'\'''* ]] ||
  fail "concurrency still keys off github.event_name == workflow_call (never true in a called workflow)"

# No other mutating Pulumi / Deployments-API paths in this workflow or the
# composite actions it calls. Previews and artifact uploads are allowed.
mutating_hits="$(
  grep -nE '[[:space:]]pulumi[[:space:]]+(up|destroy|refresh)|pulumi[[:space:]]+stack[[:space:]]+init|repos/.*/deployments' \
    "$workflow" \
    "$actions_root/pulumi-preview/action.yml" \
    "$actions_root/pulumi-preview/main.sh" \
    "$actions_root/pulumi-setup/action.yml" \
    "$actions_root/pulumi-collect/action.yml" \
    "$actions_root/detect-pulumi-stacks/action.yml" \
    "$actions_root/detect-pulumi-stacks/main.sh" ||
    true
)"
allowed_up_runs="$(printf '%s\n' "$mutating_hits" | grep -cE 'pulumi up -C' || true)"
[[ $allowed_up_runs -eq 2 ]] || fail "expected exactly 2 pulumi up run lines, got $allowed_up_runs: $mutating_hits"
if printf '%s\n' "$mutating_hits" | grep -vE 'pulumi up \(stage\)|pulumi up \(prod\)|pulumi up -C' | grep -q .; then
  fail "unexpected mutating path: $(printf '%s\n' "$mutating_hits" | grep -vE 'pulumi up \(stage\)|pulumi up \(prod\)|pulumi up -C')"
fi

echo "gha-pulumi-preview-only ok"
