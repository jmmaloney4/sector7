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

tmp_all="$(mktemp)"
select_expr="$(<"${GITHUB_ACTION_PATH}/select.nix")"
echo "Running nix-eval-jobs to detect flake outputs..." >&2
nix run github:nix-community/nix-eval-jobs --option extra-substituters "https://nix-community.cachix.org" --option extra-trusted-public-keys "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=" -- \
  --flake . \
  --check-cache-status \
  --meta \
  --workers 1 \
  --select "(${select_expr}) \"${system}\"" >"$tmp_all"

# Transform nix-eval-jobs output to matrix format
echo "Processing nix-eval-jobs output..." >&2
all_outputs=$(nix -L run nixpkgs#jq -- -s -c --arg system "$system" '
    # Filter out non-objects and ensure attr exists (handles error messages or malformed lines)
    map(select(type == "object" and .attr != null))
    # Parse each JSON object and extract matrix fields.
    # After select.nix narrows to packages/checks for the current system, nix-eval-jobs emits
    # 2-part attrs (e.g. "packages.foo") rather than 3-part ("packages.x86_64-linux.foo").
    # Handle both shapes; reconstruct a full flake_attr for the 2-part case using $system.
    | map(
        (.attr | split(".")) as $parts
        # select.nix pre-filters to the current system, so nix-eval-jobs always emits
        # 2-part attrs of the form "<category>.<name>" where <name> may itself contain
        # dots (e.g. "packages.python3.requests"). The old $long heuristic
        # (length >= 3 → treat as 3-part) is therefore wrong for dotted names and has
        # been removed. Assumption: select.nix is always used; callers that bypass it
        # and rely on 3-part attrs are not supported by this script.
        #
        # Risk: a 1-part attr (no dot) would produce an empty $name.
        # Mitigation: retain the "// \"default\"" fallback below.
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
  # Filter out categories we dont want to build (packages, checks, OR images)
  # IMPORTANT: Use parentheses around (.category | test(...)) to ensure OR applies to boolean result,
  # otherwise pipe precedence passes string context to .is_image causing "Cannot index string" error.
  | map(select((.category | test("^(packages|checks)$")) or .is_image == true))
  # Extract only fields needed for the matrix
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
      # Render a markdown table listing all outputs and whether they are cached
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
