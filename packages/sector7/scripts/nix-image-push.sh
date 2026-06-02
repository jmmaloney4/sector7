#!/usr/bin/env bash
# Push a nix2container image from a store path to a container registry.
#
# Modes (controlled by SCRIPT_MODE env var):
#   "push"    - push the image and output the digest (default)
#   "resolve" - skip push, just resolve the digest of the already-pushed tag
#
# Env vars:
#   IMAGE_NAME            - image name in registry (e.g. "lens-api")
#   IMAGE_TAG             - tag (e.g. "dev", "v1.2.3")
#   ARTIFACT_REGISTRY_URL - registry URL (e.g. "us-east1-docker.pkg.dev/proj/repo")
#   STORE_PATH            - nix store path of the image (required for push mode)
#   COMMAND_LOG_STEM      - log directory path (default: .pulumi/command-logs)
#   AUTH_MODE             - "gcloud" (default) or "ghcr"
#   SCRIPT_MODE           - "push" (default) or "resolve"
#
# For AUTH_MODE=ghcr, also set GITHUB_USER and GITHUB_TOKEN.

set -euo pipefail

SCRIPT_MODE="${SCRIPT_MODE:-push}"

# Validate common required env vars
for var in IMAGE_NAME IMAGE_TAG ARTIFACT_REGISTRY_URL; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: Required env var $var is not set" >&2
    exit 1
  fi
done

# Push mode requires STORE_PATH
if [ "${SCRIPT_MODE}" = "push" ]; then
  if [ -z "${STORE_PATH:-}" ]; then
    echo "ERROR: Required env var STORE_PATH is not set for push mode" >&2
    exit 1
  fi
fi

COMMAND_LOG_STEM="${COMMAND_LOG_STEM:-.pulumi/command-logs}"
AUTH_MODE="${AUTH_MODE:-gcloud}"

# Set up logging
LOG_DIR="${COMMAND_LOG_STEM}"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/$(date +%Y%m%d-%H%M%S)-${IMAGE_NAME//\//_}-${SCRIPT_MODE}.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

ARTIFACT_REGISTRY_URL="${ARTIFACT_REGISTRY_URL#*://}"
FULL_TAG="${ARTIFACT_REGISTRY_URL}/${IMAGE_NAME}:${IMAGE_TAG}"

echo "=== ${SCRIPT_MODE} ${IMAGE_NAME}:${IMAGE_TAG} ==="
echo "AUTH_MODE: ${AUTH_MODE}"

# Temp files for auth and digest
DIGEST_FILE=$(mktemp)
AUTH_FILE=$(mktemp)
trap 'rm -f "${AUTH_FILE}" "${DIGEST_FILE}"' EXIT

# Authenticate by writing authfile directly.
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

REGISTRY_HOST="${ARTIFACT_REGISTRY_URL%%/*}"
AUTH_B64=$(printf '%s:%s' "${USERNAME}" "${PASSWORD}" | base64 | tr -d '\n')
printf '{"auths":{"%s":{"auth":"%s"}}}' \
  "${REGISTRY_HOST}" "${AUTH_B64}" >"${AUTH_FILE}"
chmod 600 "${AUTH_FILE}"

if [ "${SCRIPT_MODE}" = "resolve" ]; then
  echo "--- resolving digest ---"
  nix run github:nlewo/nix2container/76be9608a7f4d6c985d28b0e7be903ae2547df3e#skopeo-nix2container -- \
    --insecure-policy inspect --format '{{.Digest}}' \
    --authfile "${AUTH_FILE}" \
    docker://"${FULL_TAG}" |
    tr -d '\n' \
      >"${DIGEST_FILE}"
else
  IMAGE_PATH="nix:${STORE_PATH}"

  echo "--- skopeo copy ---"
  nix run github:nlewo/nix2container/76be9608a7f4d6c985d28b0e7be903ae2547df3e#skopeo-nix2container -- \
    --insecure-policy copy --digestfile "${DIGEST_FILE}" \
    --authfile "${AUTH_FILE}" \
    "${IMAGE_PATH}" \
    "docker://${FULL_TAG}"
fi

DIGEST=$(cat "${DIGEST_FILE}")

echo "=== ${SCRIPT_MODE} complete: ${FULL_TAG} ==="
echo "=== Digest: ${DIGEST} ==="
echo "DIGEST_OUTPUT:${DIGEST}"
