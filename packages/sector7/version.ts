import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);

/**
 * Version of the `sector7` Pulumi resource plugin that this package's
 * plugin-backed resources bind to.
 *
 * It is read from package.json rather than hardcoded, because it MUST equal
 * this package's npm version: the provider binary is built from the same git
 * tag, and the plugin cache directory is `resource-sector7-v<version>`. A
 * mismatch surfaces at deploy time as `no resource plugin 'sector7' found in
 * the workspace at version vX.Y.Z`.
 *
 * Deriving it removes a release footgun. `just cut` bumps package.json but only
 * understands `type = "npm"` files, so a hardcoded constant here would go stale
 * on every single release — and the release commit itself would be the one that
 * broke, since the drift guard fires as part of it.
 *
 * Two candidate paths, because the relative location differs between source and
 * build output: `./package.json` when running from
 * `packages/sector7/version.ts` (vitest executes the TypeScript directly), and
 * `../package.json` from `dist/version.js` in the published tarball, where npm
 * always includes package.json regardless of the `files` allowlist.
 */
function readPluginVersion(): string {
	const candidates = ["./package.json", "../package.json"];
	for (const candidate of candidates) {
		try {
			const pkg = require_(candidate) as { name?: string; version?: string };
			// Only accept our own package.json — guards against resolving some
			// other one if the build layout ever changes.
			if (pkg.name === "@jmmaloney4/sector7" && pkg.version) {
				return pkg.version;
			}
		} catch {
			// Try the next candidate.
		}
	}
	throw new Error(
		"sector7: could not read the plugin version from package.json " +
			`(tried ${candidates.join(", ")} relative to ${import.meta.url})`,
	);
}

export const PLUGIN_VERSION: string = readPluginVersion();
