# Renovate Presets

This directory contains composable Renovate presets that can be shared across projects.

## Available Presets

### Core Presets

- **`default.json`** - Base Renovate configuration with common settings
- **`all.json`** - Aggregate preset that includes all presets in this repo
- **`security.json`** - Security-focused package rules and vulnerability handling
- **`lock-maintenance.json`** - Lock file maintenance configuration
- **`package-groups.json`** - Package groupings for common technology stacks

### Technology-Specific Presets

- **`nix.json`** - Nix-specific configuration with safe regex managers for `fetchPypi` plus `mkHelmChartFromGitHub` version bumps (see ADR-038 in jackpkgs); Nix SRI hashes such as `sha256-XRJNwpeGjQSEPub34BLrPJn3Tj6Ie90/PB7LR2+tPmU=` are matched structurally but left for manual recomputation (see ADR-023). Also keeps `nix run github:owner/repo/<ref>#attr` flake pins in shell scripts current: version-tag pins (`/v1.2.3#`) bump via the `github-tags` datasource, and commit-SHA pins (`/<40-hex>#`) bump to the latest commit on `main` via the `github-commits` datasource (used for the `jmmaloney4/jackpkgs#skopeo-nix2container` pin in the nix-image push scripts)
- **`pulumi.json`** - Pulumi-specific configuration and version management
- **`docker-images.json`** - Tracks container image references that live as string literals in TypeScript sources (e.g. Pulumi service definitions like `const image = config.get("image") ?? "ghcr.io/owner/app:tag"`), which Renovate's built-in docker/kubernetes managers don't parse. Each managed image opts in with an inline annotation on the line above — `// renovate: datasource=docker` (optional `versioning=…`) — so only explicitly-annotated literals are touched. `depName` is parsed from the image literal itself (so it can't drift from the string being updated; registries with ports are handled). With the repo's `pinDigests`, the digest is pinned and refreshed via PR; a semver tag also gets version bumps. Use this to bring otherwise-invisible images (e.g. third-party `:latest` server images) under managed, reproducible updates.
- **`sector7-release-tarballs.json`** - Package.json dependency updates for `@jmmaloney4/sector7` GitHub release tarballs

## Usage

To use these presets in your Renovate configuration, extend them using the GitHub preset syntax:

```json
{
  "extends": [
    "github>jmmaloney4/sector7//renovate/default.json",
    "github>jmmaloney4/sector7//renovate:nix",
    "github>jmmaloney4/sector7//renovate:security"
  ]
}
```

Alternatively, you can use the aggregate preset to include everything from this repository in one line:

```json
{
  "extends": [
    "github>jmmaloney4/sector7//renovate/all.json"
  ]
}
```

### Preset Resolution Examples

- `github>jmmaloney4/sector7//renovate/default.json` → loads `renovate/default.json`
- `github>jmmaloney4/sector7//renovate/all.json` → loads `renovate/all.json`
- `github>jmmaloney4/sector7//renovate/nix.json` → loads `renovate/nix.json`
- `github>jmmaloney4/sector7//renovate/security.json` → loads `renovate/security.json`

### Pinning to Releases

For production use, consider pinning to a specific release:

```json
{
  "extends": [
    "github>jmmaloney4/sector7//renovate/default.json#v1.0.0"
  ]
}
```

Or pin the aggregate preset:

```json
{
  "extends": [
    "github>jmmaloney4/sector7//renovate/all.json#v1.0.0"
  ]
}
```

## Preset Composition

The presets are designed to be composable. Common combinations:

### Full-Featured Project

```json
{
  "extends": [
    "github>jmmaloney4/sector7//renovate/default.json",
    "github>jmmaloney4/sector7//renovate/security.json",
    "github>jmmaloney4/sector7//renovate/package-groups.json",
    "github>jmmaloney4/sector7//renovate/lock-maintenance.json"
  ]
}
```

Alternatively, use the single aggregate preset:

```json
{
  "extends": [
    "github>jmmaloney4/sector7//renovate/all.json"
  ]
}
```

### Nix + Pulumi Project

```json
{
  "extends": [
    "github>jmmaloney4/sector7//renovate/default.json",
    "github>jmmaloney4/sector7//renovate/nix.json",
    "github>jmmaloney4/sector7//renovate/pulumi.json"
  ]
}
```

Alternatively, use the single aggregate preset:

```json
{
  "extends": [
    "github>jmmaloney4/sector7//renovate/all.json"
  ]
}
```

## Valid Configuration File Locations

Renovate looks for configuration files in these locations (in order):

01. `renovate.json`
02. `renovate.json5`
03. `.github/renovate.json`
04. `.github/renovate.json5`
05. `.gitlab/renovate.json`
06. `.gitlab/renovate.json5`
07. `.renovaterc`
08. `.renovaterc.json`
09. `.renovaterc.json5`
10. `package.json` (within a `"renovate"` section - deprecated)

Renovate stops searching after finding the first matching configuration file.

## Override Behavior

Settings defined directly in your configuration file will override preset settings due to Renovate's merge precedence rules.
