---
id: ADR-022
title: GitHub App authentication for add-to-project workflow
status: Proposed
date: 2026-05-14
deciders: [Jack Maloney]
consulted: []
tags: [design, adr, ci, authentication]
supersedes: []
superseded_by: []
links:
  - https://github.com/actions/add-to-project/issues/158
  - https://github.com/jmmaloney4/sector7/issues/165
  - https://github.com/actions/create-github-app-token
---

# Context

The reusable workflow `.github/workflows/add-to-project.yml` adds issues and PRs
to an org-level GitHub Project. It currently requires a `github-token` secret
that must be a Personal Access Token (PAT). The built-in `GITHUB_TOKEN` will not
work because it is scoped to the triggering repository and cannot access
org-level Projects.

PAT-based authentication creates operational friction:

- PATs are tied to a specific user. If that user leaves or rotates the token,
  every repo calling this workflow must update its secret.
- A PAT makes all project modifications appear to come from the token owner,
  not from the automation itself.
- PATs require periodic manual rotation. Fine-grained PATs expire after one year.

A GitHub App installation token solves all three: it is org-scoped, identifies
itself as the app, and requires no periodic rotation (installation tokens are
short-lived and minted per-workflow-run).

## Scope

This ADR documents the authentication approach. The implementation plan
(`2026-05-02-github-app-add-to-project.md`) details the steps. This ADR covers
the design decision; the plan covers execution.

# Decision

The reusable workflow generates a GitHub App installation token itself using
`actions/create-github-app-token@v2` so callers only need to pass `app-id` and
`private-key` secrets. The token is then passed to
`actions/add-to-project` like any other token.

This keeps the complexity in one place (the reusable workflow) and gives callers
a simple `secrets:` block to wire up.

## Caller workflow

```yaml
jobs:
  add-to-project:
    uses: jmmaloney4/sector7/.github/workflows/add-to-project.yml@main
    secrets:
      app-id: ${{ secrets.SECTOR7_PROJECT_BOT_APP_ID }}
      private-key: ${{ secrets.SECTOR7_PROJECT_BOT_PRIVATE_KEY }}
```

## Reusable workflow (target state)

```yaml
on:
  workflow_call:
    inputs:
      runs-on:
        default: 'self-hosted'
        type: string
      project_url:
        default: 'https://github.com/orgs/ergodicsystems/projects/1'
        type: string
      owner:
        # Account that owns the app installation AND the project. Passed to
        # create-github-app-token so the token is minted against this
        # installation regardless of which repo triggers the workflow.
        default: 'ergodicsystems'
        type: string
      labeled:
        default: ''
        type: string
      label-operator:
        default: OR
        type: string
    secrets:
      app-id:
        required: false
      private-key:
        required: false
      github-token:
        description: Fallback PAT secret (legacy)
        required: false

permissions:
  contents: read

jobs:
  add-to-project:
    runs-on: ${{ inputs.runs-on }}
    env:
      # Mapped to job env so they can be referenced in step-level `if` (the
      # secrets context is not available in conditionals).
      APP_ID: ${{ secrets.app-id }}
      GH_FALLBACK_TOKEN: ${{ secrets.github-token }}
    steps:
      - name: Generate GitHub App token
        id: app-token
        if: ${{ env.APP_ID != '' }}
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0
        with:
          app-id: ${{ secrets.app-id }}
          private-key: ${{ secrets.private-key }}
          owner: ${{ inputs.owner }}

      - name: Verify auth provided
        if: ${{ steps.app-token.outputs.token == '' && env.GH_FALLBACK_TOKEN == '' }}
        shell: bash
        run: |
          echo "::error::add-to-project: no credentials provided. Pass app-id + private-key (preferred) or a github-token fallback."
          exit 1

      - name: Add issue or PR to project
        uses: jmmaloney4/sector7/.github/actions/add-to-project@main
        with:
          project-url: ${{ inputs.project_url }}
          github-token: ${{ steps.app-token.outputs.token || secrets.github-token }}
          labeled: ${{ inputs.labeled }}
          label-operator: ${{ inputs.label-operator }}
```

The `owner` input is the critical detail: `create-github-app-token` defaults
to minting a token for the **caller repo's account**, which only has an
installation if the caller lives in the same org as the app. Cross-org callers
(`jmmaloney4/garden`, `cavinsresearch/zeus`, ...) would otherwise fail with
"installation not found". Setting `owner` to the account that owns the app
installation makes token minting work from any repo. The actual workflow uses
the local `jmmaloney4/sector7/.github/actions/add-to-project` composite action
(gh CLI based) rather than `actions/add-to-project` directly.

