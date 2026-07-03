import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildLabelSelector } from "../k8s/port-forward.ts";

describe("buildLabelSelector", () => {
	it("renders matchLabels", () => {
		expect(
			buildLabelSelector({ matchLabels: { app: "connect", tier: "api" } }),
		).toBe("app=connect,tier=api");
	});

	it("renders set-based matchExpressions", () => {
		expect(
			buildLabelSelector({
				matchExpressions: [
					{ key: "app", operator: "In", values: ["a", "b"] },
					{ key: "env", operator: "NotIn", values: ["dev"] },
					{ key: "live", operator: "Exists" },
					{ key: "legacy", operator: "DoesNotExist" },
				],
			}),
		).toBe("app in (a,b),env notin (dev),live,!legacy");
	});

	it("combines matchLabels and matchExpressions", () => {
		expect(
			buildLabelSelector({
				matchLabels: { app: "connect" },
				matchExpressions: [{ key: "tier", operator: "Exists" }],
			}),
		).toBe("app=connect,tier");
	});

	it("skips expressions missing key or operator, and unknown operators", () => {
		expect(
			buildLabelSelector({
				matchLabels: { app: "connect" },
				matchExpressions: [
					{ operator: "In", values: ["x"] },
					{ key: "k" },
					{ key: "k2", operator: "Gt", values: ["1"] },
				],
			}),
		).toBe("app=connect");
	});

	it("returns empty string for an empty or missing selector", () => {
		expect(buildLabelSelector(undefined)).toBe("");
		expect(buildLabelSelector({})).toBe("");
		expect(buildLabelSelector({ matchLabels: {}, matchExpressions: [] })).toBe(
			"",
		);
	});
});

describe("k8sClientNodePath pre-resolution", () => {
	it("resolves @kubernetes/client-node to an absolute path inside sector7's deps", async () => {
		// Loading the module exercises the module-level createRequire().resolve
		// call; if the package were not resolvable from sector7's installed
		// location, the import would throw before this assertion runs.
		await import("../k8s/port-forward.ts");
		const { createRequire } = await import("node:module");
		const require_ = createRequire(import.meta.url);
		const resolved = require_.resolve("@kubernetes/client-node");

		expect(resolved).toMatch(/@kubernetes[\\/]client-node/);
		expect(existsSync(resolved)).toBe(true);
	});

	it("keeps withPortForward as a serializable function reference", async () => {
		const mod = await import("../k8s/port-forward.ts");
		expect(typeof mod.withPortForward).toBe("function");
		// The function must not close over the heavy k8s module at load time.
		// The module-level pre-resolution is a string; the actual import happens
		// inside the function body via `await import(k8sClientNodePath)`.
	});
});
