#!/usr/bin/env bash
# Realize one flake output and push it with `niks3 push --stdin`.
#
# Opt-in sibling of push-attic-cache. Does not configure a Nix substituter:
# stock substitution from the niks3-test server is currently broken, so this
# helper is a push target only (seven#81 / seven ADR 023 trial).
set -euo pipefail

flake_attr="${INPUT_FLAKE_ATTR:-}"
endpoint="${INPUT_NIKS3_ENDPOINT:-}"
token_path="${INPUT_NIKS3_AUTH_TOKEN_PATH:-}"
token="${INPUT_NIKS3_AUTH_TOKEN:-}"
max_uploads="${INPUT_NIKS3_MAX_CONCURRENT_UPLOADS:-30}"

if [ -z "$endpoint" ]; then
  echo "niks3 endpoint is empty. Skipping niks3 cache push."
  exit 0
fi

if [ -z "$token_path" ] && [ -z "$token" ]; then
  echo "niks3 auth token is empty (likely a fork PR). Skipping niks3 cache push."
  exit 0
fi

if [ -z "$flake_attr" ]; then
  echo "flake-attr is required for a niks3 cache push."
  exit 1
fi

workdir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
token_dir="$(mktemp -d "${workdir}/niks3-push-XXXXXX")"
cleanup() {
  rm -rf "$token_dir"
}
trap cleanup EXIT

if [ -n "$token" ]; then
  token_path="${token_dir}/auth-token"
  umask 077
  printf '%s\n' "$token" >"$token_path"
fi

if [ ! -r "$token_path" ]; then
  echo "niks3 auth token path is not readable: $token_path"
  exit 1
fi

run_niks3() {
  if command -v niks3 >/dev/null 2>&1; then
    niks3 "$@"
  else
    nix run nixpkgs#niks3 -- "$@"
  fi
}

echo "Realizing flake output for niks3 push: $flake_attr"
nix build "$flake_attr" --no-link --print-out-paths -L |
  run_niks3 push --stdin \
    --server-url "$endpoint" \
    --auth-token-path "$token_path" \
    --max-concurrent-uploads "$max_uploads"
