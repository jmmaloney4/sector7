## ☁️🎺 sector7

Reusable GitHub Actions workflows, composite actions, and development environments for CI/CD across repositories.

## 📚 Documentation

- **[GitHub Actions Workflows](docs/public/workflows.md)** - Reusable workflows for Rust, Nix, Pulumi, Pulumi drift detection, and Claude AI
- **[Pulumi Components](docs/public/pulumi.md)** - `@jmmaloney4/sector7` package with reusable Pulumi components
- **[Renovate Presets](docs/public/renovate.md)** - Composable Renovate configurations for dependency management

## 🚀 Quick Start

### GitHub Actions Workflows

Use our reusable workflows in your repository:

```yaml
# Rust CI
jobs:
  rust:
    uses: jmmaloney4/sector7/.github/workflows/rust.yml@main
    with:
      runs-on: ubuntu-latest
      repository: ${{ github.repository }}
      ref: ${{ github.ref }}

# Nix builds
jobs:
  nix-build:
    uses: jmmaloney4/sector7/.github/workflows/nix.yml@main
    with:
      runs-on: ubuntu-latest
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

#### Optional Attic binary cache inputs

When a caller has a private or self-hosted Attic cache, pass the cache explicitly instead of teaching Sector7 about your runner topology:

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

`binary-cache-url` is the full Nix substituter URL (for example `https://attic.example.com/cache`). `binary-cache-endpoint` is the Attic server root URL used for `attic login` before pushes.

### Pulumi Components

Install the Pulumi package:

```bash
pnpm add @jmmaloney4/sector7
```

Until automated package release publishing lands, prefer a packed GitHub Release tarball over pnpm's `github:` shorthand or GitHub Packages:

```json
{
  "dependencies": {
    "@jmmaloney4/sector7": "https://github.com/jmmaloney4/sector7/releases/download/sector7-v0.6.0-a27687e/jmmaloney4-sector7-0.6.0.tgz"
  }
}
```

This artifact is created with `npm pack` / `pnpm pack` from `packages/sector7`, so it has the same package root, `exports`, files, and dependency metadata that pnpm expects from a normal npm package.

Avoid specs like `github:jmmaloney4/sector7#<commit>&path:/packages/sector7` in Nix-backed pnpm workspaces. pnpm may lock those as `git+ssh` or `git+https` dependencies and then invoke `git clone` during the Nix `node_modules` build. That makes otherwise hermetic builds fail with missing `git`, missing `ssh`, or unavailable credentials.

Also avoid relying on GitHub codeload source archives for runtime monorepo subpackages. They avoid `git`, but can install the repository root instead of the subpackage root, which breaks subpath exports such as `@jmmaloney4/sector7/nix-image`. [ADR-018](docs/internal/designs/018-pnpm-release-tarball-artifacts.md) documents the release-tarball artifact decision.

Use the GitHubOidcResource component:

```typescript
import { GitHubOidcResource } from "@jmmaloney4/sector7/iam";

const githubOidc = new GitHubOidcResource("github-oidc", {
    repoOwner: "jmmaloney4",
    repoName: "my-repo",
    serviceAccountRoles: ["roles/storage.admin"],
    limitToRef: "refs/heads/main"
});
```

### Renovate Presets

Configure Renovate with our presets:

```json
{
  "extends": [
    "github>jmmaloney4/sector7//renovate/all.json"
  ]
}
```

If a consumer repository depends on the packed Sector7 GitHub Release tarball URL, add the dedicated preset or use `all.json`:

```json
{
  "extends": [
    "github>jmmaloney4/sector7//renovate/sector7-release-tarballs.json"
  ]
}
```

## 🛠️ Development Environment

This repository includes a Nix flake that provides a consistent development environment across all supported platforms.

### Prerequisites

1. Install Nix package manager:

   ```bash
   curl -L https://nixos.org/nix/install | sh
   ```

2. Enable flakes (if not already enabled):

   ```bash
   mkdir -p ~/.config/nix
   echo "experimental-features = nix-command flakes" >> ~/.config/nix/nix.conf
   ```

3. Install direnv (optional, but recommended):

   ```bash
   nix-env -i direnv
   ```

### Usage

#### Using direnv (recommended)

1. Allow direnv in the repository:

   ```bash
   cd nix/default
   direnv allow
   ```

2. The development environment will be automatically activated when you enter the directory.

#### Manual activation

1. Enter a development shell:
   ```bash
   cd nix/default
   nix develop
   ```

### Available Tools

The development environment includes:

- **Build Tools**: Make, CMake, Ninja, pkg-config
- **Version Control**: Git, GitHub CLI
- **Development Tools**: direnv, Nix LSP
- **Languages**: Rust (with rust-analyzer), Go, Python 3, Node.js
- **Cloud Tools**: AWS CLI, Azure CLI, Google Cloud SDK, kubectl, Helm
- **Utilities**: jq, yq, ripgrep, fd, bat, exa, fzf, htop, tmux

### Customization

To customize the development environment, modify `nix/default/flake.nix`. The file is well-documented and follows Nix best practices.