## GitHub App registration

The app should be registered in the target org with these settings:

| Field                                 | Value                 |
| ------------------------------------- | --------------------- |
| Name                                  | `sector7-project-bot`              |
| Permissions → Organization → Projects | Read and write                     |
| Permissions → Repository → Metadata   | Read-only                          |
| Webhook                               | Active: unchecked                  |
| Where can this app be installed?      | Only on this account (`ergodicsystems`) |

Register it as **"Only on this account"** -- least privilege. The single
`ergodicsystems` installation is the only one that grants write access to the
org project; cross-org callers never need their own installation, they only need
the `app-id`/`private-key` to mint a token that targets the `ergodicsystems`
installation (via the `owner` input above).

The app only needs that one org-level installation -- it does not need to be
installed on individual consumer repos. Its permission to touch org projects
comes from the org installation itself.

## Required secrets

The app ID and private key should be stored as **organization secrets** on the
target org (preferred), so all consumer repos reference the same credential:

| Secret                            | Value             |
| --------------------------------- | ----------------- |
| `SECTOR7_PROJECT_BOT_APP_ID`      | App ID (integer)  |
| `SECTOR7_PROJECT_BOT_PRIVATE_KEY` | Full PEM contents |

For repos outside the org, store as repository secrets instead.

# Consequences

## Positive

- No PAT tied to a user identity. App identity survives personnel changes.
- Project modifications are attributed to the app, not an individual.
- No manual token rotation -- installation tokens are minted per run and expire
  after one hour.
- Finer-grained scoping: the app can be limited to org projects.
- Callers have a simple interface: two secrets, no token generation logic.

## Negative

- Requires creating and configuring a GitHub App at the org level.
- The reusable workflow now has an additional step and conditional logic.
- Private key storage in secrets must be rotated if compromised.
- Does not work for user-level projects.

# Alternatives

- **PAT (current approach)**: Simplest to set up, but ties automation to a user,
  requires manual rotation, and attributes changes to the token owner.
- **Token generation in caller workflow**: Puts the token minting step in every
  caller instead of the reusable workflow. This works (see issue #158 workarounds)
  but replicates the same two steps across all six consumer repos. Chose to
  centralize instead.
- **actions/create-github-app-token vs tibdex/github-app-token**: The official
  action (`actions/create-github-app-token@v2`) is preferred over `tibdex` because
  it is maintained by GitHub, supports configurable permissions out of the box,
  and requires no pinned SHA -- the action version is the pin.

# Security / Privacy / Compliance

- The `private-key` secret contains a private RSA key. Store as an org-level
  secret. Do not log or echo it.
- Installation tokens expire after one hour, limiting blast radius if leaked.
- The official `actions/create-github-app-token` action is pinned by version tag
  in the caller, not by SHA -- this is the recommended pinning method for this
  action (see its README for security guidance).
- Review which repos have the app installed. The app's token grants permissions
  across the org's projects regardless of which repo triggers it.

# Operational Notes

- When creating the GitHub App, generate a private key immediately and store it
  in the org-level secrets. The key is shown only once during creation.
- The app does not need a webhook URL or public endpoint -- it is used solely
  for token generation.
- If the private key is rotated, update the org-level secrets before the old key
  expires. All repos reference the same secret name, so this is a single update.
- The app's org project permissions take effect immediately -- no re-installation
  needed after changing permissions in the app settings.

# Status Transitions

None.

# Implementation Notes

The implementation plan is at
`docs/internal/plans/2026-05-02-github-app-add-to-project.md`. It covers:

1. Register the GitHub App in the org.
2. Store credentials as org-level secrets.
3. Update the reusable workflow to generate tokens internally.
4. Update caller workflows in all six consumer repos.
5. Verify end-to-end.

Owner: Jack Maloney

# References

- actions/add-to-project issue #158:
  https://github.com/actions/add-to-project/issues/158
- GitHub Community Discussion: GitHub Apps and V2 Projects:
  https://github.com/orgs/community/discussions/46681
- GitHub Docs: Authenticating with GitHub Apps:
  https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app
- GitHub App registration plan:
  `docs/internal/plans/2026-05-02-github-app-add-to-project.md`
- Sector7 issue #165 (tracking):
  https://github.com/jmmaloney4/sector7/issues/165
