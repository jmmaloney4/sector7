// Package version carries the provider's build version.
package version

// Version is the plugin version reported to the Pulumi engine and embedded in
// the generated schema. It is overwritten at build time via
//
//	-ldflags "-X github.com/jmmaloney4/sector7/provider/version.Version=<v>"
//
// by the Nix derivation (pkgs/pulumi-resource-sector7 in jackpkgs), which
// derives <v> from the nvfetcher-pinned release tag with the leading "v"
// stripped.
//
// This MUST match the version the TypeScript wrappers pass in
// CustomResourceOptions.version, or the engine reports
// "no resource plugin 'sector7' found in the workspace at version vX.Y.Z".
// garden's checks.sector7-plugin-lockstep asserts that invariant at
// `nix flake check` time rather than at deploy time.
var Version = "dev"
