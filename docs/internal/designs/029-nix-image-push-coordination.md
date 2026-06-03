---
id: ADR-029
title: Coordinated Push Phase for NixImage (Shared Base Layer Deduplication)
status: Proposed
date: 2026-06-03
deciders: [jmmaloney4]
consulted: []
tags: [design, adr, nix-image]
supersedes: []
superseded_by: []
links: [ADR-017]
---

# Context

Repositories that build several container images from one monorepo (yard, zeus)
almost always produce images that **share a large base layer** and differ only
in a small top layer. With nix2container this is the normal outcome: the shared
runtime closure is one content-addressed store path, so every image references
the *same* layer digest.

`NixImage` (ADR-017) builds each image with a `NixOutput` (the `nix build`) and
pushes it with a `command.local.Command` running `skopeo copy nix:<store-path> docker://<ref>`. Pulumi has no dependency edge between independent `NixImage`s,
so it runs their pushes **concurrently**. Each push independently probes the
registry for each layer (`HEAD /v2/<name>/blobs/<digest>`) and uploads the ones
that are missing.

When N images that share a base layer are pushed at once, all N `HEAD`s for the
shared blob return 404 before any push has finished uploading it, so the
identical multi-hundred-MB base is uploaded N times. Only one copy is kept; the
other N-1 uploads are wasted bandwidth and wall-clock. This was observed in
yard's cron stack, where three images (`discovery-runner`, `dbt`,
`pipeline-runner`) each re-push the same `sha256:…` base on every rebuild.

**Deduplication boundary.** Registries deduplicate layer blobs per *registry*,
not globally. For GCP Artifact Registry the boundary is the **repository
resource** (`PROJECT/REPO`): images pushed under different image names within
one AR repository share stored blobs, and a layer already present anywhere in
that repository satisfies the `HEAD` existence check, so a later push skips it.
Across *different* AR repositories nothing is shared (skopeo does not implement
the OCI cross-repo blob `mount` API — only crane/gcrane do). The fix therefore
only needs to coordinate pushes **destined for the same registry**.

In scope: avoiding concurrent re-upload of shared layers from `NixImage`'s push
phase, with a default that requires no consumer changes. Out of scope:
cross-registry layer sharing (would require swapping skopeo for crane); changing
the image build or the push script; multi-arch manifests.

Triggers: yard PR observing triple-pushed base layers; this ADR proposes the
upstream fix so consumers can drop their hand-rolled `dependsOn` workarounds.

# Decision

Add a **push-coordination** layer to `NixImage` that serializes the pushes of
images sharing a registry, while leaving the `nix build` phase fully parallel.

## `NixImagePushGroup`

Introduce a small, Pulumi-state-free coordinator exported from
`@jmmaloney4/sector7/nix-image`:

```ts
export class NixImagePushGroup {
  constructor(args?: { strategy?: "serial" | "primer" });
  dependencies(): pulumi.Resource[]; // what the next push must wait for
  register(push: pulumi.Resource): void; // record a constructed push
}
```

`NixImage` calls `dependencies()` before constructing its push `Command` (adding
the result to `dependsOn`) and `register()` after. The group holds only
in-memory references to already-constructed push commands.

- **`"serial"`** (default): each push waits for the previously registered push,
  so at most one runs at a time. Correct regardless of which layers the images
  share.
- **`"primer"`**: only the first push runs alone; every later push waits for
  that first ("primer") push and then runs concurrently. Optimal when all images
  share a base (the primer uploads it once; the rest skip it and upload only
  their unique top layers in parallel). Assumes the first image carries the
  shared base.

## `NixImage` integration

Add `pushGroup?: NixImagePushGroup | false` to `NixImageArgs`:

- **omitted (default):** the image joins an **internal default group keyed on its
  `artifactRegistryUrl`**. Images pushing to the same registry are serialized;
  images on different registries stay parallel. Zero-config — existing consumers
  get the dedup automatically.
- **a `NixImagePushGroup`:** the image joins that explicit group instead, to
  widen/narrow the coordination set or opt into `"primer"`.
- **`false`:** opt out; the push runs unordered (pre-ADR behavior).

The default group map is keyed on the `artifactRegistryUrl` Input itself: plain
strings collapse by value; Output registries collapse by reference (the common
case where one `artifactRegistryUrl` Output is shared across `NixImage`s). If a
consumer passes a distinct Output per image, keys differ and the default
degrades to the prior fully-parallel behavior — never worse than before.

Coordination applies to `"build"` mode only; `"resolve"` mode performs no upload
and never joins a group.

The component MUST:

- Serialize pushes within a registry by default, with no required consumer
  changes (RFC 2119 MUST).
- Keep `nix build` (`NixOutput`) phases parallel — only the push `Command`
  carries the added `dependsOn` (MUST). This is strictly better than a
  consumer-level `dependsOn` between whole `NixImage`s, which also serializes
  builds.
