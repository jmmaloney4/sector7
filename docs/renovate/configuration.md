# Configuring Renovate Presets

Everything the presets set, and where to change it. The sources are
[`renovate/*.json`](../../renovate/); a consumer repo inherits them by extending
`all.json` and can override any value in its own `.github/renovate.json5`.

- [Shared defaults](#shared-defaults-defaultjson)
- [Schedules](#schedules)
- [Automerge & rate limits](#automerge--rate-limits)
- [Stability delay & digest pinning](#stability-delay--digest-pinning)
- [PR groups](#pr-groups-minor-patch-automergejson)
- [Major updates](#major-updates-major-updatesjson)
- [Security alerts](#security-alerts-securityjson)
- [Lock-file maintenance](#lock-file-maintenance-lock-maintenancejson)
- [Custom managers](#custom-managers)
- [Overriding in a consumer repo](#overriding-in-a-consumer-repo)

## Shared defaults (`default.json`)

The base every consumer inherits.

| Key | Value | Role |
| --- | ----- | ---- |
| `extends` | `config:best-practices`, `:semanticCommits`, `helpers:pinGitHubActionDigestsToSemver`, `:enableVulnerabilityAlertsWithLabel(security)`, `:pinAllExceptPeerDependencies` | Renovate's recommended baseline + semantic commit messages + digest-pin GitHub Actions to a semver comment + vuln alerts + pin all deps except peer deps. |
| `timezone` | `America/Chicago` | Anchors every `schedule` window. |
| `schedule` | `["before 4:00 am"]` | Global update window (any day). See [Schedules](#schedules). |
| `prHourlyLimit` | `0` | No hourly cap. See [Automerge & rate limits](#automerge--rate-limits). |
| `prConcurrentLimit` | `0` | No concurrent-PR cap. |
| `rebaseWhen` | `conflicted` | Only rebase a branch when it actually conflicts (avoids churn). |
| `automergeType` | `pr` | Renovate merges the PR itself (not GitHub native auto-merge). |
| `automergeStrategy` | `merge` | Merge commit, matching the house preference. |
| `platformAutomerge` | `false` | Do **not** use GitHub's native auto-merge. |
| `rangeStrategy` | `pin` | Pin exact versions rather than widening ranges. |
| `minimumReleaseAge` | `4 days` | Stability delay before an update is proposed. |
| `internalChecksFilter` | `strict` | Hold updates that haven't cleared internal checks (e.g. the stability delay) instead of opening them early. |
| `pinDigests` | `true` | Pin image/action digests and keep them refreshed. |
| `dependencyDashboard` | `true` | Maintain the "Renovate Dashboard 🤖" tracking issue. |
| `dependencyDashboardTitle` | `Renovate Dashboard 🤖` | Title of that issue. |
| `dependencyDashboardLabels` | `["chore/deps"]` | Labels on that issue. |
| `labels` | `["chore/deps", "renovate"]` | Default labels on every PR. |
| `commitMessagePrefix` | `deps: ` | Commit/PR title prefix. |
| `commitMessageAction` | `update` | Verb in the commit message. |
| `prHeader` / `prFooter` | (boilerplate) | Header/footer text on every PR body. |
| `nix.enabled` | `true` | Turn on Renovate's built-in Nix manager. |

### Repo-wide `packageRules` in `default.json`

These apply across all ecosystems (not per-group):

| Match | Effect | Why |
| ----- | ------ | --- |
| `jmmaloney4/sector7` action refs (`/^jmmaloney4\/sector7($\|\/)/`) | `minimumReleaseAge: null` | First-party refs skip the stability delay. They are **still digest-pinned** via the global `pinDigests: true`. |
| `matchDepTypes: ["requires-python"]` | `enabled: false` | `requires-python` is managed by hand per project as a capped minor range (e.g. `>=3.13,<3.14`). |
| `**/docs/**` | `enabled: false` | Archived reference material, not actively maintained. |
| `**/dbt_packages/**` | `enabled: false` | Vendored dbt package code, not maintained here. |

## Schedules

- **Global:** `schedule: ["before 4:00 am"]` in `default.json`, in `America/Chicago`. Renovate creates, updates, and merges branches only inside this window.
- **All PR groups inherit the global schedule.** As of the cleanup in
  `minor-patch-automerge.json`, there are **no per-group `schedule` overrides** —
  every group runs `before 4:00 am`, any day of the week.
- **Lock-file maintenance** runs weekly: `before 4:00 am on Sunday`.
- **Security / vulnerability alerts bypass the schedule** — Renovate raises them
  as soon as an advisory lands, regardless of the window.

To change the window for everyone, edit `schedule` in `default.json`. To change
it for one consumer, set `schedule` in that repo's config.

## Automerge & rate limits

**How automerge works here.** `automergeType: "pr"` + `platformAutomerge: false`
means **Renovate itself** merges the PR during one of its own runs — and only
once the branch is **fully green**. It never force-merges a PR whose checks are
failing or pending. So an automerge-enabled PR that isn't merging almost always
means red/incomplete CI, not a config problem — see
[faq → Why didn't my automerge PR merge?](./faq.md#why-didnt-my-automerge-pr-merge).

Which updates automerge:

- **Automerged:** minor/patch/digest updates in the groups marked automerge in
  [PR groups](#pr-groups-minor-patch-automergejson), lock-file maintenance, and
  security alerts.
- **Not automerged:** all **major** updates, and the **Docker Images** group
  (image bumps get a human look).

**Rate limits.** `prHourlyLimit: 0` and `prConcurrentLimit: 0` both mean
**unlimited**. Note the trap: *deleting* these keys does **not** mean unlimited —
Renovate would fall back to its built-in defaults (`2`/hour, `10` concurrent).
`0` is the explicit "no limit" sentinel. To reintroduce throttling, set them to a
positive integer.

## Stability delay & digest pinning

- `minimumReleaseAge: "4 days"` with `internalChecksFilter: "strict"` holds each
  update until its release is 4 days old; until then it sits under **Pending
  Status Checks** on the dashboard. sector7's own action refs are exempt
  (`minimumReleaseAge: null`).
- `pinDigests: true` pins Docker image and GitHub Action digests (e.g.
  `actions/checkout@v4.2.0@<sha256>`) and refreshes them. Combined with
  `helpers:pinGitHubActionDigestsToSemver`, actions are pinned to a digest with a
  human-readable semver comment. sector7's own refs are **also** digest-pinned
  (they only skip the stability delay, not the pinning).

## PR groups (`minor-patch-automerge.json`)

Minor, patch, and (for Actions) digest updates are bucketed into ecosystem
groups so related bumps travel together in one PR. **All inherit the global
`before 4:00 am` schedule.** The catch-all JS/TS group is declared first so the
specific groups below it win for their packages.

| Group | Matches | Update types | Automerge | Extra labels |
| ----- | ------- | ------------ | --------- | ------------ |
| **JS/TS Dependencies** | manager `npm` (catch-all) | minor, patch, pin | ✅ | `deps/npm` |
| **Rust Dependencies** | manager `cargo`, datasource `crate` | minor, patch | ✅ | — |
| **Python Dependencies** | `pip_requirements`/`pip_setup`/`pipenv`/`poetry`/`pep621`, datasource `pypi` | minor, patch | ✅ | — |
| **Node.js Core** | `@types/node`, `node`, `ts-node` | minor, patch | ✅ | — |
| **TypeScript Dependencies** | `typescript`, `@types/*` | minor, patch | ✅ | — |
| **Arrow Ecosystem** | `arrow*`, `parquet*` | minor, patch | ✅ | — |
| **Docker Images** | datasource `docker` | minor, patch | ❌ (manual) | `deps/docker` |
| **GitHub Actions** | manager `github-actions`, datasources `github-tags`/`github-digest` | minor, patch, **digest** | ✅ | `deps/github-actions` |
| **Pulumi Dependencies** | `@pulumi/*`, `pulumi*` | minor, patch | ✅ | `deps/pulumi` |
| **Nix Dependencies** | manager `nix` | minor, patch | ✅ | — |
| **Nix PyPI Dependencies** | datasource `pypi` in `nix/**/*.nix` | minor, patch | ✅ | `deps/nix/pypi` |
| **Nix GitHub Dependencies** | datasource `github-releases` in `nix/**/*.nix` | minor, patch | ✅ | `deps/nix/github` |

There is also a non-group rule: Pulumi npm updates touching a `pnpm-lock.yaml`
get `postUpdateOptions: ["pnpmDedupe"]` so the lockfile is deduplicated after the
bump.

> The former **Testing Dependencies** group (`jest`, `@types/jest`) was removed —
> we use vitest, which already flows into the **JS/TS Dependencies** catch-all.

## Major updates (`major-updates.json`)

| Setting | Value | Role |
| ------- | ----- | ---- |
| `matchUpdateTypes` | `["major"]` | Applies to every major bump in any ecosystem. |
| `groupName` | `null` | **Ungrouped** — each major gets its own PR. |
| `automerge` | `false` | Always needs a human. |
| `prPriority` | `10` | Surfaced above routine updates. |
| `reviewers` | `["jmmaloney4"]` | Requests review. |
| `labels` | `major-update`, `deps/major`, `chore/deps`, `renovate` | For triage. |

## Security alerts (`security.json`)

`vulnerabilityAlerts` is enabled with `automerge: true` and labels `security`,
`vulnerability`, `deps/security`, `renovate`. Security updates **bypass the
schedule**. (The same block is also present in `default.json`; this preset keeps
it usable standalone.)

## Lock-file maintenance (`lock-maintenance.json`)

`lockFileMaintenance` is enabled, `automerge: true`, scheduled
`before 4:00 am on Sunday` (weekly). A nested rule sets `allowedVersions: ">=0"`
for the `nix` manager so lock refreshes aren't version-constrained.

## Custom managers

These presets teach Renovate to find dependencies that its built-in managers
miss. They only **detect**; the detected updates flow through the groups above.

| Preset | Detects | Annotation / pattern |
| ------ | ------- | -------------------- |
| `nix.json` | `fetchPypi` packages, `mkHelmChartFromGitHub` chart versions, and `nix run github:owner/repo/<ref>` pins in `.sh` | Structural regex over `nix/**/*.nix` and shell scripts. Nix SRI hashes are matched but **not** rewritten — recompute by hand before merge (`docs/internal/designs/023-renovate-nix-manual-hash-recompute.md`). |
| `pulumi.json` | Versions in `Pulumi.*.yaml` | Inline comment `# renovate: datasource=… depName=… registryUrl=…` above a `…Version: x.y.z` line. |
| `docker-images.json` | Container-image string literals in `.ts` sources | Inline `// renovate: datasource=docker [versioning=…]` on the line above the `"repo:tag"` literal. Digest pinned + refreshed via `pinDigests`. |
| `yaml-manifests.json` | Container images and Helm chart versions in `.yaml` | Images: `# renovate: datasource=docker` above an `image:` line. Helm: `# renovate: datasource=helm depName=<chart> [registryUrl=<url>] [versioning=<scheme>]` above a `version:` line — **fields are order-sensitive** (see below). |
| `sector7-release-tarballs.json` | `@jmmaloney4/sector7` release-tarball URLs in `package.json` | Rewrites the GitHub Release asset URL; lockfile regen left to Renovate's normal flow. `minimumReleaseAge: null` (internal). |

> **RE2 / Helm annotation order.** Renovate compiles `customManagers`
> `matchStrings` with **RE2, which has no lookahead** (`(?=…)`). The Helm manager
> therefore requires its annotation fields in fixed order —
> `datasource=helm depName=<chart> [registryUrl=<url>] [versioning=<scheme>]`.
> Out-of-order fields won't match. See
> [faq → Why does my Helm annotation not match?](./faq.md#why-does-my-helm-annotation-not-match).

## Overriding in a consumer repo

Settings declared directly in a repo's `.github/renovate.json5` override anything
inherited from a preset (Renovate merge precedence). Typical overrides:

```json5
{
  extends: ["github>jmmaloney4/sector7//renovate/all.json"],
  // run any time instead of only before 4am
  schedule: ["at any time"],
  // re-introduce a concurrency cap for this repo
  prConcurrentLimit: 5,
}
```

See [workflows](./workflows.md) for adopting the presets, pinning to a release,
and adding a new group.
