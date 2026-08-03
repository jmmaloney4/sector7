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

	"github.com/jmmaloney4/sector7/provider/attic"
	"github.com/jmmaloney4/sector7/provider/d1"
	"github.com/jmmaloney4/sector7/provider/internal/kube"
	"github.com/jmmaloney4/sector7/provider/litellm"
	"github.com/jmmaloney4/sector7/provider/matrix"
	"github.com/jmmaloney4/sector7/provider/onepassword"
	"github.com/jmmaloney4/sector7/provider/r2"
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
	// ONE transport shared by every port-forwarded resource.
	//
	// Sharing is deliberate: SPDYTransport caches *rest.Config per kubeconfig
	// payload, so a single instance parses each kubeconfig once for the whole
	// process, and its mutex makes that cache safe under Pulumi's concurrent
	// gRPC serving. It caches configs, never forwards — each CRUD call still
	// opens its own port-forward.
	//
	// Passing it is NOT optional. kube.Transport is an interface, so a resource
	// registered as a bare `litellm.KeyRecord{}` carries a nil transport and
	// SEGFAULTS the whole provider process the moment it reaches connect() —
	// see resources() below.
	transport := &kube.SPDYTransport{}

	return infer.NewProviderBuilder().
		WithNamespace("jmmaloney4").
		WithDisplayName("sector7").
		WithDescription("Resource provider for sector7 components (LiteLLM, Attic, 1Password, R2, D1, Matrix).").
		WithHomepage("https://github.com/jmmaloney4/sector7").
		WithRepository("https://github.com/jmmaloney4/sector7").
		WithLicense("MIT").
		WithResources(resources(transport)...).
		Build()
}

// resources is every resource this provider serves, wired to tr.
//
// Split out of New so TestEveryKubeBackedResourceHasATransport can reflect over
// the exact values New registers. That test exists because the first four
// entries below shipped with a nil Transport from the very first release and
// nothing caught it for five releases: unit tests always construct these types
// with an explicit kube.Fake, and Check/Diff never touch the transport, so
// `preview` and `up` stayed green while the state was byte-identical. The first
// real Read — `pulumi refresh` against litellm/prod, after the migration had
// already landed — took the provider down with
//
//	panic: runtime error: invalid memory address or nil pointer dereference
//	  ...litellm.connect(...) client.go:43
//	  ...litellm.KeyRecord.Read(...) key.go:315
//
// A nil interface field is invisible to the compiler and to every test that
// bothers to populate it, which is exactly the shape of bug that needs a
// structural check rather than another unit test.
func resources(tr kube.Transport) []infer.InferredResource {
	return []infer.InferredResource{
		// The token's module segment is derived from the Go package name,
		// so this registers as `sector7:litellm:TeamRecord` — matching the
		// token the TypeScript wrapper passes to pulumi.CustomResource.
		infer.Resource(litellm.TeamRecord{Transport: tr}),
		infer.Resource(litellm.KeyRecord{Transport: tr}),
		infer.Resource(onepassword.Item{Transport: tr}),
		infer.Resource(attic.Cache{Transport: tr}),
		// attic.Token mints a JWT locally and never calls a server, so it
		// needs no transport — the reason it has no Transport field at all.
		infer.Resource(attic.Token{}),
		// d1 and r2 talk to the Cloudflare API directly over the public
		// internet; only ClusterIP-only Services need a port-forward.
		infer.Resource(d1.Query{}),
		infer.Resource(r2.ZoneCachePurge{}),
		infer.Resource(r2.Object{}),
		// Matrix resources were garden-LOCAL dynamic providers, not
		// sector7 ones. They live here because they carry the identical
		// serialised-closure fragility and a second plugin binary would
		// duplicate all the packaging, discovery and release machinery.
		// homeserverUrl is a public URL, so no transport either.
		infer.Resource(matrix.BotAccount{}),
		infer.Resource(matrix.Room{}),
	}
}
