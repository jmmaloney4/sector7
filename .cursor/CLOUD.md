# Cursor Cloud: sector7

Cloud-specific operating notes. Follow root `AGENTS.md` (especially workflow-call contracts, composite action references, and TypeScript export boundaries) and the relevant subsystem's documentation.

## Setup and orientation

- Sector7 is shared CI/infrastructure tooling, not a deployed application: reusable workflows in `.github/workflows/`, composite actions in `.github/actions/`, TypeScript Pulumi components in `packages/sector7/`, a Go resource provider in `provider/`, and Renovate presets in `renovate/`.
- The root `flake.nix` defines the Nix development shell and checks using jackpkgs. Prefer the existing shell (`nix develop` or direnv) with `nix`, `just`, `pnpm`, and Go available. If unavailable, report the limitation instead of repeatedly installing tools or mutating the machine.
- Read the relevant `docs/actions/README.md`, `docs/pulumi/README.md`, `docs/renovate/README.md`, or `docs/internal/designs/` entry before changing a consumer contract. Search only within the impacted subsystem first.

## Validation and safety

- For Pulumi TypeScript changes, prefer targeted `pnpm --dir packages/sector7 test` / `pnpm --dir packages/sector7 build`; inspect package subpath exports and barrel guards. For Go provider work, run `go test ./...` from `provider/` (with race checking when appropriate).
- For workflow/composite-action changes, inspect caller inputs, explicit permissions and secrets, checkout refs, and relevant local shell tests. Validate the affected paths; do not dispatch live workflows for a documentation or static check.
- The repository-wide gates are `nix fmt -L` and `nix flake check -L`. Do not claim they passed unless they ran successfully; note any unavailable tools or blocked checks.
- Do not run `pulumi up`, deploy, push caches/images, publish packages, rotate secrets, or otherwise mutate live infrastructure without explicit task authorization. Preserve preview-only defaults and avoid unnecessary `flake.lock` changes.

## Efficient execution and handoff

- Work on one bounded task, use targeted file reads/searches, and reuse findings in a short handoff rather than repeatedly exploring the tree. Avoid background polling, speculative agent fan-out, and unnecessary status loops.
- Report changed paths, affected consumer contracts, checks actually run, anything unverified, and follow-up risk. Do not expose credentials or secret values.
