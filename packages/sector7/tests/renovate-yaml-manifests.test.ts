import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const yamlConfig = JSON.parse(
	readFileSync(
		resolve(import.meta.dirname, "../../../renovate/yaml-manifests.json"),
		"utf8",
	),
) as {
	customManagers: Array<{
		description: string;
		managerFilePatterns: string[];
		matchStrings: string[];
	}>;
};

function managerRegexes(description: string): RegExp[] {
	const manager = yamlConfig.customManagers.find(
		(candidate) => candidate.description === description,
	);

	expect(manager).toBeDefined();
	if (!manager) {
		throw new Error(`Missing manager: ${description}`);
	}
	return manager.matchStrings.map((pattern) => new RegExp(pattern, "m"));
}

function firstMatch(regexes: RegExp[], input: string) {
	return regexes.map((regex) => input.match(regex)).find(Boolean);
}

describe("renovate/yaml-manifests.json file patterns", () => {
	const patterns = yamlConfig.customManagers
		.flatMap((manager) => manager.managerFilePatterns ?? [])
		.map((pattern) => new RegExp(pattern));

	it("matches yaml and yml files", () => {
		const testFiles = [
			"kube-vip.yaml",
			"deployment.yml",
			"path/to/manifest.yaml",
			"deep/nested/Chart.yml",
		];

		for (const file of testFiles) {
			expect(
				patterns.some((regex) => regex.test(file)),
				`expected ${file} to match`,
			).toBe(true);
		}
	});

	it("does not match non-yaml files", () => {
		const testFiles = [
			"kube-vip.json",
			"README.md",
			"yaml-manifests.json",
		];

		for (const file of testFiles) {
			expect(
				patterns.some((regex) => regex.test(file)),
				`expected ${file} NOT to match`,
			).toBe(false);
		}
	});
});

describe("renovate/yaml-manifests.json container image regex manager", () => {
	const description = "Annotated container image string literals in YAML";

	it("matches unquoted kube-vip image with registry path", () => {
		const yaml = [
			"        - name: kube-vip",
			"          # renovate: datasource=docker",
			"          image: ghcr.io/kube-vip/kube-vip:v0.8.7",
		].join("\n");

		const match = firstMatch(managerRegexes(description), yaml);
		expect(match?.groups?.depName).toBe("ghcr.io/kube-vip/kube-vip");
		expect(match?.groups?.currentValue).toBe("v0.8.7");
	});

	it("matches Docker Hub images (no registry prefix)", () => {
		const yaml = [
			"          # renovate: datasource=docker",
			"          image: nginx:1.25.3",
		].join("\n");

		const match = firstMatch(managerRegexes(description), yaml);
		expect(match?.groups?.depName).toBe("nginx");
		expect(match?.groups?.currentValue).toBe("1.25.3");
	});

	it("matches images with digest pinning", () => {
		const yaml = [
			"          # renovate: datasource=docker",
			"          image: ghcr.io/kube-vip/kube-vip:v0.8.7@sha256:" +
				"a".repeat(64),
		].join("\n");

		const match = firstMatch(managerRegexes(description), yaml);
		expect(match?.groups?.depName).toBe("ghcr.io/kube-vip/kube-vip");
		expect(match?.groups?.currentValue).toBe("v0.8.7");
		expect(match?.groups?.currentDigest).toBe(`sha256:${"a".repeat(64)}`);
	});

	it("matches images with optional versioning override", () => {
		const yaml = [
			"          # renovate: datasource=docker versioning=semver",
			"          image: ghcr.io/kube-vip/kube-vip:v0.8.7",
		].join("\n");

		const match = firstMatch(managerRegexes(description), yaml);
		expect(match?.groups?.versioning).toBe("semver");
		expect(match?.groups?.depName).toBe("ghcr.io/kube-vip/kube-vip");
	});

	it("does not match unannotated image lines", () => {
		const yaml = "          image: ghcr.io/kube-vip/kube-vip:v0.8.7";

		expect(firstMatch(managerRegexes(description), yaml)).toBeUndefined();
	});
});

describe("renovate/yaml-manifests.json Helm chart version regex manager", () => {
	const description = "Annotated Helm chart versions in YAML";

	it("matches HelmChart CRD version with depName and registryUrl", () => {
		const yaml = [
			"spec:",
			"  # renovate: datasource=helm depName=cilium registryUrl=https://helm.cilium.io/",
			'  version: "1.17.15"',
		].join("\n");

		const match = firstMatch(managerRegexes(description), yaml);
		expect(match?.groups?.depName).toBe("cilium");
		expect(match?.groups?.registryUrl).toBe("https://helm.cilium.io/");
		expect(match?.groups?.currentValue).toBe("1.17.15");
	});

	it("matches unquoted version values", () => {
		const yaml = [
			"  # renovate: datasource=helm depName=traefik registryUrl=https://traefik.github.io/charts/",
			"  version: 27.0.0",
		].join("\n");

		const match = firstMatch(managerRegexes(description), yaml);
		expect(match?.groups?.depName).toBe("traefik");
		expect(match?.groups?.currentValue).toBe("27.0.0");
	});

	it("matches without registryUrl (depName only)", () => {
		const yaml = [
			"  # renovate: datasource=helm depName=cert-manager",
			'  version: "v1.14.5"',
		].join("\n");

		const match = firstMatch(managerRegexes(description), yaml);
		expect(match?.groups?.depName).toBe("cert-manager");
		expect(match?.groups?.registryUrl).toBeUndefined();
		expect(match?.groups?.currentValue).toBe("v1.14.5");
	});

	it("matches with parameters in a different order (registryUrl before depName)", () => {
		const yaml = [
			"  # renovate: datasource=helm registryUrl=https://helm.cilium.io/ depName=cilium",
			'  version: "1.17.15"',
		].join("\n");

		const match = firstMatch(managerRegexes(description), yaml);
		expect(match?.groups?.depName).toBe("cilium");
		expect(match?.groups?.registryUrl).toBe("https://helm.cilium.io/");
		expect(match?.groups?.currentValue).toBe("1.17.15");
	});

	it("does not match unannotated version lines", () => {
		const yaml = '  version: "1.17.15"';

		expect(firstMatch(managerRegexes(description), yaml)).toBeUndefined();
	});
});
