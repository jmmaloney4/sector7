#!/usr/bin/env bash
set -euo pipefail

# Detect current Nix system (e.g., aarch64-darwin, x86_64-linux)
system="$(nix eval --impure --raw --expr 'builtins.currentSystem')"
if [[ ! $system =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "Invalid system string: $system" >&2
  exit 1
fi

# Set probe timeout from input or default
PROBE_TIMEOUT_SECONDS="${PROBE_TIMEOUT_SECONDS:-180}"
EXTRA_SUBSTITUTERS="${INPUT_EXTRA_SUBSTITUTERS:-}"
EXTRA_TRUSTED_PUBLIC_KEYS="${INPUT_EXTRA_TRUSTED_PUBLIC_KEYS:-}"

tmp_all="$(mktemp)"
select_expr="$(<"${GITHUB_ACTION_PATH}/select.nix")"
echo "Running nix-eval-jobs to detect flake outputs..." >&2

extra_substituters_value="https://nix-community.cachix.org"
extra_trusted_public_keys_value="nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="

append_option_values() {
  local existing_values="$1"
  local extra_values="$2"
  local merged="$existing_values"
  local value=""

  if [ -z "$extra_values" ]; then
    printf '%s\n' "$merged"
    return 0
  fi

  while IFS= read -r value; do
    [ -n "$value" ] || continue
    merged+=" $value"
  done < <(printf '%s\n' "$extra_values" | tr -s '[:space:]' '\n')

  printf '%s\n' "$merged"
}

if [ -n "$EXTRA_SUBSTITUTERS" ]; then
  extra_substituters_value="$(append_option_values "$extra_substituters_value" "$EXTRA_SUBSTITUTERS")"
fi

if [ -n "$EXTRA_TRUSTED_PUBLIC_KEYS" ]; then
  extra_trusted_public_keys_value="$(append_option_values "$extra_trusted_public_keys_value" "$EXTRA_TRUSTED_PUBLIC_KEYS")"
fi

nix_eval_args=(
  --option extra-substituters "$extra_substituters_value"
  --option extra-trusted-public-keys "$extra_trusted_public_keys_value"
)

nix run github:nix-community/nix-eval-jobs/v2.34.1 "${nix_eval_args[@]}" -- --flake . --check-cache-status --meta --workers 1 --select "(${select_expr}) \"${system}\"" >"$tmp_all"

# Transform nix-eval-jobs output to matrix format
echo "Processing nix-eval-jobs output..." >&2
all_outputs=$(nix -L run nixpkgs#jq -- -s -c --arg system "$system" '
    map(select(type == "object" and .attr != null))
    | map(
        (.attr | split(".")) as $parts
        | ($parts[1:] | join(".")) as $name
        | {
          attr: .attr,
          category: ($parts[0] // "unknown"),
          system:   $system,
          name:     ($name // "default"),
          flake_attr: (".#" + $parts[0] + "." + $system + "." + $name),
          cached: ((.cacheStatus == "cached") or (.cacheStatus == "local") or (.isCached == true)),
          store_path: (.outputs.out // (.drvPath // "unknown")),
          is_image: (($parts[-1] // "") | endswith("-image")) // false,
          ci_skip: ((.meta.ci.skip? == true) // false)
        }
      )
  ' "$tmp_all")

echo "All detected outputs: $all_outputs"

# Build include array from only uncached, buildable outputs OR container images (which must be pushed regardless of cache)
include_array=$(nix -L run nixpkgs#jq -- -c '
  map(select(.ci_skip != true and (.cached == false or .is_image == true)))
  | map(select((.category | test("^(packages|checks)$")) or .is_image == true))
  | map({category, system, name, flake_attr} + (if .is_image then {is_image: .is_image} else {} end))
' <<<"$all_outputs")

echo "Computed include (uncached only): $include_array"

# Compute boolean flag indicating whether there is any work to do
has_work=$(nix -L run nixpkgs#jq -- -rc 'if (length > 0) then "true" else "false" end' <<<"$include_array")
echo "Has work: $has_work"

# Expose outputs for downstream jobs
delim="MATRIX_INCLUDE_$(date +%s)"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "matrix_include<<$delim"
    echo "$include_array"
    echo "$delim"
  } >>"$GITHUB_OUTPUT"
  echo "has_work=$has_work" >>"$GITHUB_OUTPUT"
else
  echo "GITHUB_OUTPUT not set, skipping GitHub Actions output"
fi

# Cleanup temp files
rm -f "$tmp_all"

# Write a human-readable summary to the GitHub Actions run summary
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Detected flake outputs"
    if [ -n "$all_outputs" ] && [ "$all_outputs" != "null" ] && [ "$all_outputs" != "[]" ]; then
      nix -L run nixpkgs#jq -- -rc '
        ["| Category | System | Name | Attr | Store Path | Status |",
         "|---|---|---|---|---|---|"]
        + ( .
            | map("| " + (if .is_image then "container-image" else .category end) + " | " + .system + " | **" + .name + "** | " + .flake_attr + " | `" + .store_path + "` | " + (if .ci_skip then "⏭️  skipped" elif .cached then "📦  cached" else "🏗️  build" end) + " |")
          )
        | .[]
      ' <<<"$all_outputs"
    else
      echo "No outputs detected for this system."
    fi
    echo
  } >>"$GITHUB_STEP_SUMMARY"
else
  echo "GITHUB_STEP_SUMMARY not set, skipping summary output"
fi
