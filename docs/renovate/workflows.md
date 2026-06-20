# Renovate Presets Workflows

The day-to-day playbook for consuming and maintaining the presets. Each section
is a single task. For what every setting means, see
[configuration](./configuration.md).

## Adopt the presets in a new repo

1. Create `.github/renovate.json5` in the consumer repo.
2. Extend the aggregate preset:

   ```json5
   {
     $schema: "https://docs.renovatebot.com/renovate-schema.json",
     extends: ["github>jmmaloney4/sector7//renovate/all.json"],
   }
   ```

3. Ensure the Renovate (Mend) app is installed on the repo.
4. The first run opens the **Renovate Dashboard 🤖** issue; updates flow from
   there.

## Compose a subset instead of `all.json`

Extend only the presets you need (each is independently extensible):

```json5
{
  extends: [
    "github>jmmaloney4/sector7//renovate/default.json",
    "github>jmmaloney4/sector7//renovate/nix.json",
    "github>jmmaloney4/sector7//renovate/pulumi.json",
  ],
}
```

Preset path syntax: `github>jmmaloney4/sector7//renovate/<file>.json`.

## Pin to a sector7 release

For reproducible behavior, pin the preset reference to a tag:

```json5
{
  extends: ["github>jmmaloney4/sector7//renovate/all.json#v1.0.0"],
}
```

Without a `#tag`, consumers always track `main`, so preset changes here take
effect on their next Renovate run.

## Change the schedule or rate limits for everyone

1. Edit `renovate/default.json` — `schedule`, `prHourlyLimit`, `prConcurrentLimit`.
2. Remember `0` means *unlimited* for the rate limits; deleting the key reverts
   to Renovate's defaults (2/hour, 10 concurrent), which is **not** unlimited.
3. [Validate locally](#validate-config-changes-locally), commit, open a PR.

To change just one repo, set the same keys in that repo's config instead.

## Add or change a PR group

1. Edit `renovate/minor-patch-automerge.json`.
2. Add a `packageRules` entry with `groupName`, a matcher (`matchManagers` /
   `matchPackageNames` / `matchDatasources`), `matchUpdateTypes`, and `automerge`.
3. Placement matters: the catch-all **JS/TS Dependencies** group is first so more
   specific groups must come **after** it to win for their packages.
4. Leave `schedule` off so the group inherits the global `before 4:00 am`.
5. [Validate locally](#validate-config-changes-locally), commit, open a PR.

## Track an otherwise-invisible dependency

For deps Renovate's built-in managers don't see, add the matching inline
annotation (see [configuration → Custom managers](./configuration.md#custom-managers)):

- **Docker image in a `.ts` file** — annotate the line above the literal:

  ```ts
  // renovate: datasource=docker
  const image = "ghcr.io/owner/app:1.2.3";
  ```

- **Container image in YAML:**

  ```yaml
  # renovate: datasource=docker
  image: ghcr.io/owner/app:1.2.3
  ```

- **Helm chart version in YAML** (fields are **order-sensitive** — RE2 has no
  lookahead):

  ```yaml
  # renovate: datasource=helm depName=cert-manager registryUrl=https://charts.jetstack.io
  version: 1.14.5
  ```

## Force a rate-limited or pending PR to open now

On the **Renovate Dashboard 🤖** issue, tick the checkbox next to the update:

- under **Rate-Limited** → creates the PR immediately (bypasses the rate cap);
- under **Pending Status Checks** / **Awaiting Schedule** → forces creation
  despite the stability delay or schedule window.

There's also a "Create all rate-limited PRs at once" checkbox.

## Validate config changes locally

sector7 CI does **not** run the Renovate config check, so validate before you
push:

```bash
nix build .#checks.<system>.renovate-config   # e.g. checks.aarch64-darwin.renovate-config
```

This runs `renovate-config-validator --strict` over every preset and the repo's
`.github/renovate.json*`. Exit 0 = valid. See
[faq → Why didn't CI catch my broken preset?](./faq.md#why-didnt-ci-catch-my-broken-preset).
