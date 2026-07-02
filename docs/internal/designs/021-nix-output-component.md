---
id: ADR-021
title: NixOutput Component — Declarative Nix Store Path Resolution
status: Accepted
date: 2026-05-13
deciders: [jmmaloney4]
tags: [design, adr, nix]
supersedes: []
superseded_by: []
links: [ADR-017]
---

# Context

ADR-017 created a `NixImage` ComponentResource that combines two concerns:

1. Resolving and building a nix derivation to produce a store path.
2. Pushing the resulting nix2container image to a registry.

The component is named `NixBuild`-adjacent in spirit (it builds images). Under the hood it uses `command.local.Command` to run `nix build` imperatively. This mixes a declarative contract ("I need an image at this reference") with an imperative description of how to produce it.

Other use cases will need store paths without pushing images — static site tarballs, compiled binaries, compiled documentation, data assets — but the current component is locked to the image workflow.

# Decision

Create a new ComponentResource called `NixOutput` that encapsulates the store-path resolution step independently of the image push step.

## Naming: `NixOutput`, not `NixBuild`

The name describes what the resource provides, not how it produces it.

- `NixBuild` describes a process: "run `nix build` on this attribute."
- `NixOutput` describes a contract: "give me the store path for this flake attribute."

The imperative implementation (`nix build`, `nix resolve`, or whatever is necessary) is internal to the component. A Pulumi program that declares a `NixOutput` is not making a promise about the build process — it is declaring that a store path must exist and be available as a resource output.

This follows the Pulumi philosophy: resources describe desired state, the provider figures out how to reach it.

## Type token

`sector7:nix:NixOutput`

## Interface

```ts
export interface NixOutputArgs {
  /** Flake attribute path (e.g. "packages.x86_64-linux.lens-api-image") */
  nixAttr: pulumi.Input<string>;
  /**
   * Absolute path to the repo root containing the flake.
   */
  repoRoot: pulumi.Input<string>;
  /**
   * Select a named output from a multi-output nix derivation.
   * Nix derivations can produce outputs like `out`, `dev`, `docs`.
   * Use this to select a specific output: `myapp#docs`.
   * Only meaningful when the underlying derivation is a multi-output
   * derivation. Ignored (no-op) for single-output derivations.
   */
  subOutput?: pulumi.Input<string>;
  /**
   * Select a sub-path within the resolved store path.
   * The store path is the root output; this picks a file or directory
   * inside it. Example: if `storePath` resolves to
   * `/nix/store/...-myapp-docs/`, then `subPath: "assets/style.css"`
   * produces `/nix/store/...-myapp-docs/assets/style.css`.
   * Equivalent to `path.resolve(storePath, subPath)` in Node or
   * `${storePath}/${subPath}` in bash, resolved to an absolute path.
   * The path must exist within the output derivation.
   */
  subPath?: pulumi.Input<string>;
  /** Additional trigger values */
  triggers?: pulumi.Input<string>[];
  /**
   * "resolve" = resolve the output path without building (default).
   * Fast — just evaluates the flake to find the store path.
   * Fails if the derivation hasn't been built yet and isn't cached
   * locally (nix eval cannot produce a store path without evaluating
   * the derivation, which requires building).
   *
   * "build"   = ensure the output exists by building the derivation.
   * Runs `nix build` before resolving. Expensive but guarantees the
   * output is in the local store.
   */
  mode?: "resolve" | "build";
  /**
   * Preview path resolution strategy.
   *
   * "resource" keeps the child command as the source of truth, which can
   * leave `storePath` unknown during preview when the command needs to rerun.
   *
   * "eager" attempts to resolve the path during preview when all required
   * inputs are already plain strings, preserving better downstream diff
   * fidelity for consumers like local Helm charts.
   */
  previewStrategy?: "resource" | "eager";
  /** Extra environment variables to pass to the build command. */
  env?: Record<string, pulumi.Input<string>>;
}

export class NixOutput extends pulumi.ComponentResource {
  /** The /nix/store/... store path of the built/resolved output */
  public readonly storePath: pulumi.Output<string>;

