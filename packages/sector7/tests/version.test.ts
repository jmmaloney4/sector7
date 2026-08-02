import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLUGIN_VERSION } from "../version.ts";

describe("PLUGIN_VERSION", () => {
	// PLUGIN_VERSION is derived from package.json rather than hardcoded, so this
	// no longer guards against hand-maintained drift — it guards the resolution
	// itself. If the build layout moves version.ts relative to package.json, the
	// candidate paths in readPluginVersion() stop resolving and this fails.
	it("resolves this package's npm version", () => {
		const pkg = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { version: string };
		expect(PLUGIN_VERSION).toBe(pkg.version);
	});

	// The plugin cache directory is resource-sector7-v<version>; a non-semver
	// value would produce a directory Pulumi never looks in.
	it("is a bare semver with no leading v", () => {
		expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
	});
});