- Never let coordination affect correctness: push order is irrelevant to the
  result, so mis-grouping changes only performance (MUST).
- Provide an explicit opt-out (`pushGroup: false`) and an explicit override
  (`pushGroup: group`) (SHOULD).

# Consequences

## Positive

- Shared base layers are uploaded once per registry instead of once per image —
  the common monorepo case gets the bandwidth/wall-clock win for free.
- Builds stay parallel; only the (I/O-bound) pushes serialize.
- Consumers can delete hand-rolled `dependsOn` chains between `NixImage`s.
- `"primer"` lets callers recover push parallelism for unique layers when images
  are known to share a base.
- The coordinator is pure in-memory state — no new Pulumi resources, no state
  bloat, nothing to import in the typical path.

## Negative

- **Behavior change:** pushes to the same registry that previously ran in
  parallel now serialize by default. For images that genuinely share no layers
  this trades a little wall-clock for no benefit; opt out with `pushGroup: false` or use `"primer"`. Warrants a minor version bump and changelog note.
- Module-level mutable state (the default-group map) — acceptable because it
  only affects scheduling and degrades safely, but it is global to the program.
- Reference-identity keying for Output registries is a heuristic; an unusual
  consumer pattern (fresh Output per image) silently forgoes the optimization.
- Under the Automation API, multiple stacks in one process share the module
  state; harmless (serialization is correctness-safe) but worth noting. Explicit
  groups sidestep it.

# Alternatives

### 1. Consumer-level `dependsOn` between `NixImage`s (status quo workaround)

Chain whole components with `dependsOn` in each consumer.

Pros: no library change; already works.

Cons: serializes **builds too**, not just pushes; must be re-implemented in every
consumer; easy to get wrong or forget. Rejected as the durable solution — it is
exactly what this ADR replaces.

### 2. Opt-in only (no default group)

Ship `NixImagePushGroup` but require consumers to wire it.

Pros: no behavior change; no module-global state.

Cons: the common case stays broken until each consumer opts in — fails the "just
works" goal. Rejected; kept available as the explicit-group path.

### 3. Cross-repo blob mount / shared base image (crane)

Push a shared base once and have app images mount its layers across repositories
via the OCI `mount` API.

Pros: dedups across *different* registries/repositories; preserves full push
parallelism.

Cons: skopeo does not implement cross-repo mount, so this means replacing the
pusher with crane/gcrane; needs a canonical base-repo convention; IAM-gated and
silently falls back to full upload on misconfig. Much larger change for a case
we do not currently have (our images share one AR repository). Rejected for now;
revisit if cross-registry dedup becomes a real requirement.

### 4. Single global serial chain (no registry keying)

Serialize *all* pushes program-wide.

Pros: simplest; always correct.

Cons: needlessly serializes pushes to unrelated registries, a larger
behavior-change blast radius. Rejected in favor of per-registry default groups.

# Security / Privacy / Compliance

- No change to authentication, tokens, or the push script. Coordination only
  reorders existing push commands.
- No new data in Pulumi state; the coordinator holds in-memory resource handles
  during program evaluation only.

# Operational Notes

- Default behavior changes deploy timing: same-registry pushes run sequentially.
  For a handful of images this is dominated by upload time that would otherwise
  be partly wasted re-uploading shared layers.
- Observability: push ordering is visible in the Pulumi resource graph
  (`dependsOn` edges on the `…-push` commands).
- Rollback: set `pushGroup: false` on affected images, or pin the prior sector7
  version.
- Cost: reduces egress/registry write amplification for shared layers; the
  primary motivation.

# Status Transitions

- Extends ADR-017 (NixImage). Does not supersede it.

# Implementation Notes

1. `packages/sector7/nix-image/push-group.ts` — `NixImagePushGroup` + types.
2. `packages/sector7/nix-image/nix-image.ts` — default-group map keyed on
   `artifactRegistryUrl`; `pushGroup` arg; wire `dependsOn`/`register` on the
   push command (build mode only).
3. `packages/sector7/nix-image/index.ts` — export `NixImagePushGroup` and types.
4. Tests: `tests/nix-image-push-group.test.ts` (pure group logic: serial,
   primer, empty) and additions to `tests/nix-image.test.ts` (registration in
   build mode, no registration in resolve mode, opt-out).
5. Minor version bump for the new feature + behavior change.

# References

- ADR-017: NixImage Pulumi Component for nix2container Build-Push
- OCI Distribution Spec — blob existence (`HEAD`) and cross-repo `mount`:
  https://github.com/opencontainers/distribution-spec/blob/main/spec.md
- GCP Artifact Registry container concepts (layer sharing within a repository):
  https://cloud.google.com/artifact-registry/docs/container-concepts
- nix2container: https://github.com/nlewo/nix2container
