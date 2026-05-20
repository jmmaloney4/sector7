---
id: ADR-024
title: Team-scoped capability aliases for LiteLLM
status: Proposed
date: 2026-05-17
deciders: [jmmaloney4]
consulted: []
tags: [design, adr, pulumi, kubernetes, litellm]
supersedes: []
superseded_by: []
links:
  - '[ADR-026](./026-litellm-proxy-component.md)'
  - https://github.com/jmmaloney4/sector7/issues/197
---

# Context

ADR-026 established Sector7's `LiteLLMProxy` component and the low-level split between provider credentials, deployments, model groups, router policy, and governance policy.

That is a good base, but the next consumer use case exposes a gap in the public API.

We now need LiteLLM to front multiple backend pools for multiple billing accounts while preserving stable capability aliases for callers. The concrete example is a shared AI gateway where both a `personal` team and a `cavinsresearch` team should be able to request `coding`, but the gateway should route those requests to different backend pools and attribute spend to different billing contexts.

The current Sector7 surface pushes consumers toward the wrong abstraction:

- billing boundaries get encoded into model names
- internal OpenAI-compatible upstreams such as `codex-proxy` still look like second-class cases
- virtual key and team lifecycle helpers live outside Sector7
- there is no documented high-level builder for multi-team capability routing

That leads to names like `personal-zai-coding` and `cavinsresearch-zai-coding`, which are operationally workable but architecturally wrong. The caller should ask for a capability. The billing context should come from the key or team.

In scope:

- Sector7's LiteLLM type surface
- a documented architecture for team-scoped capability aliases
- high-level builders that compile to the existing low-level model-group shape
- upstream LiteLLM team and API-key resources
- internal OpenAI-compatible upstreams that may not need provider-level API keys

Out of scope:

- redesigning LiteLLM itself
- replacing the low-level deployment/model-group API
- building a full LiteLLM UI or admin workflow
- solving every future budget / spend / org policy feature in one pass

# Decision

Sector7's LiteLLM package MUST separate the caller-facing alias layer from the billing/team layer.

Concretely:

1. The public API SHOULD model stable capability aliases such as `smart`, `coding`, and `cheap`.
2. Billing boundaries such as `personal` and `cavinsresearch` MUST be represented as teams or team-like routing scopes, not baked into caller-visible alias names.
3. Sector7 MUST provide a high-level builder that compiles team-scoped capability definitions into the existing low-level `LiteLLMModelGroup[]` shape.
4. Sector7 MUST widen the low-level config surface so internal OpenAI-compatible upstreams can omit provider API keys when appropriate.
5. Sector7 SHOULD upstream operational resources for LiteLLM team and key management so consumers do not need to re-implement them.

## High-level routing model

The architecture is a four-layer stack:

1. team / billing boundary
2. capability alias
3. backend pool
4. key / budget / spend attribution

Desired behavior:

- team `personal` requests `coding` -> personal coding pool
- team `cavinsresearch` requests `coding` -> research coding pool
- both callers use the same public alias
- spend attribution follows the key/team used for the request

## Internal vs public model names

Sector7 SHOULD treat LiteLLM model-group names as internal routing identifiers.

For team-scoped shared aliases, the generated model groups SHOULD:

- keep a unique internal `name`, for example `personal::coding`
- expose the caller-facing alias via `teamPublicModelName: "coding"`
- attach `teamId: "personal"`

This keeps fallback wiring and config validation unambiguous while letting the public alias remain stable per team.

## Low-level type widening

The low-level config types MUST support:

- provider configs without `apiKey`
- optional per-model metadata for team routing and tags
- passthrough settings for LiteLLM config sections where Sector7 does not yet model every upstream field

Recommended additions:

- `LiteLLMProviderConfig.apiKey?: pulumi.Input<string>`
- `LiteLLMModelDeployment.teamId?`
- `LiteLLMModelDeployment.teamPublicModelName?`
- `LiteLLMModelDeployment.tags?`
- `LiteLLMModelDeployment.extraLiteLLMParams?`
- `LiteLLMModelDeployment.extraModelInfo?`
- `LiteLLMModelGroup.teamId?`
- `LiteLLMModelGroup.teamPublicModelName?`
- `LiteLLMModelGroup.tags?`
- `LiteLLMModelGroup.extraModelInfo?`
- `LiteLLMProxyArgs.extraLiteLLMSettings?`
- `LiteLLMProxyArgs.extraGeneralSettings?`
- `LiteLLMProxyArgs.extraRouterSettings?`

