# sector7 Documentation

This is the **user-facing** documentation for the reusable building blocks that
`sector7` ships: GitHub Actions workflows, Pulumi components, Renovate presets,
and the Quarto site toolchain — what they are, how to adopt them, what you can
configure, common workflows, and the gotchas worth knowing before you hit them.

> **`docs/` vs `docs/internal/`**
>
> - **`docs/`** (this tree) — *how to use and adopt* a building block. Audience:
>   an operator or repo maintainer who wants to consume one of these from their
>   own project. Start here.
> - **`docs/internal/`** — *why it's built the way it is*. Architecture Decision
>   Records (`docs/internal/designs/`) and development plans
>   (`docs/internal/plans/`). Audience: contributors. User-facing pages link
>   *out* to these for the reasoning; they don't restate it.

## Systems

Each system has the same five-page shape (drop pages that genuinely don't apply
rather than padding them):

| Page               | What it answers                                   |
| ------------------ | ------------------------------------------------- |
| `README.md`        | What it is, what we built, the topology           |
| `deploy.md`        | How it's deployed / how to deploy it from scratch |
| `configuration.md` | What you can configure and where                  |
| `workflows.md`     | Common day-to-day workflows                       |
| `faq.md`           | Gotchas and frequently-asked questions            |

### Catalog

- **[renovate](./renovate/README.md)** — composable Renovate presets for
  dependency management: the shared defaults, the per-ecosystem PR groups, the
  schedule/automerge policy, and the custom managers for Docker, Helm, Nix, and
  Pulumi pins. *(Full five-page shape.)*
- **[actions](./actions/README.md)** — reusable GitHub Actions workflows and
  composite actions for Rust, Nix, Pulumi, and Claude AI.
- **[pulumi](./pulumi/README.md)** — the `@jmmaloney4/sector7` package of
  reusable Pulumi components (WorkerSite, NixImage, LiteLLM proxy, and more).
- **[quarto](./quarto/README.md)** — the Quarto static-site toolchain wired to
  Cloudflare Workers / R2.

_The `actions`, `pulumi`, and `quarto` systems currently carry a single
`README.md`; they can grow into the full five-page shape as the need arises._

## Conventions

- **Raw Markdown, browsed on GitHub.** No build step. Use relative links between
  pages (`./configuration.md`, `../pulumi/README.md`).
- **Link out for the "why."** Reference design docs as
  `docs/internal/designs/NNN-slug.md` rather than duplicating decisions.
- **Secrets are references, never values.** Document the `op://` path or the
  agenix secret name — never paste a credential.
- **One system per directory.** Copy the `renovate/` pages as the template for
  the next system.
