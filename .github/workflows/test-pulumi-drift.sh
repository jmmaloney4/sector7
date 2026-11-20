#!/usr/bin/env bash
# Exercise the pulumi-preview drift logic with stub nix and pulumi commands, and
# assert how pulumi.yml gates the failure. Does not invoke GitHub or Pulumi.
set -euo pipefail

self="${BASH_SOURCE[0]}"
workflow="${PULUMI_WORKFLOW:-$(cd "$(dirname "$self")" && pwd)/pulumi.yml}"
actions_root="${PULUMI_ACTIONS_ROOT:-$(cd "$(dirname "$self")/../actions" && pwd)}"
action="$actions_root/pulumi-preview"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

# The nix sandbox has no /usr/bin/env, so the stubs name this shell directly.
shebang="#!$(command -v bash)"

# `nix develop .#x --command CMD...` runs CMD.
{
  echo "$shebang"
  cat <<'EOF'
shift 3
exec "$@"
EOF
} >"$tmp/bin/nix"
# Records its arguments. --json prints $STUB_JSON, or fails when it is unset.
{
  echo "$shebang"
  cat <<'EOF'
echo "$*" >>"$STUB_LOG"
case " $* " in
*" --json "*)
  [[ -n ${STUB_JSON:-} ]] || exit 1
  printf '%s\n' "$STUB_JSON"
  ;;
*) echo "text preview" ;;
esac
EOF
} >"$tmp/bin/pulumi"
chmod +x "$tmp/bin/nix" "$tmp/bin/pulumi"

# run <json-or-empty> <mode> [no-refresh list]: leaves outputs in $tmp/run/out.
run() {
  rm -rf "$tmp/run"
  mkdir -p "$tmp/run"
  (
    cd "$tmp/run"
    PATH="$tmp/bin:$PATH" PROJECT=deploy/app STACK=prod \
      GITHUB_ACTION_PATH="$action" GITHUB_OUTPUT="$tmp/run/out" \
      STUB_LOG="$tmp/run/log" STUB_JSON="$1" DRIFT_MODE="$2" \
      NO_REFRESH_PROJECTS="${3:-}" bash "$action/main.sh"
  ) >"$tmp/stdout" 2>&1
}

output() { sed -n "s/^$1=//p" "$tmp/run/out"; }

expect() { # <json> <drift_status> <change_count> <has_changes>
  run "$1" code || fail "main.sh failed for $1: $(cat "$tmp/stdout")"
  [[ $(output drift_status) == "$2" ]] || fail "$1: drift_status=$(output drift_status), want $2"
  [[ $(output change_count) == "$3" ]] || fail "$1: change_count=$(output change_count), want $3"
  [[ $(output has_changes) == "$4" ]] || fail "$1: has_changes=$(output has_changes), want $4"
}

# Shapes taken from real previews: an in-sync stack, a mixed plan, an empty state.
expect '{"changeSummary":{"read":1,"same":49}}' clean 0 false
expect '{"changeSummary":{"create":92,"read":1,"replace":1,"same":77,"update":1}}' drift 94 true
expect '{"changeSummary":{"create":2}}' drift 2 true
# A refresh on its own is bookkeeping, not a pending change.
expect '{"changeSummary":{"refresh":49,"same":49}}' clean 0 false
# A kind of change this script has never heard of still counts.
expect '{"changeSummary":{"import":3,"same":1}}' drift 3 true
# Unreadable counts are unknown, not clean.
expect '{"steps":[]}' unknown '' false
expect '{"changeSummary":{}}' unknown '' false
expect 'not json' unknown '' false
expect '' unknown '' false

run '{"changeSummary":{"same":1}}' off
! grep -q -- --refresh "$tmp/run/log" || fail "off must not refresh"
run '{"changeSummary":{"same":1}}' code
! grep -q -- --refresh "$tmp/run/log" || fail "code must not refresh"
run '{"changeSummary":{"same":1}}' live
[[ $(grep -c -- --refresh "$tmp/run/log") -eq 2 ]] || fail "live must refresh both previews"
run '{"changeSummary":{"same":1}}' live 'deploy/other, deploy/app'
! grep -q -- --refresh "$tmp/run/log" || fail "an opted-out project must not refresh"
run '{"changeSummary":{"same":1}}' live 'deploy/app/sub'
grep -q -- --refresh "$tmp/run/log" || fail "opt-out must match the exact path"

if run '{"changeSummary":{"same":1}}' sometimes; then
  fail "an invalid drift_mode must fail"
fi
grep -q 'drift_mode must be off, code, or live' "$tmp/stdout" || fail "invalid mode wrong error: $(cat "$tmp/stdout")"
if run '{"changeSummary":{"same":1}}' ''; then
  fail "an empty drift_mode must fail"
fi

# The workflow fails the job only when asked, after a good preview, for anything
# but clean, and never for a stack this run has just deployed.
step_if=$(awk '
  index($0, "- name: fail job on drift") {found=1; next}
  found && /^[[:space:]]*- (name|uses|run):/ {exit}
  found && /if:/ {print; exit}
' "$workflow")
[[ -n $step_if ]] || fail "fail job on drift has no if:"
for want in "inputs.drift_mode != 'off'" "steps.preview.outcome == 'success'" \
  "steps.preview.outputs.drift_status != 'clean'" \
  "steps.up_stage.outcome != 'success'" "steps.up_prod.outcome != 'success'"; do
  [[ $step_if == *"$want"* ]] || fail "fail job on drift if: missing $want: $step_if"
done
awk '/^      drift_mode:/ {f=1; next} f && /^      [a-z_-]+:/ {exit} f' "$workflow" |
  grep -q "default: 'off'" || fail "drift_mode must default to off"

# drift_issues runs on failure but never on cancellation (a cancelled run would
# otherwise file "preview failed" for every stack), and only its job may write issues.
grep -q 'always() && inputs.drift_issues' "$workflow" &&
  fail "drift_issues steps must use !cancelled(), not always()"
[[ $(grep -c '!cancelled() && inputs.drift_issues' "$workflow") -eq 3 ]] ||
  fail "record, upload and the drift-issues job must each gate on !cancelled()"
[[ $(grep -cE '^[[:space:]]+issues:[[:space:]]*write[[:space:]]*$' "$workflow") -eq 1 ]] ||
  fail "only the drift-issues job may hold issues: write"

echo "gha-pulumi-drift ok"
