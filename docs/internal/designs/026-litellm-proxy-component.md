---
id: ADR-026
title: LiteLLM Proxy ComponentResource
status: Proposed
date: 2026-05-14
deciders: [jmmaloney4]
consulted: []
tags: [design, adr, pulumi, kubernetes, litellm]
supersedes: []
superseded_by: []
links: []
---

# Context

We need a repeatable way to deploy and configure a LiteLLM proxy for small but growing teams of AI users. The immediate garden deployment already has the right basic shape:

- a Kubernetes Deployment running `ghcr.io/berriai/litellm-database:main-stable`
- a ConfigMap-mounted `config.yaml`
- provider API keys supplied through Kubernetes Secrets and environment variables
- Cloud SQL PostgreSQL for LiteLLM virtual keys, spend tracking, teams, and users
- an auto-generated master key
- optional Langfuse OTEL callbacks
- consumer virtual keys created through the LiteLLM API

The current garden stack is too project-specific to reuse cleanly. It embeds model YAML construction, Cloud SQL wiring, provider env vars, and key-generation behavior directly in one Pulumi program. That is fine for a bootstrap deployment, but it will get brittle as additional providers, semantic model groups, keys, budgets, and Redis coordination are added.

Sector7 is the right home for the reusable deployment abstraction because this is not garden-specific infrastructure. It is a general Pulumi component that can be used by garden, yard, or any future cluster that wants an OpenAI-compatible team gateway with managed routing, fallback, cost tracking, and virtual keys.

# Decision

Create a Sector7 `LiteLLMProxy` Pulumi `ComponentResource` behind a dedicated subpath export, not the main package barrel.

The component SHOULD own the LiteLLM proxy Kubernetes objects and config generation:

- Namespace, when requested
- provider-credential Secret
- runtime Secret for master key and database URL references
- ConfigMap containing generated `config.yaml`
- Deployment
- Service
- optional consumer virtual keys created through the LiteLLM API after the Deployment is ready

The component MUST NOT own garden-specific Cloud SQL creation. Database creation, private networking, and database password generation belong to the consuming stack or to a separate database component. `LiteLLMProxy` accepts `databaseUrl` as a secret input.

The component MUST keep provider API keys out of the generated ConfigMap. Provider deployments reference environment variables with LiteLLM's `os.environ/<ENV_VAR>` syntax. Pulumi passes the actual values through Kubernetes Secret-backed env vars.

The component SHOULD expose a typed domain model and generate LiteLLM `config.yaml` from it. It SHOULD NOT require consumers to hand-write YAML strings.

## Type token

`sector7:kubernetes:LiteLLMProxy`

## Package surface

Use a subpath export:

```ts
import { LiteLLMProxy } from "@jmmaloney4/sector7/litellm";
```

Do not export this through the root barrel. This component adds Kubernetes, random, command, and YAML serialization concerns that should not become transitive requirements for Cloudflare-only consumers.

Package wiring:

```json
{
  "exports": {
    "./litellm": {
      "types": "./dist/litellm/index.d.ts",
      "default": "./dist/litellm/index.js"
    }
  }
}
```

## Interface sketch

