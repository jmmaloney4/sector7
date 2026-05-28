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
tmp_path="$(mktemp -t nix-config-XXXXXX)"
trap 'rm -f "$tmp_path"' EXIT
cp "$config_path" "$tmp_path" 2>/dev/null || :

contains_element() {
  local needle="$1"
  shift

  local item
  for item in "$@"; do
    if [ "$item" = "$needle" ]; then
      return 0
    fi
  done

  return 1
}

append_config_values() {
  local key="$1"
  local new_values="$2"
  [ -n "$new_values" ] || return 0

  local existing_value=""
  if [ -f "$tmp_path" ]; then
    existing_value="$({
      grep -E "^[[:space:]]*${key}[[:space:]]*=" "$tmp_path" || :
    } | tail -n 1 | cut -d '=' -f 2-)"
  fi

  local merged=()
  local item=""
  while IFS= read -r item; do
    [ -n "$item" ] || continue
    if ! contains_element "$item" ${merged[@]+"${merged[@]}"}; then
      merged+=("$item")
    fi
  done < <(printf '%s\n%s\n' "$existing_value" "$new_values" | tr -s '[:space:]' '\n')

  if [ ${#merged[@]} -eq 0 ]; then
    return 0
  fi

  local clean_tmp
  clean_tmp="$(mktemp -t nix-config-clean-XXXXXX)"
  if [ -f "$tmp_path" ]; then
    grep -Ev "^[[:space:]]*${key}[[:space:]]*=" "$tmp_path" >"$clean_tmp" || :
  fi
  printf '%s = %s\n' "$key" "${merged[*]}" >>"$clean_tmp"
  mv "$clean_tmp" "$tmp_path"
}

append_config_values "extra-substituters" "$substituters"
append_config_values "extra-trusted-public-keys" "$trusted_keys"

mv "$tmp_path" "$config_path"
echo "Configured extra Nix binary caches in $config_path"
