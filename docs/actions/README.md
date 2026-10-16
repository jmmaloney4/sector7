# GitHub Actions Workflows

This repository provides reusable GitHub Actions workflows for common CI/CD tasks across projects.

## Available Workflows

### 🦀 `rust.yml`

- **Path**: `.github/workflows/rust.yml` (callable-only)
- **Purpose**: Run Rust CI (cargo check, test with nextest + JUnit, clippy formatting)
- **Required inputs**:
  - **runs-on**: Runner label (e.g., `ubuntu-latest` or your self-hosted label)
  - **repository**: Repository to checkout (`owner/repo`), typically `${{ github.repository }}`
  - **ref**: Git ref to build, typically `${{ github.ref }}`

#### Minimal consumer workflow (copy-paste)

```yaml
name: '🦀 rust'
on:
  workflow_dispatch:
  pull_request:
  push:
    branches:
    - main

permissions:
  contents: read
  id-token: write
  checks: write

jobs:
  rust:
    uses: jmmaloney4/sector7/.github/workflows/rust.yml@main
    with:
      repository: ${{ github.repository }}
      ref: ${{ github.ref }}
```

### ❄️ `nix.yml`

- **Path**: `.github/workflows/nix.yml` (callable-only)
- **Purpose**: Build uncached Nix flake outputs for the calling repository
- **Required inputs**:
  - **runs-on**: Runner label (e.g., `ubuntu-latest` or your self-hosted label). For multiple labels, pass a JSON array string like `["self-hosted","linux","x64"]`.
  - **repository**: Repository to build (`owner/repo`), typically `${{ github.repository }}`
  - **ref**: Git ref to build, typically `${{ github.ref }}`
- **Optional inputs**:
  - **binary-cache-url**: Full substituter URL for an extra binary cache (for example `https://attic.example.com/cache`)
  - **binary-cache-public-key**: Trusted public key for that binary cache
  - **binary-cache-endpoint**: Attic server root URL used for `attic login` before cache pushes
  - **binary-cache-name**: Attic cache name used for cache pushes
- **Optional secrets**:
  - **BINARY_CACHE_TOKEN**: Attic token with push permission for `binary-cache-name`

#### Minimal consumer workflow (copy-paste)

```yaml
name: '❄️ nix'
on:
  workflow_dispatch:
  pull_request:
  push:
    branches:
    - main

permissions:
  contents: read
  id-token: write

jobs:
  nix:
    uses: jmmaloney4/sector7/.github/workflows/nix.yml@main
    with:
      repository: ${{ github.repository }}
      ref: ${{ github.ref }}
```

#### Multi-platform (self-hosted) example

```yaml
jobs:
  nix:
    strategy:
      matrix:
        include:
          - name: linux
            runs-on: '["self-hosted","linux","x64"]'
          - name: darwin
            runs-on: '["self-hosted","macos","arm64"]'
    uses: jmmaloney4/sector7/.github/workflows/nix.yml@main
    with:
      runs-on: ${{ matrix.runs-on }}
      repository: ${{ github.repository }}
      ref: ${{ github.ref }}
```

#### Attic-backed binary cache example

```yaml
jobs:
  nix:
    uses: jmmaloney4/sector7/.github/workflows/nix.yml@main
    with:
      runs-on: '["self-hosted","room-of-requirement"]'
      repository: ${{ github.repository }}
      ref: ${{ github.ref }}
      binary-cache-url: ${{ vars.ATTIC_CACHE_URL }}
      binary-cache-public-key: ${{ vars.ATTIC_CACHE_PUBLIC_KEY }}
      binary-cache-endpoint: ${{ vars.ATTIC_SERVER_URL }}
      binary-cache-name: ${{ vars.ATTIC_CACHE_NAME }}
    secrets:
      BINARY_CACHE_TOKEN: ${{ secrets.ATTIC_CACHE_TOKEN }}
```

This contract keeps the reusable workflow generic:

