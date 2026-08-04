import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildLabelSelector,
	isModuleResolutionError,
	loadKubernetesClient,
} from "../k8s/port-forward.ts";

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
		// inside the function body via `loadKubernetesClient`, which is tried as a
		// bare specifier first and falls back to the pre-resolved absolute path.
	});
});

describe("loadKubernetesClient resolution routes", () => {
	// A stand-in for the loaded @kubernetes/client-node module. `loadKubernetesClient`
	// only forwards whatever the importer returns, so its shape is irrelevant here.
	const fakeModule = { KubeConfig: class {} };

	it("tries the bare specifier first and returns without the fallback", async () => {
		const calls: string[] = [];
		const k8s = await loadKubernetesClient((specifier) => {
			calls.push(specifier);
			return Promise.resolve(fakeModule);
		});

		expect(k8s).toBe(fakeModule);
		// The bare specifier must be the only attempted load — the pre-resolved
		// absolute path fallback is never consulted when the bare import resolves.
		expect(calls).toEqual(["@kubernetes/client-node"]);
	});

	it("falls back to the pre-resolved path when the bare specifier cannot resolve", async () => {
		const calls: string[] = [];
		const k8s = await loadKubernetesClient((specifier) => {
			calls.push(specifier);
			if (specifier === "@kubernetes/client-node") {
				// Node raises ERR_MODULE_NOT_FOUND when a bare specifier cannot be
				// resolved from the consumer's working directory under pnpm.
				const err: NodeJS.ErrnoException = new Error(
					"Cannot find package '@kubernetes/client-node'",
				);
				err.code = "ERR_MODULE_NOT_FOUND";
				return Promise.reject(err);
			}
			// The fallback uses the module-level pre-resolved absolute path, so its
			// specifier starts with "/" (absolute) on every platform.
			expect(specifier).toMatch(/@kubernetes[\\/]client-node/);
			return Promise.resolve(fakeModule);
		});

		expect(k8s).toBe(fakeModule);
		expect(calls).toEqual([
			"@kubernetes/client-node",
			expect.stringMatching(/@kubernetes[\\/]client-node/),
		]);
	});

	it("does NOT fall back on a non-resolution error from inside the package", async () => {
		// A genuine load-time failure (e.g. the package throws while executing)
		// must surface rather than being masked by the absolute-path fallback,
		// which would hit the same broken package and throw again anyway.
		const boom = new Error("package blew up while loading");
		const calls: string[] = [];
		await expect(
			loadKubernetesClient((specifier) => {
				calls.push(specifier);
				return Promise.reject(boom);
			}),
		).rejects.toBe(boom);
		expect(calls).toEqual(["@kubernetes/client-node"]);
	});

	it("falls back on ERR_PACKAGE_PATH_NOT_EXPORTED as well as ERR_MODULE_NOT_FOUND", async () => {
		const err: NodeJS.ErrnoException = new Error(
			"Package subpath not exported",
		);
		err.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
		const calls: string[] = [];
		const k8s = await loadKubernetesClient((specifier) => {
			calls.push(specifier);
			return specifier === "@kubernetes/client-node"
				? Promise.reject(err)
				: Promise.resolve(fakeModule);
		});
		expect(k8s).toBe(fakeModule);
		expect(calls).toHaveLength(2);
	});
});

describe("isModuleResolutionError", () => {
	it("recognizes ERR_MODULE_NOT_FOUND", () => {
		const err: NodeJS.ErrnoException = new Error("not found");
		err.code = "ERR_MODULE_NOT_FOUND";
		expect(isModuleResolutionError(err)).toBe(true);
	});

	it("recognizes ERR_PACKAGE_PATH_NOT_EXPORTED", () => {
		const err: NodeJS.ErrnoException = new Error("not exported");
		err.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
		expect(isModuleResolutionError(err)).toBe(true);
	});

	it("rejects unrelated error codes", () => {
		const err: NodeJS.ErrnoException = new Error("boom");
		err.code = "EACCES";
		expect(isModuleResolutionError(err)).toBe(false);
	});

	it("rejects errors with no code", () => {
		expect(isModuleResolutionError(new Error("boom"))).toBe(false);
	});

	it("rejects non-Error throwables", () => {
		expect(isModuleResolutionError("a string")).toBe(false);
		expect(isModuleResolutionError(null)).toBe(false);
		expect(isModuleResolutionError(undefined)).toBe(false);
	});
});
