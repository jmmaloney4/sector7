---
id: ADR-035
title: deploy-lib dual-mode cluster credential resolver (contract-first, StackReference fallback)
status: Proposed
date: 2026-09-17
deciders: [jmmaloney4]
consulted: [garden ADR 173, garden ADR 174, garden ADR 170]
tags: [design, adr, tenancy, deploy-lib]
supersedes: []
superseded_by: []
links:
  - https://github.com/jmmaloney4/garden/issues/2074
  - https://github.com/jmmaloney4/garden/issues/1883
---

# Context

Garden's `deploy/lib` resolves the shared cluster credential via a Pulumi
`StackReference` to `organization/k8s/<env>` (`getK8sProvider`,
`getPlatformKubeconfig`, `getApiServerHost`) and cross-stack secrets via
`organization/config/<env>` (`getConfigStack`). The cluster extraction into
`room-of-requirement/seven` (garden ADR 173, initiative garden#1883) removes
the shared Pulumi backend between tenants and the platform, so those
StackReferences stop being possible across the tenancy boundary.

ADR 173 §"Breaking `getK8sProvider` without a big bang" prescribes the
migration mechanism this ADR implements:

> The sector7-published resolver reads the kubeconfig from the tenant's
> 1Password contract item **when one is present**, and falls back to the
> `organization/k8s/prod` StackReference when it is not. Tenant stacks then
> migrate to the contract one at a time, ahead of and independently from the
> `k8s` stack's own move, and the fallback is deleted in wave 5 once no stack
> uses it.

The same section gives `getConfigStack` the same dual-mode treatment and
calls it the more urgent of the two (14 consumer projects, live secrets).

Constraints inherited from the garden ADRs:

- **Channel is 1Password.** Pulumi ESC was rejected (garden ADR 170, alt 5).
  Contract items are addressed `op://<vault>/<title>/<label>` (the convention
  sector7's `OnePasswordItem` documents) and carry `producedBy` /
  `producedAt` fields so consumers can assert freshness (ADR 173).
- **Bootstrap is out-of-band.** The contract cannot describe how to reach the
  contract channel (ADR 173's named circularity): the resolver's 1Password
  Connect coordinates must arrive via stack config / CI secrets, never via a
  contract item — and never via a kubeconfig-authenticated port-forward,
  because the kubeconfig is the thing being fetched.
- **Zero call-site changes.** Consumers flip modes per stack; `getK8sProvider()`
  call sites (10 in garden today) must not change. The Pulumi provider's
  logical name `"k8s-platform"` must be preserved (garden pins one provider
  per stack on that name).

In scope: a new `@jmmaloney4/sector7/deploy-lib` sub-path exporting the
dual-mode `getK8sProvider`, `getPlatformKubeconfig`, `getApiServerHost`, and
`getConfigStack`. Out of scope: the publisher that writes contract items
(garden/seven side, #2075 wave 2), per-tenant vault provisioning, migrating
garden's remaining `deploy/lib` helpers (gateway/tailnet wrappers already
delegate to sector7; `requireMixedConfig` already lives in
`pulumi-config/mixed-config`).

# Decision

Publish `packages/sector7/deploy-lib` with a **single mode chokepoint** and
two resolution paths.

## Mode selection (the chokepoint)

A stack is in **contract mode** iff the Pulumi config key `contract:vault`
is set on that stack. Otherwise it is in **stackref mode**. Nothing else —
not read success, not credential presence — influences the mode:

- `contract:vault` set but the item is missing, a field is absent, Connect is
  unreachable, or credentials are absent → **loud failure**. A silent
  fallback would mask exactly the contract-drift failure mode garden#1784
  documents, and would turn a misconfigured stack into a stack quietly
  depending on a channel scheduled for deletion (wave 5).
- `contract:vault` unset → the existing StackReference behavior, unchanged.

Contract-mode configuration (all read once, at the chokepoint):

| Key                               | Meaning                                                       | Fallback               |
| --------------------------------- | ------------------------------------------------------------- | ---------------------- |
| `contract:vault`                  | 1Password vault (UUID or name) holding this tenant's contract | — (mode selector)      |
| `contract:connectHost`            | 1Password Connect base URL                                    | `OP_CONNECT_HOST` env  |
| `contract:connectToken` (secret)  | Connect bearer token                                          | `OP_CONNECT_TOKEN` env |
| `contract:maxAgeHours` (optional) | Reject items whose `producedAt` is older                      | no freshness check     |

## Contract item shapes (pinned here; the publisher must match)

| Item title   | Field labels                                                                                                               | Replaces                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `kubeconfig` | `kubeconfig` (YAML/JSON kubeconfig), `producedBy`, `producedAt`                                                            | `organization/k8s/<env>` outputs `kubeconfig`/`apiHost` |
| `config`     | `cloudflareApiTokens` (JSON `Record<accountId, token>`), `ghcr` (JSON `{"username", "token"}`), `producedBy`, `producedAt` | `organization/config/<env>` outputs                     |

`getApiServerHost` in contract mode parses `clusters[0].cluster.server` out
of the kubeconfig (YAML or JSON) rather than requiring a separate item — the kubeconfig
already carries the coordinate, and a second item could drift from it.

## Read mechanism

A minimal 1Password **Connect REST** client (`fetch`, no new dependencies):
vault lookup by UUID or by `filter=name eq`, item lookup by
`filter=title eq`, then field extraction by label. Reads are cached per
`(vault, title)` for the life of the process (same posture as the existing
`stackRefCache`), wrapped in `pulumi.secret(...)`, and performed inside
`pulumi.output` so failures surface as resource errors on the consuming
stack's preview — with messages naming the vault, item, and field.

The resolver MUST keep the k8s provider construction identical to garden's
today: `new k8s.Provider("k8s-platform", { kubeconfig, enablePatchForce })`.

# Consequences

## Positive

- Per-stack cutover with zero call-site changes: set `contract:vault` (plus
  Connect coordinates) on a stack and it stops depending on the shared
  backend; unset it and it rolls back.
- Wave 5 deletion is mechanical: remove the stackref path and the fallback
  types; contract mode is already the only exercised path by then.
- Misconfiguration is loud at one chokepoint instead of being interpretable
  as "fall back and carry on".
- `getConfigStack` migrates on the same mechanism for free.

## Negative

- A 1Password item is a snapshot; a StackReference was re-read every preview
  (ADR 173 names this). `producedAt` + `contract:maxAgeHours` is the
  mitigation, not a fix — staleness detection is opt-in until the publisher
  exists everywhere.
- Contract-mode previews need Connect reachability from wherever Pulumi runs
  (CI runner, workstation). That is a new operational dependency, accepted by
  ADR 173 when it made 1Password the channel.
- The item/field shapes for `config` are pinned by the consumer before the
  publisher exists; if #2075 wants different shapes, this ADR must be amended
  and the resolver updated in lockstep (both repos pin sector7 versions, so
  the skew is at least explicit).

# Alternatives

- **Go provider invoke (`sector7:onepassword:getItem`)** — a data-source
  function on the native provider, symmetrical with the `OnePasswordItem`
  write resource. Rejected for wave 0: the provider reaches Connect through a
  kubeconfig-authenticated port-forward, which is circular for fetching the
  kubeconfig itself; adding direct-Connect support plus an invoke is a much
  larger change coupled to provider releases, and buys no consumer-visible
  difference over a TypeScript reader. Remains the natural home if the read
  path ever needs closure serialization or multi-language consumers.
- **`op` CLI subprocess (service accounts)** — would also work from CI, but
  adds a binary prerequisite to every consumer environment and makes the
  failure surface a subprocess exit code. Connect REST is one `fetch` and the
  cluster already runs Connect.
- **Mode selection by "try contract, fall back on failure"** — maximally
  convenient, and rejected outright: it converts every contract outage or
  typo into a silent dependence on the channel that wave 5 deletes, and makes
  "which mode is this stack actually in" unanswerable from config.
- **In-cluster ConfigMap/Secret contract** — cannot bootstrap (needs the
  kubeconfig first); ADR 170 already retains it only as a complement.

# Security / Privacy / Compliance

- The Connect token is a bearer credential scoped to the tenant's vault(s);
  it arrives as a Pulumi secret config value or CI-injected env var and is
  never logged. Field values read from the contract are wrapped in
  `pulumi.secret` before leaving the module.
- The channel is https-only: a protocol-less `connectHost` is normalized to
  https, and an explicit `http://` host is refused outright rather than
  honored — a cleartext hop for the bearer token and contract secrets is not
  a supported configuration.
- No credential material is written anywhere by this module — it is
  read-only against Connect.
- Error messages include vault/item/field *names*, never values.

# Operational Notes

- Rollout: ships in a sector7 release (wave 0 of ADR 173's migration order);
  garden re-exports it from `deploy/lib` behind a version pin; stacks flip by
  setting `contract:*` config; wave 5 deletes the stackref path.
- Rollback per stack = unset `contract:vault`.
- Observability: contract-mode failures fail the preview/update with the
  op:// coordinate in the message; there is no partial state.

# Status Transitions

- 2026-09-17: Proposed (this PR).
