---
id: ADR-027
title: Cloud SQL Auth Proxy Sidecar ComponentResource
status: Proposed
date: 2026-05-22
deciders: [jmmaloney4]
consulted: []
tags: [design, adr, pulumi, kubernetes, gcp, cloudsql]
supersedes: []
superseded_by: []
links: [ADR-026]
---

# Context

Sector7 already contains one embedded Cloud SQL Auth Proxy sidecar implementation inside `packages/sector7/litellm/litellm-proxy.ts`. Garden now has a second implementation in `deploy/services/attic/index.ts`.

Those two implementations overlap on the same core behavior:

- run `cloud-sql-proxy` as a sidecar in the same pod as the application
- rewrite the application `DATABASE_URL` from a Cloud SQL host to `127.0.0.1:<proxyPort>`
- disable local-hop SSL because the proxy handles TLS to Cloud SQL
- optionally mount a GCP service account key as `credentials.json`
- apply small default CPU and memory requests for the proxy container
- harden the sidecar with `runAsNonRoot` and no privilege escalation

The implementations differ in important ways:

- `packages/sector7/litellm/litellm-proxy.ts` owns only the sidecar fragment and optional Kubernetes secret. It does not create the GCP service account, IAM membership, or service account key.
- `deploy/services/attic/index.ts` owns the full chain: GCP service account, `roles/cloudsql.client`, service account key, Kubernetes secret, and sidecar injection.
- `deploy/services/litellm/cloud-sql.ts` in garden still contains an older standalone proxy `Deployment` + `Service` pattern rather than the in-pod sidecar used by the reusable Sector7 `LiteLLMProxy`.

This is the wrong layering.

The reusable concern is not "LiteLLM needs Cloud SQL" and it is not "Attic needs Cloud SQL." The reusable concern is: "a Kubernetes workload outside the Cloud SQL VPC needs a pod-local Cloud SQL Auth Proxy sidecar and optional GCP credential resources."

That concern belongs in Sector7, not duplicated inside product stacks.

In scope for this ADR:

- a reusable Sector7 component for the sidecar pattern
- the interface boundary between GCP identity resources and Kubernetes pod wiring
- migration of `LiteLLMProxy` and garden attic to consume the shared component

Out of scope for this ADR:

- Cloud SQL database, user, or password creation
- application-specific bootstrap commands like attic cache provisioning
- the legacy standalone proxy `Deployment` + `Service` pattern in `deploy/services/litellm/cloud-sql.ts`
- general mutation of arbitrary third-party Deployments already created outside Sector7 ownership

# Decision

Create a dedicated Sector7 subpath export for a reusable Cloud SQL Auth Proxy sidecar component.

The component SHOULD live under a new package subpath:

```ts
import { CloudSqlAuthProxySidecar } from "@jmmaloney4/sector7/cloudsql";
```

It MUST NOT be exported through the root `packages/sector7/index.ts` barrel. This is a Kubernetes + GCP-specific surface with a heavier dependency closure than Cloudflare- or Nix-only consumers should inherit.

## Type token

`sector7:cloudsql:AuthProxySidecar`

## Ownership boundary

`CloudSqlAuthProxySidecar` MUST own only the reusable sidecar-related resources and outputs:

- optional GCP service account
- optional `roles/cloudsql.client` membership
- optional service account key
- optional Kubernetes secret containing `credentials.json`
- generated sidecar container spec
- generated pod volumes needed by that sidecar
- rewritten proxy-local database URL

It MUST NOT own:

- the application `Deployment`
- the application `Service`
- Cloud SQL database or user creation
- application runtime secrets other than the optional proxy credential secret
- standalone proxy `Deployment` + `Service` mode

This component is an attachment/composition component, not a whole application component.

## Interface sketch

