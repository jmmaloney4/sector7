---
id: ADR-032
title: Attic Cache and Token Dynamic Resources
status: Proposed
date: 2026-06-10
deciders: [jmmaloney4]
consulted: []
tags: [design, adr, pulumi, kubernetes, attic, nix, cache, secrets]
supersedes: []
superseded_by: []
links:
  - garden ADR 046 (docs/internal/decisions/046-nix-binary-cache-attic.md)
  - garden ADR 071 (docs/internal/decisions/071-attic-ci-cache-contract.md)
  - sector7 ADR-026 (LiteLLM Proxy ComponentResource)
  - sector7#258 (LiteLLM Team/ApiKey as dynamic resources)
  - sector7 ADR-031 (OnePassword Item Write Resource)
---

# Context

garden runs an [Attic](https://github.com/zhaofengli/attic) Nix binary cache
(garden `deploy/services/attic/`, ADR 046): a Deployment of
`ghcr.io/zhaofengli/attic` backed by Cloud SQL Postgres and Cloudflare R2, fronted
by a `ClusterIP` Service (port `80` → container `8080`) plus a Tailscale ingress.

Today the cache and its CI token are provisioned by two
`@pulumi/command` `local.Command` shells (garden `deploy/services/attic/index.ts`):

- **`attic-cache-bootstrap`** waits for the rollout, `kubectl exec … atticadm make-token` to mint an ephemeral admin token, `kubectl port-forward`, then
  `curl POST /_api/v1/cache-config/cache` to create one hardcoded cache named
  `cache`, scraping `.public_key` out of the response. It special-cases a `400 CacheAlreadyExists` to stay idempotent.
- **`attic-ci-token`** runs `kubectl exec … atticadm make-token --validity 1y --pull cache --push cache` and exports the result as a secret stack output.

This is the same place the garden LiteLLM stack was before sector7#258: imperative
shells, **one** hardcoded cache, **one** token, no update path, no multi-cache or
multi-consumer story, and a dependency on `atticadm`/`kubectl` being present and on
shelling out from the deployer. Adding a second cache, or a per-consumer token with
a narrower scope, means hand-writing more `local.Command` blocks.

sector7#258 (ADR-026) replaced the analogous LiteLLM shells with first-class
`pulumi.dynamic` resources (`LiteLLMTeam`, `LiteLLMApiKey`) that reach the admin
API over a short-lived **in-process Kubernetes port-forward**
(`packages/sector7/k8s/port-forward.ts`), with a full
`check`/`diff`/`create`/`update`/`delete` lifecycle, idempotent adoption, and
secret-typed outputs. Dynamic resources are a **house pattern** here
(`r2/r2object.ts`, `d1/d1-query.ts`, `litellm/admin.ts`,
`onepassword/item.ts` per ADR-031). We want the same treatment for Attic.

## What makes Attic different from LiteLLM

Attic's control plane has two halves with **different transports**, verified
against upstream (`zhaofengli/attic`):

1. **Caches are server state.** Created/configured/destroyed over an HTTP API:
   `GET/POST/PATCH/DELETE /_api/v1/cache-config/{cache}`. POST body is
   `CreateCacheRequest { keypair, is_public, store_dir, priority, upstream_cache_key_names }`; GET/PATCH use `CacheConfig` (adds
   `public_key`, `retention_period`). Each method is gated on a permission from
   the caller's bearer token (`create_cache` for POST, `configure_cache` for
   PATCH, `configure_cache_retention` for retention changes, `destroy_cache` for
   DELETE, `pull` for GET). This half needs the **port-forward** transport, exactly
   like LiteLLM.