```ts
export interface LiteLLMProxyArgs {
  namespace?: pulumi.Input<string>;
  createNamespace?: pulumi.Input<boolean>;
  image?: pulumi.Input<string>;
  replicas?: pulumi.Input<number>;

  databaseUrl: pulumi.Input<string>;
  masterKey?: pulumi.Input<string>;

  providers: Record<string, LiteLLMProviderConfig>;
  deployments: LiteLLMModelDeployment[];
  modelGroups: LiteLLMModelGroup[];

  router?: LiteLLMRouterPolicy;
  governance?: LiteLLMGovernancePolicy;
  observability?: LiteLLMObservabilityPolicy;
  redis?: LiteLLMRedisPolicy;
  allowMultiReplicaWithoutRedis?: pulumi.Input<boolean>;

  keys?: Record<string, LiteLLMVirtualKeySpec>;

  service?: LiteLLMServiceSpec;
  resources?: k8s.types.input.core.v1.ResourceRequirements;
}

export interface LiteLLMProviderConfig {
  apiKey: pulumi.Input<string>;
  envVar?: pulumi.Input<string>;
  apiBase?: pulumi.Input<string>;
}

export interface LiteLLMModelDeployment {
  id: string;
  provider: string;
  providerModel: string;
  apiBase?: pulumi.Input<string>;
  mode?: "chat" | "completion" | "embedding" | "image_generation" | "audio_transcription" | "audio_speech" | "rerank";
  baseModel?: string;
  accessGroups?: string[];
  rpm?: number;
  tpm?: number;
  rpd?: number;
  tpd?: number;
  weight?: number;
  order?: number;
  maxInputTokens?: number;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
}

export interface LiteLLMModelGroup {
  name: string;
  deploymentIds: string[];
  fallbacks?: string[];
  contextWindowFallbacks?: string[];
  accessGroups?: string[];
}

export interface LiteLLMVirtualKeySpec {
  key?: pulumi.Input<string>;
  models?: pulumi.Input<pulumi.Input<string>[]>;
  teamId?: pulumi.Input<string>;
  userId?: pulumi.Input<string>;
  maxBudget?: pulumi.Input<number>;
  budgetDuration?: pulumi.Input<string>;
  rpmLimit?: pulumi.Input<number>;
  tpmLimit?: pulumi.Input<number>;
  metadata?: pulumi.Input<Record<string, string>>;
  duration?: pulumi.Input<string>;
}
```

Concrete names can change during implementation. The important design point is the separation between:

- provider credentials
- provider model deployments
- client-facing model groups
- router policy
- governance policy
- generated virtual keys

## Generated LiteLLM configuration

The component should generate one ConfigMap entry, `config.yaml`, from a structured object.

The generated config should include:

```yaml
model_list:
  - model_name: smart
    litellm_params:
      model: anthropic/claude-sonnet-4-20250514
      api_key: os.environ/ANTHROPIC_API_KEY
      rpm: 500
      tpm: 200000
    model_info:
      id: anthropic-sonnet-smart
      base_model: anthropic/claude-sonnet-4-20250514
      access_groups: [core, premium]
      mode: chat
      max_input_tokens: 200000

litellm_settings:
  drop_params: true
  turn_off_message_logging: true
  redact_user_api_key_info: true
  request_timeout: 120
  success_callback: [prometheus]
  failure_callback: [prometheus]

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL
  enforce_user_param: true
  token_rate_limit_type: total
  database_connection_pool_limit: 10
  allow_requests_on_db_unavailable: false

router_settings:
  routing_strategy: cost-based-routing
  enable_pre_call_checks: true
  allowed_fails: 3
  cooldown_time: 30
  num_retries: 2
  retry_policy:
    RateLimitErrorRetries: 3
    InternalServerErrorRetries: 2
    TimeoutErrorRetries: 1
    AuthenticationErrorRetries: 0
  fallbacks:
    - smart: [coding, fast]
  context_window_fallbacks:
    - smart: [long-context]
  default_fallbacks: [smart]
```

The component should use a YAML serializer rather than hand-concatenating strings. Add a small runtime dependency such as `yaml` to the package if needed.

## Default model taxonomy

The component should make semantic model groups easy, but it should not bake in Jack-specific providers or model names.

Recommended consumer-facing groups:

- `smart`: best general reasoning
- `coding`: code-heavy work
- `fast`: low-latency agent loops and everyday chat
- `cheap`: summarization, extraction, classification, and test traffic
- `long-context`: large context windows
- `embedding`: embedding models

Consumers can define any names. The component should only validate references and generate the LiteLLM shape.

## Routing policy

Default policy should optimize for cost with explicit reliability behavior:

