---
id: ADR-005
title: Cloudflare WorkerSite Static Hosting with Zero Trust by Subpath (Pulumi Component)
status: Implemented
date: 2025-09-22
updated: 2025-12-19
deciders: [platform]
consulted: [security, web, infra]
tags: [design, adr, cloudflare, pulumi, workers, access, zero-trust]
supersedes: []
superseded_by: []
links:
  - cloudflare-workers: https://developers.cloudflare.com/workers/
  - cloudflare-access: https://developers.cloudflare.com/cloudflare-one/policies/access/
  - pulumi-cloudflare: https://www.pulumi.com/registry/packages/cloudflare/
  - worker-domains: https://developers.cloudflare.com/workers/platform/triggers/custom-domains/
  - worker-routes: https://developers.cloudflare.com/workers/platform/triggers/routes/
---

> **Update 2025-12-19**: Upgraded to Pulumi Cloudflare provider v6. See [Pulumi Cloudflare v6 Migration Notes](#pulumi-cloudflare-v6-migration-notes) for breaking changes.

# Context

- We want a reusable Pulumi ComponentResource to provision Cloudflare-hosted static websites on the Workers platform, not Pages.
- The component MUST bind one or more custom domains and configure Cloudflare Zero Trust (Access) with path-level policies so that some paths (e.g., `/blog/*`) are public while others (e.g., `/research/*`) are restricted to members of specific GitHub organizations.
- Drivers:
  - Strategic shift: prefer Cloudflare Workers as the unified runtime for static and dynamic needs.
  - Security baseline: managed Zero Trust with identity- and org-based controls.
  - Reusability: ship a typed component under `packages/toolbox/pulumi/` with clear inputs/outputs and an example.
- In scope:
  - Worker deployment for static assets (R2- or KV-backed, with cache and directory index handling).
  - Domain binding using Worker Custom Domains when available, otherwise Worker Routes per zone.
  - Cloudflare Access Applications and Policies per subpath, including GitHub organization allow‑lists.
- Out of scope:
  - Authoring the site content or build pipeline (callers provide an artifact path or repo build via CI).
  - Creating the GitHub Access Identity Provider in Cloudflare (assumed to exist; the component accepts its ID).

# Decision

We adopt the **R2-backed Worker pattern** for static site hosting with Zero Trust access control.

1. Build a Pulumi TypeScript ComponentResource named `WorkerSite` that:

   - Hosts static assets from R2 (default) or KV (optional) and serves them via a Worker script.
   - Binds one or more domains either via Worker Custom Domains (preferred) or Worker Routes fallback.
   - Configures Cloudflare Zero Trust on a per‑subpath basis by creating Access Applications and Policies.

   **Rationale**: This approach provides full control over static asset serving with standard Cloudflare Workers patterns (R2 bindings, Cache API, custom response headers) while integrating seamlessly with Cloudflare Access for path-level authorization.

2. Access model:

   - For each protected path pattern (e.g., `/research/*`), create an Access Application targeting the primary domain and subpath. Where provider support allows, set `domain: "<hostname><path-pattern>"` (e.g., `site.example.com/research/*`). If path scoping at the application level is not supported or proves unreliable, create distinct applications per path and apply policies accordingly.
   - Public paths (e.g., `/blog/*`) are modeled as an Access Application with a policy that `include: everyone` (permit-all), ensuring consistency of audit and future policy constraints.
   - Restricted paths use `include: github` with the specified `identity_provider_id` and one or more organization names. Additional `require` conditions (e.g., device posture) MAY be supported later.

3. Domains:

   - Prefer Worker Custom Domains where available in the provider. If unavailable or constrained, use Worker Routes with zone patterns (e.g., `site.example.com/*`).
   - DNS is assumed to be on Cloudflare nameservers; explicit `Record` resources are not required when using Routes. If Custom Domains require or benefit from explicit DNS, the component MAY ensure records when `manageDns: true`.

4. Assets:

   - Default backend is R2 with an object key prefix matching the site root. The Worker uses R2 bindings and edge caching to serve assets, supports directory index (`index.html`) and optional SPA fallback.
   - For small sites, a KV backend MAY be chosen. Large binaries and big bundles SHOULD use R2.

5. Inputs/Outputs:

   - The component accepts `accountId`, `zoneId` (for routes), `domains[]`, storage choice and bucket/namespace names, and a `paths[]` policy map with `public` vs `github-org` access.
   - It outputs the Worker name, bound domains, Access Application/Policy IDs, and the storage location (bucket/namespace).

# Consequences

## Positive

- Unified hosting on Workers supports future dynamic needs without replatforming.
- Path‑level Zero Trust provides granular access aligned to team/org boundaries.
- Reusable Pulumi interface reduces copy‑paste configs across repos.
- Clear separation between infra (provisioning) and CI (build/upload of assets).

## Negative

- Slightly higher initial complexity than Pages; additional bindings and script logic.
- Provider/API drift risk for Worker Custom Domains and Access path scoping semantics.
- Managing R2/KV contents requires a CI/upload process (out of scope for this ADR).

# Alternatives

- Cloudflare Pages + Access per subpath:
  - Pros: Simpler deploys with Pages projects and built‑in static hosting.
  - Cons: Diverges from Workers‑first strategy; separate product surface.
- Worker + reverse proxy in front of Pages:
  - Pros: Keep Pages simplicity but layer Workers flexibility.
  - Cons: More moving parts, latency overhead, operational complexity.
- DIY auth in Worker (validate CF Access JWT or custom OIDC):
  - Pros: Full control.
  - Cons: Reinvents Access; higher security burden.

# Security / Privacy / Compliance

- **API Token Permissions** - Use least-privilege Cloudflare API tokens:
  - Required: Account → Workers Scripts: Edit; R2: Edit (if creating buckets); Zero Trust Access: Edit.
  - Optional: Zone → DNS: Edit (only if managing explicit records via `manageDns: true`).
- **Worker Credentials**: No secrets are embedded in the Worker; bindings use Cloudflare-managed credentials for R2/KV access.
- **GitHub IdP Prerequisite**: The GitHub Identity Provider MUST exist in the Cloudflare account before deployment; we pass its `identity_provider_id` and constrain org membership in Access policies.
- **Access Enforcement Model**: Cloudflare Access enforces authorization at the edge BEFORE requests reach the Worker. The Worker does NOT implement auth logic; all authorization is handled by Access Applications and Policies created via Pulumi.
- **Optional JWT Validation**: For defense-in-depth, the Worker MAY validate the `Cf-Access-Jwt-Assertion` header using the `jose` library, but this is NOT required for security since Access already blocks unauthorized requests.
- **Audit Logging**: Log access decisions via Cloudflare Access audit logs; do not store PII in Worker logs. Access provides detailed audit trails for all authentication and authorization events.
- **Public Paths**: Even "public" paths should be configured as Access Applications with `include: everyone` policies for consistent audit logging and future policy flexibility.

# Operational Notes

- **Cost**: Workers and R2 pricing apply; cache effectiveness impacts egress. R2 Class A operations (PUT, GET) cost \$0.36/million requests. Edge cache with long TTLs (1 year for immutable assets) minimizes R2 requests.
- **Limits**: Worker CPU time (50ms free tier, 30s paid), Worker memory (128MB), and R2 request rates. Size large assets appropriately or use streaming for files exceeding memory limits.
- **Cache API requirement**: Cache API only works with custom domains (not `*.workers.dev`). Phase 1 MVP uses WorkerRoute without caching; Phase 2+ adds caching with custom domains.
- **Observability**: Use CF-Ray IDs from request headers, Cloudflare Access logs for authorization events, and add `X-Cache-Status` headers (HIT/MISS) in the Worker for cache debugging.
- **Rollouts/backouts**: Version the Worker script via Pulumi; safe to roll back by re-deploying prior asset manifest and script. R2 objects are immutable once uploaded; use content hashing in filenames for cache busting.
- **DNS propagation**: When using `manageDns: true`, DNS changes may take minutes to propagate. Worker Custom Domains also require DNS validation before activation.

# Status Transitions

- New ADR; no supersessions.

# Implementation Notes

- Package: `packages/toolbox/pulumi/` exports `WorkerSite` as a ComponentResource.
- Resources (indicative; subject to provider version):
  - `cloudflare.R2Bucket` (or reuse existing)
  - `cloudflare.WorkerScript` with `r2BucketBindings` or `kvNamespaceBindings`
  - `cloudflare.WorkerDomain` (preferred) or `cloudflare.WorkerRoute` per domain
  - `cloudflare.AccessApplication` per subpath/domain target
  - `cloudflare.AccessPolicy` per application (public vs GitHub org)
  - Optional: `cloudflare.Record` when `manageDns: true` and Custom Domains require DNS
- CI uploads assets to R2/KV and bumps a content hash used by the Worker for cache busting.

## Worker Script Architecture

The Worker serves static files from R2 using this standard pattern:

- **Path normalization**: Remove leading `/`, append `index.html` for directory paths
- **Cache API**: Check `caches.default` before R2 fetch (requires custom domain, not `*.workers.dev`)
- **R2 fetch**: Use `env.R2_BUCKET.get(objectKey)` with null check for 404
- **Response headers**: Set Content-Type from R2 httpMetadata, ETag, Cache-Control
- **Async cache storage**: Use `ctx.waitUntil(cache.put())` to avoid blocking response
- **SPA fallback** (Phase 3): Return `index.html` for 404s when enabled
- **Error handling**: Return 404 for missing objects (or fallback to index.html in SPA mode)

## Access Integration Model

**Key finding**: Cloudflare Access sits **in front** of the Worker at the edge. The Pulumi component creates Access Applications and Policies that enforce authorization **before** requests reach the Worker. The Worker does NOT need to implement authorization logic.

**Optional JWT validation**: For defense-in-depth, the Worker MAY validate the `Cf-Access-Jwt-Assertion` header using the `jose` library, but this is not required for basic functionality since Access already enforces policies.

**Public keys**: Access uses signing keys at `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs` that rotate every 6 weeks. Use `createRemoteJWKSet` from `jose` for automatic key refresh.

# References

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) - Official documentation for serving static assets with Workers
- [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/) - R2 bindings and API reference for Workers
- [Cloudflare R2 Cache API Example](https://developers.cloudflare.com/r2/examples/cache-api/) - Using Cache API with R2 objects
- [Cloudflare Access JWT Validation](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/) - Validating Access JWTs in applications
- [Cloudflare Worker Custom Domains](https://developers.cloudflare.com/workers/platform/triggers/custom-domains/) - Binding custom domains to Workers
- [Cloudflare Worker Routes](https://developers.cloudflare.com/workers/platform/triggers/routes/) - Using routes to trigger Workers
- [Pulumi Cloudflare Provider](https://www.pulumi.com/registry/packages/cloudflare/) - Pulumi resources for Workers, R2, and Access

______________________________________________________________________

## Appendix A — Component API (TypeScript sketch)

```ts
export interface WorkerSiteArgs {
  accountId: pulumi.Input<string>;
  zoneId?: pulumi.Input<string>; // required when using routes

  // Worker & assets
  name: pulumi.Input<string>;
  assets: {
    backend: "r2" | "kv";
    r2?: { bucketName: pulumi.Input<string>; create?: pulumi.Input<boolean>; prefix?: pulumi.Input<string>; };
    kv?: { namespace: pulumi.Input<string>; create?: pulumi.Input<boolean>; prefix?: pulumi.Input<string>; };
    spaFallback?: pulumi.Input<boolean>;
    directoryIndex?: pulumi.Input<string>; // default "index.html"
    cacheTtlSeconds?: pulumi.Input<number>;
  };

  // Domains
  domains: pulumi.Input<string>[]; // e.g., ["site.example.com"]
  preferWorkerDomains?: pulumi.Input<boolean>; // default true
  manageDns?: pulumi.Input<boolean>; // default false

  // Zero Trust
  githubIdentityProviderId: pulumi.Input<string>;
  githubOrganizations: pulumi.Input<string>[]; // one or more orgs
  paths: Array<{
    pattern: pulumi.Input<string>; // "/blog/*", "/research/*"
    access: "public" | "github-org";
  }>;
}

export interface WorkerSiteOutputs {
  workerName: pulumi.Output<string>;
  boundDomains: pulumi.Output<string[]>;
  storage: pulumi.Output<{ backend: "r2" | "kv"; bucketName?: string; namespace?: string; prefix?: string }>;
  accessApplications: pulumi.Output<string[]>; // IDs
  accessPolicies: pulumi.Output<string[]>; // IDs
}
```

## Appendix B — Resource Model and Flow

- Create or reference storage (R2/KV) according to `assets.backend`.
- Deploy `WorkerScript` that:
  - Resolves the request path to an object key with `prefix` and `directoryIndex` handling.
  - Serves from cache and R2/KV; applies SPA fallback when enabled.
- Bind the Worker to traffic:
  - If `preferWorkerDomains`, create `WorkerDomain` per hostname; otherwise create `WorkerRoute` patterns (`host/*`).
- For each `paths[*]` entry:
  - Create an `AccessApplication` targeting `<host><pattern>` (or a per-path app if required by provider semantics).
  - Create an `AccessPolicy` with:
    - `public`: `include: [{ everyone: true }]`
    - `github-org`: `include: [{ github: { identity_provider_id: <id>, name: <org> } }]`
  - Order by declaration to set policy/application precedence as needed.

## Appendix C — Implementation Plan

### Phase 1: MVP (Core Functionality)

**Scope:**

- R2-backed Worker serving static files
- Single domain via WorkerRoute (broadest compatibility)
- Exactly 2 paths: one public (`/blog/*`), one restricted (`/research/*`)
- Basic Access integration with GitHub org policies

**Pulumi Component Resources:**

- `cloudflare.R2Bucket` (or reference existing)
- `cloudflare.WorkerScript` with R2 binding
- `cloudflare.WorkerRoute` pattern: `<domain>/*`
- 2x `cloudflare.AccessApplication` (one per path pattern)
- 2x `cloudflare.AccessPolicy` (public + GitHub org)

**Worker Script Features:**

- Path normalization (remove leading `/`)
- Directory index (append `index.html` for paths ending in `/`)
- R2 object fetch with `env.R2_BUCKET.get(objectKey)`
- Null check for 404 handling
- Content-Type from `object.httpMetadata.contentType`
- ETag header from `object.httpEtag`
- Basic error responses (404 for missing objects)
- **NO caching** (Cache API requires custom domain, deferred to Phase 2)
- **NO SPA fallback** (deferred to Phase 3)

**Access Configuration:**

- **Public path** (`/blog/*`):
  - Application: `domain: <hostname>`, `path: /blog/*` (if path scoping supported)
  - Policy: `include: [{ everyone: {} }]`
- **Restricted path** (`/research/*`):
  - Application: `domain: <hostname>`, `path: /research/*`
  - Policy: `include: [{ github: { identity_provider_id: <id>, name: <org> } }]`

**Acceptance Criteria:**

- Deploy component to test Cloudflare zone
- Upload sample files to R2: `blog/index.html`, `research/data.json`
- Verify `/blog/*` accessible without authentication
- Verify `/research/*` requires GitHub org membership via Access
- Verify 404 response for non-existent paths
- Verify directory index works (`/blog/` → `/blog/index.html`)

**Limitations:**

- Single domain only (array iteration deferred to Phase 2)
- Hardcoded to 2 paths (flexible `paths[]` array deferred to Phase 2)
- No DNS management (`manageDns` flag not implemented)
- Uses WorkerRoute only (WorkerDomain deferred to Phase 2)

______________________________________________________________________

### Phase 2: Full Feature Set

**Adds:**

- Multiple domains support (iterate `domains[]` array)
- Multiple path policies (iterate `paths[]` array)
- WorkerDomain preference (feature flag `preferWorkerDomains`)
- Optional DNS management (`manageDns: true` creates `cloudflare.Record`)
- KV backend option (`assets.backend === 'kv'`)
- **Cache API integration** (now possible with custom domains)

**Worker Script Enhancements:**

- Cache API check: `cache.match(cacheKey)` before R2 fetch
- Async cache storage: `ctx.waitUntil(cache.put(cacheKey, response.clone()))`
- KV namespace binding support as alternative to R2
- Cache-Control headers with configurable TTL
- Response cloning before caching (R2 body streams are single-use)

**Pulumi Enhancements:**

- Conditional `cloudflare.WorkerDomain` vs `cloudflare.WorkerRoute`:
  ```ts
  if (args.preferWorkerDomains) {
    new cloudflare.WorkerDomain(...);
  } else {
    new cloudflare.WorkerRoute(...);
  }
  ```
- Conditional `cloudflare.Record` (A/AAAA) when `manageDns: true`:
  ```ts
  if (args.manageDns && args.preferWorkerDomains) {
    new cloudflare.Record({
      type: 'AAAA',
      value: '100::', // Workers placeholder
      proxied: true,
    });
  }
  ```
- Loop over `paths[]` to create multiple Access Applications/Policies
- Support for `assets.backend === 'kv'` with KV namespace bindings

**Cache API Implementation:**

```ts
const cache = caches.default;
const cacheKey = new Request(url.toString(), request);
let response = await cache.match(cacheKey);

if (!response) {
  const object = await env.R2_BUCKET.get(objectKey);
  response = createResponse(object, objectKey, 200, 'MISS', env);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
}
return response;
```

**DNS Management Logic:**

- Only create DNS records when both `manageDns: true` AND `preferWorkerDomains: true`
- Create AAAA record pointing to `100::` (Workers placeholder IPv6)
- Set `proxied: true` to enable Cloudflare proxy

**Acceptance Criteria:**

- Deploy with multiple domains (`example.com`, `www.example.com`)
- Verify all domains bound correctly via WorkerDomain
- Deploy with `manageDns: true` and verify DNS records created
- Test Cache API: first request misses cache, second hits
- Verify multiple path policies work correctly
- Test KV backend option as alternative to R2

______________________________________________________________________

### Phase 3: DX & Performance

**Adds:**

- SPA fallback mode (`assets.spaFallback: true`)
- Custom cache TTL configuration (`assets.cacheTtlSeconds`)
- Observability headers (cf-ray echo, cache status)
- Custom 404 page support
- Range request support for large files

**Worker Script Enhancements:**

```ts
// SPA fallback
if (!object && env.SPA_FALLBACK === 'true') {
  object = await env.R2_BUCKET.get('index.html');
  if (object) {
    response = createResponse(object, 'index.html', 200, 'MISS', env); // Return 200, not 404
  }
}

// Observability (CF-Ray echo)
// Note: X-Cache-Status is already set by createResponse based on cache hit/miss
headers.set('CF-Ray', request.headers.get('cf-ray') || 'unknown');

// Custom cache TTL
const maxAge = env.CACHE_TTL_SECONDS || 31536000;
headers.set('Cache-Control', `public, max-age=${maxAge}, immutable`);
```

**Pulumi Additions:**

- `assets.spaFallback` → Worker environment variable `SPA_FALLBACK`
- `assets.cacheTtlSeconds` → Worker environment variable `CACHE_TTL_SECONDS`
- Optional `assets.notFoundPage` for custom 404 handling

**Performance Features:**

- Configurable cache TTL (default: 1 year for immutable assets)
- SPA mode returns `index.html` with 200 status for client-side routing
- Cache status headers for debugging (`X-Cache-Status: HIT|MISS`)
- CF-Ray echo for request tracing

**Acceptance Criteria:**

- Test SPA fallback: verify `/app/route` returns `index.html` with 200
- Verify custom cache TTL reflected in Cache-Control header
- Check observability headers in response
- Measure cache hit rate improvement
- Test custom 404 page if configured

## Appendix D — Risks & Mitigations

- Provider drift for `WorkerDomain` and Access path targeting
  - Mitigation: feature-flag to use Routes; create per-path Applications if domain+path isn’t supported.
- Large asset sets impact R2 request costs and latency
  - Mitigation: edge cache with long TTLs and content hashing.
- Incorrect Access policy order yields unintended exposure
  - Mitigation: explicit precedence; smoke tests for public vs private paths.

## Appendix E — Test Strategy

- Unit: construct graph with Pulumi preview for representative inputs; assert resource counts and key properties.
- Integration: deploy to a test zone with sample assets; verify domain binding, cache behavior, and Access flows.
- Security: validate GitHub org gating; confirm `/blog/*` public and `/research/*` protected.

## Appendix F — Example Usage (illustrative)

```ts
const site = new WorkerSite("docs-site", {
  accountId,
  zoneId,
  name: "docs-site",
  assets: { backend: "r2", r2: { bucketName: "docs-site", create: true, prefix: "public/" }, spaFallback: false },
  domains: ["site.example.com", "www.site.example.com"],
  preferWorkerDomains: true,
  manageDns: true,
  githubIdentityProviderId: cfGithubIdpId,
  githubOrganizations: ["acme-org"],
  paths: [
    { pattern: "/blog/*", access: "public" },
    { pattern: "/research/*", access: "github-org" },
  ],
});
```

## Appendix G — Complete Worker Script Example

This is the reference implementation for the R2-backed static site Worker (Phase 2+):

```ts
/**
 * WorkerSite - Static file server with R2 backend and Cache API
 * Generated by WorkerSite Pulumi component
 */

export interface Env {
  R2_BUCKET: R2Bucket;
  SPA_FALLBACK?: string;
  CACHE_TTL_SECONDS?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // 1. Path normalization
    let objectKey = url.pathname.slice(1); // Remove leading /

    // 2. Directory index handling
    if (objectKey === '' || objectKey.endsWith('/')) {
      objectKey += 'index.html';
    }

    // 3. Cache API check (requires custom domain)
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    let response = await cache.match(cacheKey);

    if (response) {
      // Cache hit - add debug header
      const headers = new Headers(response.headers);
      headers.set('X-Cache-Status', 'HIT');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // 4. Cache miss - fetch from R2
    let object = await env.R2_BUCKET.get(objectKey);

    // 5. Handle 404 with optional SPA fallback
    if (!object) {
      if (env.SPA_FALLBACK === 'true') {
        // SPA mode: return index.html with 200 for client-side routing
        object = await env.R2_BUCKET.get('index.html');
        if (object) {
          response = createResponse(object, 'index.html', 200, 'MISS', env);
          ctx.waitUntil(cache.put(cacheKey, response.clone()));
          return response;
        }
      }
      // No fallback or fallback failed
      return new Response('Not Found', { status: 404 });
    }

    // 6. Build response with metadata
    response = createResponse(object, objectKey, 200, 'MISS', env);

    // 7. Async cache storage (non-blocking)
    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  },
};

/**
 * Create HTTP Response from R2 object with proper headers
 */
function createResponse(
  object: R2ObjectBody,
  objectKey: string,
  status: number,
  cacheStatus: string,
  env: Env
): Response {
  const headers = new Headers();

  // Content-Type from R2 metadata
  if (object.httpMetadata?.contentType) {
    headers.set('Content-Type', object.httpMetadata.contentType);
  } else {
    // Fallback based on file extension
    const contentType = guessContentType(objectKey);
    headers.set('Content-Type', contentType);
  }

  // ETag for cache validation
  headers.set('ETag', object.httpEtag);

  // Cache-Control with configurable TTL
  const maxAge = parseInt(env.CACHE_TTL_SECONDS || '31536000');
  headers.set('Cache-Control', `public, max-age=${maxAge}, immutable`);

  // Last-Modified
  if (object.uploaded) {
    headers.set('Last-Modified', object.uploaded.toUTCString());
  }

  // Observability headers
  headers.set('X-Cache-Status', cacheStatus);

  return new Response(object.body, { status, headers });
}

/**
 * Guess content type from file extension
 */
function guessContentType(key: string): string {
  // Get the basename (after last '/')
  const base = key.substring(key.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const ext = (dot > 0) ? base.substring(dot + 1).toLowerCase() : '';
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    eot: 'application/vnd.ms-fontobject',
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
  };
  return types[ext || ''] || 'application/octet-stream';
}
```

**Phase 1 Simplification:**
For MVP, remove:

- Cache API logic (lines 27-42, 65)
- SPA fallback logic (lines 51-60)
- `X-Cache-Status` header
- `CACHE_TTL_SECONDS` environment variable

Phase 1 script focuses on basic R2 fetch, directory index, and response headers.

## Appendix H — Critical Requirements & Gotchas

### Cache API

- **Requires custom domain**: Cache API will NOT work on `*.workers.dev` or dashboard previews
- **Must clone response**: R2 body streams are single-use; always use `response.clone()` before `cache.put()`
- **Cache key construction**: Use `new Request(url.toString(), request)` for proper cache keying

### Cloudflare Access

- **JWT header name**: Use `Cf-Access-Jwt-Assertion` header (not the `CF_Authorization` cookie)
- **Public keys rotate**: Access rotates signing keys every 6 weeks; use `createRemoteJWKSet` from `jose` library for automatic refresh
- **Public key location**: `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs`
- **Worker validation optional**: Access enforces policies at the edge BEFORE requests reach the Worker; JWT validation in Worker is defense-in-depth, not required

### R2 Integration

- **Body stream limitation**: `request.body` can only be accessed once; use `request.clone()` if multiple accesses needed
- **Null check required**: `env.R2_BUCKET.get()` returns `null` for missing objects (not 404 Response)
- **httpMetadata structure**: Content-Type stored in `object.httpMetadata.contentType`, may be undefined

### DNS Management

- **AAAA record for Workers**: Use placeholder IPv6 `100::` with `proxied: true`
- **Only with WorkerDomain**: DNS management only makes sense when using Worker Custom Domains, not Routes
- **Zone must be on Cloudflare**: Domain must already be managed by Cloudflare nameservers

### Security

- **No auth logic in Worker**: Authorization is enforced by Access policies created via Pulumi; Worker does NOT implement auth
- **R2 bucket security**: Without Access or Worker auth logic, R2 bucket is publicly exposed via Worker
- **API token permissions**: Minimum required: Account → Workers Scripts: Edit, R2: Edit, Zero Trust Access: Edit

### Performance

- **Workers CPU limits**: 50ms CPU time for free tier, 30s for paid (mainly impacts first request)
- **R2 request costs**: \$0.36 per million Class A operations; cache aggressively
- **Edge cache effectiveness**: Long cache TTLs (1 year for immutable assets) minimize R2 requests

______________________________________________________________________

## Pulumi Cloudflare v6 Migration Notes

**Migration Date**: 2025-12-19\
**Provider Version**: v5.x → v6.11.0

### Breaking Changes

The following breaking changes were required to upgrade from Pulumi Cloudflare provider v5 to v6:

#### 1. WorkerScript → WorkersScript

- **Resource renamed**: `cloudflare.WorkerScript` → `cloudflare.WorkersScript`
- **Property renamed**: `name` → `scriptName`
- **Impact**: All Worker script references updated

#### 2. Unified Bindings API

- **Old**: Separate arrays `r2BucketBindings` and `plainTextBindings`
- **New**: Single `bindings` array with `type` property for each binding
- **Example**:
  ```typescript
  // v5
  r2BucketBindings: [{ name: "R2_BUCKET", bucketName: "..." }]
  plainTextBindings: [{ name: "VAR", text: "value" }]

  // v6
  bindings: [
    { name: "R2_BUCKET", bucketName: "...", type: "r2_bucket" },
    { name: "VAR", text: "value", type: "plain_text" }
  ]
  ```

#### 3. DNS Record Property

- **Property renamed**: `value` → `content`
- **Impact**: All DNS record creation updated

#### 4. WorkerDomain Environment (New Required Property)

- **Added**: `environment` property now required
- **Purpose**: Specifies which Worker environment (e.g., "production", "staging") the domain binds to
- **Implementation**: All domains set to `"production"` for single-environment deployments
- **Background**: Cloudflare Workers support multiple environments per script with different configurations

#### 5. Access Resources Architecture Change

- **Resources renamed**:
  - `AccessApplication` → `ZeroTrustAccessApplication`
  - `AccessPolicy` → `ZeroTrustAccessPolicy` (embedded)
- **Major change**: Policies are now **embedded within applications** rather than separate resources
  - Old: Create `AccessApplication`, then create separate `AccessPolicy` with `applicationId`
  - New: Create `ZeroTrustAccessApplication` with `policies: [...]` array
- **Precedence scope**: Changed from global to per-application
  - v5: Global precedence counter across all policies
  - v6: Each application has its own policies with precedence scoped to that application
- **Component impact**:
  - Removed `public readonly accessPolicies` property
  - Each (domain, path) gets one application with one embedded policy
  - Functionally equivalent for WorkerSite use case

#### 6. Type Updates

- `AccessPolicyInclude` → `ZeroTrustAccessApplicationPolicyInclude`

### Migration Impact

**Functional Equivalence**: Despite the resource model changes, the WorkerSite component provides **identical functionality**:

- Path-level access control works the same way
- Public vs restricted paths behave identically
- GitHub organization authentication unchanged
- Edge caching and R2 integration unaffected

**API Changes**: The component's public API remains unchanged - no breaking changes for users of the WorkerSite component.

### Testing

All functionality verified after migration:

- ✅ Worker script compilation with TypeScript
- ✅ R2 bindings with unified bindings API
- ✅ DNS record creation with `content` property
- ✅ Worker domain binding with `environment: "production"`
- ✅ Access applications with embedded policies
- ✅ Public and restricted path access control
