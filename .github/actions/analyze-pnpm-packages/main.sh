#!/usr/bin/env bash
set -euo pipefail

# Unified monorepo release analyzer.
# Reads version from root package.json, checks if a v${version} tag already
# exists as a GitHub Release, and outputs a matrix entry if publishing is needed.

TARGET="${A_TARGET:-release}"
DRY_RUN="$(echo "${A_DRY_RUN:-false}" | tr '[:upper:]' '[:lower:]')"
GITHUB_REPO="${A_GITHUB_REPOSITORY:-}"
ROOT="${A_ROOT:-.}"

SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
OUT_FILE="${GITHUB_OUTPUT:-/dev/stdout}"

# ── Verify tools are available ──────────────────────────────────────

for cmd in jq gh; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: $cmd is required but not available" >&2
    exit 1
  fi
done

# ── Read unified version from root package.json ─────────────────────

if [[ ! -f "${ROOT}/package.json" ]]; then
  echo "Error: package.json not found at ${ROOT}" >&2
  exit 1
fi

VERSION="$(jq -r '.version // empty' "${ROOT}/package.json")"
if [[ -z $VERSION || $VERSION == "null" ]]; then
  echo "Error: version field missing or empty in ${ROOT}/package.json" >&2
  exit 1
fi

TAG="v${VERSION}"

echo "# 📦 Unified release analysis" >>"$SUMMARY_FILE"
if [[ ${DRY_RUN} == "true" ]]; then
  echo "> **DRY RUN MODE** - No packages will be published" >>"$SUMMARY_FILE"
fi
echo "" >>"$SUMMARY_FILE"
echo "- **Version:** \`${VERSION}\`" >>"$SUMMARY_FILE"
echo "- **Tag:** \`${TAG}\`" >>"$SUMMARY_FILE"
echo "- **Target:** \`${TARGET}\`" >>"$SUMMARY_FILE"

# ── Validate all package versions match the root version ────────────

if [[ ${DRY_RUN} == "true" ]]; then
  echo "- **Version check:** skipped in dry run" >>"$SUMMARY_FILE"
else
  if [[ -d "${ROOT}/packages" ]]; then
    VERSION_MISMATCH=0
    for pkg_json in "${ROOT}"/packages/*/package.json; do
      [[ -f $pkg_json ]] || continue
      pkg_name="$(jq -r '.name' "$pkg_json")"
      pkg_ver="$(jq -r '.version // empty' "$pkg_json")"
      if [[ $pkg_ver != "$VERSION" ]]; then
        echo "❌ Version mismatch: ${pkg_name} is ${pkg_ver}, expected ${VERSION}" >&2
        VERSION_MISMATCH=1
      fi
    done
    if [[ $VERSION_MISMATCH -ne 0 ]]; then
      echo "Error: not all package versions match root package.json version (${VERSION})" >&2
      echo "Update all packages to version ${VERSION} before releasing." >&2
      exit 1
    fi
  fi
fi

# ── Collect packages ────────────────────────────────────────────────

PKG_PATHS=()
if [[ -d "${ROOT}/packages" ]]; then
  for pkg_json in "${ROOT}/packages"/*/package.json; do
    [[ -f $pkg_json ]] && PKG_PATHS+=("${pkg_json%/package.json}")
  done
fi

echo "- **Packages:** ${#PKG_PATHS[@]}" >>"$SUMMARY_FILE"
echo "" >>"$SUMMARY_FILE"

