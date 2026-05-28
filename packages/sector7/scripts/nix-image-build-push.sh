#!/usr/bin/env bash
# Generic nix2container image build+push or resolve script.
#
# Modes (controlled by SCRIPT_MODE env var):
#   "build"   - build the nix image and push to registry (default)
#   "resolve" - skip build, just resolve the digest of an already-pushed tag
#
# Env vars:
#   NIX_ATTR              - flake attribute path (e.g. "packages.x86_64-linux.lens-api-image")
#   IMAGE_NAME            - image name in registry (e.g. "lens-api")
#   IMAGE_TAG             - tag (e.g. "dev", "v1.2.3")
#   ARTIFACT_REGISTRY_URL - registry URL (e.g. "us-east1-docker.pkg.dev/proj/repo")
#   REPO_ROOT             - absolute path to repo root containing the flake
#   RESULT_LINK           - symlink name for nix build output (default: result-image)
#   COMMAND_LOG_STEM      - log directory path (default: .pulumi/command-logs)
#   AUTH_MODE             - "gcloud" (default) or "ghcr"
#   SCRIPT_MODE           - "build" (default) or "resolve"
#
# For AUTH_MODE=ghcr, also set GITHUB_USER and GITHUB_TOKEN.

set -euo pipefail

SCRIPT_MODE="${SCRIPT_MODE:-build}"

# Validate common required env vars
for var in IMAGE_NAME IMAGE_TAG ARTIFACT_REGISTRY_URL; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: Required env var $var is not set" >&2
    exit 1
  fi
done

# Build mode requires additional vars
if [ "${SCRIPT_MODE}" = "build" ]; then
  for var in NIX_ATTR REPO_ROOT; do
    if [ -z "${!var:-}" ]; then
      echo "ERROR: Required env var $var is not set for build mode" >&2
      exit 1
    fi
  done
fi

RESULT_LINK="${RESULT_LINK:-result-image}"
COMMAND_LOG_STEM="${COMMAND_LOG_STEM:-.pulumi/command-logs}"
AUTH_MODE="${AUTH_MODE:-gcloud}"

# Set up logging
LOG_DIR="${COMMAND_LOG_STEM}"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/$(date +%Y%m%d-%H%M%S)-${IMAGE_NAME}-${SCRIPT_MODE}.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

ARTIFACT_REGISTRY_URL="${ARTIFACT_REGISTRY_URL#*://}"
FULL_TAG="${ARTIFACT_REGISTRY_URL}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "=== ${SCRIPT_MODE} ${IMAGE_NAME}:${IMAGE_TAG} ==="
echo "AUTH_MODE: ${AUTH_MODE}"

# Temp files for auth and digest
DIGEST_FILE=$(mktemp)
AUTH_FILE=$(mktemp)
trap 'rm -f "${AUTH_FILE}" "${RESULT_LINK}" "${DIGEST_FILE}"' EXIT

# Authenticate by writing authfile directly.
# nix run does not reliably forward stdin to the child process (it must
# resolve the flake first), so skopeo login --password-stdin fails with
# a truncated/empty authfile.  Writing the JSON authfile directly avoids
# the issue entirely.
echo "--- authenticating (${AUTH_MODE}) ---"
case "${AUTH_MODE}" in
gcloud)
  PASSWORD=$(gcloud auth print-access-token)
  USERNAME="oauth2accesstoken"
  ;;
ghcr)
  if [ -z "${GITHUB_TOKEN:-}" ] || [ -z "${GITHUB_USER:-}" ]; then
    echo "ERROR: GITHUB_TOKEN and GITHUB_USER env vars required for ghcr auth mode" >&2
    exit 1
  fi
  PASSWORD="${GITHUB_TOKEN}"
  USERNAME="${GITHUB_USER}"
  ;;
*)
  echo "ERROR: Unknown AUTH_MODE '${AUTH_MODE}' (expected 'gcloud' or 'ghcr')" >&2
  exit 1
  ;;
esac

# Extract registry host (first path component before the next /).
# Use base64-encoded auth field — nix-built skopeo ignores separate
# username/password fields and treats them as empty credentials.
REGISTRY_HOST="${ARTIFACT_REGISTRY_URL%%/*}"
AUTH_B64=$(printf '%s:%s' "${USERNAME}" "${PASSWORD}" | base64 | tr -d '\n')
printf '{"auths":{"%s":{"auth":"%s"}}}' \
  "${REGISTRY_HOST}" "${AUTH_B64}" >"${AUTH_FILE}"
chmod 600 "${AUTH_FILE}"

if [ "${SCRIPT_MODE}" = "resolve" ]; then
  # Resolve-only: inspect the already-pushed image to get its digest
  echo "--- resolving digest ---"
  nix run github:nlewo/nix2container/v1.0.0#skopeo-nix2container -- \
    --insecure-policy inspect --format '{{.Digest}}' \
    --authfile "${AUTH_FILE}" \
    docker://"${FULL_TAG}" |
    tr -d '\n' \
      >"${DIGEST_FILE}"
else
  # Build the image
  echo "--- nix build ---"
  echo "NIX_ATTR: ${NIX_ATTR}"
  echo "REPO_ROOT: ${REPO_ROOT}"
  nix build "${REPO_ROOT}#${NIX_ATTR}" -o "${RESULT_LINK}" -L

  IMAGE_PATH="nix:./${RESULT_LINK}"

  # Push the image
  echo "--- skopeo copy ---"
  nix run github:nlewo/nix2container/v1.0.0#skopeo-nix2container -- \
    --insecure-policy copy --digestfile "${DIGEST_FILE}" \
    --authfile "${AUTH_FILE}" \
    "${IMAGE_PATH}" \
    "docker://${FULL_TAG}"
fi

DIGEST=$(cat "${DIGEST_FILE}")

echo "=== ${SCRIPT_MODE} complete: ${FULL_TAG} ==="
echo "=== Digest: ${DIGEST} ==="
echo "DIGEST_OUTPUT:${DIGEST}"
