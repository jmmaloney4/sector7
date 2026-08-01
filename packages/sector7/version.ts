/**
 * Version of the `sector7` Pulumi resource plugin that this package's
 * plugin-backed resources bind to.
 *
 * It MUST equal this package's npm version: the provider binary is built from
 * the same git tag (jackpkgs pins `sector7` via nvfetcher and injects the tag
 * into `version.Version` with `-ldflags`), and the plugin cache directory is
 * `resource-sector7-v<version>`. A mismatch surfaces at deploy time as
 * `no resource plugin 'sector7' found in the workspace at version vX.Y.Z`.
 *
 * `just cut` bumps `package.json` but currently only understands
 * `type = "npm"` files, so this constant is maintained by hand and guarded by
 * `tests/version.test.ts`, which fails the build if the two drift. Teaching
 * `jackpkgs.just.cut` a generic file type would remove the manual step.
 */
export const PLUGIN_VERSION = "0.20.1";
