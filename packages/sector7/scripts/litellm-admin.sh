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

run_proxy_python() {
  local body_b64="$1"
  local path="$2"
  local master_key_b64
  master_key_b64=$(printf '%s' "$LITELLM_MASTER_KEY" | base64)

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
  json_b64=$(printf '%s' "$json_text" | base64)
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

require_env LITELLM_PROXY_NAMESPACE
require_env LITELLM_MASTER_KEY
require_env LITELLM_PROXY_DEPLOYMENT

case "$ACTION" in
create-key)
  require_env LITELLM_KEY_ALIAS
  require_env LITELLM_KEY_VALUE
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
  response=$(run_proxy_python "$(printf '%s' "$body" | base64)" "/key/generate")
  extract_field "$response" "token"
  ;;

delete-key)
  token_id="${PULUMI_COMMAND_STDOUT:-${LITELLM_KEY_VALUE:-}}"
  if [[ -z $token_id ]]; then
    exit 0
  fi
  body=$(printf '{"keys":["%s"]}' "$token_id")
  run_proxy_python "$(printf '%s' "$body" | base64)" "/key/delete" >/dev/null
  ;;

create-team)
  require_env LITELLM_TEAM_ALIAS
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
  response=$(run_proxy_python "$(printf '%s' "$body" | base64)" "/team/new")
  extract_field "$response" "team_id"
  ;;

delete-team)
  team_id="${LITELLM_TEAM_ID:-${PULUMI_COMMAND_STDOUT:-}}"
  if [[ -z $team_id ]]; then
    exit 0
  fi
  body=$(printf '{"team_ids":["%s"]}' "$team_id")
  run_proxy_python "$(printf '%s' "$body" | base64)" "/team/delete" >/dev/null
  ;;

*)
  echo "usage: $0 {create-key|delete-key|create-team|delete-team}" >&2
  exit 1
  ;;
esac
