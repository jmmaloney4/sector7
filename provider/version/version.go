// Package version carries the provider's build version.
package version

// Version is the plugin version reported to the Pulumi engine and embedded in
// the generated schema. It is overwritten at build time via
//
//	-ldflags "-X github.com/jmmaloney4/sector7/provider/version.Version=<v>"
//
// by packages.pulumi-resource-sector7 in THIS repo's own flake.nix (not
// jackpkgs — packaging moved here so this repo's own CI builds the plugin on
// every PR; see the comment on that derivation), which reads <v> straight
// off packages/sector7/package.json. checks.provider-version-stamped in the
// same flake.nix asserts the built binary actually reports that version via
// `pulumi package get-schema`, not just that this ldflags line is present —
// a build that silently drops the -X flag (e.g. a bad module path) leaves
// this var at its "dev" default with no other visible signal, which is
// exactly what shipped in v0.20.2 and made every operation on every sector7
// resource fail on litellm/prod.
//
// The reported version MUST match the version the TypeScript wrappers pass
// in CustomResourceOptions.version, or the engine reports "no resource
// plugin 'sector7' found in the workspace at version vX.Y.Z". garden's
// checks.sector7-plugin-lockstep asserts THAT invariant, at `nix flake
// check` time rather than at deploy time.
var Version = "dev"
