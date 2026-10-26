---
id: ADR-007
title: Renovate Configuration Restructuring for Update Type Separation
status: Proposed
date: 2026-01-07
deciders: [jmmaloney4]
consulted: []
tags: [design, adr, renovate, dependencies]
supersedes: []
superseded_by: []
links: []
---

> **Current policy (verified on `main` at `a4c1d45bb364510a5f471e7975c4b122da23798a`, PR #413):** shared presets do not automerge. `minor-patch-automerge.json` is a **legacy filename** — grouping remains, but every group, `vulnerabilityAlerts`, `lockFileMaintenance`, and a last-wins catch-all in `all.json` set `automerge: false`. The decision below records the original restructuring, which did enable automerge.

# Context

## Problem Statement

Our Renovate configuration is currently split across multiple files in the `renovate/` directory with conflicting and inconsistent automerge rules. The current structure makes it difficult to enforce a clear policy: minor/patch updates should be grouped by ecosystem and automerged, GitHub Actions digest updates should also be automerged, while major updates should be individual PRs requiring manual review.

## Current File Structure

```
renovate/
├── default.json              # Base configuration
├── all.json                  # Aggregates default + lock-maintenance
├── package-groups.json       # Technology-specific package groups
├── pulumi.json              # Pulumi-specific rules and regex managers
├── nix.json                 # Nix-specific rules and regex managers
├── security.json            # Security patches and major update rules
└── lock-maintenance.json    # Lock file maintenance
```

## Current Issues

1. **Conflicting automerge rules**: Multiple files define automerge behavior leading to conflicts

   - `security.json:15` sets `automerge: false` for major updates
   - However, ecosystem-specific groups in `package-groups.json` (TypeScript:8, Node.js:14, Testing:20, Arrow:26, Rust:33, Docker:39, GitHub Actions:46), `pulumi.json:21`, and `nix.json` (41, 49, 58) set `automerge: true` without filtering by update type
   - Result: Major updates are automerged despite the intention to require manual review

2. **Inconsistent grouping**: Some ecosystems group all updates together regardless of update type, while others don't have grouping at all

3. **Unclear separation of concerns**: Update type policies (major vs minor/patch) are mixed with ecosystem-specific grouping rules across multiple files

4. **Missing ecosystem coverage**: Several package ecosystems (Python outside Nix, npm/pnpm packages outside Pulumi, Go, etc.) lack explicit grouping

## Scope

**In scope:**

- Restructuring Renovate configuration files for clear update type separation
- Ensuring major updates are never automerged
- Grouping minor/patch updates by ecosystem with automerge enabled
- Covering all major package ecosystems (Rust, Python, Node.js, Docker, GitHub Actions, Pulumi, Nix, etc.)

**Out of scope:**

- Changing base Renovate settings (schedules, PR limits, etc.)
- Modifying regex managers for custom dependency extraction
- Altering vulnerability alert handling

# Decision

We MUST restructure the Renovate configuration to explicitly separate concerns by update type, with major updates handled completely independently from minor/patch updates.

## New File Structure

```
renovate/
├── default.json              # Base settings (unchanged)
├── all.json                  # Main aggregator (MUST include new files)
├── lock-maintenance.json     # Lock file maintenance (unchanged)
├── major-updates.json        # NEW: All major updates → individual PRs, manual review
├── minor-patch-automerge.json # NEW: Minor/patch grouped by ecosystem with automerge
├── security.json             # Security & vulnerability rules (simplified)
├── pulumi.json              # Pulumi regex managers only (package rules removed)
└── nix.json                 # Nix regex managers only (package rules removed)
```

## Configuration Principles

1. **Update type separation**: Major updates MUST be handled completely separately from minor/patch and GitHub Actions digest updates
2. **Ecosystem grouping**: Each ecosystem (Rust, Python, Node.js, etc.) SHOULD have its own group for minor/patch updates, with GitHub Actions digest updates included in the GitHub Actions group
3. **Single source of truth**: Each policy decision MUST live in exactly one place
4. **Rule priority**: Major update rules MUST have higher priority (`prPriority`) to ensure they're never automerged

## File Responsibilities

### `major-updates.json`

Contains a single package rule that applies to ALL major version updates across all ecosystems:

- MUST disable automerge (`automerge: false`)
- MUST NOT group updates — each package receives its own individual PR (achieved by setting `groupName: null` to override any grouping from inherited presets like `config:best-practices`)
- MUST require manual review (assigns reviewers)
- MUST use high priority (`prPriority: 10`) to ensure this rule takes precedence over ecosystem-specific rules
- MUST apply appropriate labels for visibility (`major-update`)

### `minor-patch-automerge.json`

Contains multiple package rules, one per ecosystem, with the following characteristics:

- MUST explicitly match only minor and patch updates, except the GitHub Actions rule which MAY also match digest updates
- MUST group updates by ecosystem using descriptive group names
- MUST enable automerge (`automerge: true`)
- MUST use ecosystem-appropriate matchers (managers, datasources, or package names)
- SHOULD cover all major package ecosystems in use: Rust (cargo), Python (pip/poetry), Node.js Core (runtime tooling), TypeScript, Testing (Jest), Arrow ecosystem, Docker Images, GitHub Actions, Pulumi packages, and Nix dependencies (with sub-groups for PyPI and GitHub sources)

### `pulumi.json` & `nix.json`

- MUST contain only `regexManagers` for custom dependency extraction
- MUST NOT contain package rules (moved to `minor-patch-automerge.json`)

### `security.json`

- MUST handle vulnerability alerts (unchanged)
- MAY contain security patch rules or these MAY be moved to `minor-patch-automerge.json`
- SHOULD remove redundant major update rules (now in `major-updates.json`)

# Consequences

## Positive

- **Clear policy enforcement**: Major updates will never be automerged due to explicit rule priority
- **Easier maintenance**: Adding a new ecosystem requires only adding a group to `minor-patch-automerge.json`
- **Better visibility**: Developers can quickly understand the update policy by reading two files
- **Reduced conflicts**: Update type rules are separated from ecosystem grouping rules
- **Consistent behavior**: All ecosystems follow the same major vs minor/patch policy
- **Explicit over implicit**: The use of `matchUpdateTypes` makes intent clear

## Negative

- **Migration effort**: Need to update existing configuration files and test the changes
- **More files**: Adds two new files to the configuration (7→8 files total)
- **Initial learning**: Team needs to understand the new structure

## Neutral

- **Regex managers**: Pulumi and Nix files become simpler (only regex managers) but still necessary
- **Total file count**: Overall count increases slightly (7→8 files)

# Alternatives

## Alternative A: Single monolithic file

Combine all rules into one large configuration file.

**Pros:**

- Single file to review
- No need to track which file contains which rule

**Cons:**

- Difficult to maintain as it grows
- Harder to understand structure at a glance
- Merge conflicts more likely

**Decision:** Rejected. Modularity is more valuable for long-term maintenance.

## Alternative B: Directory structure by ecosystem

Organize configuration files in a nested directory structure with one file per ecosystem (e.g., `renovate/ecosystems/rust.json`, `renovate/ecosystems/python.json`, etc.).

**Pros:**

- Very clear separation by ecosystem
- Easy to find ecosystem-specific rules

**Cons:**

- Splits update type policy across many files
- Harder to ensure consistent major vs minor/patch handling
- More files to maintain

**Decision:** Rejected. Update type separation is more important than ecosystem separation.

## Alternative C: Keep current structure, add override rules

Add high-priority override rules for major updates without restructuring.

**Pros:**

- Minimal changes required
- No file migration needed

**Cons:**

- Doesn't address root cause (mixing concerns)
- Still difficult to understand which rules apply
- Future confusion likely

**Decision:** Rejected. Band-aid solution that doesn't improve maintainability.

# Security / Privacy / Compliance

- **Dependency updates**: Major updates MAY contain breaking changes or security implications requiring review
- **Automerge risk**: Minor/patch updates are generally safe to automerge per semver conventions
- **Vulnerability alerts**: Remain enabled and automerged for rapid security response
- **Review requirements**: Major updates MUST be manually reviewed before merge

# Operational Notes

## Observability

- Monitor Renovate Dashboard for PR volume and merge rates
- Track time-to-merge for major vs minor/patch updates
- Review automerge failures in Renovate logs

## Cost

- No direct cost impact
- May reduce developer time spent on routine minor/patch updates
- Major updates still require manual review time

## Rollout Plan

1. Create new configuration files
2. Test locally with `renovate-config-validator`
3. Commit changes and monitor first batch of PRs
4. Verify major updates are NOT automerged
5. Verify minor/patch updates ARE automerged and grouped correctly

## Backout Plan

- Revert to previous configuration via git if issues arise
- Configuration changes take effect immediately for new PRs
- Existing PRs may need manual intervention

# Implementation Notes

## Steps

1. Create `major-updates.json` with catch-all rule for major updates
2. Create `minor-patch-automerge.json` with ecosystem-specific groups
3. Update `all.json` to extend new configuration files
4. Remove package rules from `pulumi.json` (keep regex managers)
5. Remove package rules from `nix.json` (keep regex managers)
6. Simplify `security.json` by removing redundant major update rules
7. Test configuration with `renovate-config-validator`
8. Commit changes and monitor initial PRs

## Ecosystems to Cover

- Rust (cargo)
- Python (pip, poetry, pypi)
- Node.js (npm, pnpm, yarn)
- Docker images
- GitHub Actions
- Pulumi packages
- Nix dependencies
- Go modules
- TypeScript/Testing packages

## Owner

- jmmaloney4

## Timeline

- Implementation: Single work session
- Validation: 1-2 weeks of monitoring

# References

- [Renovate Package Rules Documentation](https://docs.renovatebot.com/configuration-options/#packagerules)
- [Renovate Rule Priority](https://docs.renovatebot.com/configuration-options/#packagerules)
- [Renovate matchUpdateTypes](https://docs.renovatebot.com/configuration-options/#matchupdatetypes)
- Current configuration: `renovate/` directory
- Related files: `.github/renovate.json5`

# Appendix A: Workspace vs Package-Level Differentiation

## Question

Should we differentiate between workspace-level dependencies (monorepo root) and package-level dependencies when grouping ecosystem updates?

## Repository Context

This repository is a monorepo with the following structure:

- **Workspace root** (`package.json`): Shared development tooling (TypeScript, @types/node, rimraf)
- **Packages** (`packages/*/package.json`): Package-specific dependencies (e.g., Pulumi packages in sector7)

## Analysis

### Case FOR Differentiation

**Potential benefits:**

1. **Blast radius visibility**: Workspace-level updates affect all packages, so separate PRs make the impact more visible
2. **Different risk profiles**: Even for minor/patch updates, a workspace-level TypeScript update could theoretically break multiple packages
3. **Selective policies**: Could automerge package-level minor/patch but manually review workspace-level changes
4. **Testing strategy alignment**: Workspace updates might warrant running the full test suite, while package-specific updates could use targeted tests

Implementation approach would use `matchFileNames` to distinguish workspace root (`"package.json"`) from packages (`"packages/**/package.json"`), with different automerge policies per location.

### Case AGAINST Differentiation

**Why the current ecosystem-only approach is sufficient:**

1. **Major updates already protected**: The high-risk changes (major versions) already receive individual PRs with manual review via `major-updates.json`
2. **Minor/patch are inherently low-risk**: By semantic versioning contract, these updates should not introduce breaking changes
3. **Dev tooling is especially safe**: TypeScript and build tool minor/patch updates are typically very stable
4. **Simplicity**: Fewer rules make the configuration easier to understand and maintain
5. **Small workspace footprint**: With only shared dev tooling at the workspace root (not runtime dependencies), the added complexity does not provide proportional value

### Decision

**We chose NOT to differentiate** between workspace and package-level dependencies for the following reasons:

1. **Workspace dependencies are development tools**: The workspace contains only devDependencies (TypeScript, rimraf, @types/node), not runtime dependencies that could affect production behavior
2. **Risk is already managed**: Major version updates (the primary source of breaking changes) are already handled separately with manual review
3. **Minimal complexity**: Keeping ecosystem grouping simple reduces cognitive overhead and maintenance burden
4. **Semantic versioning trust**: We trust that minor/patch updates follow semver conventions and are safe to automerge
5. **Escape hatch available**: If a specific workspace update proves problematic, it can be manually reverted and handled individually

### When Differentiation WOULD Be Valuable

Future consideration: Differentiation should be reconsidered if:

- Runtime dependencies are added at the workspace level
- The monorepo grows to have packages with significantly different stability requirements
- Staged rollout patterns are needed (e.g., update workspace first, then packages)
- CI/CD pipeline is enhanced to support different test strategies for workspace vs package updates
- Historical data shows workspace updates frequently cause issues

### Configuration Note

If differentiation is needed in the future, use `matchFileNames` to distinguish:

- Workspace: `"matchFileNames": ["package.json"]` (root only)
- Packages: `"matchFileNames": ["packages/**/package.json"]`

This approach maintains the ecosystem grouping while adding location-based filtering.