- `routing_strategy: cost-based-routing`
- `enable_pre_call_checks: true`
- `allowed_fails: 3`
- `cooldown_time: 30`
- `num_retries: 2`
- retry rate limits and 5xx errors
- do not retry authentication errors
- model-group fallbacks
- context-window fallbacks
- optional `default_fallbacks`

Rationale:

- LiteLLM's `simple-shuffle` is the low-latency production recommendation, but this component is aimed at teams that explicitly want fallback and cost optimization across providers.
- Cost-sensitive groups should prefer `cost-based-routing`.
- Latency-sensitive groups can be modeled as separate model groups such as `fast`; if LiteLLM version support for `routing_groups` is confirmed, the component can expose per-group strategies later.
- Authentication errors should fail loudly. Retrying bad credentials hides a deployment problem.

## Redis behavior

The component should support Redis but not require it for a single-replica deployment.

Rules:

- If `replicas > 1`, Redis SHOULD be required unless `allowMultiReplicaWithoutRedis` is explicitly set.
- Redis-backed `cache_params` should be used for multi-instance cooldown and rate-limit coordination.
- `cache_params.supported_call_types: []` should be the default so Redis coordinates proxy state without enabling response caching by accident.
- `general_settings.use_redis_transaction_buffer: true` should be opt-in. LiteLLM documents it as mandatory for very high RPS or many instances; it is not needed for an initial 1-3 replica deployment unless deadlocks are observed.

## Virtual keys

The component may manage virtual keys, but the key-management implementation should be isolated.

Initial implementation can use the existing pattern from garden:

1. Generate a key in Pulumi when `key` is not provided.
2. Register it with LiteLLM via `/key/generate` after the Deployment is ready.
3. Store the generated key as a Pulumi secret output.
4. Delete the key by token hash on destroy/replacement.

The helper must build JSON with a real JSON encoder, not shell `printf`. Key aliases and metadata can contain quotes. A TypeScript command wrapper (using `@pulumi/command`) is preferred to avoid requiring Python in the runtime environment.

Virtual key creation is operationally useful but it increases the component's side effects. If implementation gets too large, split it into two resources:

- `LiteLLMProxy`: Deployment and config
- `LiteLLMVirtualKey`: key registration against an existing proxy

# Consequences

## Positive

- Garden's LiteLLM stack becomes mostly configuration instead of bespoke deployment code.
- Other repos can reuse the same gateway pattern without copying a Pulumi stack.
- Semantic model groups and fallback policy become typed and reviewable.
- Provider secrets stay out of ConfigMaps and Pulumi previews.
- The component can enforce hard-won validation before `pulumi up` reaches Kubernetes.
- Sector7 gains a useful Kubernetes deployment component, not just Cloudflare/Nix utilities.

## Negative

- Sector7 gains Kubernetes dependencies in a new subpath export.
- The component spans several concerns: Deployment, config generation, secrets, and optional API-side key registration.
- LiteLLM config settings move fast. The component must avoid over-modeling every upstream knob or it will become stale.
- Generated virtual keys require imperative API calls after deploy. That is less clean than Kubernetes-only resources, but LiteLLM exposes keys through its database-backed API, not Kubernetes objects.

# Alternatives

## Keep LiteLLM deployment only in garden

Simpler today, but repeats the same mistakes as the bootstrap stack: handwritten YAML, project-specific provider handling, and no reusable validation. This is acceptable for a spike, not for the stable pattern.

## Put only the YAML generator in Sector7

This avoids Kubernetes dependencies, but it leaves every consumer to wire ConfigMaps, Secrets, Deployment args, probes, and Service objects by hand. The deployment mechanics are part of the value. A partial helper would invite inconsistent production setups.

## Helm chart wrapper

LiteLLM has deployment examples and charts, but a Helm wrapper does not solve the main problem: typed model groups, provider-secret mapping, key generation, and Pulumi-native outputs. It also makes validation harder because values are passed into a chart boundary.

## Dynamic provider for the whole proxy