2. **Tokens are stateless JWTs — there is no token API.** Attic auth is a
   self-contained HS256 JWT signed with the server's shared secret
   (`ATTIC_SERVER_TOKEN_HS256_SECRET_BASE64`). `atticadm make-token` mints these
   **locally/offline** from the secret; the server only *verifies* the signature on
   each request and never stores tokens. The claim that carries authorization is a
   custom namespace `https://jwt.attic.rs/v1` holding a `caches` map of
   cache-name-pattern → permission flags (`r` pull, `w` push, `d` delete, `cc`
   create-cache, `cr` configure-cache, `cq` configure-cache-retention, `cd`
   destroy-cache); patterns support `*` wildcards with exact-match-wins,
   default-deny lookup. The HMAC key is the **base64-decoded** secret bytes.

Consequence (2) is the crux: **minting an Attic token needs no server and no
port-forward** — just the HS256 secret and a JWT signer. That makes the token
resource *simpler* than LiteLLM's DB-backed `ApiKey`, but it also means a token
**cannot be individually revoked**: the only ways to invalidate one are to let its
`exp` lapse or to rotate the shared secret (which invalidates *every* token).

**In scope:** two reusable sector7 dynamic resources — `AtticCache` (cache-config
HTTP API over the in-process port-forward) and `AtticToken` (local HS256 JWT mint)
— a pure JWT-minting helper, the `./attic` subpath export, and tests.

**Out of scope:** the garden consumer rewrite (garden's attic stack swapping its two
`local.Command`s for these resources — a follow-up in garden); provisioning the
HS256 secret (the consuming stack already generates it via `random.RandomBytes`);
the cache's storage/DB IaC (R2 bucket, Cloud SQL — unchanged, and one R2 bucket
backs all caches since Attic namespaces internally); a token *renewal* loop (see
Consequences).

# Decision

Add a `attic` module to sector7 exposing two Pulumi **dynamic resources**:
`AtticCache` and `AtticToken`.

## Type tokens & package surface

- `sector7:attic:Cache`
- `sector7:attic:Token`

Subpath export (not the root barrel — `AtticCache` pulls in
`@kubernetes/client-node` via the shared transport), mirroring `./litellm` and
`./onepassword`:

```ts
import { AtticCache, AtticToken } from "@jmmaloney4/sector7/attic";
```

Package wiring adds `exports["./attic"]` → `./dist/attic/index.d.ts` / `index.js`.

## AtticToken — local HS256 JWT (`sector7:attic:Token`)

A first-class resource whose output is a signed Attic token.

- **Inputs:** `hs256SecretBase64` (secret), `sub`, `validity` (a duration string —
  `1y`, `90d`, `12h`, or bare seconds), and `caches`: a map of cache-name pattern →
  permission flags (`pull`/`push`/`delete`/`createCache`/`configureCache`/
  `configureCacheRetention`/`destroyCache`). Cache names are plain string keys
  (Pulumi cannot key an object on an `Output`); they are normally the same literals
  passed to `AtticCache`, or wildcards like `*`.
- **`create()`** mints the JWT in-process (`node:crypto` HMAC-SHA256 over the
  base64-decoded secret): payload `{ sub, nbf, exp, "https://jwt.attic.rs/v1": { caches } }`, with `exp = now + validity` and `nbf = now` baked at create. It
  returns a **random opaque id** (`crypto.randomUUID()`) as the Pulumi resource id —
  **never** the token value, which is a bearer credential and would otherwise sit in
  plaintext state. The token, `sub`, `expiresAt`, and `notBefore` are outputs; the
  token is a **secret** output.
- **`diff()`** treats every meaningful input change (`hs256SecretBase64`, `sub`,
  `validity`, `caches`) as a **replacement** — a signed JWT is immutable, so a
  changed claim means a new token. `caches` is compared order-insensitively. The
  baked `exp`/`nbf`/token outputs are state, not inputs, so a no-op `pulumi up` does
  **not** churn the token. `deleteBeforeReplace: false` (the old token can't be
  revoked anyway, so mint-then-replace avoids a credential gap).
- **`delete()`** is a **no-op** with a logged note: a stateless JWT has no
  server-side record to remove. Genuine revocation is secret rotation (mass) or
  expiry.
