#!/usr/bin/env bash
# Start `attic watch-store` in the background so every store path realised
# during this job is pushed to the Attic binary cache incrementally, as it
# appears — not only by an end-of-job push step.
#
# Why this instead of a Nix `post-build-hook`: the runner uses a multi-user
# Nix daemon (DeterminateSystems installer), so a post-build-hook would run as
# root in the daemon's restricted context AND would *fail the build* if it
# errored. `attic watch-store` runs as the runner user, needs no daemon/root
# config, and is strictly best-effort — it never fails the job.
#
# Two payoffs:
#   1. Resilient seeding — a job cancelled mid-build (concurrency
#      cancel-in-progress) still uploads everything it finished, instead of
#      losing it all because the single end-of-job push never ran.
#   2. The detect job builds nix-eval-jobs from source (its pinned closure is
#      in no public cache); watch-store pushes that closure to Attic, so
#      subsequent detect runs substitute it instead of rebuilding.
set -euo pipefail

endpoint="${INPUT_ATTIC_ENDPOINT:-}"
cache="${INPUT_ATTIC_CACHE:-}"
token="${INPUT_ATTIC_TOKEN:-}"
server="${INPUT_SERVER_NAME:-ci}"

if [ -z "$endpoint" ] || [ -z "$cache" ] || [ -z "$token" ]; then
  echo "Attic watch-store: endpoint/cache/token not all set; skipping."
  exit 0
fi

# Ensure the attic client is on PATH for the rest of the job. attic-client is
# in nixpkgs (substituted from cache.nixos.org), so this does not build.
if ! command -v attic >/dev/null 2>&1; then
  echo "Installing attic-client into the Nix profile..."
  if ! nix profile install nixpkgs#attic-client; then
    echo "::warning::failed to install attic-client; skipping watch-store"
    exit 0
  fi
fi

# Isolate the attic client state to a per-job config dir so the token is not
# written into the runner's shared $HOME config (defence-in-depth; our runners
# are ephemeral one-job pods, but this keeps state job-scoped regardless).
XDG_CONFIG_HOME="$(mktemp -d -t attic-watch-XXXXXX)"
export XDG_CONFIG_HOME

if ! attic login "$server" "$endpoint" "$token"; then
  echo "::warning::attic login failed; skipping watch-store (incremental cache push disabled for this job)"
  exit 0
fi

log=/tmp/attic-watch-store.log
echo "Starting 'attic watch-store $server:$cache' in the background (log: $log)"
# Fully detach so the watcher survives this step (and step-boundary process
# cleanup) and keeps pushing for the rest of the job: `setsid` puts it in its
# own session/process group, stdin is closed (</dev/null) and stdout/stderr go
# to a file so the step never hangs on an open pipe. It is still reaped at job
# end. Failures land in the log and never affect the job. XDG_CONFIG_HOME is
# inherited so the watcher reads the isolated login config.
setsid attic watch-store "$server:$cache" </dev/null >"$log" 2>&1 &
disown || true
echo "attic watch-store started (pid $!)"