## High-level builder

Sector7 SHOULD provide a builder that accepts team definitions and capability definitions, then emits low-level model groups.

The builder MUST:

- generate unique internal model-group names per team/capability
- preserve shared public aliases per team
- rewrite fallback references within the same team scope
- fail loudly on duplicate team/capability combinations

## Operational resources

Sector7 SHOULD ship team and key resources in the LiteLLM package:

- `LiteLLMTeam`
- `LiteLLMApiKey`

These resources SHOULD use the existing Pulumi command-provider pattern already used elsewhere in Sector7, and they SHOULD support team-aware payloads such as `teamId`, `budgetId`, aliases, metadata, and tags.

# Consequences

## Positive

- Consumers can expose stable aliases without leaking billing-account names into their public API.
- Internal upstreams such as `codex-proxy` become first-class citizens.
- Team and key lifecycle logic moves into the reusable library instead of being reimplemented in each consumer stack.
- The high-level builder gives consumers a clean entry point while preserving the existing low-level escape hatch.

## Negative

- The LiteLLM package grows a second abstraction layer, which adds API surface area.
- Team-scoped aliases depend on LiteLLM semantics that Sector7 must keep validating against upstream behavior.
- There is some risk of overfitting to the current multi-team gateway use case if we do not keep the low-level surface available.

## Neutral

- Existing consumers can keep using the low-level deployment/model-group API.
- The builder is additive, not a breaking replacement.

# Alternatives

## Alternative A: keep billing names in model aliases

Example: `personal-coding`, `research-coding`.

Pros:

- no library refactor required
- easy to understand in one small deployment

Cons:

- caller-visible API leaks internal billing structure
- aliases become unstable when account structure changes
- every consumer repeats the same awkward naming policy

Decision: rejected.

## Alternative B: build the high-level builder only in a consumer repo

Pros:

- fast for one consumer
- fewer immediate upstream changes

Cons:

- duplicates logic outside Sector7
- keeps team/key lifecycle split across repos
- locks the reusable library at the wrong abstraction level

Decision: rejected.

## Alternative C: replace the low-level API entirely with a high-level one

Pros:

- one clean opinionated surface

Cons:

- throws away useful escape hatches
- too risky while LiteLLM integration is still evolving
- makes advanced or unusual topologies harder to express

Decision: rejected.

# Security / Privacy / Compliance

- Provider API keys MUST stay out of generated ConfigMaps.
- Internal upstreams without provider API keys SHOULD not force dummy secrets into Kubernetes.
- Team and key management helpers SHOULD treat generated keys as secret outputs.
- This decision introduces more admin-surface automation, so request/response payloads SHOULD avoid logging raw credentials.

# Operational Notes

- Shared aliases improve operator ergonomics because keys and teams can change routing without changing clients.
- The high-level builder SHOULD generate deterministic internal names so fallbacks and diffs are reviewable.
- Internal OpenAI-compatible upstreams should prefer explicit `apiBase` configuration and no fake provider secret when authentication is handled elsewhere.
- Release validation for the LiteLLM subpath remains important because previous packaging drift broke the published artifact shape.

# Status Transitions

- This ADR amends ADR-026 in practice by defining the next abstraction layer above the original low-level proxy component.
- ADR-026 remains the foundational deployment ADR. This ADR narrows how the public LiteLLM API should evolve.

# Implementation Notes

- Add the team-scoped builder first, but keep it compiled to `LiteLLMModelGroup[]`.
- Make provider API keys optional before wiring internal upstream examples.
- Upstream the existing consumer-side key helper into Sector7 and add a parallel team helper.
- Add tests for shared alias generation, internal upstreams, and admin resource payloads.
- Update public Pulumi docs to describe both the low-level and high-level entry points.

# References

- [ADR-026: LiteLLM Proxy ComponentResource](./026-litellm-proxy-component.md)
- Sector7 issue tracking the refactor: https://github.com/jmmaloney4/sector7/issues/197
