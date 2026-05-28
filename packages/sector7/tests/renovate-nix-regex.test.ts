import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const nixConfig = JSON.parse(
	readFileSync(
		resolve(import.meta.dirname, "../../../renovate/nix.json"),
		"utf8",
	),
) as {
	customManagers: Array<{
		description: string;
		matchStrings: string[];
	}>;
};

function managerRegexes(description: string): RegExp[] {
	const manager = nixConfig.customManagers.find(
		(candidate) => candidate.description === description,
	);

	expect(manager).toBeDefined();
	return manager!.matchStrings.map((pattern) => new RegExp(pattern, "m"));
}

function firstMatch(regexes: RegExp[], input: string) {
	return regexes.map((regex) => input.match(regex)).find(Boolean);
}

const sriHash = "sha256-XRJNwpeGjQSEPub34BLrPJn3Tj6Ie90/PB7LR2+tPmU=";

describe("renovate/nix.json mkHelmChartFromGitHub regex managers", () => {
	it("matches ARC chart blocks that use real Nix SRI hashes", () => {
		const arcRegexes = managerRegexes(
			"Update mkHelmChartFromGitHub ARC chart packages in Nix files",
		);
		const arcBlock = [
			"mkHelmChartFromGitHub rec {",
			'  pname = "gha-runner-scale-set-controller-chart";',
			'  version = "v0.27.6";',
			'  owner = "actions";',
			'  repo = "actions-runner-controller";',
			'  rev = "gha-runner-scale-set-${version}";',
			`  hash = "${sriHash}";`,
			"};",
		].join("\n");

		const match = firstMatch(arcRegexes, arcBlock);
		expect(match?.groups?.depName).toBe(
			"gha-runner-scale-set-controller-chart",
		);
		expect(match?.groups?.currentValue).toBe("v0.27.6");
		expect(match?.groups?.owner).toBe("actions");
		expect(match?.groups?.repo).toBe("actions-runner-controller");
	});

	it("matches generic chart blocks that use real Nix SRI hashes", () => {
		const genericRegexes = managerRegexes(
			"Update mkHelmChartFromGitHub packages in Nix files",
		);
		const genericBlock = `mkHelmChartFromGitHub {
  pname = "envoy-gateway-crds-chart";
  version = "1.8.0";
  owner = "envoyproxy";
  repo = "gateway";
  hash = "${sriHash}";
};`;

		const match = firstMatch(genericRegexes, genericBlock);
		expect(match?.groups?.depName).toBe("envoy-gateway-crds-chart");
		expect(match?.groups?.currentValue).toBe("1.8.0");
		expect(match?.groups?.owner).toBe("envoyproxy");
		expect(match?.groups?.repo).toBe("gateway");
	});

	it("matches generic chart blocks with chartSubdir before hash", () => {
		const genericRegexes = managerRegexes(
			"Update mkHelmChartFromGitHub packages in Nix files",
		);
		const chartSubdirBlock = `mkHelmChartFromGitHub rec {
  pname = "some-chart";
  version = "1.2.3";
  owner = "example";
  repo = "repo";
  chartSubdir = "charts/some-chart";
  hash = "${sriHash}";
};`;

		const match = firstMatch(genericRegexes, chartSubdirBlock);
		expect(match?.groups?.depName).toBe("some-chart");
		expect(match?.groups?.currentValue).toBe("1.2.3");
		expect(match?.groups?.owner).toBe("example");
		expect(match?.groups?.repo).toBe("repo");
	});

	it("matches let-bound ARC chart blocks that inherit version inside the attrset", () => {
		const arcRegexes = managerRegexes(
			"Update mkHelmChartFromGitHub ARC chart packages in Nix files",
		);
		const arcBlock = [
			"gha-runner-scale-set-controller-chart = let",
			'  version = "0.14.0";',
			"in",
			"  mkHelmChartFromGitHub {",
			"    inherit version;",
			'    pname = "gha-runner-scale-set-controller-chart";',
			'    owner = "actions";',
			'    repo = "actions-runner-controller";',
			'    rev = "gha-runner-scale-set-${version}";',
			`    hash = "${sriHash}";`,
			'    chartSubdir = "charts/gha-runner-scale-set-controller";',
			"  };",
		].join("\n");

		const match = firstMatch(arcRegexes, arcBlock);
		expect(match?.groups?.depName).toBe(
			"gha-runner-scale-set-controller-chart",
		);
		expect(match?.groups?.currentValue).toBe("0.14.0");
		expect(match?.groups?.owner).toBe("actions");
		expect(match?.groups?.repo).toBe("actions-runner-controller");
	});

	it("matches let-bound generic chart blocks that inherit version inside the attrset", () => {
		const genericRegexes = managerRegexes(
			"Update mkHelmChartFromGitHub packages in Nix files",
		);
		const genericBlock = [
			"envoy-gateway-crds-chart = let",
			'  version = "1.7.3";',
			"in",
			"  mkHelmChartFromGitHub {",
			"    inherit version;",
			'    pname = "envoy-gateway-crds-chart";',
			'    owner = "envoyproxy";',
			'    repo = "gateway";',
			`    hash = "${sriHash}";`,
			'    chartSubdir = "charts/gateway-crds-helm";',
			"  };",
		].join("\n");

		const match = firstMatch(genericRegexes, genericBlock);
		expect(match?.groups?.depName).toBe("envoy-gateway-crds-chart");
		expect(match?.groups?.currentValue).toBe("1.7.3");
		expect(match?.groups?.owner).toBe("envoyproxy");
		expect(match?.groups?.repo).toBe("gateway");
	});

	it("does not let the generic matcher swallow let-bound ARC chart blocks", () => {
		const genericRegexes = managerRegexes(
			"Update mkHelmChartFromGitHub packages in Nix files",
		);
		const arcBlock = [
			"gha-runner-scale-set-controller-chart = let",
			'  version = "0.14.0";',
			"in",
			"  mkHelmChartFromGitHub {",
			"    inherit version;",
			'    pname = "gha-runner-scale-set-controller-chart";',
			'    owner = "actions";',
			'    repo = "actions-runner-controller";',
			'    rev = "gha-runner-scale-set-${version}";',
			`    hash = "${sriHash}";`,
			'    chartSubdir = "charts/gha-runner-scale-set-controller";',
			"  };",
		].join("\n");

		expect(firstMatch(genericRegexes, arcBlock)).toBeUndefined();
	});

	it("does not let the generic matcher swallow ARC chart blocks with rev lines", () => {
		const genericRegexes = managerRegexes(
			"Update mkHelmChartFromGitHub packages in Nix files",
		);
		const arcBlock = [
			"mkHelmChartFromGitHub rec {",
			'  pname = "gha-runner-scale-set-controller-chart";',
			'  version = "v0.27.6";',
			'  owner = "actions";',
			'  repo = "actions-runner-controller";',
			'  rev = "gha-runner-scale-set-${version}";',
			`  hash = "${sriHash}";`,
			"};",
		].join("\n");

		expect(arcBlock.match(genericRegexes[0])).toBeNull();
	});
});
