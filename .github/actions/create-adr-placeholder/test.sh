#!/usr/bin/env bash
# Formatter + post-generate-command coverage for create-adr-placeholder.
# Uses a local git remote; does not contact GitHub.
set -euo pipefail

actions_root="${ADR_PLACEHOLDER_ROOT:-$(cd "$(dirname "$0")" && pwd)}"
script="${actions_root}/script.sh"
action_yml="${actions_root}/action.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f $script ]] || fail "script not found: $script"
[[ -f $action_yml ]] || fail "action.yml not found: $action_yml"
bash -n "$script"

grep -q '^  post-generate-command:' "$action_yml" ||
  fail "action.yml must declare post-generate-command"
grep -q 'nix fmt && python scripts/generate_internal_indexes.py' "$action_yml" ||
  fail "action.yml should document an example like nix fmt && python scripts/generate_internal_indexes.py"

export GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
export HOME="$workdir/home"
mkdir -p "$HOME"
git config --global user.name "test"
git config --global user.email "test@example.com"
git config --global commit.gpgsign false
git config --global init.defaultBranch main
git config --global --add safe.directory '*'

setup_consumer() {
  local dir="$1"
  mkdir -p "$dir"
  git init -b main "$dir" >/dev/null
  git -C "$dir" config user.name "test"
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config commit.gpgsign false
  printf 'init\n' >"$dir/README"
  git -C "$dir" add README
  git -C "$dir" commit -m init >/dev/null
  git init --bare -b main "$dir.origin.git" >/dev/null
  git -C "$dir" remote add origin "$dir.origin.git"
  git -C "$dir" push -u origin main >/dev/null
}

run_action() {
  local worktree="$1"
  local adr_list="$2"
  (
    cd "$worktree"
    ADR_FILES="$adr_list" \
      PR_URL="${PR_URL:-https://github.com/example/repo/pull/4097}" \
      PR_NUMBER="${PR_NUMBER:-4097}" \
      BASE_BRANCH=main \
      POST_GENERATE_COMMAND="${POST_GENERATE_COMMAND-}" \
      bash "$script"
  )
}

assert_file_equals() {
  local actual_path="$1"
  local expected_path="$2"
  if ! cmp -s "$actual_path" "$expected_path"; then
    echo "FAIL: contents mismatch for $actual_path" >&2
    echo "----- expected -----" >&2
    cat -A "$expected_path" >&2
    echo "----- actual -----" >&2
    cat -A "$actual_path" >&2
    exit 1
  fi
}

today=$(date -u +%Y-%m-%d)

# --- formatting: colon-space title must be quoted; blank line after H1; trailing newline ---
fmt_repo="$workdir/fmt"
setup_consumer "$fmt_repo"
fmt_list="$workdir/fmt-adrs.txt"
tricky_rel='docs/internal/designs/340-colon-title:-needs-quotes.md'
plain_rel='docs/internal/designs/341-plain-title.md'
printf '%s\n%s\n' "$tricky_rel" "$plain_rel" >"$fmt_list"
POST_GENERATE_COMMAND="" run_action "$fmt_repo" "$fmt_list"

git -C "$fmt_repo" fetch origin main >/dev/null
git -C "$fmt_repo" show "origin/main:$tricky_rel" >"$workdir/tricky.md"
git -C "$fmt_repo" show "origin/main:$plain_rel" >"$workdir/plain.md"

cat >"$workdir/tricky.expected.md" <<EOF
---
id: ADR-340
title: "Colon Title: Needs Quotes"
status: proposed
date: ${today}
---

# ADR 340: Colon Title: Needs Quotes

*Date:* ${today}
*Status:* proposed

**Related PR:** https://github.com/example/repo/pull/4097

This ADR is currently being developed in linked pull request above.
Please refer to that PR for current content and discussion.
EOF
cat >"$workdir/plain.expected.md" <<EOF
---
id: ADR-341
title: Plain Title
status: proposed
date: ${today}
---

# ADR 341: Plain Title

*Date:* ${today}
*Status:* proposed

**Related PR:** https://github.com/example/repo/pull/4097

This ADR is currently being developed in linked pull request above.
Please refer to that PR for current content and discussion.
EOF

assert_file_equals "$workdir/tricky.md" "$workdir/tricky.expected.md"
assert_file_equals "$workdir/plain.md" "$workdir/plain.expected.md"

# --- hook success: command runs after stub write, extra files are committed ---
ok_repo="$workdir/hook-ok"
setup_consumer "$ok_repo"
ok_list="$workdir/ok-adrs.txt"
ok_rel='docs/internal/designs/001-hook-ok.md'
printf '%s\n' "$ok_rel" >"$ok_list"
POST_GENERATE_COMMAND='printf "index\n" > docs/internal/indexes.md && printf "\n# extra\n" >> docs/internal/designs/001-hook-ok.md' \
  run_action "$ok_repo" "$ok_list"
git -C "$ok_repo" fetch origin main >/dev/null
git -C "$ok_repo" cat-file -e "origin/main:docs/internal/indexes.md" ||
  fail "successful hook should stage new files"
git -C "$ok_repo" show "origin/main:$ok_rel" | grep -q '# extra' ||
  fail "successful hook should stage edits to the stub"

# --- hook failure: no commit, no push ---
fail_repo="$workdir/hook-fail"
setup_consumer "$fail_repo"
fail_list="$workdir/fail-adrs.txt"
fail_rel='docs/internal/designs/002-hook-fail.md'
printf '%s\n' "$fail_rel" >"$fail_list"
init_sha=$(git -C "$fail_repo" rev-parse origin/main)
if POST_GENERATE_COMMAND='printf "nope\n" > hook-fail.txt; exit 1' \
  run_action "$fail_repo" "$fail_list"; then
  fail "post-generate-command failure must fail the action"
fi
git -C "$fail_repo" fetch origin main >/dev/null
after_sha=$(git -C "$fail_repo" rev-parse origin/main)
[[ $after_sha == "$init_sha" ]] || fail "failed hook must not push a commit (was $init_sha, now $after_sha)"
if git -C "$fail_repo" cat-file -e "origin/main:$fail_rel" 2>/dev/null; then
  fail "failed hook must not push the stub"
fi

echo "gha-create-adr-placeholder ok"