if [[ ${#PKG_PATHS[@]} -eq 0 ]]; then
  echo "No packages found under ${ROOT}/packages/" >&2
  echo "matrix=[]" >>"$OUT_FILE"
  echo "has_packages=false" >>"$OUT_FILE"
  exit 0
fi

# ── Check if release already exists ─────────────────────────────────

ALREADY_PUBLISHED="false"
case "$TARGET" in
release)
  if [[ -n $GITHUB_REPO ]]; then
    if gh release view "$TAG" --repo "$GITHUB_REPO" >/dev/null 2>&1; then
      # Release exists — verify all expected assets are present.
      # Partial releases (tag created but upload failed) must be retried.
      # Fetch asset list once to avoid N API calls per package.
      EXISTING_ASSETS="$(gh release view "$TAG" --repo "$GITHUB_REPO" --json assets -q ".assets[].name" 2>/dev/null || true)"
      MISSING_ASSETS=()
      for pkg_path in "${PKG_PATHS[@]}"; do
        name="$(jq -r '.name' "${pkg_path}/package.json")"
        pkg_version="$(jq -r '.version // empty' "${pkg_path}/package.json")"
        stem="${name#@}"
        stem="${stem//\//-}"
        asset_name="${stem}-${pkg_version}.tgz"
        # grep -F for literal match (asset names contain dots)
        if ! echo "$EXISTING_ASSETS" | grep -Fqx "$asset_name"; then
          MISSING_ASSETS+=("$asset_name")
        fi
      done
      if [[ ${#MISSING_ASSETS[@]} -eq 0 ]]; then
        ALREADY_PUBLISHED="true"
        echo "- **Status:** already published (tag \`${TAG}\` exists with all assets)" >>"$SUMMARY_FILE"
      else
        echo "- **Status:** incomplete release (missing: ${MISSING_ASSETS[*]}), will republish" >>"$SUMMARY_FILE"
        for asset in "${MISSING_ASSETS[@]}"; do
          echo "  ⚠️ Missing asset: $asset" >&2
        done
      fi
    else
      echo "- **Status:** new release needed" >>"$SUMMARY_FILE"
    fi
  else
    echo "- **Status:** unknown (no GITHUB_REPO set, assuming not published)" >>"$SUMMARY_FILE"
  fi
  ;;
*)
  echo "Error: unknown or deprecated target '${TARGET}'. Only 'release' is supported." >&2
  exit 1
  ;;
esac

# ── Build matrix entries ────────────────────────────────────────────

MATRIX_ENTRIES=()
for pkg_path in "${PKG_PATHS[@]}"; do
  name="$(jq -r '.name' "${pkg_path}/package.json")"
  # pnpm pack uses the package's own version for the tarball filename,
  # not the root package.json version (workspaces don't auto-inherit).
  pkg_version="$(jq -r '.version // empty' "${pkg_path}/package.json")"
  # npm pack: strip @, replace / with -
  stem="${name#@}"
  stem="${stem//\//-}"
  asset_name="${stem}-${pkg_version}.tgz"

  MATRIX_ENTRIES+=("$(jq -n \
    --arg path "$pkg_path" \
    --arg name "$name" \
    --arg version "$pkg_version" \
    --arg target "$TARGET" \
    --arg tag "$TAG" \
    --arg asset_name "$asset_name" \
    '{
      package_path: $path,
      name: $name,
      version: $version,
      action: "publish",
      target: $target,
      tag: $tag,
      asset_name: $asset_name
    }')")
done

# ── Decide action ───────────────────────────────────────────────────

ACTION="publish"
if [[ $ALREADY_PUBLISHED == "true" || $DRY_RUN == "true" ]]; then
  ACTION="skip"
fi

echo "" >>"$SUMMARY_FILE"
echo "| Package | Version | Action |" >>"$SUMMARY_FILE"
echo "|---|---|---|" >>"$SUMMARY_FILE"

if [[ $ACTION == "skip" ]]; then
  for entry in "${MATRIX_ENTRIES[@]}"; do
    name="$(echo "$entry" | jq -r '.name')"
    echo "| ${name} | ${VERSION} | ⏭️ skip |" >>"$SUMMARY_FILE"
  done
  echo "matrix=[]" >>"$OUT_FILE"
  echo "has_packages=false" >>"$OUT_FILE"
else
  for entry in "${MATRIX_ENTRIES[@]}"; do
    name="$(echo "$entry" | jq -r '.name')"
    echo "| ${name} | ${VERSION} | 🚀 publish |" >>"$SUMMARY_FILE"
  done
  MATRIX="$(printf '%s\n' "${MATRIX_ENTRIES[@]}" | jq -s '.')"
  echo "matrix=$(echo "$MATRIX" | jq -c .)" >>"$OUT_FILE"
  echo "has_packages=true" >>"$OUT_FILE"
fi
