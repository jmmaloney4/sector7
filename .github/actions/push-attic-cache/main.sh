#!/usr/bin/env bash
set -euo pipefail

flake_attr="${INPUT_FLAKE_ATTR}"
attic_endpoint="${INPUT_ATTIC_ENDPOINT}"
attic_cache_name="${INPUT_ATTIC_CACHE_NAME}"
attic_token="${INPUT_ATTIC_TOKEN}"
server_name="${INPUT_SERVER_NAME:-ci}"

run_attic() {
  if command -v attic >/dev/null 2>&1; then
    attic "$@"
    return 0
  fi

  nix run nixpkgs#attic-client -- "$@"
}

mkdir -p "$HOME/.config/attic"
run_attic login "$server_name" "$attic_endpoint" "$attic_token"

echo "Realizing flake output for Attic push: $flake_attr"
nix build "$flake_attr" --no-link --print-out-paths -L | run_attic push --stdin "$server_name:$attic_cache_name"
