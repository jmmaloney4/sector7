#!/usr/bin/env bash
set -euo pipefail

substituters="${INPUT_EXTRA_SUBSTITUTERS:-}"
trusted_keys="${INPUT_EXTRA_TRUSTED_PUBLIC_KEYS:-}"

if [ -z "$substituters" ] && [ -z "$trusted_keys" ]; then
  echo "No extra binary cache configuration requested."
  exit 0
fi

mkdir -p "$HOME/.config/nix"
config_path="$HOME/.config/nix/nix.conf"
tmp_path="$(mktemp)"
trap 'rm -f "$tmp_path"' EXIT
cp "$config_path" "$tmp_path" 2>/dev/null || :

append_unique_lines() {
  local prefix="$1"
  local lines="$2"
  [ -n "$lines" ] || return 0

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if grep -Fqx "$prefix = $line" "$tmp_path" 2>/dev/null; then
      continue
    fi
    printf '%s = %s\n' "$prefix" "$line" >>"$tmp_path"
  done <<<"$lines"
}

append_unique_lines "extra-substituters" "$substituters"
append_unique_lines "extra-trusted-public-keys" "$trusted_keys"

mv "$tmp_path" "$config_path"
echo "Configured extra Nix binary caches in $config_path"