  constructor(
    name: string,
    args: NixOutputArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) { ... }
}
```

### Key differences from current `NixImageArgs`:

- Removed `imageName`, `imageTag`, `artifactRegistryUrl`, `authMode` (image-specific).
- Removed `resultLink` (an internal detail of the shell script; the output is the store path, not a symlink name).
- Default mode is `"resolve"` — resolve the attribute path without triggering a build. Consumers who need the derivation built should pass `"build"`.
- Output is `storePath` instead of `imageRef` + `digest`.
- Added `subOutput` to select a named output from a multi-output derivation.
- Added `subPath` to select a file or directory within the resolved store path.

## Relationship to NixImage

`NixImage` becomes a composition of `NixOutput` + push:

```
NixImage (refactored)
  if mode == "resolve":
    Use skopeo inspect to resolve digest of existing tag.
    Does NOT create a NixOutput child.

  if mode == "build":
    1. Create NixOutput child (gets storePath)
    2. Run skopeo push from storePath to registry
    3. Parse digest from skopeo output

  outputs: imageRef, digest (unchanged)
```

This makes `NixImage` a composition pattern — it builds an output and then pushes it. The build step is no longer baked into the same command as the push.

## Implementation: two scripts, one component

Split the existing `nix-image-build-push.sh` into two scripts:

1. **`nix-output-resolve.sh`** (new) — resolves and/or builds a nix attribute.

   - Outputs `STORE_PATH_OUTPUT:<storepath>` to stdout.
   - Accepts env vars: `NIX_ATTR`, `REPO_ROOT`, `SCRIPT_MODE` ("resolve" or "build").
   - In "build" mode: `nix build ${REPO_ROOT}#${NIX_ATTR} -L`
   - In "resolve" mode: `nix eval --raw ${REPO_ROOT}#${NIX_ATTR}`
   - Creates log files under `COMMAND_LOG_STEM`.

2. **`nix-image-push.sh`** (extracted from existing script) — pushes a store path to a registry.

   - Outputs `DIGEST_OUTPUT:<sha256:...>` to stdout.
   - Accepts env vars: `IMAGE_NAME`, `IMAGE_TAG`, `ARTIFACT_REGISTRY_URL`, `AUTH_MODE`, `STORE_PATH`, `COMMAND_LOG_STEM`.
   - Does NOT accept `NIX_ATTR` or `REPO_ROOT`.

The `NixOutput` component runs `nix-output-resolve.sh`. The refactored `NixImage` component runs `nix-output-resolve.sh` (via NixOutput) + `nix-image-push.sh`.

## Trigger semantics

> **Amended 2026-07-02.** The original design triggered only on `nixAttr`
> (plus caller-supplied `triggers`). In practice no consumer passed extra
> triggers, so `command.local.Command` never re-ran after the first
> deploy: content changes silently served the stale store path from
> Pulumi state (observed on the theoreticaledge.com dev stack, where a
> `pulumi up` after new posts merged reported "unchanged" and deployed
> nothing). Correct-by-default replaces opt-in triggering.

`NixOutput` computes a **derivation-path trigger** by default
(`changeDetection: "drv"`): at program time it runs
`nix eval --raw <repoRoot>#<nixAttr>.drvPath` and includes the result in
the child command's `triggers`. The drv path is nix's own hash over every
transitive build input (sources as nix would copy them, lockfiles, flake
inputs, toolchain), so:

- the command re-runs **iff** the build would produce a different result;
- `pulumi preview` stays clean when nothing relevant changed;
- Pulumi never needs to know which files feed the build — nix answers that.

Cost: one flake evaluation per preview/up. Nix's eval is the same work a
no-op `nix build` would do, so this does not meaningfully slow deploys.
An eval failure fails the program with a descriptive error (the build
could not have succeeded either).

`changeDetection: "none"` restores the legacy attr-only triggering for
consumers whose evaluation is prohibitively slow and who manage triggers
manually. `nixAttr` remains a trigger in both modes, and caller-supplied
`triggers` are appended after the computed ones.

For `NixImage` (build mode), the composed `NixOutput` inherits the same
default, and the push command already re-triggers off `storePath`, so a
drv change propagates build → push automatically. `NixImage` exposes a
`changeDetection` passthrough for opt-out.

Alternatives considered for the trigger value:

- **Source narHash / git SHA**: cheaper to compute but wrong in both
  directions — over-triggers on unrelated monorepo changes and cannot see
  flake-input or toolchain changes that alter the output.
- **Always re-run (timestamp/nonce trigger)**: correct results (nix
  caches), but every preview shows a diff and state churns on every up.
