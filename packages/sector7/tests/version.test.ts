import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLUGIN_VERSION } from "../version.ts";

describe("PLUGIN_VERSION", () => {
	// The provider binary is built from the same git tag and installed as
	// `resource-sector7-v<version>`, so a drift here surfaces at deploy time as
	// "no resource plugin 'sector7' found in the workspace at version vX.Y.Z".
	// `just cut` bumps package.json but not this constant, so this test is the
	// forcing function.
	it("matches the package.json version", () => {
		const pkg = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { version: string };
		expect(PLUGIN_VERSION).toBe(pkg.version);
	});
});
