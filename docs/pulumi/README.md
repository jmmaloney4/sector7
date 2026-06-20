# @jmmaloney4/sector7

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

## LiteLLM

Sector7 ships a low-level `LiteLLMProxy` component plus higher-level helpers for team-scoped capability routing.

Use the low-level API when you want to wire providers, deployments, and model groups by hand.
Use the team-scoped builder when callers should see stable aliases like `coding` or `cheap` while LiteLLM routes to different backend pools based on team / billing context.

```typescript
import * as pulumi from "@pulumi/pulumi";
import {
  LiteLLMApiKey,
  LiteLLMProxy,
  LiteLLMTeam,
  buildLiteLLMTeamScopedModelGroups,
} from "@jmmaloney4/sector7/litellm";

const modelGroups = buildLiteLLMTeamScopedModelGroups({
  teams: [
    {
      id: "personal",
      alias: "Personal",
      capabilities: [
        {
          name: "coding",
          deploymentIds: ["codex-main", "codex-fallback"],
          fallbacks: ["cheap"],
        },
        {
          name: "cheap",
          deploymentIds: ["cheap-main"],
        },
      ],
    },
  ],
});

const proxy = new LiteLLMProxy("litellm", {
  namespace: "litellm",
  databaseUrl: pulumi.secret("postgres://..."),
  providers: {
    codex: {
      apiBase: "http://codex-proxy.codex.svc.cluster.local:9879",
    },
    openai: {
      apiKey: pulumi.secret("[REDACTED]"),
    },
  },
  deployments: [
    {
      id: "codex-main",
      provider: "codex",
      providerModel: "openai/gpt-5-codex",
    },
    {
      id: "codex-fallback",
      provider: "codex",
      providerModel: "openai/gpt-5-codex",
    },
    {
      id: "cheap-main",
      provider: "openai",
      providerModel: "openai/gpt-4o-mini",
    },
  ],
  modelGroups,
  router: {
    routingStrategy: "least-busy",
  },
});

const personalTeam = new LiteLLMTeam("personal-team", {
  proxyNamespace: proxy.namespace,
  masterKey: proxy.masterKey,
  teamAlias: "Personal",
  teamId: "team-personal",
  models: ["coding", "cheap"],
});

const personalKey = new LiteLLMApiKey("personal-key", {
  proxyNamespace: proxy.namespace,
  masterKey: proxy.masterKey,
  keyAlias: "personal-default",
  teamId: personalTeam.teamId,
  models: ["coding", "cheap"],
});
```

Notes:

- Internal OpenAI-compatible upstreams can omit `apiKey` and rely on `apiBase` only.
- Team-scoped aliases compile to unique internal model names such as `personal::coding` while exposing the caller-facing alias through LiteLLM team metadata.
- `LiteLLMTeam` and `LiteLLMApiKey` use LiteLLM's admin endpoints through the in-cluster deployment.

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
