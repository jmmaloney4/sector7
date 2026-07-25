#!/usr/bin/env bash
# Resolve or build a nix flake attribute and output its store path.
#
# Modes (controlled by SCRIPT_MODE env var):
#   "resolve" - evaluate the flake to find the store path without building (default)
#   "build"   - build the derivation, then output the store path
#
# Env vars:
#   NIX_ATTR          - flake attribute path (e.g. "packages.x86_64-linux.lens-api-image")
#   REPO_ROOT         - absolute path to repo root containing the flake
#   SUB_OUTPUT        - named output from a multi-output derivation (e.g. "docs", "dev")
#   SUB_PATH          - sub-path within the resolved store path (e.g. "assets/style.css")
#   SCRIPT_MODE       - "resolve" (default) or "build"
#   COMMAND_LOG_STEM  - log directory path (default: .pulumi/command-logs)
#
# UTF-8 safety (sector7#318): this script is invoked by a
# `command.local.Command` resource, whose captured stdout/stderr become Pulumi
# resource output properties. Pulumi marshals those as protobuf strings, which
# MUST be valid UTF-8 — but `nix build -L` logs are arbitrary bytes (a fixup
# phase can leak a raw gzip stream, compiler output can carry non-UTF-8 paths,
# etc.). Merging that log into the captured streams crashed `pulumi up` with
# "grpc: error while marshaling: string field contains invalid UTF-8".
#
# To stay marshal-safe, all verbose build output is routed to LOG_FILE (via a
# dedicated file descriptor), never to the stdout/stderr Pulumi captures. The
# only thing on stdout is the ASCII STORE_PATH_OUTPUT protocol line, and the
# only thing on stderr is ASCII diagnostics — both always valid UTF-8.

set -euo pipefail

SCRIPT_MODE="${SCRIPT_MODE:-resolve}"
COMMAND_LOG_STEM="${COMMAND_LOG_STEM:-.pulumi/command-logs}"

# Validate required env vars
for var in NIX_ATTR REPO_ROOT; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: Required env var $var is not set" >&2
    exit 1
  fi
done

# Build the full attribute path with optional sub-output
FULL_ATTR="${NIX_ATTR}"
if [ -n "${SUB_OUTPUT:-}" ]; then
  FULL_ATTR="${NIX_ATTR}^${SUB_OUTPUT}"
fi

# Set up logging. fd 3 is the verbose log sink: everything that can carry
# arbitrary bytes (nix build/eval output) goes here and nowhere else.
LOG_DIR="${COMMAND_LOG_STEM}"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/$(date +%Y%m%d-%H%M%S)-nix-output-${SCRIPT_MODE}.log"
exec 3>>"${LOG_FILE}"

# log <msg> — write a diagnostic line to the verbose log only.
log() { printf '%s\n' "$*" >&3; }

# On any failure, point at the full log on stderr. Keep this message
# ASCII-only: the log may contain non-UTF-8 bytes and must never leak onto the
# captured stderr stream.
on_err() {
  echo "nix-output ${SCRIPT_MODE} failed for ${FULL_ATTR}; see ${LOG_FILE}" >&2
}
trap on_err ERR

log "=== nix-output ${SCRIPT_MODE} ${FULL_ATTR} ==="
log "REPO_ROOT: ${REPO_ROOT}"

STORE_PATH=""

if [ "${SCRIPT_MODE}" = "build" ]; then
  # Build the derivation. --print-out-paths writes the store path to stdout
  # (captured below); -L build logs go to stderr, redirected to the log fd.
  #
  # always-allow-substitutes=false: nix2container records layer tar digests in
  # JSONs built with allowSubstitutes=false so they always match the local
  # store the push later streams from. Determinate Nix defaults
  # always-allow-substitutes to true, which overrides that and lets a cache
  # serve JSONs built on another machine — if any layer dependency is not
  # bit-reproducible (e.g. python bytecode), every push then fails with
  # "Digest did not match". Forcing the option off restores the invariant;
  # it only affects derivations that explicitly opted out of substitution,
  # which are cheap by design.
  log "--- nix build ---"
  STORE_PATH=$(nix build "${REPO_ROOT}#${FULL_ATTR}" --no-link --print-out-paths -L \
    --option always-allow-substitutes false 2>&3)
else
  # Resolve without building. nix eval --raw gives the store path on stdout;
  # any warnings/errors go to stderr, redirected to the log fd.
  log "--- nix eval ---"
  STORE_PATH=$(nix eval --raw "${REPO_ROOT}#${FULL_ATTR}" 2>&3)
fi

if [ -z "${STORE_PATH}" ]; then
  echo "ERROR: Could not resolve store path for ${FULL_ATTR}" >&2
  exit 1
fi

# Apply sub-path if specified
if [ -n "${SUB_PATH:-}" ]; then
  FULL_PATH="${STORE_PATH}/${SUB_PATH}"
  if [ ! -e "${FULL_PATH}" ]; then
    echo "ERROR: Sub-path '${SUB_PATH}' does not exist within ${STORE_PATH}" >&2
    exit 1
  fi
  # Resolve to absolute path (handles symlinks, .., etc.)
  STORE_PATH=$(cd "$(dirname "${FULL_PATH}")" && pwd)/$(basename "${FULL_PATH}")
fi

log "=== Resolved: ${STORE_PATH} ==="

# The ONLY line on real stdout: the machine-readable store path. Store paths
# are ASCII (/nix/store/<hash>-<name>), so the Command's captured stdout is
# always valid UTF-8 and safe for Pulumi to marshal.
echo "STORE_PATH_OUTPUT:${STORE_PATH}"
