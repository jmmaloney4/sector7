#!/usr/bin/env bash
set -euo pipefail

ADR_FILES="${ADR_FILES:?ADR_FILES env var is required}"
PR_URL="${PR_URL:?PR_URL env var is required}"
BASE_BRANCH="${BASE_BRANCH:-main}"
PR_NUMBER="${PR_NUMBER:-}"
COMMIT_MESSAGE="${COMMIT_MESSAGE:-}"
POST_GENERATE_COMMAND="${POST_GENERATE_COMMAND:-}"
created_numbers=()

# Quote a YAML plain scalar only when YAML requires it (leading indicator,
# colon-space, comment start, quotes, or surrounding whitespace).
yaml_format_scalar() {
  local value=$1
  local first=${value:0:1}
  local needs_quotes=0
  if [ -z "$value" ]; then
    needs_quotes=1
  elif [[ $value =~ ^[[:space:]] ]] || [[ $value =~ [[:space:]]$ ]]; then
    needs_quotes=1
  else
    case $first in
    '-' | ':' | '?' | ',' | '[' | ']' | '{' | '}' | '#' | '&' | '*' | '!' | '|' | '>' | "'" | '"' | '%' | '@' | '`')
      needs_quotes=1
      ;;
    esac
    if [[ $value == *": "* ]] || [[ $value == *" #"* ]] || [[ $value == *\"* ]] || [[ $value == *"'"* ]]; then
      needs_quotes=1
    fi
  fi
  if [ "$needs_quotes" -eq 1 ]; then
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    printf '"%s"' "$value"
  else
    printf '%s' "$value"
  fi
}

write_placeholder() {
  local adr_file=$1
  local adr_number=$2
  local adr_title=$3
  local current_date=$4
  local yaml_title
  yaml_title=$(yaml_format_scalar "$adr_title")
  cat >"$adr_file" <<EOF
---
id: ADR-${adr_number}
title: ${yaml_title}
status: proposed
date: ${current_date}
---

# ADR ${adr_number}: ${adr_title}

*Date:* ${current_date}
*Status:* proposed

**Related PR:** ${PR_URL}

This ADR is currently being developed in linked pull request above.
Please refer to that PR for current content and discussion.
EOF
}

if [ ! -f "$ADR_FILES" ]; then
  echo "Error: ADR_FILES '$ADR_FILES' does not exist" >&2
  exit 1
fi

# Configure git for commits
git config user.name "GitHub Actions ADR Bot"
git config user.email "actions@github.com"

# Fetch latest base branch to reduce race condition window
git fetch origin "${BASE_BRANCH}"
git checkout "origin/${BASE_BRANCH}" -b "${BASE_BRANCH}-placeholder"

current_date=$(date -u +%Y-%m-%d)

while IFS= read -r adr_file; do
  [ -z "$adr_file" ] && continue

  # Security: Prevent path traversal and validate path
  # 1. Prevent directory traversal (../) anywhere in path
  if [[ $adr_file =~ (^|/)\.\.(/|$) ]]; then
    printf "Error: Unsafe ADR file path (contains '..'): %s\n" "$adr_file" >&2
    continue
  fi

  # 2. Must be a relative path to a markdown file (optionally with directories)
  # Regex allows: 'foo.md', 'dir/foo.md', 'dir/subdir/foo.md'
  # Rejects: '/foo.md' (absolute), 'foo.txt' (wrong extension)
  if [[ $adr_file =~ ^/ ]] || [[ ! $adr_file =~ ^([^/].*/)*[^/]+\.md$ ]]; then
    printf "Error: Invalid ADR file path format: %s\n" "$adr_file" >&2
    printf "Expected: relative path to .md file (e.g., 'docs/adr/001.md')\n" >&2
    continue
  fi
  adr_filename=$(basename "$adr_file")
  adr_number=$(echo "$adr_filename" | grep -o '^[0-9]\{3\}' || echo "")
  if [ -z "$adr_number" ]; then
    echo "Warning: Could not extract ADR number from $adr_filename, skipping"
    continue
  fi

  created_numbers+=("$adr_number")

  # Extract title from filename (e.g., 001-my-title.md -> My Title)
  if [[ $adr_filename =~ ^[0-9]{3}-(.*)\.md$ ]] && [ -n "${BASH_REMATCH[1]}" ]; then
    slug="${BASH_REMATCH[1]}"
    adr_title=$(echo "$slug" | tr '-' ' ' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)} 1')
  else
    adr_title="Untitled ADR"
  fi
  # Create directory if needed
  mkdir -p "$(dirname "$adr_file")"
  write_placeholder "$adr_file" "$adr_number" "$adr_title" "$current_date"
  git add "$adr_file"
  echo "Created placeholder: $adr_file"
done <"$ADR_FILES"

if [ -n "$POST_GENERATE_COMMAND" ]; then
  if [ "${#created_numbers[@]}" -eq 0 ]; then
    echo "Skipping post-generate-command (no placeholders written)"
  else
    echo "Running post-generate-command"
    if ! bash -euo pipefail -c "$POST_GENERATE_COMMAND"; then
      echo "Error: post-generate-command failed" >&2
      exit 1
    fi
    repo_root=$(git rev-parse --show-toplevel)
    git add -A -- "$repo_root"
  fi
fi

# Commit and push if there are changes
if git diff --cached --quiet; then
  echo "No changes to commit"
else
  # Join ADR numbers with commas for commit message
  joined_numbers=$(printf ", %s" "${created_numbers[@]}")
  joined_numbers="${joined_numbers:2}"

  if [ -z "$COMMIT_MESSAGE" ]; then
    # Generate conventional commit message

    if [ -n "$PR_NUMBER" ]; then
      subject="chore(docs): reserve ADR ${joined_numbers} for PR #${PR_NUMBER}"
    else
      subject="chore(docs): reserve ADR ${joined_numbers}"
    fi

    COMMIT_MESSAGE="${subject}

Related PR: ${PR_URL}"
  else
    # Replace placeholders in custom message
    COMMIT_MESSAGE="${COMMIT_MESSAGE//{{adr_numbers/}}/$joined_numbers}"
    COMMIT_MESSAGE="${COMMIT_MESSAGE//{{pr_number/}}/$PR_NUMBER}"
    COMMIT_MESSAGE="${COMMIT_MESSAGE//{{pr_url/}}/$PR_URL}"
  fi

  git commit -m "$COMMIT_MESSAGE"
  git push origin "${BASE_BRANCH}-placeholder:${BASE_BRANCH}"
  echo "Pushed placeholder(s) to ${BASE_BRANCH}"
fi
