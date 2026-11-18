#!/usr/bin/env bash
set -euo pipefail

project="${PROJECT:?PROJECT is required}"
stack="${STACK:?STACK is required}"
safe_name_input="${SAFE_NAME_IN:-}"

safe_name="$safe_name_input"
if [[ -z $safe_name ]]; then
  safe_name="$project"
fi
safe_name="${safe_name//\//__}"

drift_mode="${DRIFT_MODE:-off}"
case "$drift_mode" in
off | code | live) ;;
*)
  echo "::error title=Invalid drift_mode::drift_mode must be off, code, or live, got '$drift_mode'" >&2
  exit 1
  ;;
esac

# live mode refreshes inside the preview, which reads real infrastructure and
# writes no state. Projects that cannot tolerate a refresh opt out by exact path.
refresh_args=()
if [[ $drift_mode == live ]]; then
  refresh_args=(--refresh)
  IFS=',' read -ra no_refresh <<<"${NO_REFRESH_PROJECTS:-}"
  for entry in "${no_refresh[@]}"; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    if [[ $entry == "$project" ]]; then
      refresh_args=()
      echo "Previewing $project without --refresh (drift_no_refresh_projects)" >&2
      break
    fi
  done
fi

export DEVSHELL_NO_MOTD=1
export DEVSHELL_NO_GREETING=1
export DEVSHELL_QUIET=1

mkdir -p previews ok

# Human-readable diff output
nix develop .#ci-pulumi --command pulumi preview -C "$project" --stack "$stack" --non-interactive --diff "${refresh_args[@]}" | tee "previews/${safe_name}.txt"

# Optional JSON, tolerate failure to keep previews robust
if nix develop .#ci-pulumi --command pulumi preview -C "$project" --stack "$stack" --non-interactive --json "${refresh_args[@]}" >"previews/${safe_name}.json"; then
  :
else
  echo "JSON preview failed or unsupported; continuing with text preview only" >&2
fi

# Render a markdown summary suitable for PR comments
bash "$GITHUB_ACTION_PATH/render_preview_summary.sh" "$project" "$stack" "$safe_name" >stage-preview-summary.md || true

# Count the changes and emit OK marker. An unreadable count is `unknown`, never
# `clean`: the drift check must not pass because the JSON preview failed.
change_count=$(nix develop .#ci-pulumi --command bash "$GITHUB_ACTION_PATH/count_changes.sh" "previews/${safe_name}.json" || true)
has_changes=false
if [[ ! $change_count =~ ^[0-9]+$ ]]; then
  change_count=""
  drift_status=unknown
elif [[ $change_count -eq 0 ]]; then
  drift_status=clean
else
  drift_status=drift
  has_changes=true
fi
echo "drift_status=$drift_status" >>"$GITHUB_OUTPUT"
echo "change_count=$change_count" >>"$GITHUB_OUTPUT"

echo "has_changes=$has_changes" >>"$GITHUB_OUTPUT"

# Always create an OK marker on successful preview run of this action
nix develop .#ci-pulumi --command jq -n --arg project "$project" --arg stack "$stack" --arg has_changes "$has_changes" \
  '{project:$project, stack:$stack, has_changes: ($has_changes=="true")}' >"ok/${safe_name}.json"
