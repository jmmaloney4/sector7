// Package provider assembles the sector7 Pulumi resource provider.
//
// This replaces sector7's Pulumi *dynamic* providers. A dynamic provider
// serialises its JavaScript closure into stack state under `__provider`, and
// the engine re-executes that stored code on `refresh` and `delete`. Because
// sector7's port-forward transport had to pre-resolve an absolute path to
// @kubernetes/client-node to stay loadable under pnpm strict isolation, that
// machine- and directory-specific path was frozen into state — and when the
// git worktree it pointed at was deleted, `pulumi refresh` on
// organization/litellm/prod began failing with ERR_MODULE_NOT_FOUND.
//
// A plugin has no such failure mode: state records a *reference* to
// "provider sector7 vX.Y.Z", never code, so nothing about node_modules, pnpm
// layout or worktrees can be captured.
package provider

import (
	p "github.com/pulumi/pulumi-go-provider"
	"github.com/pulumi/pulumi-go-provider/infer"

	"github.com/jmmaloney4/sector7/provider/litellm"
)

// Name is the provider package name. The plugin binary MUST be named
// pulumi-resource-<Name> for the Pulumi CLI to discover it, both on $PATH and
// under $PULUMI_HOME/plugins/resource-<Name>-v<version>/.
const Name = "sector7"

// New builds the provider. Resources are added one family per release; see the
// migration plan. Every resource here must keep its schema byte-compatible
// with the dynamic provider it replaces, so that retyping a live resource via
// `aliases: [{ type: "pulumi-nodejs:dynamic:Resource" }]` diffs to nothing.
func New() (p.Provider, error) {
	return infer.NewProviderBuilder().
		WithNamespace("jmmaloney4").
		WithDisplayName("sector7").
		WithDescription("Resource provider for sector7 components (LiteLLM, Attic, 1Password, R2, D1).").
		WithHomepage("https://github.com/jmmaloney4/sector7").
		WithRepository("https://github.com/jmmaloney4/sector7").
		WithLicense("MIT").
		WithResources(
			// The token's module segment is derived from the Go package name,
			// so this registers as `sector7:litellm:TeamRecord` — matching the
			// token the TypeScript wrapper passes to pulumi.CustomResource.
			infer.Resource(litellm.TeamRecord{}),
			infer.Resource(litellm.KeyRecord{}),
		).
		Build()
}
