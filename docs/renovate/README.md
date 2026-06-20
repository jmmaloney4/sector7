# Renovate Presets

sector7 ships a set of **composable Renovate presets** that a consumer repo
extends in one line to get a complete, opinionated dependency-update policy:
shared defaults, per-ecosystem PR groups, a single update schedule, an automerge
policy, and custom managers for dependencies that Renovate's built-in managers
don't see (Docker image literals, Helm chart pins, Nix hashes, Pulumi versions).

See also: [configuration](./configuration.md) (every default, group, and knob),
[workflows](./workflows.md) (adopt the presets, force a PR, add a group),
[faq](./faq.md) (gotchas).

> There is no separate `deploy.md` — presets aren't deployed. "Deploying" them
> means a consumer repo extends them; see [workflows → Adopt the presets in a
> new repo](./workflows.md#adopt-the-presets-in-a-new-repo).

## What we built

The presets live in [`renovate/`](../../renovate/) at the repo root, one JSON
file per concern, plus an aggregate that composes them:

| Preset | Role |
| ------ | ---- |
| `default.json` | Base config: timezone, schedule, automerge policy, rate limits, labels, stability delay, digest pinning, dependency dashboard, and repo-wide `packageRules`. |
| `minor-patch-automerge.json` | The per-ecosystem **PR groups** for minor/patch/digest updates, most with automerge enabled. |
| `major-updates.json` | Forces every **major** update into its own non-automerged PR with a reviewer. |
| `security.json` | Vulnerability-alert handling (automerged, labelled). |
| `lock-maintenance.json` | Weekly lock-file maintenance. |
| `nix.json` | Custom regex managers for Nix (`fetchPypi`, `mkHelmChartFromGitHub`, `nix run github:` pins). |
| `pulumi.json` | Custom regex manager for annotated versions in `Pulumi.*.yaml`. |
| `docker-images.json` | Custom regex manager for annotated container-image string literals in `.ts` sources. |
| `yaml-manifests.json` | Custom regex managers for annotated container images and Helm chart versions in `.yaml`. |
| `sector7-release-tarballs.json` | Updates `@jmmaloney4/sector7` GitHub release-tarball URLs in `package.json`. |
| `all.json` | **Aggregate** — extends every preset above. Most consumers use only this. |

A consumer's own configuration file always wins: settings declared directly in
the repo override anything inherited from a preset (Renovate merge precedence).

## Topology: how a consumer composes the presets

```
consumer repo  .github/renovate.json5
      │  extends
      ▼
github>jmmaloney4/sector7//renovate/all.json
      │  extends (in order)
      ▼
default ─ major-updates ─ minor-patch-automerge ─ security ─ pulumi
        ─ docker-images ─ yaml-manifests ─ nix ─ lock-maintenance
        ─ sector7-release-tarballs
```

Order matters: later presets layer on top of earlier ones, and within
`minor-patch-automerge.json` the catch-all group is declared first so the more
specific groups below it win for their packages.

## Data flow: a dependency update, end to end

1. Renovate (Mend-hosted app) scans the consumer repo on its cron and resolves
   `extends` by fetching these presets from `jmmaloney4/sector7` on GitHub.
2. It detects updates via built-in managers **and** the custom regex managers
   (`nix`, `pulumi`, `docker-images`, `yaml-manifests`, `sector7-release-tarballs`).
3. Each update is matched against the `packageRules` to pick a **group**, labels,
   automerge flag, and reviewers.
4. The update waits out the **stability delay** (`minimumReleaseAge`), then opens
   (or is held on the [Dependency Dashboard](./faq.md#what-does-rate-limited-mean-on-the-dashboard)).
5. A PR opens within the **schedule** window (`before 4:00 am`), CI runs, and if
   the group has automerge enabled **and the branch goes green**, Renovate merges
   it on a later run.

See [configuration](./configuration.md) for the exact value of every step above,
and [faq → Why didn't my automerge PR merge?](./faq.md#why-didnt-my-automerge-pr-merge)
for the most common failure.

## Where things live

| Thing | Location |
| ----- | -------- |
| Preset sources | [`renovate/*.json`](../../renovate/) |
| Quick-reference for preset authors | [`renovate/README.md`](../../renovate/README.md) |
| Local validation | `nix build .#checks.<system>.renovate-config` (runs `renovate-config-validator --strict` over every preset + `.github/renovate.json*`) |
| Config-file flake check | defined in [`flake.nix`](../../flake.nix) (`checks.renovate-config`) |
| Consumer example | a repo's `.github/renovate.json5` extending `github>jmmaloney4/sector7//renovate/all.json` |

## Why it's built this way

The presets centralize one dependency-update policy across every repo so changes
are made once, here, and inherited everywhere. The restructuring into composable
files and the rationale for the group/schedule/automerge choices are recorded in
`docs/internal/designs/007-renovate-config-restructuring.md`, with Nix
hash-recompute behavior in `docs/internal/designs/023-renovate-nix-manual-hash-recompute.md`.
