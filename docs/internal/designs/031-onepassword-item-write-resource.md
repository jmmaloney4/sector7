---
id: ADR-031
title: OnePassword Item Write Resource
status: Proposed
date: 2026-06-10
deciders: [jmmaloney4]
consulted: []
tags: [design, adr, pulumi, kubernetes, onepassword, secrets]
supersedes: []
superseded_by: []
links:
  - garden ADR 091 (docs/internal/decisions/091-pulumi-writes-litellm-keys-to-1password.md)
  - sector7#258 (LiteLLM Team/ApiKey as dynamic resources)
---

# Context

We need a way to **write** (create and update) a 1Password item from Pulumi —
i.e. to publish a value Pulumi already holds into 1Password so that downstream
read paths (the 1Password operator's `OnePasswordItem` CR → k8s Secret, or a
`op read` on a workstation) can distribute it. The triggering consumer is
**garden ADR 091**: the garden LiteLLM stack mints virtual keys (e.g.
`personalHermesAgentApiKey`) and wants to store one in 1Password instead of
leaving it in Pulumi state and hand-copied plaintext.

The forces that shape this:

- **1Password Connect is `ClusterIP`-only** in the target clusters
  (garden's `deploy/platform/1password/`). We MUST NOT add tailnet/public ingress
  to Connect (garden ADR 088 keeps these surfaces private). The Connect **server**
  REST API is full CRUD; the **operator** only syncs items *out* to Secrets, so it
  cannot create or update items.
- **Pulumi runs out of cluster.** garden deploys from GitHub Actions runners that
  reach the kube-apiserver over the tailnet via an mTLS kubeconfig pulled from
  stack state. They can port-forward to a pod *through* that apiserver, but cannot
  reach a `ClusterIP` Service directly.
- **A bridged provider can't help here.** `@pulumiverse/onepassword` is an
  out-of-process Terraform-bridged plugin that owns its own network connection and
  exposes only `url`/`token`; it cannot reach `ClusterIP` Connect from outside the
  cluster and offers no seam to insert a port-forward.
- **We already have the transport.** sector7#258 reaches the LiteLLM admin API
  from this exact out-of-cluster CI by opening a short-lived **in-process
  Kubernetes port-forward** (`@kubernetes/client-node` `PortForward` +
  `net.createServer`) and `fetch`-ing over `localhost`. And dynamic resources are
  a **house pattern** here: `r2/r2object.ts`, `d1/d1-query.ts`, and (via #258)
  `litellm/admin.ts`.

**In scope:** a generic, reusable Pulumi dynamic resource in sector7 that
creates/updates a 1Password item via the Connect REST API over an in-process
port-forward, plus extracting the shared port-forward transport helper, plus
tests.

**Out of scope:** the garden consumer wiring (owned by garden ADR 091); the read
path (the operator and `OnePasswordItem` CRs already exist); provisioning of the
Connect write token and the target vault (operator/IaC concern); a 1Password
*cloud-API* variant (see Alternatives).

# Decision

Create a Sector7 Pulumi **dynamic resource** `OnePasswordItem` that manages a
1Password item through 1Password Connect, reached over an **in-process Kubernetes
port-forward**.

## Type token & package surface

- Type token: `sector7:onepassword:Item`.

- Subpath export (not the root barrel — it pulls in `@kubernetes/client-node`):

  ```ts
  import { OnePasswordItem } from "@jmmaloney4/sector7/onepassword";
  ```

  Package wiring mirrors `./litellm` (ADR 026): an `exports["./onepassword"]`
  entry pointing at `./dist/onepassword/index.d.ts` / `index.js`.

> **Naming.** This is the 1Password *noun* "item" and lives in Pulumi's type
> namespace. It is **distinct from** the operator's read-only
> `onepassword.com/v1 OnePasswordItem` **CRD**, which lives in the Kubernetes API
> namespace. They sit on opposite ends of the same item (this writes it; the CR
> reads it into a Secret). The design accepts the shared noun deliberately;
> code/docs MUST disambiguate "Pulumi resource" vs "operator CR" wherever both
> appear.

## Provider lifecycle

The resource MUST be a `pulumi.dynamic.ResourceProvider` with a full
`check`/`diff`/`create`/`update`/`delete` lifecycle (the #258 / `r2object.ts`
shape):

- `create()` MUST be **find-or-create**: if an item with the target title already
  exists in the vault, **adopt** it and reconcile its fields in place
  (`PUT /v1/vaults/{vault}/items/{id}`); otherwise `POST /v1/vaults/{vault}/items`.
  This is what makes a safe cutover from a hand-created or previously-unmanaged
  item possible (the same property #258 relies on).
- `diff()` MUST route a changed field value to an **in-place update**, and MUST
  reserve replacement for an identity change (vault, or the stable title/key the
  item is matched on). It MUST NOT delete-and-recreate on a value change —
  consumers reference the item by path, and a new UUID would break them.
- `delete()` deletes the item. Callers that want the item to outlive the stack
  SHOULD use `pulumi.RetainOnDelete` or model it as adopt-only (a `protect` knob
  MAY be added later; not required for v1).
- All `@kubernetes/client-node` / `node:net` / 1Password-client imports MUST be
  lazy `await import()` **inside** the callbacks, so the provider closure
  serializes (the rule `r2object.ts` and `litellm/admin.ts` document).

## Transport: extract and generalize the port-forward helper

The in-process port-forward in `litellm/admin.ts` SHOULD be **factored out** into a
shared sector7 util (e.g. `@jmmaloney4/sector7/k8s` `portForward()` or an internal
module both call sites import), so the LiteLLM admin providers and this resource
share one implementation. The extraction MUST generalize two things the current
helper hardcodes:

1. **Kubeconfig source.** #258 does `kc.loadFromDefault()`. The shared helper MUST
   accept an explicit kubeconfig (string or `KubeConfig`) so callers whose creds
   come from Pulumi stack state (garden's `getK8sProvider()` kubeconfig) can pass
   it in. `loadFromDefault()` becomes the fallback when none is supplied.
2. **Target.** The helper MUST accept the target Service/pod selector, namespace,
   and port (admin.ts targets the LiteLLM proxy Deployment; this resource targets
   the Connect Service, default `onepassword-connect.1password.svc.cluster.local`
   on port `8080` — confirm against the deployed `connect` Helm release).

The **Connect REST client** (auth header `Authorization: Bearer <connectToken>`,
the `/v1/vaults/{vault}/items` create/update/get/delete calls, and item-field
JSON shaping) is the only genuinely new code; `adminRequest()` in #258 is
LiteLLM-specific and is NOT shared.

## Inputs / outputs (interface sketch)

Inputs (exact names settled in implementation):

- `kubeconfig` (secret) — for the port-forward.
- `connectToken` (secret) — Connect access token with **write** scope on the
  target vault.
- `connectService` — `{ namespace, name, port }` (or a resolved `url`) for the
  Connect Service to forward to.
- `vault` — vault id.
- `title` — stable match key for adoption.
- `category` — e.g. `password` / `api_credential`.
- `fields` — map of field label → `{ value (secret), type }`; optional `sections`.

Outputs:

- `uuid` — the created/adopted item id.
- `itemPath` — `vaults/{vault}/items/{uuid}` (the form the operator's
  `OnePasswordItem` CR `spec.itemPath` and `op read` consume).

Field values MUST be treated as Pulumi **secrets** on both input and output.

## Tests

Mirror `tests/litellm-admin.test.ts`: mock Pulumi + the transport + `fetch`, and
assert `diff` (in-place vs replace), `create` (adopt-vs-new), `update`, and
`delete`. The transport extraction SHOULD keep `litellm/admin.ts`'s existing tests
green (a refactor, not a behavior change).

# Consequences

## Positive

- A **reusable** "Pulumi writes a 1Password item" primitive for any stack/repo,
  not a garden one-off. First consumer: garden ADR 091.
- **No new network exposure** — Connect stays `ClusterIP`-only; the write tunnels
  through the apiserver the runner already authenticates to.
- **DRY transport** — one in-process port-forward implementation shared with the
  LiteLLM admin providers, and the same closure-serialization discipline.
- No new third-party provider/plugin; stays inside the established
  `pulumi.dynamic` house pattern with mock-based tests.
- Typed inputs/outputs and explicit `diff()` control over in-place vs replace.

## Negative

- Net-new code (a dynamic provider + Connect REST client) and a transport
  refactor of `litellm/admin.ts` — more than instantiating a bridged
  `onepassword.Item`.
- Carries the closure-serialization constraint and needs kubeconfig + Connect
  token plumbed in by every consumer.
- Shared noun with the operator's `OnePasswordItem` CRD invites confusion if not
  disambiguated.
- The write path's reachability depends on the apiserver and a ready Connect pod
  at deploy time.

# Alternatives

- **Bridged `@pulumiverse/onepassword` + `ClusterIP` Connect** — can't reach
  `ClusterIP` from out-of-cluster Pulumi; no port-forward seam. Rejected.
- **Bridged provider + tailnet-expose Connect** — adds the Connect ingress we
  explicitly avoid. Rejected.
- **Bridged provider + 1Password service-account token → cloud API** — bypasses
  Connect and k8s entirely; lowest-effort and not a worse data boundary (the
  secret lives in 1Password's cloud regardless). Rejected as the default to avoid
  a *second* 1Password auth mechanism alongside Connect — but this is a natural
  **future variant** of this same resource (swap the transport: cloud API instead
  of port-forward+Connect) and is the documented escape hatch if the port-forward
  proves fiddly in CI.
- **A garden-local dynamic provider** (don't put it in sector7) — would copy
  #258's transport rather than reuse it and wouldn't be available to other
  stacks/repos. Rejected.
- **Bake the write into `@jmmaloney4/sector7/litellm`** (the package that mints
  the keys) instead of a generic resource — simplest for the one caller, but not
  reusable for non-LiteLLM secrets. Rejected in favor of the generic resource;
  the LiteLLM stack composes the two.

# Security / Privacy / Compliance

- **Connect write token** MUST be write-scoped to the target vault only (least
  privilege), distinct from the operator's read token, and supplied as a Pulumi
  secret. It is a long-lived credential — treat like the existing
  `1password:connectToken`.
- **Kubeconfig** grants apiserver access; it is the same credential stacks already
  use for their k8s provider, passed as a secret. The port-forward rides that
  authenticated, audited channel; Connect gains no new ingress.
- **Item field values are secrets** end to end — mark secret on input and output
  so they never land in plaintext state or logs.
- Connect remains private (`ClusterIP`); this resource does not change its
  exposure (consistent with garden ADR 088).

# Operational Notes

- Out-of-cluster runs require apiserver reachability and a **ready Connect pod** at
  deploy time; surface a clear error if the port-forward can't bind or Connect is
  unready.
- The port-forward is **short-lived per operation** and torn down after — no
  lingering tunnels.
- Idempotent adoption avoids duplicate items on re-runs and on cutover from a
  hand-created item.
- Ordering for the first consumer (garden ADR 091): publish runs after the
  key-minting resource reconciles; do not entangle with #258's state-delete
  cutover (deleting a LiteLLM team cascades to its keys).

# Status Transitions

- New design; does not amend or supersede an existing ADR. Reuses the transport
  pattern established in sector7#258.

# Implementation Notes

- Extract `portForward()` from `litellm/admin.ts` into a shared util; generalize
  kubeconfig source and target Service/port; keep admin.ts tests green.
- Add the `./onepassword` subpath export and package wiring (mirror ADR 026).
- Implement the Connect REST client (`/v1/vaults/{vault}/items` CRUD) and the
  `sector7:onepassword:Item` dynamic provider with find-or-create + in-place diff.
- Add `tests/onepassword-item.test.ts` mirroring `litellm-admin.test.ts`.
- Coordinate with sector7#258: the transport helper originates there, so either
  land after #258 merges or carry the extraction in the same change set.
- First consumer and acceptance: garden ADR 091 wiring (garden's litellm stack
  publishes `personalHermesAgentApiKey`).

# References

- garden ADR 091 — `docs/internal/decisions/091-pulumi-writes-litellm-keys-to-1password.md`
- sector7#258 — LiteLLM Team/ApiKey as dynamic resources (in-process port-forward
  transport; `packages/sector7/litellm/admin.ts`)
- `packages/sector7/r2/r2object.ts`, `packages/sector7/d1/d1-query.ts` — dynamic
  provider + closure-serialization precedent
- ADR 026 — LiteLLM Proxy ComponentResource (subpath-export / package-wiring
  precedent)
- 1Password Connect REST API — `POST/PUT/GET/DELETE /v1/vaults/{vaultId}/items`
