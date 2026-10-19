# Renovate Presets FAQ & Gotchas

Real gotchas, ordered roughly by how often they come up. For settings, see
[configuration](./configuration.md); for procedures, [workflows](./workflows.md).

## Why didn't my automerge PR merge?

**Shared presets do not automerge.** `minor-patch-automerge.json` is a legacy
filename: groups still exist, but every group sets `automerge: false`, and
`all.json` ends with a last-wins catch-all (`matchPackageNames: ["*"]`,
`automerge: false`). `vulnerabilityAlerts` and `lockFileMaintenance` are also
`automerge: false`. An open Renovate PR waiting for a human is expected.

If a consumer re-enabled automerge in its own config and the PR still does not
merge, the usual cause is **the branch isn't green.** With `automergeType: "pr"`
and `platformAutomerge: false`, Renovate merges the PR itself during one of its
own runs, and only once all checks pass. It never force-merges a failing or
pending PR. Nested keys (`lockFileMaintenance`, `vulnerabilityAlerts`) are not
flipped by the `all.json` package-rule catch-all; they must be set on those
objects.

Other contributors once CI is green:

- Merges happen during the Renovate run inside the `before 4:00 am` window, not
  the instant checks pass — so there can be a delay (and with slow CI, a PR can
  miss the window and wait for the next run).
- The repo must allow the merge. There's no GitHub-native auto-merge here
  (`platformAutomerge: false`), so Renovate uses its own merge via the API.

## What does "rate-limited" mean on the dashboard?

It means Renovate *wants* to open the PR but is holding it back to avoid flooding
the repo — it's queued, not broken. With `prHourlyLimit`/`prConcurrentLimit` at
`0` (unlimited) you should rarely see it now, but if you do, tick the checkbox to
force creation (see [workflows](./workflows.md#force-a-rate-limited-or-pending-pr-to-open-now)).

Don't confuse the three dashboard sections:

- **Rate-Limited** — held by the hourly/concurrent caps.
- **Pending Status Checks** — held by the stability delay (`minimumReleaseAge`)
  or `internalChecksFilter: strict`.
- **Awaiting Schedule** — held by the `schedule` window.

## Why is `prHourlyLimit: 0` not "zero PRs per hour"?

In Renovate, `0` is the sentinel for **unlimited**, not "none". Likewise
`prConcurrentLimit: 0` = unlimited concurrent PRs. If you *delete* these keys you
don't get unlimited — you get Renovate's built-in defaults (2/hour, 10
concurrent). To actually throttle, set a positive integer.

## Why does my Helm annotation not match?

The annotation fields are **order-sensitive**:
`# renovate: datasource=helm depName=<chart> [registryUrl=<url>] [versioning=<scheme>]`.
Renovate compiles `customManagers` `matchStrings` with **RE2, which has no
lookahead** (`(?=…)`), so the manager can't accept arbitrary field order — it
requires `depName` first, then optional `registryUrl`, then optional
`versioning`. Put them in that order and the `version:` line on the next line is
captured.

This is also why a lookahead-based regex anywhere in a preset will fail
validation with `Invalid regExp for customManagers`.

## Why didn't CI catch my broken preset?

sector7's GitHub CI does **not** run the Renovate config check — the only PR
checks are housekeeping bots. A preset that breaks
`renovate-config-validator --strict` can merge with a green PR. The check exists
only as a Nix flake check; run it locally:

```bash
nix build .#checks.<system>.renovate-config
```

Gotcha within the gotcha: `nix build` may **substitute a stale cached success**
for the `main` ref, making a broken `main` look green. Force a fresh build
(`--rebuild`) or build your branch (fresh source hash) to see the real state.

## Why isn't a sector7 action waiting out the 4-day stability delay?

By design. A repo-wide rule in `default.json` sets `minimumReleaseAge: null` for
`jmmaloney4/sector7` refs, so first-party actions update without the delay. They
are **still digest-pinned** via the global `pinDigests: true` — the exemption is
only the stability delay, not the pinning.

## Why does Renovate flag a Nix hash change but not fix it?

The `nix.json` custom managers detect `fetchPypi` / `mkHelmChartFromGitHub`
version bumps and match the quoted SRI hash structurally, but they **don't
rewrite** the hash. Recompute it by hand before merge. Rationale:
`docs/internal/designs/023-renovate-nix-manual-hash-recompute.md`.

## Where's the dashboard?

The **Renovate Dashboard 🤖** issue in each consumer repo (labelled
`chore/deps`). It lists every pending, rate-limited, awaiting-schedule, and open
update, with checkboxes to force actions. Filter issues by the `renovate` label.
