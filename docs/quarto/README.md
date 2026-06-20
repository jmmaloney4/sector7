# Quarto + Cloudflare Pages (multi-site) — Setup & Reusable Workflow

## Overview

This guide explains how to:

- Provision Cloudflare Pages projects and bind custom subdomains (Pulumi, optional but recommended).
- Configure Cloudflare API tokens and Account ID.
- Use a reusable GitHub Actions workflow to build and deploy multiple Quarto sites from one repository.

## Prerequisites

- A Cloudflare account and the target domain’s zone on Cloudflare nameservers.
- Cloudflare Account ID (Dashboard → Account Home → right sidebar).
- API Token with scopes:
  - Required: Account → Cloudflare Pages: Edit
  - Optional (for domain/DNS automation): Zone → DNS: Edit; Zone → Zone: Read
- GitHub repository with Quarto sites and a Nix flake/devshell that provides `quarto`.

## Cloudflare (optional IaC) with Pulumi

You can manage Pages projects and custom domains as code.

### Quickstart (TypeScript)

```ts
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const cfg = new pulumi.Config();
const accountId = cfg.require("accountId");
const zoneName  = cfg.require("zone");          // e.g., "example.com"
const project   = cfg.require("projectName");    // e.g., "zeus"
const domain    = cfg.require("customDomain");   // e.g., "research.example.com"

// Optional: ensure the zone exists in your account (skip if already managed)
const zone = new cloudflare.Zone(zoneName, { accountId, zone: zoneName });

const pagesProject = new cloudflare.PagesProject(project, {
  accountId,
  name: project,
  productionBranch: "main",
});

const pagesDomain = new cloudflare.PagesDomain(`${project}-domain`, {
  accountId,
  projectName: pagesProject.name,
  domain,
});

export const pagesSubdomain = pagesProject.subdomain;
export const boundDomain    = pagesDomain.domain;
```

Deploy:

```bash
pulumi stack init dev
pulumi config set accountId <CLOUDFLARE_ACCOUNT_ID>
pulumi config set zone example.com
pulumi config set projectName zeus
pulumi config set customDomain research.example.com
pulumi up
```

Notes:

- If your zone is on Cloudflare, `PagesDomain` typically manages DNS for the subdomain automatically.
- Apex domains need CNAME flattening; this guide focuses on subdomains.

## GitHub configuration

Create the following in the caller repository:

- Secret `CLOUDFLARE_PAGES_API_TOKEN` with the token above.
- Variable `CLOUDFLARE_ACCOUNT_ID` with your account ID.

## Reusable workflow (consumer usage)

Call the reusable workflow with a JSON `sites` array. Each entry:

- `name`: logical name
- `path`: site root directory (where `_quarto.yml` lives)
- `dist`: build output directory (e.g., `research/_site`)
- `cloudflare_project_name`: the Pages project to deploy to
- `env_prod` / `env_preview`: GitHub environment names for deploys

Single-site example:

```yaml
name: Deploy research site
on:
  push:
    branches: [ main ]
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  deploy:
    uses: jmmaloney4/sector7/.github/workflows/quarto.yml@main
    with:
      runs-on: ubuntu-latest
      repository: ${{ github.repository }}
      ref: ${{ github.ref }}
      cloudflare-account-id: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
      sites: |
        [
          {
            "name": "research",
            "path": "research",
            "dist": "research/_site",
            "cloudflare_project_name": "zeus",
            "env_prod": "research-production",
            "env_preview": "research-preview"
          }
        ]
    secrets:
      cloudflare_api_token: ${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}
      github_token: ${{ secrets.GITHUB_TOKEN }}
```

Multi-site example:

```yaml
jobs:
  deploy:
    uses: jmmaloney4/sector7/.github/workflows/quarto.yml@main
    with:
      runs-on: ubuntu-latest
      repository: ${{ github.repository }}
      ref: ${{ github.ref }}
      cloudflare-account-id: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
      sites: |
        [
          {
            "name": "research",
            "path": "research",
            "dist": "research/_site",
            "cloudflare_project_name": "zeus",
            "env_prod": "research-production",
            "env_preview": "research-preview"
          },
          {
            "name": "docs",
            "path": "docs-site",
            "dist": "docs-site/_site",
            "cloudflare_project_name": "athena",
            "env_prod": "docs-production",
            "env_preview": "docs-preview"
          }
        ]
    secrets:
      cloudflare_api_token: ${{ secrets.CLOUDFLARE_PAGES_API_TOKEN }}
      github_token: ${{ secrets.GITHUB_TOKEN }}
```

### Why JSON for `sites`?

GitHub `workflow_call` inputs only support primitive types. Arrays/objects are not allowed as typed inputs, so we pass a JSON string and parse it with `fromJSON` inside the called workflow.

## Build details

- The reusable workflow uses Nix and runs: `nix develop -c quarto render ./${path}`.
- It validates `${dist}` contains `index.html` before deploying.
- Deploys via Cloudflare Pages Direct Uploads to the given project.
- Preview vs production environments are set based on branch (`main` → production).

## Troubleshooting

- 403 / permissions: verify token scopes and account ID.
- Project not found: create the Pages project first (UI or Pulumi), or ensure the name matches.
- Domain not active: ensure the zone is on Cloudflare and the subdomain is bound to the Pages project.
- Build failures: run `nix develop -c quarto render ./<path>` locally to reproduce.

## FAQ

**Can the deploy action configure custom domains?** No. Configure domains on the Pages project (UI/API/Pulumi). The deploy step only uploads build artifacts.

**Can Pulumi create all required resources?** Yes. Use `PagesProject` and `PagesDomain`. DNS is handled automatically for subdomains when the zone is on Cloudflare.

**Can I avoid JSON in inputs?** Not today. `workflow_call` doesn’t support object/array inputs; JSON parsing is the standard workaround.
