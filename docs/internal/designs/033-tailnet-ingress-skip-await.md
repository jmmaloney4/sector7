---
id: ADR-033
title: Skip Pulumi Readiness Check for Tailscale Ingress
status: Accepted
date: 2026-06-14
deciders: [jmmaloney4]
consulted: []
tags: [design, adr, pulumi, kubernetes, tailscale, ingress, gateway]
supersedes: []
superseded_by: []
links:
  - zeus ADR 125 (docs/internal/decisions/125-tailnet-service-exposure-via-envoy-gateway.md)
---

# Context

`createTailnetIngress` creates a Kubernetes `Ingress` resource with
`ingressClassName: tailscale` and a backend pointing at the private gateway
proxy Service. The Tailscale operator reconciles the Ingress asynchronously:
provisioning WireGuard tunnels, obtaining Let's Encrypt certificates via ACME
DNS-01, and populating `status.loadBalancer.ingress` with the tailnet FQDN.

Pulumi's k8s provider performs a readiness check after creating any `Ingress`
resource. The check polls in sequence:

1. **Backend Service endpoints** — `GET /api/v1/namespaces/<ns>/services/<svc>`
   and `GET /endpointslices` to verify the backend has ready endpoints.
2. **`status.loadBalancer.ingress`** — polls the Ingress status until the
   controller (Tailscale operator) populates the loadBalancer field.

Deploy identities in garden are deliberately scoped (zeus ADR 125). The
`pulumi-zeus` service account has a Role granting only
`networking.k8s.io/ingresses` CRUD in the `networking` namespace — no Services,
no Endpoints, no pods. This means step 1 fails with HTTP 403 on every poll. The
provider retries indefinitely and never reaches step 2.

Even with full RBAC, step 2 adds latency proportional to the Tailscale
operator's async reconciliation time (cert issuance, tunnel establishment) —
typically 30-60 seconds but potentially longer on first deploy. The deployer
gains no real safety from this wait: the operator will reconcile regardless of
whether Pulumi blocks, and if the operator is broken, Pulumi will just time out
rather than surface a useful error.

This pattern is not unique to Tailscale. Any Ingress backed by an external
async controller (cert-manager, external-dns, Tailscale operator) has the same
problem: Pulumi's readiness check couples deploy completion to controller
reconciliation, adding latency and failure modes without safety benefit.

# Decision

`createTailnetIngress` MUST set the `pulumi.com/skipAwait: "true"` annotation
on every Ingress it creates.

This tells Pulumi's k8s provider to skip the readiness check entirely — create
the Ingress object and return immediately. The Tailscale operator handles
reconciliation on its own schedule.

# Consequences

## Positive

- Deploys complete immediately after the Ingress is created, not 30-60s later.
- Works regardless of the deploy identity's RBAC — no need to grant Service
  read access in the `networking` namespace.
- Decouples deploy completion from controller reconciliation, which is the
  operator's responsibility.

## Negative

- Pulumi no longer verifies that the Tailscale operator successfully reconciled
  the Ingress. A broken operator won't block the deploy — the Ingress will be
  created but the tailnet hostname won't resolve.
- Operators consuming sector7 who relied on Pulumi's readiness check as a smoke
  test will need a separate post-deploy verification step (e.g. `curl --max-time 15 https://<fqdn>/`).

# Alternatives

## Grant RBAC to read Services in the networking namespace

Give the deploy identity `get` on Services and Endpoints in the namespace where
the Ingress lives. This would let Pulumi pass step 1 of the readiness check and
reach step 2 (status.loadBalancer poll).

**Rejected.** This violates the security boundary established in zeus ADR 125,
which deliberately scopes the deploy identity to Ingress CRUD only. The ADR
explicitly lists "No access to networking Services" under what the identity does
not get. Widening RBAC to make Pulumi's check work is the tail wagging the dog.

## Selective skip (skip endpoint check only, keep loadBalancer check)

Pulumi's `pulumi.com/skipAwait` annotation is all-or-nothing per resource. There
is no way to skip the endpoint readiness check while keeping the
`status.loadBalancer` population check. Even if there were, the loadBalancer
check would still add 30-60s of latency per service for no real safety benefit.

**Rejected.** Not technically possible with Pulumi today, and the latency cost
isn't justified.

# Operational Notes

## Post-deploy verification

After deploying a service with a tailnet Ingress, verify the operator reconciled:

```bash
# Check the Ingress has a loadBalancer address (operator populated it)
kubectl get ingress <name>-tailnet -n networking

# Verify the tailnet hostname resolves over HTTPS
curl -sv --max-time 15 https://<fqdn>/

# Check ingress-proxies pod logs for cert provisioning success
kubectl logs -n tailscale ingress-proxies-0 --tail=20
# Look for: cert("<fqdn>"): got cert
```

## Affected consumers

All consumers of `createTailnetIngress` are affected by this change:

- **garden** — services deployed via the garden Pulumi identity
- **zeus** — `atlas/src/gateway/tailnet-ingress.ts` via `createCavinsTailnetIngress`

Zeus's `createCavinsTailnetIngress` previously inlined the Ingress construction
with `pulumi.com/skipAwait` as a workaround. Once sector7 ships this fix, zeus
should revert to delegating to `createTailnetIngress` and remove the inlined
code.

# References

- zeus ADR 125 — RBAC analysis for tailnet ingress (Appendix C)
- Pulumi k8s provider `pulumi.com/skipAwait` annotation:
  https://www.pulumi.com/registry/packages/kubernetes/api-docs/
