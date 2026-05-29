#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"

require_env() {
  local name="$1"
  if [[ -z ${!name:-} ]]; then
    echo "missing required env: $name" >&2
    exit 1
  fi
}

# Encode a string to single-line base64 (safe for heredoc expansion).
b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

run_proxy_python() {
  local body_b64="$1"
  local path="$2"
  local master_key_b64
  master_key_b64=$(b64 "$LITELLM_MASTER_KEY")

  kubectl exec -i \
    -n "$LITELLM_PROXY_NAMESPACE" \
    "deploy/$LITELLM_PROXY_DEPLOYMENT" -- \
    python3 - "$body_b64" "$path" "${LITELLM_PROXY_PORT:-4000}" <<PYEOF
import base64
import json
import sys
import urllib.error
import urllib.request

master_key = base64.b64decode("${master_key_b64}").decode()
body = json.loads(base64.b64decode(sys.argv[1]).decode())
path = sys.argv[2]
port = int(sys.argv[3])

req = urllib.request.Request(
    f"http://localhost:{port}{path}",
    data=json.dumps(body).encode(),
    headers={
        "Authorization": f"Bearer {master_key}",
        "Content-Type": "application/json",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode())
        if isinstance(payload, dict) and "error" in payload:
            print(json.dumps(payload["error"]), file=sys.stderr)
            sys.exit(1)
        print(json.dumps(payload))
except urllib.error.HTTPError as exc:
    body_text = exc.read().decode()
    print(f"HTTP {exc.code}: {body_text}", file=sys.stderr)
    sys.exit(1)
except Exception as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(1)
PYEOF
}

extract_field() {
  local json_text="$1"
  local field="$2"
  local json_b64
  json_b64=$(b64 "$json_text")
  python3 - "$json_b64" "$field" <<'PYEOF'
import base64
import json
import sys

payload = json.loads(base64.b64decode(sys.argv[1]).decode())
field = sys.argv[2]
value = payload
for part in field.split('.'):
    if isinstance(value, dict):
        value = value.get(part)
    else:
        value = None
        break
if value is None:
    sys.exit(1)
if isinstance(value, (dict, list)):
    print(json.dumps(value))
else:
    print(value)
PYEOF
}

# Find an existing team by team_id or team_alias.
# Performs the full lookup inside the container (single kubectl exec).
# Prints the team_id if found, exits with code 1 if not found.
find_team() {
  local search_id="${1:-}"
  local search_alias="${2:-}"
  local master_key_b64
  master_key_b64=$(b64 "$LITELLM_MASTER_KEY")

  kubectl exec -i \
    -n "$LITELLM_PROXY_NAMESPACE" \
    "deploy/$LITELLM_PROXY_DEPLOYMENT" -- \
    python3 - "$master_key_b64" "${LITELLM_PROXY_PORT:-4000}" "$search_id" "$search_alias" <<'PYEOF'
import base64
import json
import sys
import urllib.error
import urllib.request

master_key = base64.b64decode(sys.argv[1]).decode()
port = int(sys.argv[2])
search_id = sys.argv[3]
search_alias = sys.argv[4]

req = urllib.request.Request(
    f"http://localhost:{port}/team/list",
    headers={"Authorization": f"Bearer {master_key}"},
)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
except Exception as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(1)

teams = data if isinstance(data, list) else data.get("teams", data.get("data", []))
if not isinstance(teams, list):
    print("unexpected /team/list response format", file=sys.stderr)
    sys.exit(1)

for team in teams:
    if search_id and team.get("team_id") == search_id:
        print(team["team_id"])
        sys.exit(0)
    if search_alias and team.get("team_alias") == search_alias:
        print(team["team_id"])
        sys.exit(0)

sys.exit(1)
PYEOF
}

# Find an existing key by key_alias.
# Performs the full lookup inside the container (single kubectl exec).
# Iterates /key/list -> /key/info for each key to match alias.
# Prints the token if found, exits with code 1 if not found.
find_key_by_alias() {
  local search_alias="$1"
  local master_key_b64
  master_key_b64=$(b64 "$LITELLM_MASTER_KEY")

  kubectl exec -i \
    -n "$LITELLM_PROXY_NAMESPACE" \
    "deploy/$LITELLM_PROXY_DEPLOYMENT" -- \
    python3 - "$master_key_b64" "${LITELLM_PROXY_PORT:-4000}" "$search_alias" <<'PYEOF'
import base64
import json
import sys
import urllib.error
import urllib.request

master_key = base64.b64decode(sys.argv[1]).decode()
port = int(sys.argv[2])
search_alias = sys.argv[3]

# List all key hashes
list_req = urllib.request.Request(
    f"http://localhost:{port}/key/list",
    headers={"Authorization": f"Bearer {master_key}"},
)
try:
    with urllib.request.urlopen(list_req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
except Exception as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(1)

keys = data.get("keys", data) if isinstance(data, dict) else data
if not isinstance(keys, list):
    print("unexpected /key/list response format", file=sys.stderr)
    sys.exit(1)

# Check each key's info for matching alias
for key_hash in keys:
    info_req = urllib.request.Request(
        f"http://localhost:{port}/key/info?key={key_hash}",
        headers={"Authorization": f"Bearer {master_key}"},
    )
    try:
        with urllib.request.urlopen(info_req, timeout=15) as resp:
            info_data = json.loads(resp.read().decode())
    except Exception:
        continue

    info = info_data.get("info", info_data)
    if info.get("key_alias") == search_alias:
        token = info.get("token", "")
        if token:
            print(token)
            sys.exit(0)

sys.exit(1)
PYEOF
}

require_env LITELLM_PROXY_NAMESPACE
require_env LITELLM_MASTER_KEY
require_env LITELLM_PROXY_DEPLOYMENT

case "$ACTION" in
create-key)
  require_env LITELLM_KEY_ALIAS
  require_env LITELLM_KEY_VALUE

  # Idempotency: check if a key with this alias already exists.
  existing_token=$(find_key_by_alias "$LITELLM_KEY_ALIAS" 2>/dev/null) || true
  if [[ -n "$existing_token" ]]; then
    echo "$existing_token"
    exit 0
  fi

  # Key not found — create it.
  body=$(
    python3 - <<'PYEOF'
import json
import os

body = {
    "key_alias": os.environ["LITELLM_KEY_ALIAS"],
    "key": os.environ["LITELLM_KEY_VALUE"],
    "models": json.loads(os.environ.get("LITELLM_KEY_MODELS_JSON", "[]")),
    "aliases": json.loads(os.environ.get("LITELLM_KEY_ALIASES_JSON", "{}")),
    "metadata": json.loads(os.environ.get("LITELLM_KEY_METADATA_JSON", "{}")),
}
# tags is a LiteLLM Enterprise feature — only include when non-empty.
_tags = json.loads(os.environ.get("LITELLM_KEY_TAGS_JSON", "[]"))
if _tags:
    body["tags"] = _tags
for env_key, body_key in [
    ("LITELLM_KEY_TEAM_ID", "team_id"),
    ("LITELLM_KEY_USER_ID", "user_id"),
    ("LITELLM_KEY_BUDGET_ID", "budget_id"),
    ("LITELLM_KEY_MAX_BUDGET", "max_budget"),
    ("LITELLM_KEY_BUDGET_DURATION", "budget_duration"),
    ("LITELLM_KEY_DURATION", "duration"),
]:
    value = os.environ.get(env_key, "")
    if value == "":
        continue
    if body_key == "max_budget":
        body[body_key] = float(value)
    else:
        body[body_key] = value
print(json.dumps(body))
PYEOF
  )
  response=$(run_proxy_python "$(b64 "$body")" "/key/generate")
  extract_field "$response" "token"
  ;;

delete-key)
  token_id="${PULUMI_COMMAND_STDOUT:-${LITELLM_KEY_VALUE:-}}"
  if [[ -z $token_id ]]; then
    exit 0
  fi
  body=$(printf '{"keys":["%s"]}' "$token_id")
  run_proxy_python "$(b64 "$body")" "/key/delete" >/dev/null
  ;;