- placement stays in the caller's `runs-on`
- the caller decides which cache to use
- Sector7 only wires the supplied cache into `nix.conf`, cache probing, and post-build Attic pushes
- `nix-setup` runs `attic watch-store -j 1` and `push-attic-cache` runs `attic push -j 1 --stdin`. The attic client defaults to 5 parallel uploads; atticd has no server-side limit, so unbounded concurrency OOMs the cache (room-of-requirement/seven#81)

Attic remains the default cache backend. The reusable `nix.yml` / `push-nix-image.yml` workflows are unchanged.

### Opt-in niks3 push helpers

Composite actions (usable from a caller workflow without changing Sector7's reusable workflows):

- `.github/actions/push-niks3-cache` — realize one flake output and `niks3 push --stdin`
- `.github/actions/nix-setup` `cache-push-backend` + `niks3-*` inputs — incremental `niks3 push --stdin` from inotify on `/nix/store` (Linux), analog of `attic watch-store`

niks3 authenticates with a bearer token via `--auth-token-path` (not Attic HS256 JWTs, not `--auth-token` on argv). The CLI also accepts `NIKS3_SERVER_URL` and `NIKS3_AUTH_TOKEN_FILE`.

**Push only.** Do not pass the niks3-test URL as `extra-substituters` / `binary-cache-url`. Stock Nix substitution from this server is currently broken. The trusted public key for a later substituter trial is `niks3-test-1:cCyJ4sfbrAM8LbVW4IWX7kyAsx5CemWkld7XBlZaR0Y=`. NAR bodies are uploaded as path-style HTTP PUTs to `s3.roomofrequirement.xyz`.

Test server (hagrid, Tailnet only): `https://niks3-test.mellori-delta.ts.net`. Trial approved 2026-10-14, goal of eventually replacing Attic (`room-of-requirement/seven#81`, seven ADR 023).

`nix-setup` input `cache-push-backend`:

| Value             | Incremental pusher                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| `attic` (default) | `attic watch-store -j 1` when Attic creds are set. Existing callers unchanged.                    |
| `niks3`           | niks3 stdin/inotify pusher when niks3 endpoint + token are set. Attic watch-store does not start. |
| `both`            | Start each helper whose creds are present.                                                        |

```yaml
- uses: jmmaloney4/sector7/.github/actions/nix-setup@main
  with:
    runs-on: ${{ matrix.runs-on }}
    cache-push-backend: niks3
    niks3-endpoint: https://niks3-test.mellori-delta.ts.net
    niks3-auth-token-path: ${{ runner.temp }}/niks3-auth-token

- uses: jmmaloney4/sector7/.github/actions/push-niks3-cache@main
  with:
    flake-attr: ${{ matrix.attr }}
    niks3-endpoint: https://niks3-test.mellori-delta.ts.net
    niks3-auth-token-path: ${{ runner.temp }}/niks3-auth-token
```

Write the bearer token to `niks3-auth-token-path` in an earlier step (`umask 077`). Alternatively pass `niks3-auth-token` and the helper writes a job-scoped file itself. Fork PRs with an empty token skip the push, matching Attic.

Do not use `Mic92/niks3-action` / `niks3-hook` here: those register a Nix `post-build-hook`, which on these multi-user daemon runners runs as root and fails the build on upload errors. Same reason `nix-setup` uses `attic watch-store` instead of a post-build-hook.

### 📦 `pnpm.yml`

- **Path**: `.github/workflows/pnpm.yml` (callable-only)
- **Purpose**: Publish pnpm packages to GitHub Container Registry (GHCR) with automatic version analysis
- **Required inputs**:
  - **runs-on**: Runner label (e.g., `ubuntu-latest` or your self-hosted label)
  - **repository**: Repository to checkout (`owner/repo`), typically `${{ github.repository }}`
  - **ref**: Git ref to build, typically `${{ github.ref }}`
- **Optional inputs**:
  - **dry_run**: Run in dry-run mode (show analysis without publishing) - defaults to `false`

#### Minimal consumer workflow (copy-paste)

```yaml
name: '📦 pnpm'
on:
  workflow_dispatch:
  push:
    branches:
    - main
    tags:
    - 'v*'

permissions:
  contents: read
  packages: write

jobs:
  pnpm:
    uses: jmmaloney4/sector7/.github/workflows/pnpm.yml@main
    with:
      repository: ${{ github.repository }}
      ref: ${{ github.ref }}
      dry_run: ${{ !startsWith(github.ref, 'refs/tags/v') }}
```

**Note**: This workflow automatically analyzes package versions and only publishes packages that have version changes. It uses the `analyze-pnpm-packages` action to determine which packages need publishing.

### ☁️ `pulumi.yml`

- **Path**: `.github/workflows/pulumi.yml` (callable-only)
- **Purpose**: Preview and deploy Pulumi stacks. Preview artifacts are uploaded; this workflow does not post a PR comment.
- **Required inputs**:
  - **repository**: Repository to checkout (`owner/repo`), typically `${{ github.repository }}`
  - **ref**: Git ref to build, typically `${{ github.ref }}`
  - **google_workload_identity_provider**: GCP Workload Identity Provider resource
  - **google_service_account_email**: GCP service account email
  - **pulumi_backend_url**: GCS bucket URL for Pulumi backend (e.g., `gs://my-bucket-name`)
  - **nodejs_package_manager**: `pnpm`, `npm`, or `none`
- **Optional inputs**:
  - **runs-on**: Runner label (defaults to `self-hosted`). For multiple labels, pass a JSON array string like `["self-hosted","linux","x64"]`.
  - **pr_number**: Declared unused. Accepted for caller compatibility; the workflow never reads it and nothing posts a comment.
  - **is_fork**: Whether the PR comes from a fork. When true, Attic push credentials are blanked even if a token is supplied.
  - **ignore_projects**: Comma-separated list of Pulumi project paths to skip when detecting stacks
  - **binary-cache-url**: Full substituter URL for an extra binary cache (for example `https://attic.example.com/cache`)
  - **binary-cache-public-key**: Trusted public key for that binary cache
  - **binary-cache-endpoint**: Attic server root URL used for `attic login` before cache pushes
  - **binary-cache-name**: Attic cache name used for cache pushes
  - **preview_only**: Boolean. Default **`true`**. When true, every caller event (PR, `main` push, `v*` tag, `workflow_dispatch`) still runs `pulumi preview` and uploads artifacts, but **never** `pulumi up`. Consumers must pass `preview_only: false` to enable stage/prod deploys.
- **Optional secrets**:
  - **BINARY_CACHE_TOKEN**: Attic token with push permission for `binary-cache-name`. Ignored for forks (`inputs.is_fork` blanks `attic-token` even if the caller supplies a token).

**Safe by default.** Until a consumer opts in, CI cannot apply. Pass `preview_only: false` only when you intend `pulumi up` on `main` (stage) and `v*` tags (prod).

#### Migrating existing callers (sector7#410)

`preview_only` now defaults to `true` (`c18c673`). A caller that used to deploy on `main` or `v*` tags now only previews unless it passes `preview_only: false`.

To keep the new default explicit in a consumer workflow (so a later `workflow_call` default change cannot silently start applying):

```yaml
# 2026-10-16: pin the sector7#410 default (preview only; no pulumi up).
preview_only: true
```

| Caller event                  | `preview_only: true` (default) | `preview_only: false`                                  |
| ----------------------------- | ------------------------------ | ------------------------------------------------------ |
| `pull_request`                | preview + artifacts            | preview + artifacts (no up; not main / not a `v*` tag) |
| `push` to `main`              | preview + artifacts            | preview, then `pulumi up` for `stage`                  |
| `push` of `v*` tag            | preview + artifacts            | preview, then `pulumi up` for `prod`                   |
| `workflow_dispatch` on `main` | preview + artifacts            | same as `push` to `main`                               |

Concurrency: preview-only runs on `main` / `v*` tags use the **preview** group. The deploy group is used only when `preview_only` is false *and* the ref is `main` or a `v*` tag. (`github.event_name` in this called workflow is the **caller** event, never `workflow_call`.)

Permissions cannot be conditional in GitHub Actions, so `deployments: write` stays on the job even for preview-only runs. This workflow does not call the GitHub Deployments API; the grant is unused unless a future step does.

#### Minimal consumer workflow (copy-paste)

```yaml
name: '☁️ pulumi'
on:
  push:
    branches:
    - main
  pull_request:
  workflow_dispatch:

permissions:
  contents: read
  packages: read
  actions: write
  deployments: write
  id-token: write
  issues: write
  pull-requests: write

jobs:
  pulumi:
    uses: jmmaloney4/sector7/.github/workflows/pulumi.yml@main
    with:
      repository: ${{ github.repository }}
      ref: ${{ github.ref }}
      google_workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}
      google_service_account_email: ${{ vars.GCP_SERVICE_ACCOUNT_EMAIL }}
      pulumi_backend_url: gs://${{ vars.PULUMI_BACKEND_BUCKET }}
      nodejs_package_manager: pnpm  # Required: "pnpm", "npm", or "none"
      # Default is true (previews only; zero chance of pulumi up).
      # Uncomment to enable stage/prod deploys:
      # preview_only: false
      # 2026-10-16: explicit pin of the sector7#410 default (optional; same as omitting).
      # preview_only: true

      # pr_number is declared on the reusable workflow but unused (nothing posts a comment).
      pr_number: ${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && github.event.pull_request.number || 0 }}
      is_fork: ${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && github.event.pull_request.head.repo.fork }}
```

**Required inputs:**

- `nodejs_package_manager`: Package manager for Node.js dependencies. Valid values:
  - `"pnpm"`: Use pnpm (recommended for most projects)
  - `"npm"`: Use npm
  - `"none"`: Skip dependency installation (for non-Node.js Pulumi projects)

**Caller flake contract:** The workflow requires a `ci-pulumi` dev shell in the caller repository. That shell must provide `pulumi`, `jq`, and the selected Node.js package manager (`pnpm` or `npm`). When `nodejs_package_manager` is `"none"`, no Node.js package manager is required.

**Note**: Ensure each Pulumi stack defines `gcp:project` in its stack configuration to specify the target GCP project.

### 🤖 `claude.yml`

- **Path**: `.github/workflows/claude.yml` (callable-only)
- **Purpose**: Automated Claude AI assistant for GitHub issues and comments
- **Important**: Put all event-based `if:` conditions in the caller workflow. The reusable workflow runs under `workflow_call` and does not have access to original event payloads.
- **Required inputs**:
  - **runs-on**: Runner label (e.g., `ubuntu-latest` or your self-hosted label)
  - **repository**: Repository to checkout (`owner/repo`), typically `${{ github.repository }}`
  - **ref**: Git ref to build, typically `${{ github.ref }}`

#### Minimal consumer workflow (copy-paste)

```yaml
name: 🤖 claude

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  pull-requests: read
  issues: read
  id-token: write
  actions: read

jobs:
  claude:
    # Gate on event context in the caller
    if: |
      (github.event_name == 'issue_comment' &&
       (contains(github.event.comment.body, '@claude') || contains(github.event.comment.body, '@Claude') || contains(github.event.comment.body, '@CLAUDE')) &&
       !(contains(github.event.comment.body, 'claude review') || contains(github.event.comment.body, 'Claude review') || contains(github.event.comment.body, 'CLAUDE REVIEW'))) ||
      (github.event_name == 'pull_request_review_comment' &&
       (contains(github.event.comment.body, '@claude') || contains(github.event.comment.body, '@Claude') || contains(github.event.comment.body, '@CLAUDE')) &&
       !(contains(github.event.comment.body, 'claude review') || contains(github.event.comment.body, 'Claude review') || contains(github.event.comment.body, 'CLAUDE REVIEW'))) ||
      (github.event_name == 'pull_request_review' &&
       (contains(github.event.review.body, '@claude') || contains(github.event.review.body, '@Claude') || contains(github.event.review.body, '@CLAUDE')) &&
       !(contains(github.event.review.body, 'claude review') || contains(github.event.review.body, 'Claude review') || contains(github.event.review.body, 'CLAUDE REVIEW'))) ||
      (github.event_name == 'issues' &&
       ((contains(github.event.issue.body, '@claude') || contains(github.event.issue.body, '@Claude') || contains(github.event.issue.body, '@CLAUDE')) ||
        (contains(github.event.issue.title, '@claude') || contains(github.event.issue.title, '@Claude') || contains(github.event.issue.title, '@CLAUDE'))) &&
       !((contains(github.event.issue.body, 'claude review') || contains(github.event.issue.body, 'Claude review') || contains(github.event.issue.body, 'CLAUDE REVIEW')) ||
         (contains(github.event.issue.title, 'claude review') || contains(github.event.issue.title, 'Claude review') || contains(github.event.issue.title, 'CLAUDE REVIEW'))))
    uses: jmmaloney4/sector7/.github/workflows/claude.yml@main
    with:
      repository: ${{ github.repository }}
      ref: ${{ github.ref }}
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### 👀 `claude-review.yml`

- **Path**: `.github/workflows/claude-review.yml` (callable-only)
- **Purpose**: Automated Claude AI code review triggered by "claude review" comments
- **Important**: Gate on event context in the caller workflow. The reusable workflow runs under `workflow_call` and cannot read `github.event.comment.*`.
- **Required inputs**:
  - **runs-on**: Runner label (e.g., `ubuntu-latest` or your self-hosted label)
  - **repository**: Repository to checkout (`owner/repo`), typically `${{ github.repository }}`
  - **ref**: Git ref to build, typically `${{ github.ref }}`
- **Required secrets**:
  - **CLAUDE_CODE_OAUTH_TOKEN**: Claude Code OAuth token for authentication

#### Minimal consumer workflow (copy-paste)

```yaml
name: 👀 claude review

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: read
  issues: read
  id-token: write
  actions: read

jobs:
  claude-review:
    # Only run when someone comments "claude review" on a pull request
    if: |
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       (contains(github.event.comment.body, 'claude review') || contains(github.event.comment.body, 'Claude review') || contains(github.event.comment.body, 'CLAUDE REVIEW')) &&
       !contains(github.event.comment.body, 'no claude review') &&
       !contains(github.event.comment.body, 'disable claude review') &&
       !contains(github.event.comment.body, 'claude review is not needed')) ||
      (github.event_name == 'pull_request_review_comment' &&
       (contains(github.event.comment.body, 'claude review') || contains(github.event.comment.body, 'Claude review') || contains(github.event.comment.body, 'CLAUDE REVIEW')) &&
       !contains(github.event.comment.body, 'no claude review') &&
       !contains(github.event.comment.body, 'disable claude review') &&
       !contains(github.event.comment.body, 'claude review is not needed'))

    uses: jmmaloney4/sector7/.github/workflows/claude-review.yml@main
    with:
      repository: ${{ github.repository }}
      ref: ${{ github.ref }}
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### 🧾 `adr-management.yml`

- **Path**: `.github/workflows/adr-management.yml` (callable-only)
- **Purpose**: Reserve ADR numbers by creating placeholder ADR files on the base branch and comment on PRs when ADR numbers conflict
- **Important**: This workflow runs under `workflow_call`, so the caller must pass PR context (`pr_number`, `pr_url`, and a PR head `ref`).
- **Required inputs**:
  - **repository**: Repository to checkout (`owner/repo`), typically `${{ github.repository }}`
  - **ref**: PR head ref to operate on (recommended: `refs/pull/${{ github.event.pull_request.number }}/head`)
  - **pr_number**: Pull request number (for commenting)
  - **pr_url**: Pull request URL (for placeholder content)
- **Optional inputs**:
  - **runs-on**: Runner label (defaults to `ubuntu-latest`)
  - **base_ref**: Base branch/ref to compare against (defaults to `main`)
  - **adr_glob**: ADR file glob to watch (defaults to `docs/internal/decisions/*.md`)

#### Minimal consumer workflow (copy-paste)

```yaml
name: ADR Management

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: write
  pull-requests: write

jobs:
  adr-management:
    if: github.actor != 'github-actions[bot]'
    uses: jmmaloney4/sector7/.github/workflows/adr-management.yml@main
    with:
      runs-on: ubuntu-latest
      repository: ${{ github.repository }}
      ref: refs/pull/${{ github.event.pull_request.number }}/head
      base_ref: ${{ github.event.pull_request.base.ref }}
      adr_glob: 'docs/internal/decisions/*.md'
      pr_number: ${{ github.event.pull_request.number }}
      pr_url: ${{ github.event.pull_request.html_url }}
```

#### Security: `pull_request_target` and fork PRs

This workflow uses `pull_request_target` so it runs even when a PR branch has
merge conflicts with the base branch. Unlike `pull_request`, `pull_request_target`
always runs in the context of the base branch — with write permissions and access
to repository secrets — **even for PRs opened from forks**.

This is the ["pwn request"](https://securitylab.github.com/resources/github-actions-preventing-pwn-requests/)
attack surface: a malicious fork PR could try to abuse the write token that
`pull_request_target` provides.

**Why this workflow is relatively safe:**

The ADR workflow only reads file *names* from the PR head — it never executes
any code from the PR branch. The only privileged operation is pushing a
placeholder commit to the base branch. There is no `npm install`, `make`, or
shell execution of PR-provided content.

**Residual risk:**

A malicious PR could craft ADR filenames designed to exploit shell handling in
the conflict-check or placeholder scripts (path traversal, injection via unusual
characters). The scripts include path safety checks to mitigate this.

**Available mitigations (recommended for public repos):**

1. **Require approval for fork PRs** — Go to **Settings → Actions → General →
   Fork pull request workflows** and select _"Require approval for all outside
   collaborators"_. This forces a maintainer to manually approve each fork PR
   before any workflow runs, directly preventing untrusted code from triggering
   a `pull_request_target` workflow.

2. **Branch protection on the base branch** — Ensure the base branch has push
   restrictions enabled so that only the Actions bot (or specific actors) can
   push to it. This limits blast radius if the write token is misused.

3. **Private repos** — Fork PRs from non-members are not possible by default in
   private repositories, which eliminates this attack vector entirely.

For internal/private repos where all contributors are trusted, the risk profile
is the same as a standard `pull_request` workflow.

## Usage Notes

- All workflows are designed to be called from other repositories using the `uses:` syntax
- Required inputs must be provided by the calling workflow
- Workflows automatically checkout the specified repository and ref
- For production use, consider pinning to specific releases instead of `@main`