- No port-forward, no cluster contact. Imports stay lazy (`await import("node:crypto")`)
  to honor the closure-serialization contract.

## AtticCache — cache-config API over port-forward (`sector7:attic:Cache`)

Mirrors `LiteLLMTeam`: a `ComponentResource` wrapping a dynamic resource with full
lifecycle, reached over the shared `withPortForward` transport.

- **Admin target:** `{ namespace, deploymentName (default "attic"), port (default 8080), hs256SecretBase64 }`. The resource **mints its own short-lived admin
  token** in-process from the HS256 secret (validity ~5 min, scoped to *this* cache
  name with only the permissions the operation needs — `cc`+`cr`+`cq`+`r` for
  create/update, `cd`+`r` for delete) rather than requiring the caller to pass a
  pre-minted admin token. So the consumer provides only the secret, and the same
  secret powers both resources.
- **Inputs:** `cacheName`, `isPublic` (default `true`), `priority` (default `0`),
  `storeDir` (default `/nix/store`), `upstreamCacheKeyNames` (default `[]`),
  `retentionPeriodSeconds` (optional → server default / `Global` when unset).
  `keypair` is always `Generate` (server generates and stores the signing keypair;
  we surface the public key).
- **`create()`** is **find-or-create**: `POST /_api/v1/cache-config/{name}`; on
  `400 CacheAlreadyExists`, **adopt** by `PATCH`-reconciling config and `GET`-ing
  the current state — the same idempotency the bootstrap shell relies on. Since
  `CreateCacheRequest` has no `retention_period` field, a requested retention is
  applied by a follow-up `PATCH`. Output: `publicKey` (non-secret signing key),
  echoed config.
