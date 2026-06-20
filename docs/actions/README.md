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
- **Purpose**: Preview and deploy Pulumi stacks with PR commenting
- **Required inputs**:
  - **repository**: Repository to checkout (`owner/repo`), typically `${{ github.repository }}`
  - **ref**: Git ref to build, typically `${{ github.ref }}`
  - **google_workload_identity_provider**: GCP Workload Identity Provider resource
  - **google_service_account_email**: GCP service account email
  - **pulumi_backend_url**: GCS bucket URL for Pulumi backend (e.g., `gs://my-bucket-name`)
  - **nodejs_package_manager**: `pnpm`, `npm`, or `none`
- **Optional inputs**:
  - **runs-on**: Runner label (defaults to `self-hosted`)
  - **stack-filter**: Regex to limit which stack directories run
  - **stack-config-passphrase**: Passphrase for Pulumi secrets when using passphrase backend
  - **pr_number**: Pull request number for comment posting
  - **is_fork**: Whether the PR comes from a fork
  - **preview_only**: Skip `pulumi up` on pushes and run previews only
  - **working_directory**: Relative path to the Pulumi project root inside the caller repo

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

      # PR context (enables commenting on PRs)
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
