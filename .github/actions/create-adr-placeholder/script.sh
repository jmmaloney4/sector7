#!/usr/bin/env bash
set -euo pipefail

ADR_FILES="${ADR_FILES:?ADR_FILES env var is required}"
PR_URL="${PR_URL:?PR_URL env var is required}"
BASE_BRANCH="${BASE_BRANCH:-main}"
PR_NUMBER="${PR_NUMBER:-}"
COMMIT_MESSAGE="${COMMIT_MESSAGE:-}"
POST_GENERATE_COMMAND="${POST_GENERATE_COMMAND:-}"
created_numbers=()
created_files=()

# Quote a YAML plain scalar only when YAML requires it (leading indicator,
# colon-space, trailing colon, whitespace-free digit-containing values,
# YAML 1.1 .inf/.nan spellings, bool/null words, comment start, quotes, or
# surrounding whitespace).
yaml_format_scalar() {
  local value=$1
  local first=${value:0:1}
  local folded
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
  if [ "$needs_quotes" -eq 0 ]; then
    if [[ $value == *: ]]; then
      needs_quotes=1
    elif [[ $value != *[[:space:]]* && $value == *[0-9]* ]]; then
      # Conservative: YAML 1.1 (e.g. PyYAML) also resolves scientific notation,
      # leading-dot floats, and hex/octal/underscore ints as non-strings.
      needs_quotes=1
    else
      folded=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')
      case $folded in
      yes | no | true | false | on | off | null | ~ | .inf | +.inf | -.inf | .nan | +.nan | -.nan)
        needs_quotes=1
        ;;
      esac
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

# Snapshot worktree file hashes (tracked + untracked, excluding ignored).
# Records are hash<TAB>path, one per line. Paths with newlines are skipped.
# File hashes are computed in one git hash-object --stdin-paths invocation.
snapshot_worktree() {
  local out=$1
  local path dir files hashes kinds paths
  dir=$(mktemp -d)
  files="$dir/files"
  hashes="$dir/hashes"
  kinds="$dir/kinds"
  paths="$dir/paths"
  : >"$files"
  : >"$kinds"
  : >"$paths"
  {
    git ls-files -z
    git ls-files -z --others --exclude-standard
  } | sort -z -u | while IFS= read -r -d '' path; do
    [[ -n $path ]] || continue
    if [[ $path == *$'\n'* ]]; then
      continue
    fi
    printf '%s\n' "$path" >>"$paths"
    if [[ -f $path || -L $path ]]; then
      printf 'F\n' >>"$kinds"
      printf '%s\n' "$path" >>"$files"
    else
      printf 'A\n' >>"$kinds"
    fi
  done
  if [[ -s $files ]]; then
    git hash-object --stdin-paths <"$files" >"$hashes"
  else
    : >"$hashes"
  fi
  awk -F '\t' '
    NR == FNR { hashes[++nh] = $0; next }
    {
      kind = $1
      path = substr($0, index($0, "\t") + 1)
      if (kind == "F") print hashes[++hi] "\t" path
      else print "ABSENT\t" path
    }
  ' "$hashes" <(paste -d $'\t' "$kinds" "$paths") >"$out"
  rm -rf "$dir"
}

# After the hook, keep the ADR stubs staged and add only paths whose contents
# (or existence) changed relative to the pre-hook snapshot. Pre-existing dirty
# or untracked paths the hook did not touch stay unstaged.
stage_hook_delta() {
  local pre=$1
  local post path adr
  post=$(mktemp)
  snapshot_worktree "$post"
  git reset --quiet

  for adr in "${created_files[@]}"; do
    git add -- "$adr"
  done

  awk -F '\t' '
    NR == FNR { pre[$2] = $1; next }
    {
      post[$2] = $1
      if (pre[$2] != $1) print $2
    }
    END {
      for (p in pre) if (!(p in post)) print p
    }
  ' "$pre" "$post" | while IFS= read -r path; do
    [[ -n $path ]] || continue
    if [[ -e $path || -L $path ]]; then
      git add -- "$path"
    elif git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
      git add -- "$path"
    fi
  done

  rm -f "$post"
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
  created_files+=("$adr_file")

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
    pre_snapshot=$(mktemp)
    snapshot_worktree "$pre_snapshot"
    if ! bash -euo pipefail -c "$POST_GENERATE_COMMAND"; then
      rm -f "$pre_snapshot"
      echo "Error: post-generate-command failed" >&2
      exit 1
    fi
    stage_hook_delta "$pre_snapshot"
    rm -f "$pre_snapshot"
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