```ts
export interface CloudSqlAuthProxySidecarArgs {
  connectionName: pulumi.Input<string>; // project:region:instance

  databaseUrl?: pulumi.Input<string>;   // optional; rewritten when provided
  proxyPort?: pulumi.Input<number>;     // default 5432
  image?: pulumi.Input<string>;         // default gcr.io/cloud-sql-connectors/cloud-sql-proxy:2
  extraArgs?: pulumi.Input<pulumi.Input<string>[]>;
  resources?: k8s.types.input.core.v1.ResourceRequirements;

  kubernetes?: {
    namespace?: pulumi.Input<string>;
    provider?: k8s.Provider;
    existingServiceAccountKeySecretName?: pulumi.Input<string>;
    secretName?: pulumi.Input<string>;
  };

  credentials?:
    | {
        mode: "existing-secret";
        secretName: pulumi.Input<string>;
      }
    | {
        mode: "inline-key";
        serviceAccountKey: pulumi.Input<string>;
      }
    | {
        mode: "managed-key";
        project: pulumi.Input<string>;
        accountId: pulumi.Input<string>;
        displayName?: pulumi.Input<string>;
      }
    | {
        mode: "ambient-iam";
      };
}

export class CloudSqlAuthProxySidecar extends pulumi.ComponentResource {
  readonly container: pulumi.Output<k8s.types.input.core.v1.Container>;
  readonly volumes: pulumi.Output<k8s.types.input.core.v1.Volume[]>;
  readonly rewrittenDatabaseUrl: pulumi.Output<string | undefined>;

  readonly credentialSecret?: k8s.core.v1.Secret;
  readonly serviceAccount?: gcp.serviceaccount.Account;
  readonly serviceAccountKey?: gcp.serviceaccount.Key;
  readonly cloudSqlClientMembership?: gcp.projects.IAMMember;
}
```

## Composition model

The component MUST be consumable from a parent-owned deployment.

The parent stack or parent component remains responsible for building the final pod template, for example:

```ts
const proxy = new CloudSqlAuthProxySidecar(`${name}-db-proxy`, {
  connectionName,
  databaseUrl,
  kubernetes: {
    namespace,
    provider,
  },
  credentials: {
    mode: "managed-key",
    project: gcpProject,
    accountId: `${name}-proxy`,
  },
}, { parent: this });

const deployment = new k8s.apps.v1.Deployment(`${name}-deployment`, {
  spec: {
    template: {
      spec: pulumi.all([proxy.container, proxy.volumes]).apply(([proxyContainer, proxyVolumes]) => ({
        volumes: [...baseVolumes, ...proxyVolumes],
        containers: [
          {
            ...appContainer,
            env: [
              ...(appContainer.env ?? []),
              { name: "DATABASE_URL", value: proxy.rewrittenDatabaseUrl },
            ],
          },
          proxyContainer,
        ],
      })),
    },
  },
}, { parent: this, provider, dependsOn: [proxy] });
```

This keeps Deployment ownership where it already belongs while centralizing the sidecar contract in one place.

## Required behavior

The component MUST:

- rewrite `databaseUrl` with the native `URL` class, not regex replacement
- force host `127.0.0.1`
- force port `proxyPort`
- force `sslmode=disable` for the local hop
- mount credentials at a stable path when a key-backed mode is selected
- default to `runAsNonRoot: true` and `allowPrivilegeEscalation: false`
- omit default readiness and liveness probes; localhost-bound sidecars MUST NOT ship pod-IP TCP probes
- provide sane default resource requests and limits when none are supplied

The component SHOULD:

- support both key-backed auth and ambient IAM / Workload Identity-style auth
- create the Kubernetes secret only when the selected credential mode needs it
- expose child resources so consuming stacks can depend on or inspect them directly

The component MAY later grow a separate standalone proxy mode, but that is not part of this ADR.

## Package layout

Add a new subpath rather than burying this under `litellm`:

```text
packages/sector7/
  cloudsql/
    auth-proxy-sidecar.ts
    index.ts
  tests/
    cloudsql-auth-proxy-sidecar.test.ts
```

Package exports:

```json
{
  "exports": {
    "./cloudsql": {
      "types": "./dist/cloudsql/index.d.ts",
      "default": "./dist/cloudsql/index.js"
    }
  }
}
```

`packages/sector7/litellm` should then import this component instead of carrying its own local helper functions for sidecar assembly.

# Consequences

## Positive

- One source of truth for Cloud SQL sidecar behavior across garden and future consumers.
- `LiteLLMProxy` gets smaller and more honest about its boundary: LiteLLM deployment logic stays in `litellm`; Cloud SQL proxy mechanics move to `cloudsql`.
- Garden attic can drop a substantial block of sidecar-specific plumbing from `deploy/services/attic/index.ts`.
- The GCP identity path becomes explicit instead of half-embedded in app stacks.
- Tests for URL rewrite, credential secret creation, and sidecar spec assembly move into Sector7 once instead of being re-proven ad hoc.

## Negative

- This introduces a second reusable layer next to `LiteLLMProxy`, so the public API surface of Sector7 grows.
- The component still cannot magically attach itself to arbitrary pre-existing Deployments; consumers must compose its outputs into pod specs they own.
- Credential-mode flexibility adds interface complexity, especially if we support both managed SA keys and ambient IAM in the first cut.
- We will still have one legacy standalone proxy pattern in garden until a later migration removes it.

# Alternatives

