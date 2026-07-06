---
id: ADR-034
title: WorkerSite Static Assets Serving Mode
status: proposed
date: 2026-07-05
---

# ADR 034: WorkerSite Static Assets Serving Mode

*Date:* 2026-07-05
*Status:* proposed

## Context

`WorkerSite` serves static sites from an R2 bucket via a generated Worker
script (ADR-011), with content uploaded through per-file `R2Object` Pulumi
dynamic resources (`uploadStaticAssets`, ADR-014/015).

The per-file resource model does not scale. A 955-file site
(theoreticaledge.com dev, which ships a JupyterLite app of ~830 files) takes
**hours** to deploy:

- The Pulumi engine checkpoints stack state after every resource completion,
  and each checkpoint serializes the whole stack — cost per file grows with
  stack size (~10–15s/file observed at 400+ resources).
- Every `pulumi preview` re-stats and re-MD5s every file through 955 dynamic
  provider RPCs.
- A deploy with 955 sequential commit points has a large transient-failure
  surface; a mid-run failure leaves the bucket — and the live site —
  half-updated (observed: `lite/notebooks/index.html` 404ing after a failed
  run uploaded 158 of 671 pending files).

Meanwhile Cloudflare has shipped the platform-native answer: **Workers Static
Assets** (the Pages successor). As of terraform-provider-cloudflare v5.11.0
(2025-10, wrapped by `@pulumi/cloudflare` ≥ 6.x current), `workers_script`
accepts `assets.directory` and the provider itself performs the same upload
flow wrangler uses: scan the directory, hash each file, register a
content-addressed manifest, and upload only the missing files, in parallel
chunked batches. Deploys are atomic and versioned; unchanged files are never
re-uploaded; served assets get platform caching with strong ETags.

## Decision

Add a second serving mode to `WorkerSite`: `staticAssets`, mutually exclusive
with `r2Bucket`.

```ts
const site = new WorkerSite("my-site", {
  accountId,
  zoneId,
  name: workerName,
  domains: ["example.com", "www.example.com"],
  staticAssets: {
    directory: siteBuild.storePath,          // Input<string>
    htmlHandling?: "auto-trailing-slash",     // platform default
    notFoundHandling?: "404-page",            // component default (see below)
    runWorkerFirst?: boolean | string[],      // default: auto (see below)
  },
  redirects: [{ fromHost: "www.example.com", toHost: "example.com" }],
  paths,                                      // AccessGate — unchanged
});
```

In `staticAssets` mode:

- **No R2 bucket, no upload resources, no cache purge.** The
  `WorkersScript` resource carries `assets = { directory, config }`; the
  provider owns manifest computation and delta upload. The whole site is one
  Pulumi resource.
- **Generated script becomes a thin passthrough** (`generateAssetsWorkerScript`):
  evaluate host-level `redirects`, then `return env.ASSETS.fetch(request)`.
  The Worker gets a single `{ name: "ASSETS", type: "assets" }` binding.
- **`runWorkerFirst` defaults to `true` when `redirects` are configured** —
  host redirects must run before platform asset serving — and stays unset
  otherwise, so assets are served without invoking the Worker at all and the
  script only runs on asset misses.
- **`notFoundHandling` defaults to `"404-page"`** (serve root `/404.html`
  with status 404). The platform default is `"none"`, but WorkerSite is a
  static-site component and every Sphinx/Quarto/bundler site ships a 404
  page; parity with the R2 script's plain-text 404 is not worth preserving.
- **`cacheTtlSeconds` and `cacheKeyVersion` are rejected** (throw) in this
  mode: asset caching, ETags, and invalidation-on-deploy are platform
  behavior. Custom cache headers can later be exposed via the assets
  `_headers` config if a consumer needs them.
- **AccessGate, custom domains, observability are unchanged** — they operate
  at the zone/worker level, orthogonal to how bytes are served.
- **Custom `workerScript` composes**: the caller's content replaces the
  generated passthrough, the ASSETS binding is still attached, and
  `redirects` are ignored (same rule as R2 mode). Callers doing this set
  `runWorkerFirst` explicitly.

### Limits

Workers Static Assets caps: 20,000 files per version, 25 MiB per file. Both
are far above current consumers (955 files, largest well under 10 MiB).
Sites beyond those caps stay on R2 mode.

## Alternatives Considered

### 1. Batch R2 sync resource (`R2BucketSync`)

One dynamic resource holding a `key → {etag, contentType}` manifest in state;
create/update diffs the manifest and PUTs/DELETEs only the delta with bounded
concurrency. Fixes the checkpoint quadratic and keeps ADR-015's no-external-
deps stance.

Rejected as the *primary* fix: it re-implements — and permanently owns —
manifest diffing, retry/backoff, prune ordering, and partial-failure
semantics that Cloudflare now provides below the API line, and it keeps the
non-atomic-deploy problem (a failed sync still leaves the bucket mixed
old/new). Remains a reasonable future addition for *non-site* R2 sync needs;
`R2Object`/`uploadStaticAssets` stay for genuine single-object and
small-tree use.

### 2. Shell out to `rclone`/`wrangler` via `command:local:Command`

Fast and simple, but reintroduces a deploy-host binary dependency —
precisely what ADR-015 removed — and hides drift from Pulumi entirely.
Rejected.

### 3. Keep per-file `R2Object` resources

Status quo. Rejected for the scaling evidence above.

## Consequences

- `WorkerSiteArgs.r2Bucket` becomes optional; validation requires exactly one
  of `r2Bucket` | `staticAssets`. Existing R2-mode consumers are untouched.
- New exports: `StaticAssetsConfig`, `generateAssetsWorkerScript`.
- The upload token (`AccountToken` for R2 item writes) is not needed in
  assets mode; asset upload rides the provider's API token.
- **Consumer migration has a landmine**: switching an existing stack from
  `uploadStaticAssets` to `staticAssets` makes Pulumi delete every `R2Object`
  resource — each `delete()` issues a real DELETE against the bucket **and**
  pays the same per-resource checkpoint cost (hours), racing the freshly
  served site if the bucket is reused. Migrating stacks must instead remove
  the asset resources from state without invoking delete:
  `pulumi state delete <urn>` over the `R2Object` URNs (scriptable from
  `pulumi stack export`), then drop the bucket + `uploadStaticAssets` +
  `purgeZoneCache` code and clean up the orphaned bucket out-of-band.
- `pulumi preview`/`up` previews in assets mode hash the directory via the
  provider; with Nix-built sites the directory path itself changes on content
  change, so previews stay cheap and unknown-until-built store paths behave
  like any other unknown input.

## Implementation Notes

- `packages/sector7/workersite/worker-site.ts`: mode validation, `assets`
  block on `WorkersScript`, ASSETS binding, passthrough script selection.
- `packages/sector7/workersite/worker-site-script.ts`:
  `generateAssetsWorkerScript(redirects?)`.
- Provider floor: requires the wrapped terraform-provider-cloudflare
  ≥ 5.11.0 (`@pulumi/cloudflare` 6.17.0 in-repo satisfies this).
- First consumer: `garden/deploy/www/theoreticaledge.com` (dev stack first —
  it has the 955-file JupyterLite tree that motivated this).
