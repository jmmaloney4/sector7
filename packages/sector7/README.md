# ☁️🎺 `@jmmaloney4/sector7`

Reusable Pulumi components for infrastructure management.

## Installation

You can install this package directly from GitHub using pnpm:

```bash
pnpm add "git+https://github.com/jmmaloney4/sector7.git#path:/packages/sector7"
```

Or pin to a specific version/commit:

```bash
pnpm add "git+https://github.com/jmmaloney4/sector7.git#path:/packages/sector7#v0.1.0"
```

## Components

This package is organized into **subpath modules**, each exported under
`@jmmaloney4/sector7/<name>` so a consumer only pulls in the dependency closure
it needs. The root barrel (`@jmmaloney4/sector7`) re-exports the lighter modules
as namespaces (`access`, `d1`, `iam`, `monitor`, `nixImage`, `nixOutput`,
`workersite`); heavier modules — those carrying `@pulumi/kubernetes`,
`@kubernetes/client-node`, or other large/optional type closures — are
**subpath-only** and deliberately kept out of the root barrel (asserted by
`barrel-guard.ts`).

| Subpath                             | Key exports                                                                           | Purpose                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `@jmmaloney4/sector7/iam`           | `GitHubOidcResource`, `WorkloadIdentityPool`, `GitHubActionsIdentityProvider`         | GitHub Actions OIDC → GCP Workload Identity Federation ([details](#githuboidcresource))   |
| `@jmmaloney4/sector7/access`        | `AccessGate`                                                                          | GitHub OAuth access-control gate for WorkerSite routes (ADR-016)                          |
| `@jmmaloney4/sector7/workersite`    | `WorkerSite`, `generateWorkerScript`                                                  | Cloudflare Worker static-site deployment                                                  |
| `@jmmaloney4/sector7/r2`            | `R2Object`, `uploadAssets`, `uploadStaticAssets`, `purgeZoneCache`                    | Cloudflare R2 object upload + zone cache purge (dynamic resources)                        |
| `@jmmaloney4/sector7/d1`            | `D1Query`                                                                             | Cloudflare D1 query as a dynamic resource                                                 |
| `@jmmaloney4/sector7/nix-image`     | `NixImage`, `NixImagePushGroup`                                                       | Build and push OCI images from Nix outputs (ADR-017/029)                                  |
| `@jmmaloney4/sector7/nix-output`    | `NixOutput`                                                                           | Realize a Nix flake output as a resource (ADR-021)                                        |
| `@jmmaloney4/sector7/monitor`       | `UptimeMonitor`                                                                       | Cloudflare Worker uptime monitor (ADR-020/028/030)                                        |
| `@jmmaloney4/sector7/cloudsql`      | `CloudSqlAuthProxySidecar`, `rewriteDatabaseUrlForProxy`                              | Cloud SQL Auth Proxy sidecar for Kubernetes workloads (ADR-027)                           |
| `@jmmaloney4/sector7/litellm`       | `LiteLLMProxy`, `LiteLLMTeam`, `LiteLLMApiKey`, `generateLiteLLMConfig`               | LiteLLM proxy deployment + team/virtual-key admin, dynamic (ADR-026; [details](#litellm)) |
| `@jmmaloney4/sector7/onepassword`   | `OnePasswordItem`                                                                     | Write/update a 1Password item via Connect, dynamic (ADR-031; [details](#onepassword))     |
| `@jmmaloney4/sector7/attic`         | `AtticCache`, `AtticToken`                                                            | Attic Nix binary cache + access-token admin, dynamic (ADR-032; [details](#attic))         |
| `@jmmaloney4/sector7/gateway`       | `createServiceHttpRoute`, `createSharedGatewayReferenceGrant`, `createTailnetIngress` | Gateway API HTTPRoute / ReferenceGrant / Tailnet Ingress helpers (ADR-040/075)            |
| `@jmmaloney4/sector7/pulumi-config` | `requireMixedConfig`                                                                  | Typed loader for mixed plain + secret Pulumi config                                       |
| `@jmmaloney4/sector7/scripts`       | `getScriptPath`                                                                       | Resolve the path to a script bundled with the package                                     |

> The dynamic-resource modules (`litellm`, `onepassword`, `attic`, `r2`, `d1`)
> reach a `ClusterIP`-only service from an out-of-cluster `pulumi up` over a
> short-lived **in-process Kubernetes port-forward** (`k8s/port-forward.ts`), so
> the targets need no tailnet/public ingress. Their provider closures must keep
> native imports lazy — see the serialization contract in `k8s/port-forward.ts`.

### GitHubOidcResource

A component that sets up GitHub Actions OIDC authentication with Google Cloud Platform (GCP). This creates:

- A GCP Service Account
- A Workload Identity Pool
- A Workload Identity Provider configured for GitHub Actions
- Necessary IAM bindings

#### Usage

```typescript
import * as pulumi from "@pulumi/pulumi";
import { GitHubOidcResource } from "@jmmaloney4/sector7/iam";

const githubOidc = new GitHubOidcResource("github-oidc", {
    repoOwner: "jmmaloney4",
    repoName: "my-repo",
    // Map role -> list of project IDs to bind the role in
    serviceAccountRoles: {
        "roles/iam.serviceAccountTokenCreator": ["my-admin-project"],  // SA/WIF admin project
        "roles/storage.admin": ["my-prod", "my-stage"],
        "roles/secretmanager.secretAccessor": ["my-prod"],
        "roles/storage.objectViewer": ["my-dev"]
    },
    limitToRef: "refs/heads/main"  // Optional: limit to specific branch/tag
});

// Export the service account email and workload identity provider resource
export const serviceAccountEmail = githubOidc.serviceAccountEmail;
export const workloadIdentityProviderResource = githubOidc.workloadIdentityProviderResource;
```

#### Using with the reusable Pulumi workflow

This component emits outputs that map 1:1 to the inputs expected by the reusable workflow in this repo at `.github/workflows/pulumi.yml`:

- `workloadIdentityProviderResource` → `google_workload_identity_provider`
- `serviceAccountEmail` → `google_service_account_email`

Yes — this component creates all of the required GCP resources to authenticate GitHub Actions via OIDC for that workflow: a Service Account, a Workload Identity Pool, a GitHub OIDC Provider, and the `workloadIdentityUser` binding.

Typical setup:

1. Bootstrap once with Pulumi using this component to create the resources and capture the two outputs.
2. Store the outputs in your repository variables (recommended) or secrets in the caller repo, e.g. `vars.GOOGLE_WORKLOAD_IDENTITY_PROVIDER` and `vars.GOOGLE_SERVICE_ACCOUNT_EMAIL`.
3. Call the reusable workflow and pass those values as inputs, along with your Pulumi backend URL.

Example caller workflow:

```yaml
name: Infra

on:
  push:
    branches: [ main ]
  pull_request:

jobs:
  pulumi:
    uses: jmmaloney4/sector7/.github/workflows/pulumi.yml@main
    with:
      runs-on: ubuntu-latest
      repository: ${{ github.repository }}
      ref: ${{ github.ref }}
      google_workload_identity_provider: ${{ vars.GOOGLE_WORKLOAD_IDENTITY_PROVIDER }}
      google_service_account_email: ${{ vars.GOOGLE_SERVICE_ACCOUNT_EMAIL }}
      pulumi_backend_url: ${{ vars.PULUMI_BACKEND_URL }} # e.g., gs://my-pulumi-state
      nodejs_package_manager: pnpm  # Required: "pnpm", "npm", or "none"
```

Notes:

- If you set `limitToRef` when creating the provider (e.g., `refs/heads/main`), authentication will only work for that ref. Ensure it matches the refs where you expect this workflow to run.
- The reusable workflow checks out the caller repo/ref you pass via `repository`/`ref`, so the Pulumi projects and `flake.lock` referenced by the workflow should live in the caller repository.
- The workflow requires a `ci-pulumi` dev shell in the caller repository. That shell must provide `pulumi`, `jq`, and the selected `nodejs_package_manager` (`pnpm` or `npm`; no package manager is required for `none`).
- The workflow requires the inputs shown above; variables/secrets are not implicitly inherited, so pass them explicitly as inputs as shown.

#### Configuration

Create a stack configuration file (e.g., `Pulumi.dev.yaml`):

```yaml
config:
  gcp:project: your-admin-project-id
  wif:
    repoOwner: jmmaloney4
    repoName: my-repo
    serviceAccountRoles:
      roles/iam.serviceAccountTokenCreator:
        - your-admin-project-id
      roles/storage.admin:
        - your-prod-project
        - your-stage-project
      roles/secretmanager.secretAccessor:
        - your-prod-project
      roles/storage.objectViewer:
        - your-dev-project
    limitToRef: refs/heads/main
```

### LiteLLM

`@jmmaloney4/sector7/litellm` deploys an OpenAI-compatible
[LiteLLM](https://docs.litellm.ai) proxy and manages its teams and virtual keys.
`LiteLLMProxy` owns the Kubernetes objects and generates `config.yaml` from a
typed model; `LiteLLMTeam` and `LiteLLMApiKey` are **dynamic resources** that
reconcile teams/keys through the proxy admin API over an in-process port-forward
(idempotent adoption, in-place updates, secret-typed key outputs). See ADR-026.

```typescript
import * as pulumi from "@pulumi/pulumi";
import { LiteLLMApiKey, LiteLLMTeam } from "@jmmaloney4/sector7/litellm";

const team = new LiteLLMTeam("prod", {
    proxyNamespace: "litellm",
    masterKey: pulumi.secret(masterKey),
    teamAlias: "prod-personal",
    teamId: "personal", // explicit id → idempotent adoption
    models: ["coding", "cheap"],
});

const key = new LiteLLMApiKey("openwebui", {
    proxyNamespace: "litellm",
    masterKey: pulumi.secret(masterKey),
    teamId: team.teamId,
    keyAlias: "prod-openwebui",
});

export const openWebuiKey = key.key; // secret Output<string>
```

### OnePassword

`@jmmaloney4/sector7/onepassword` **writes** (creates/updates) a 1Password item
via 1Password Connect, reached over an in-process Kubernetes port-forward — so
Connect stays `ClusterIP`-only. Use it to publish a value Pulumi already holds so
the 1Password operator (or `op read`) can distribute it. Field values are treated
as secrets end to end. See ADR-031.

```typescript
import * as pulumi from "@pulumi/pulumi";
import { OnePasswordItem } from "@jmmaloney4/sector7/onepassword";

const item = new OnePasswordItem("hermes-key", {
    namespace: "1password",
    connectToken: pulumi.secret(connectToken), // write-scoped Connect token
    vault: vaultId,
    title: "hermes-agent-api-key",
    category: "password",
    fields: [
        { label: "credential", value: pulumi.secret(apiKey), type: "concealed" },
    ],
});

export const itemPath = item.itemPath; // vaults/<vault>/items/<uuid>
```

### Attic

`@jmmaloney4/sector7/attic` manages an
[Attic](https://github.com/zhaofengli/attic) Nix binary cache and its access
tokens as **dynamic resources**. `AtticCache` find-or-creates and reconciles a
cache through the cache-config HTTP API over an in-process port-forward, minting
its own short-lived admin token from the server's signing secret; `AtticToken`
mints a stateless HS256 access token in-process from that same secret (no server
contact). The token is a secret output; the resource id never carries it. See
ADR-032.

```typescript
import * as pulumi from "@pulumi/pulumi";
import { AtticCache, AtticToken } from "@jmmaloney4/sector7/attic";

const cache = new AtticCache("cache", {
    namespace: "attic-prod",
    hs256SecretBase64: pulumi.secret(signingSecret),
    cacheName: "cache",
    isPublic: true,
});

const ciToken = new AtticToken("ci", {
    hs256SecretBase64: pulumi.secret(signingSecret),
    sub: "github-actions-ci",
    validity: "1y",
    caches: { cache: { pull: true, push: true } },
});

export const cachePublicKey = cache.publicKey;
export const atticCiToken = ciToken.token; // secret Output<string>
```

> **Token revocation caveat:** Attic tokens are stateless JWTs — `AtticToken`
> deletion is a no-op. A token is invalidated only by its `validity` lapsing or by
> rotating the shared signing secret (which invalidates *every* token). Prefer
> short `validity` and least-privilege `caches` scopes.

## Development

### Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   pnpm install
   ```
3. Build the package:
   ```bash
   pnpm run build
   ```

### Running Examples

The `examples/stack` directory contains a working example of how to use this package:

1. Navigate to the example:
   ```bash
   cd examples/stack
   ```
2. Initialize a new stack:
   ```bash
   pulumi stack init dev
   ```
3. Configure the stack:
   ```bash
   pulumi config set gcp:project your-admin-project-id
   pulumi config set --path wif.repoOwner jmmaloney4
   pulumi config set --path wif.repoName my-repo
   pulumi config set --path 'wif.serviceAccountRoles["roles/storage.admin"][0]' your-prod-project
   pulumi config set --path 'wif.serviceAccountRoles["roles/storage.admin"][1]' your-stage-project
   ```
4. Deploy:
   ```bash
   pulumi up
   ```

## License

MPL-2.0