- **drvPath (selected)**: exact change semantics at the cost of one eval.

# Consequences

## Positive

- **Declarative API**: `NixOutput` says "I need this nix output's store path." The implementation details (nix build, nix eval, nix resolve) are internal.
- **Composable**: Other components (NixImage, NixTarball, NixStaticSite) can depend on `NixOutput` as a building block.
- **General-purpose**: Any nix attribute that produces a derivable output can be represented, not just nix2container images.
- **Resolve-first default**: The default mode is "resolve" — if the derivation already exists in the store, no build is triggered. This is the correct Pulumi-aligned default: declare desired state, only build if necessary.
- **Cleaner separation of concerns**: Image push logic no longer shares a command with nix build logic. Each step has its own command, its own triggers, its own error surface.
- **Optional preview fidelity**: Consumers that use local file-path inputs downstream can opt into preview-time store-path resolution when their `NixOutput` inputs are already concrete strings.

## Negative / Risks

- **Two commands instead of one**: Splitting build and push introduces two state entries and two command resources. A failed push after a successful build means the build output is rebuilt on the next apply (unless `resultLink` caching or a proper `onFailure` strategy is used). This is acceptable but worth noting.
- **State bloat**: The store path output (a long `/nix/store/...` string) will be stored in Pulumi state. Not a practical concern for size, but the change in store path on each build means state will drift between applies.
- **Migration**: Existing `NixImage` consumers get the same interface — no API break. But the internal command changes (two scripts instead of one, different env vars) means the test suite and any manual testing of the scripts need to pass.
- **`resolve` mode in NixImage**: When `NixImage` is in "resolve" mode (digest-only, image already pushed elsewhere), it should NOT create a `NixOutput` child. It should just run `skopeo inspect`. This means the refactored `NixImage` has two code paths — one that composes `NixOutput` + push, and one that just does skopeo inspect.

## Alternative names considered

### `NixDerivation`

Describes the nix concept precisely. But "derivation" is a nix internals term that leaks implementation detail. Not all outputs are top-level derivations — some are sub-output paths from multi-output derivations.

### `NixPackage`

Concise and common in nix parlance. But "package" implies a specific kind of output (a full derivation result), not the general case of any flake attribute.

### `NixStorePath`

Explicitly states the output type. A bit verbose and technically descriptive rather than declarative.

### `NixOutput` (selected)

Balances declarative intent ("output" of the nix system) with generality. An output is whatever the attribute path resolves to. The name doesn't imply a specific nix concept — it's a contract about the result, not the mechanism.

# Security / Privacy / Compliance

- The script runs `nix build` or `nix eval` on user-supplied flake paths. The `repoRoot` and `nixAttr` values must be controlled (they are Pulumi inputs, not user-facing).
- No credentials are involved in the build step — auth is only needed for the push step, which lives in a separate component/script.
- Store path values in Pulumi state are not secrets.

# Status Transitions

- 2026-05-13: Proposed
- 2026-05-13: Accepted — all open questions resolved, implementation in progress
- 2026-07-02: Amended — default drvPath change detection (`changeDetection: "drv"`) replaces attr-only triggering after a stale-deploy incident

# Resolved Questions

1. **Should `NixOutput` have a `subOutput` arg?** Yes. Added `subOutput` to select named outputs from multi-output derivations. Implemented as `nixAttr^subOutput` syntax passed to the shell script via `SUB_OUTPUT` env var.

2. **What happens on `pulumi preview`?** By default, `NixOutput` keeps the resource-backed behavior, so `mode="build"` can still leave `storePath` unknown during preview because `command.local.Command` doesn't execute in preview. Consumers that need a concrete preview-time path can opt into `previewStrategy="eager"`, which runs the resolver script during preview when all required inputs are already plain strings.

3. **Should `NixOutput` support caching?** No explicit caching in the component. Nix daemon cache handles this naturally. The `--no-link --print-out-paths` build approach doesn't create symlinks to clean up. Leave caching to the nix daemon.

# References

- ADR-017: NixImage Pulumi Component for nix2container Build-Push
- `packages/sector7/nix-image/nix-image.ts`: current implementation
- `packages/sector7/scripts/nix-image-build-push.sh`: current shell script
- `packages/sector7/tests/nix-image.test.ts`: current test suite
