import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pulumiConfig = JSON.parse(
	readFileSync(
		resolve(import.meta.dirname, "../../../renovate/pulumi.json"),
		"utf8",
	),
) as {
	customManagers: Array<{
		customType: string;
		managerFilePatterns: string[];
		matchStrings: string[];
		autoReplaceStringTemplate?: string;
	}>;
};

// Select by a stable property (targets Pulumi config files) rather than by
// array position, so reordering or adding managers can't silently make these
// tests exercise the wrong configuration.
function selectPulumiManager() {
	const matches = pulumiConfig.customManagers.filter((m) =>
		m.managerFilePatterns.some((pattern) => pattern.includes("Pulumi")),
	);
	if (matches.length !== 1) {
		throw new Error(
			`expected exactly one Pulumi customManager, found ${matches.length}`,
		);
	}
	return matches[0];
}

const manager = selectPulumiManager();
const regexes = manager.matchStrings.map((pattern) => new RegExp(pattern));

function firstMatch(input: string) {
	return regexes.map((regex) => input.match(regex)).find(Boolean);
}

// The only dependency fields Renovate carries from a custom-manager match onto
// the upgrade object that renders the *Template fields (including
// autoReplaceStringTemplate). Capture groups outside this set are dropped after
// extraction, so referencing them in a replace template yields an empty string.
// Source: renovate lib/modules/manager/custom/utils.ts (validMatchFields) and
// lib/modules/manager/custom/regex/utils.ts (createDependency).
const VALID_MATCH_FIELDS = new Set([
	"depName",
	"packageName",
	"currentValue",
	"currentDigest",
	"datasource",
	"versioning",
	"extractVersion",
	"registryUrl",
	"depType",
	"indentation",
]);

const SAMPLE =
	"  observability:tempoChartVersion: 2.2.0 # renovate: datasource=helm depName=tempo registryUrl=https://grafana-community.github.io/helm-charts";

describe("renovate/pulumi.json Pulumi YAML version manager", () => {
	it("extracts the annotated dependency", () => {
		const match = firstMatch(SAMPLE);
		expect(match?.groups?.versionKey).toBe("observability:tempoChartVersion");
		expect(match?.groups?.currentValue).toBe("2.2.0");
		expect(match?.groups?.datasource).toBe("helm");
		expect(match?.groups?.depName).toBe("tempo");
		expect(match?.groups?.registryUrl).toBe(
			"https://grafana-community.github.io/helm-charts",
		);
	});

	it("matches a single-segment stack-config key", () => {
		const match = firstMatch(
			"  langfuse:chartVersion: 1.5.31 # renovate: datasource=helm depName=langfuse registryUrl=https://langfuse.github.io/langfuse-k8s",
		);
		expect(match?.groups?.depName).toBe("langfuse");
		expect(match?.groups?.currentValue).toBe("1.5.31");
	});

	it("does not match an unannotated version line", () => {
		expect(
			firstMatch("  observability:tempoChartVersion: 2.2.0"),
		).toBeUndefined();
	});

	// Regression guard for WORKER_FILE_UPDATE_FAILED ("Error updating branch:
	// update failure"). Renovate's default in-place replacement rewrites only
	// currentValue; the resulting line must still re-extract to the new version
	// (this mirrors Renovate's post-replace confirmIfDepUpdated check). A line
	// that fails to re-extract aborts the whole update.
	it("round-trips: the in-place-rewritten line re-extracts to the new version", () => {
		const match = firstMatch(SAMPLE);
		expect(match).toBeTruthy();
		const rewritten = SAMPLE.replace(match!.groups!.currentValue, "2.2.3");
		// the key, annotation and registryUrl must survive untouched
		expect(rewritten).toContain("observability:tempoChartVersion: 2.2.3");

		const reMatch = firstMatch(rewritten);
		expect(reMatch?.groups?.currentValue).toBe("2.2.3");
		expect(reMatch?.groups?.depName).toBe("tempo");
	});

	// The original bug: an autoReplaceStringTemplate referencing `versionKey`
	// (a capture group Renovate does not carry onto the upgrade object) rendered
	// it empty and corrupted the line. Forbid any replace template that
	// references a captured group which is not a valid Renovate match field.
	it("any autoReplaceStringTemplate only references valid Renovate match fields", () => {
		const template = manager.autoReplaceStringTemplate;
		if (!template) {
			// Fixed state: no template, so Renovate's default in-place
			// replacement is used. Nothing further to check.
			return;
		}
		// Computed update fields are always available on the upgrade object.
		const ALWAYS_AVAILABLE = new Set([
			"newValue",
			"newDigest",
			"newName",
			"newVersion",
		]);
		const referenced = [...template.matchAll(/\{\{\{?\s*(\w+)\s*\}?\}\}/g)].map(
			(m) => m[1],
		);
		for (const name of referenced) {
			if (ALWAYS_AVAILABLE.has(name)) {
				continue;
			}
			// Anything else must be a field Renovate actually carries onto the
			// upgrade object. A custom capture group (e.g. `versionKey`) or a
			// typo is NOT carried and renders empty, corrupting the file — fail
			// for any such reference, not just known capture groups.
			expect(
				VALID_MATCH_FIELDS.has(name),
				`autoReplaceStringTemplate references "${name}", which Renovate does not carry onto the upgrade object (not a computed field or valid match field) — it will render empty and corrupt the file`,
			).toBe(true);
		}
	});
});