- **`diff()`** routes config changes (`isPublic`, `priority`,
  `upstreamCacheKeyNames`, `retentionPeriodSeconds`) to an **in-place** `PATCH`;
  reserves **replacement** for `cacheName` (a different cache) and `storeDir`
  (cache identity); and treats admin-target changes (`namespace`/`deploymentName`/
  `port`/`hs256SecretBase64`) as in-place so a later update/delete re-targets the
  new deployment and re-mints under the new secret (the `adminTargetChanged`
  pattern from #258).
- **`update()`** `PATCH`es changed fields and re-reads `publicKey`.
- **`delete()`** `DELETE`s the cache (soft/hard per the server's
  `soft_delete_caches`). Callers wanting the cache to outlive the stack use
  `pulumi.RetainOnDelete`.
- All `@kubernetes/client-node` / `node:net` / `node:crypto` imports are lazy inside
  the callbacks (the serialization rule documented in `k8s/port-forward.ts`).

## Shared JWT helper

A pure `mintAtticToken({ secretBase64, sub, issuedAtSeconds, expiresAtSeconds, caches })` in `attic/token.ts`, used by both resources (`AtticToken` for the
consumer token, `AtticCache` for its ephemeral admin token). It carries the same
**serialization contract** as `k8s/port-forward.ts`: no top-level runtime imports;
`node:crypto` is imported lazily inside the function. It emits the minimal claim set
`atticadm` produces (`sub`, `nbf`, `exp`, the namespace claim with only the
true permission flags) — no `iss`/`aud`/`iat`, which Attic does not require unless
the server is configured with a bound issuer/audience (it is not).

## Tests

Mirror `tests/litellm-admin.test.ts`: mock `@pulumi/pulumi`, the transport, and
`fetch`. Assert `AtticCache` `diff` (in-place config change vs replace on
`cacheName`/`storeDir` vs in-place on admin-target change), `create` (new vs adopt
on `CacheAlreadyExists`), `update`, and `delete`. For `AtticToken`, assert that a
minted JWT verifies against the secret with the expected header/claims/permission
short-keys, that all input changes are replacements, and that `delete` is a no-op.

# Consequences

## Positive

- Declarative **multi-cache** creation, config reconciliation, and **per-consumer**
  scoped tokens — replacing two hardcoded, single-cache/single-token shells with
  typed resources that have a real `diff`/`update` path.
- **Reuses** the #258 in-process port-forward transport: no new cluster ingress,
  the call rides the apiserver the deployer already authenticates to (consistent
  with garden ADR 046's `ClusterIP`-only posture; the Tailscale ingress is for
  clients, not for IaC).
- The token half is **simpler than LiteLLM's** — no server round-trip, no
  port-forward — because Attic tokens are stateless. One secret drives both
  resources.
- Permission model maps cleanly to typed flags + wildcard patterns; least-privilege
  per-consumer tokens become trivial to express.
- Drops the deploy-time dependency on `atticadm`/`kubectl` shelling out.

## Negative

- **Tokens cannot be individually revoked.** A leaked or over-scoped token is live
  until `exp`; the only revocation is rotating the shared HS256 secret, which
  invalidates **all** tokens at once. Mitigations: short `validity` where feasible,
  least-privilege `caches` scopes, and `RetainOnDelete`-free deletion that at least
  stops *issuing* it. This is an inherent property of Attic's stateless-JWT design,
  not of this resource.
- **`exp` is baked at create and does not auto-renew.** A long-lived token (e.g.
  a 1y CI token) silently lapses with no input change to trigger re-mint — same
  behavior as today's `atticadm --validity 1y` shell. Renewal is manual (`pulumi up --replace`) or a future `renewBefore` knob; out of scope here.
- Net-new code (two providers + a JWT signer) and the closure-serialization
  constraint, plus a hand-rolled HS256 JWT (no `jose`/`jsonwebtoken` dependency —
  HS256 is a 3-line `node:crypto` HMAC, and avoiding a dep keeps the provider
  closure small and serializable).
- The `KeypairConfig`/`RetentionPeriodConfig` enum **wire formats** (`"Generate"`
  vs `{ "Keypair": … }`; `"Global"` vs `{ "Period": n }`) are externally-tagged
  serde enums confirmed from source but not byte-verified against a live response;
  implementation MUST validate with one live create→get round-trip (the existing
  bootstrap already proves the create body).

# Alternatives

- **Keep the `local.Command` shells.** Status quo: no update path, single
  cache/token, depends on `atticadm`/`kubectl` at deploy time, and every new cache
  or scoped token is another bespoke shell. Rejected — this is exactly what #258
  moved LiteLLM away from.
- **A garden-local dynamic provider** (don't put it in sector7). Would copy #258's
  transport and the JWT helper rather than reuse them and wouldn't be available to
  other clusters/repos. Rejected, consistent with ADR-031.
- **`AtticToken` mints inline in a `ComponentResource` via `pulumi.all().apply()`
  instead of a dynamic resource.** Signing is pure, so this seems tempting — but an
  `apply` recomputes every run, and baking `exp` from "now" inside an apply would
  change the token on every `pulumi up` (perpetual diff). A dynamic resource
  persists `exp`/token in state and only re-mints on a real input change. Rejected.
- **`AtticCache` requires the caller to pass a pre-minted admin token** instead of
  minting one from the secret. More explicit, but it pushes the JWT-minting burden
  onto every consumer and means handling two secret-ish inputs. Rejected in favor of
  "give the resource the secret, it mints what it needs"; a pre-minted-token input
  MAY be added later for a stack that wants to withhold the raw secret from the
  cache resource.
- **Add `jose`/`jsonwebtoken`.** Unnecessary for HS256; a runtime dep complicates
  the closure serialization the providers depend on. Rejected.

# Security / Privacy / Compliance

- **HS256 secret** is the root credential for the whole cache: anyone holding it can
  mint a `*`-scoped admin token. It MUST be a Pulumi secret end to end and is the
  same secret the cache server already runs on. Both resources treat it as secret on
  input; it is never an output.
- **Minted tokens are bearer credentials** — `AtticToken.token` is a **secret**
  output; the resource **id** is a random UUID, never the token, so the credential
  never lands in plaintext state or in logs.
- **Least privilege:** consumer tokens SHOULD carry the narrowest `caches` scope and
  shortest `validity` that works (e.g. CI: `pull`+`push` on the one cache, not `*`).
  `AtticCache`'s self-minted admin token is scoped to the single target cache and
  the operation's permissions, with ~5-min validity.
- **No new network exposure** — the cache-config calls tunnel through the apiserver;
  Attic's `ClusterIP` + Tailscale-client posture (ADR 046) is unchanged.
- **Revocation caveat** (above) is a compliance-relevant limitation: document that
  token rotation is all-or-nothing via the shared secret.

# Operational Notes

- `AtticCache` runs require apiserver reachability and a **ready Attic pod** at
  deploy time; surface a clear error if the port-forward can't bind or the rollout
  is unready (the transport already distinguishes "no ready pod").
- The port-forward is **short-lived per operation** and torn down after.
- Idempotent adoption (`CacheAlreadyExists` → reconcile) makes cutover from the
  bootstrap-created `cache` safe: importing/adopting the existing cache MUST NOT
  regenerate its keypair (POST is create-only; adoption goes through GET/PATCH, so
  the signing key — and thus every client's `trusted-public-keys` — is preserved).
- Default `port` is `8080` (Attic's container listen port; garden's Service maps
  `80 → 8080`, but the port-forward targets the **pod** port).

# Status Transitions

- New design; does not supersede an existing ADR. Reuses the transport pattern from
  sector7#258 (ADR-026) and the dynamic-resource/subpath-export precedent from
  ADR-031. garden ADR 046/071 remain the cache's deployment and CI-contract
  decisions; this ADR only changes *how* caches and tokens are provisioned.

# Implementation Notes

- Add `packages/sector7/attic/{token.ts,config-types.ts,admin.ts,index.ts}` and the
  `./attic` subpath export (mirror ADR-026 / ADR-031 wiring).
- `token.ts`: pure `mintAtticToken` + `parseDurationSeconds`, lazy `node:crypto`,
  no top-level runtime imports (serialization contract).
- `admin.ts`: `AtticCache` + `AtticToken` providers reusing `withPortForward`
  (cache only) and `mintAtticToken` (both).
- Validate the `KeypairConfig`/`RetentionPeriodConfig` wire format with one live
  create→get against the deployed cache before relying on retention.
- Add `tests/attic.test.ts` mirroring `litellm-admin.test.ts`.
- First consumer and acceptance (follow-up, garden): garden's
  `deploy/services/attic/index.ts` replaces `attic-cache-bootstrap` /
  `attic-ci-token` with `AtticCache` + `AtticToken`, preserving the existing
  `cache` cache's keypair via adoption.

# References

- garden ADR 046 — `docs/internal/decisions/046-nix-binary-cache-attic.md`
- garden ADR 071 — `docs/internal/decisions/071-attic-ci-cache-contract.md`
- sector7#258 / ADR-026 — LiteLLM Team/ApiKey dynamic resources, in-process
  port-forward transport (`packages/sector7/litellm/admin.ts`,
  `packages/sector7/k8s/port-forward.ts`)
- sector7 ADR-031 — OnePassword Item Write Resource (dynamic-resource + subpath
  precedent)
- Attic source — `token/src/lib.rs` (claims, `CachePermission`, HS256 secret
  decode), `server/src/api/v1/cache_config.rs` (cache-config handlers + per-method
  permissions), `attic/src/api/v1/cache_config.rs` (`CreateCacheRequest`,
  `CacheConfig`, `KeypairConfig`, `RetentionPeriodConfig`), `attic/src/cache.rs`
  (`CacheName`/`CacheNamePattern` wildcards)
