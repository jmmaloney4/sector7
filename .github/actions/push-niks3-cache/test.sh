#!/usr/bin/env bash
# Skip-path tests for the niks3 GHA helpers. Does not talk to a live server.
set -euo pipefail

actions_root="${NIKS3_GHA_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
push_script="${actions_root}/push-niks3-cache/main.sh"
watch_script="${actions_root}/nix-setup/start-niks3-watch-store.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

out="$(
  INPUT_FLAKE_ATTR='.#hello' \
    INPUT_NIKS3_ENDPOINT='' \
    INPUT_NIKS3_AUTH_TOKEN_PATH='' \
    INPUT_NIKS3_AUTH_TOKEN='' \
    bash "$push_script"
)"
printf '%s\n' "$out" | grep -q 'Skipping niks3 cache push' || fail "empty endpoint should skip: $out"

out="$(
  INPUT_FLAKE_ATTR='.#hello' \
    INPUT_NIKS3_ENDPOINT='https://niks3-test.mellori-delta.ts.net' \
    INPUT_NIKS3_AUTH_TOKEN_PATH='' \
    INPUT_NIKS3_AUTH_TOKEN='' \
    bash "$push_script"
)"
printf '%s\n' "$out" | grep -q 'Skipping niks3 cache push' || fail "empty token should skip: $out"

out="$(
  INPUT_CACHE_PUSH_BACKEND='attic' \
    INPUT_NIKS3_ENDPOINT='https://niks3-test.mellori-delta.ts.net' \
    INPUT_NIKS3_AUTH_TOKEN_PATH='/etc/hostname' \
    INPUT_NIKS3_AUTH_TOKEN='' \
    bash "$watch_script"
)"
printf '%s\n' "$out" | grep -q 'Attic remains the default' || fail "default backend should skip niks3 watch: $out"

out="$(
  INPUT_CACHE_PUSH_BACKEND='niks3' \
    INPUT_NIKS3_ENDPOINT='' \
    INPUT_NIKS3_AUTH_TOKEN_PATH='/etc/hostname' \
    INPUT_NIKS3_AUTH_TOKEN='' \
    bash "$watch_script"
)"
printf '%s\n' "$out" | grep -q 'endpoint not set' || fail "niks3 backend without endpoint should skip: $out"

echo "gha-niks3-helpers skip paths ok"