- Keep the duplicated logic in attic and LiteLLM.

  - Rejected. We already have drift: sidecar-only in Sector7 LiteLLM, full GCP + sidecar chain in attic, and a legacy standalone deployment in garden LiteLLM.

- Move the attic implementation into a plain helper function inside garden.

  - Rejected. The abstraction is cross-repo, not garden-local. A garden helper would still leave `LiteLLMProxy` carrying its own copy.

- Leave the logic inside `packages/sector7/litellm` and import it from attic.

  - Rejected. That inverts the dependency boundary. Attic is not a LiteLLM consumer. Cloud SQL sidecar mechanics should not live under a product-specific subpath.

- Create one giant `CloudSqlBackedService` component that owns database creation, IAM, sidecar wiring, runtime secret generation, and deployment creation.

  - Rejected. That is too coarse. Database ownership, app deployment ownership, and sidecar attachment are separate concerns with different reuse boundaries.

- Standardize on the standalone proxy `Deployment` + `Service` pattern instead of sidecars.

  - Rejected for this ADR. The requested extraction target is the sidecar pattern already used in Sector7 LiteLLM and now attic. Standalone mode can be revisited later if it proves broadly reusable.

# Security / Privacy / Compliance

- Service account keys are sensitive. The component MUST treat any inline or managed key output as secret Pulumi values and MUST place them only in Kubernetes Secrets, never ConfigMaps.
- The component SHOULD prefer `ambient-iam` where available, but MUST still support explicit key-backed auth for clusters without Workload Identity.
- The component MUST grant `roles/cloudsql.client` with `IAMMember`, not authoritative `IAMBinding`.
- The component MUST bind the proxy to `127.0.0.1` for sidecar mode. Binding `0.0.0.0` exposes the PostgreSQL listener on the pod IP for no benefit.
- The component MUST disable local-hop SSL in the rewritten URL. The proxy handles TLS to Cloud SQL; the in-pod client-to-proxy hop is plain TCP.

# Operational Notes

- Default image should track a v2 Cloud SQL Proxy release, but the image must stay overrideable.
- Migrations from in-place sidecar resources SHOULD use Pulumi aliases when child resources move under `CloudSqlAuthProxySidecar`, especially for existing LiteLLM credential `Secret` state.
- Consumers remain responsible for application rollout semantics. If a secret value derived from `rewrittenDatabaseUrl` changes, the owning Deployment still needs a pod-template change or explicit restart policy.
- Tests must cover both URL rewriting and the credential-mode matrix.
- The first migration targets should be:
  1. `packages/sector7/litellm/litellm-proxy.ts`
  2. `garden/deploy/services/attic/index.ts`
- `garden/deploy/services/litellm/cloud-sql.ts` should be audited separately because it still uses standalone proxy deployment/service mode rather than the sidecar pattern this ADR standardizes.

# Status Transitions

- This ADR depends on and refines ADR-026. ADR-026 said LiteLLM should not own garden-specific Cloud SQL creation and should accept `databaseUrl` as an input. This ADR sharpens that boundary further by moving the reusable proxy mechanics out of the `litellm` subpath entirely.
- If accepted and implemented, ADR-026 should be patched to reference `@jmmaloney4/sector7/cloudsql` as the home for the sidecar attachment abstraction.

# Implementation Notes

1. Add `packages/sector7/cloudsql/auth-proxy-sidecar.ts` and `packages/sector7/cloudsql/index.ts`.
2. Move `rewriteDatabaseUrlForProxy` out of `packages/sector7/litellm/litellm-proxy.ts` into the new module.
3. Move sidecar container assembly logic out of `LiteLLMProxy` into `CloudSqlAuthProxySidecar`.
4. Add tests for:
   - URL rewrite to `127.0.0.1:<proxyPort>?sslmode=disable`
   - inline-key mode
   - managed-key mode
   - ambient-iam mode
   - no pod-IP probes on localhost binding
5. Refactor `LiteLLMProxy` to consume the new component.
6. Refactor garden attic to consume the new component or mirror its interface until the garden stack upgrades to the released Sector7 version.
7. Later, decide whether the legacy standalone proxy pattern in garden LiteLLM should be deleted, migrated, or formalized as a separate component.

# References

- `packages/sector7/litellm/litellm-proxy.ts`
- `packages/sector7/litellm/config-types.ts`
- `packages/sector7/tests/litellm-proxy.test.ts`
- `garden/deploy/services/attic/index.ts`
- `garden/deploy/services/litellm/cloud-sql.ts`
- `docs/internal/designs/026-litellm-proxy-component.md`