Wrong abstraction. Kubernetes resources should stay Kubernetes resources. Only the LiteLLM API-side key registration needs imperative behavior.

# Security / Privacy / Compliance

- Provider API keys MUST be Kubernetes Secret values and MUST NOT appear in generated `config.yaml`.
- `databaseUrl` and `masterKey` MUST be treated as Pulumi secrets and mounted through env vars.
- The default generated config SHOULD set `turn_off_message_logging: true` and `redact_user_api_key_info: true`.
- Langfuse or other callbacks that store prompts/responses MUST be explicit opt-in.
- `allow_requests_on_db_unavailable` should default to false. Allowing requests when the DB is unavailable weakens key verification and should only be used in tightly controlled private networks.
- Consumer virtual keys should support budgets, RPM/TPM limits, model access groups, and expirations.

# Operational Notes

- Liveness probe: `GET /health/liveliness`.
- Readiness probe: `GET /health/readiness`.
- Service port: 4000.
- Use the `litellm-database` image variant when `DATABASE_URL` is set; it includes Prisma and migration tooling.
- Start with resource limits around the known garden shape: requests `250m` CPU / `512Mi` memory, limits `1` CPU / `2Gi` memory. The 2Gi limit avoids early OOMKilled startup failures while Prisma and LiteLLM initialize.
- Emit useful outputs:
  - `proxyUrl`
  - `namespace`
  - `serviceName`
  - `masterKey`
  - virtual key outputs
  - generated model names
- Provide a generated smoke-test command or script in docs:
  - health check
  - `/v1/models`
  - one cheap request
  - one smart request
  - forced fallback request using LiteLLM's `mock_testing_fallbacks`

# Status Transitions

- 2026-05-14: Proposed after extracting the garden LiteLLM config design into Sector7.

# Implementation Notes

Proposed file layout:

```text
packages/sector7/litellm/
  config.ts
  config-types.ts
  index.ts
  litellm-proxy.ts
  litellm-virtual-key.ts
packages/sector7/scripts/
  litellm-key.sh
packages/sector7/tests/
  litellm-config.test.ts
  litellm-proxy.test.ts
  litellm-virtual-key.test.ts
```

Validation should reject:

- duplicate deployment IDs
- model groups that reference missing deployment IDs
- fallbacks that reference missing model groups
- deployments that reference missing providers
- provider env var name collisions
- `replicas > 1` without Redis, unless explicitly overridden
- `databaseUrl` or provider API keys appearing in generated config text

Implementation sequence:

1. Add the ADR and keep the garden note out of garden.
2. Add config types and pure config generator tests.
3. Add `LiteLLMProxy` with Namespace, Secret, ConfigMap, Deployment, and Service tests using Pulumi mocks.
4. Add `LiteLLMVirtualKey` or key support after the Deployment path is stable.
5. Migrate garden's `deploy/services/litellm` stack to use the Sector7 component.
6. Fix garden's current `DATABASE_URL` construction during migration. The bootstrap stack has used a literal `***` placeholder in the connection string; the migrated code must use the real password value in the secret.

# References

- LiteLLM routing docs: https://docs.litellm.ai/docs/routing
- LiteLLM proxy docs: https://docs.litellm.ai/docs/simple_proxy
- LiteLLM config management: https://docs.litellm.ai/docs/proxy/config_management
- LiteLLM config settings: https://docs.litellm.ai/docs/proxy/config_settings
- LiteLLM DB deadlocks / HA setup: https://docs.litellm.ai/docs/proxy/db_deadlocks
- LiteLLM router architecture: https://docs.litellm.ai/docs/router_architecture
- LiteLLM user hierarchy: https://docs.litellm.ai/docs/proxy/user_management_heirarchy
- LiteLLM virtual keys: https://docs.litellm.ai/docs/proxy/virtual_keys
- LiteLLM users, budgets, and rate limits: https://docs.litellm.ai/docs/proxy/users