create-team)
  require_env LITELLM_TEAM_ALIAS

  # Idempotency: check if a team with this team_id or team_alias already exists.
  existing_team=$(find_team "${LITELLM_TEAM_ID:-}" "$LITELLM_TEAM_ALIAS" 2>/dev/null) || true
  if [[ -n "$existing_team" ]]; then
    echo "$existing_team"
    exit 0
  fi

  # Team not found — create it.
  body=$(
    python3 - <<'PYEOF'
import json
import os

body = {
    "team_alias": os.environ["LITELLM_TEAM_ALIAS"],
    "models": json.loads(os.environ.get("LITELLM_TEAM_MODELS_JSON", "[]")),
    "metadata": json.loads(os.environ.get("LITELLM_TEAM_METADATA_JSON", "{}")),
}
# tags is a LiteLLM Enterprise feature — only include when non-empty.
_tags = json.loads(os.environ.get("LITELLM_TEAM_TAGS_JSON", "[]"))
if _tags:
    body["tags"] = _tags
for env_key, body_key in [
    ("LITELLM_TEAM_ID", "team_id"),
    ("LITELLM_TEAM_MAX_BUDGET", "max_budget"),
    ("LITELLM_TEAM_BUDGET_DURATION", "budget_duration"),
]:
    value = os.environ.get(env_key, "")
    if value == "":
        continue
    if body_key == "max_budget":
        body[body_key] = float(value)
    else:
        body[body_key] = value
print(json.dumps(body))
PYEOF
  )
  response=$(run_proxy_python "$(b64 "$body")" "/team/new")
  extract_field "$response" "team_id"
  ;;

delete-team)
  team_id="${LITELLM_TEAM_ID:-${PULUMI_COMMAND_STDOUT:-}}"
  if [[ -z $team_id ]]; then
    exit 0
  fi
  body=$(printf '{"team_ids":["%s"]}' "$team_id")
  run_proxy_python "$(b64 "$body")" "/team/delete" >/dev/null
  ;;

*)
  echo "usage: $0 {create-key|delete-key|create-team|delete-team}" >&2
  exit 1
  ;;
esac
