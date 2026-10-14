#!/usr/bin/env bash
# Start a best-effort incremental niks3 push for store paths realised during
# this job. niks3 has no `watch-store` command; the streaming equivalent is
# `niks3 push --stdin` fed from inotify on /nix/store.
#
# Why this instead of `niks3-hook` / a Nix `post-build-hook`: the runner uses
# a multi-user Nix daemon, so a post-build-hook would run as root in the
# daemon's restricted context AND would *fail the build* if it errored. The
# attic helper next to this file documents the same constraint. Streaming
# push runs as the runner user, needs no daemon/root config, and is strictly
# best-effort — it never fails the job.
#
# Not a substituter: do not write extra-substituters / trusted-public-keys
# for niks3 from this script. Stock Nix substitution from niks3-test is
# currently broken; this is push-only (seven#81 / seven ADR 023).
set -euo pipefail

backend="${INPUT_CACHE_PUSH_BACKEND:-attic}"
endpoint="${INPUT_NIKS3_ENDPOINT:-}"
token_path="${INPUT_NIKS3_AUTH_TOKEN_PATH:-}"
token="${INPUT_NIKS3_AUTH_TOKEN:-}"
max_uploads="${INPUT_NIKS3_MAX_CONCURRENT_UPLOADS:-30}"

case "$backend" in
niks3 | both) ;;
*)
  echo "niks3 watch-store: cache-push-backend=${backend}; skipping (Attic remains the default)."
  exit 0
  ;;
esac

if [ -z "$endpoint" ]; then
  echo "niks3 watch-store: endpoint not set; skipping."
  exit 0
fi

if [ -z "$token_path" ] && [ -z "$token" ]; then
  echo "niks3 watch-store: auth token not set; skipping."
  exit 0
fi

if [ "$(uname -s)" != "Linux" ]; then
  echo "::warning::niks3 has no native watch-store; incremental inotify push is Linux-only. Use push-niks3-cache for the end-of-job upload."
  exit 0
fi

niks3_bin="$(command -v niks3 2>/dev/null || true)"
if [ -z "$niks3_bin" ]; then
  echo "Resolving niks3 from nixpkgs..."
  niks3_out="$(nix build --no-link --print-out-paths nixpkgs#niks3 2>/dev/null | head -n1 || true)"
  if [ -z "$niks3_out" ] || [ ! -x "$niks3_out/bin/niks3" ]; then
    echo "::warning::failed to resolve niks3; skipping incremental niks3 push"
    exit 0
  fi
  niks3_bin="$niks3_out/bin/niks3"
fi

inotifywait_bin="$(command -v inotifywait 2>/dev/null || true)"
if [ -z "$inotifywait_bin" ]; then
  echo "Resolving inotify-tools from nixpkgs..."
  inotify_out="$(nix build --no-link --print-out-paths nixpkgs#inotify-tools 2>/dev/null | head -n1 || true)"
  if [ -z "$inotify_out" ] || [ ! -x "$inotify_out/bin/inotifywait" ]; then
    echo "::warning::failed to resolve inotifywait; skipping incremental niks3 push"
    exit 0
  fi
  inotifywait_bin="$inotify_out/bin/inotifywait"
fi

workdir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
state_dir="$(mktemp -d "${workdir}/niks3-watch-XXXXXX")"
if [ -n "$token" ]; then
  # Job-scoped: GHA deletes RUNNER_TEMP after the job. The detached watcher
  # must keep this file until job end, so we cannot trap-rm it here.
  token_path="${state_dir}/auth-token"
  umask 077
  printf '%s\n' "$token" >"$token_path"
fi

if [ ! -r "$token_path" ]; then
  echo "::warning::niks3 auth token path is not readable (${token_path}); skipping incremental niks3 push"
  exit 0
fi

log="${state_dir}/watch.log"
fifo="${state_dir}/paths.fifo"
mkfifo "$fifo"

echo "Starting niks3 push --stdin from inotify on /nix/store (log: $log)"
# Fully detach so the watcher survives this step (and step-boundary process
# cleanup) and keeps pushing for the rest of the job. `setsid` alone is not
# enough on GitHub-hosted / actions/runner jobs: the worker still reaps
# children that inherit RUNNER_TRACKING_ID when this composite step ends.
# Drop that id (and the raw token env, which is already on disk at 0600)
# so later job builds still get incremental uploads. Failures land in the
# log and never affect the job. Attic's watch-store is left unchanged.
setsid env -u RUNNER_TRACKING_ID -u INPUT_NIKS3_AUTH_TOKEN \
  NIKS3_BIN="$niks3_bin" \
  INOTIFYWAIT_BIN="$inotifywait_bin" \
  NIKS3_ENDPOINT="$endpoint" \
  NIKS3_AUTH_TOKEN_PATH="$token_path" \
  NIKS3_MAX_UPLOADS="$max_uploads" \
  NIKS3_FIFO="$fifo" \
  NIKS3_STATE_DIR="$state_dir" \
  bash -c '
    set -euo pipefail
    # FIFO open(O_WRONLY) blocks until a reader exists. Start niks3 (the
    # reader) first so this writer cannot deadlock before inotify starts.
    "$NIKS3_BIN" push --stdin \
      --server-url "$NIKS3_ENDPOINT" \
      --auth-token-path "$NIKS3_AUTH_TOKEN_PATH" \
      --max-concurrent-uploads "$NIKS3_MAX_UPLOADS" \
      <"$NIKS3_FIFO" &
    niks3_pid=$!
    exec 3>"$NIKS3_FIFO"
    "$INOTIFYWAIT_BIN" -m -e moved_to,create --format "%f" /nix/store |
      while IFS= read -r name; do
        # RUNNER_TEMP cleanup unlinks files but never kills this setsid
        # watcher; stop once the state dir is gone so it cannot keep
        # pushing paths built by later jobs on persistent runners.
        [ -d "$NIKS3_STATE_DIR" ] || break
        case "$name" in
          .* | *.lock) continue ;;
        esac
        # Nix store path names are <32-char hash>-<name>. Keep .drv
        # (real store paths); skip *.lock (transient realisation locks)
        # so niks3 push --stdin cannot SIGPIPE the watcher.

        case "$name" in
          ????????????????????????????????-*) ;;
          *) continue ;;
        esac
        path="/nix/store/${name}"
        [ -e "$path" ] || continue
        printf "%s\n" "$path" >&3
      done
    kill "$niks3_pid" 2>/dev/null || true
  ' </dev/null >"$log" 2>&1 &
watch_pid=$!
disown || true
# Startup crashes (bad flag, rejected token, unreachable endpoint) would
# otherwise push nothing for the whole job with no visible signal.
sleep 2
if ! kill -0 "$watch_pid" 2>/dev/null; then
  echo "::warning::niks3 incremental pusher exited during startup; see $log"
  tail -n 20 "$log" 2>/dev/null || true
fi
echo "niks3 incremental push started (pid $watch_pid, state $state_dir)"
