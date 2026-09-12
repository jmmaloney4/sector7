import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const flakeNix = readFileSync(resolve(import.meta.dirname, "../../../flake.nix"), "utf8");

describe("pre-push vitest hook config", () => {
	it("uses runner config loader to avoid writing into node_modules/.vite-temp", () => {
		expect(flakeNix).toContain(
			'pre-commit.settings.hooks.vitest.args = ["--configLoader" "runner"];',
		);
	});
});
