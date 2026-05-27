#!/usr/bin/env bash
set -euo pipefail

flake_attr="${INPUT_FLAKE_ATTR}"
attic_endpoint="${INPUT_ATTIC_ENDPOINT}"
attic_cache_name="${INPUT_ATTIC_CACHE_NAME}"
attic_token="${INPUT_ATTIC_TOKEN}"
server_name="${INPUT_SERVER_NAME:-ci}"

xdg_config_home_tmp="$(mktemp -d -t attic-config-XXXXXX)"
export XDG_CONFIG_HOME="$xdg_config_home_tmp"
trap 'rm -rf "$xdg_config_home_tmp"' EXIT

if [ -d "$HOME/.config/nix" ]; then
  mkdir -p "$XDG_CONFIG_HOME"
  cp -R "$HOME/.config/nix" "$XDG_CONFIG_HOME/"
fi

run_attic() {
  if command -v attic >/dev/null 2>&1; then
    attic "$@"
  else
    nix run nixpkgs#attic-client -- "$@"
  fi
}

run_attic login "$server_name" "$attic_endpoint" "$attic_token"

echo "Realizing flake output for Attic push: $flake_attr"
nix build "$flake_attr" --no-link --print-out-paths -L | run_attic push --stdin "$server_name:$attic_cache_name"
