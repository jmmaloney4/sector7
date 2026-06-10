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
