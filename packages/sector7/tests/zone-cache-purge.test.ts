import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ZoneCachePurgeProvider = {
	check: (
		olds: Record<string, unknown>,
		news: Record<string, unknown>,
	) => Promise<{
		inputs: Record<string, unknown>;
		failures: Array<{ property: string; reason: string }>;
	}>;
	diff: (
		id: string,
		olds: Record<string, unknown>,
		news: Record<string, unknown>,
	) => Promise<{
		changes: boolean;
		replaces?: string[];
	}>;
	create: (inputs: Record<string, unknown>) => Promise<{
		id: string;
		outs: Record<string, unknown>;
	}>;
	update: (
		id: string,
		olds: Record<string, unknown>,
		news: Record<string, unknown>,
	) => Promise<{ outs: Record<string, unknown> }>;
	delete: (id: string, props: Record<string, unknown>) => Promise<void>;
};

let provider: ZoneCachePurgeProvider | undefined;

// Capture the provider from ZoneCachePurge constructor.
// The constructor passes the provider as the first arg to dynamic.Resource super().
vi.mock("@pulumi/pulumi", () => ({
	dynamic: {
		Resource: class {
			constructor(resourceProvider: ZoneCachePurgeProvider) {
				provider = resourceProvider;
			}
		},
	},
	mergeOptions: (..._opts: unknown[]) => ({}),
	secret: <T>(value: T) => value,
	// r2object.ts also exports R2Object (`extends pulumi.CustomResource`) from
	// the same module this file imports purgeZoneCache from — the class
	// declaration is evaluated at module-load time regardless of which export
	// this file actually uses, so CustomResource must exist here too or the
	// import throws before any test in this file runs.
	CustomResource: class {},
}));

import { purgeZoneCache } from "../r2/r2object.ts";

const baseArgs = {
	zoneId: "zone-abc123",
	apiToken: "test-token",
	trigger: "trigger-v1",
};

// Mock fetch to capture Cloudflare API calls
const mockFetch = vi.fn().mockResolvedValue({
	ok: true,
	status: 200,
	statusText: "OK",
	text: async () => '{"success": true}',
});

vi.stubGlobal("fetch", mockFetch);

describe("ZoneCachePurge provider", () => {
	beforeEach(() => {
		provider = undefined;
		mockFetch.mockClear();
		// Instantiate to capture provider
		purgeZoneCache("test-purge", baseArgs);
	});

	it("captures the provider on construction", () => {
		expect(provider).toBeDefined();
	});

	describe("check", () => {
		it("passes with valid required inputs", async () => {
			const result = await provider!.check({}, baseArgs);
			expect(result.failures).toEqual([]);
		});

		it("reports failures for missing required fields", async () => {
			const result = await provider!.check({}, {});
			const properties = result.failures.map((f) => f.property);
			expect(properties).toContain("zoneId");
			expect(properties).toContain("apiToken");
			expect(properties).toContain("trigger");
		});

		it("accepts optional files array", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					files: ["https://dev.example.com/index.html"],
				},
			);
			expect(result.failures).toEqual([]);
		});

		it("accepts optional hosts array", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					hosts: ["dev.example.com"],
				},
			);
			expect(result.failures).toEqual([]);
		});

		it("rejects non-array files value", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					files: "not-an-array",
				},
			);
			expect(result.failures).toEqual([
				{
					property: "files",
					reason: "files must be an array of non-empty URL strings",
				},
			]);
		});

		it("rejects files array with non-string elements", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					files: ["https://example.com", 123 as unknown as string],
				},
			);
			expect(result.failures).toEqual([
				{
					property: "files",
					reason: "files must be an array of non-empty URL strings",
				},
			]);
		});

		it("rejects files array with empty strings", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					files: ["https://example.com", ""],
				},
			);
			expect(result.failures).toEqual([
				{
					property: "files",
					reason: "files must be an array of non-empty URL strings",
				},
			]);
		});

		it("rejects empty files array", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					files: [],
				},
			);
			expect(result.failures).toEqual([
				{
					property: "files",
					reason:
						"files must not be empty — omit the property to purge the entire zone",
				},
			]);
		});

		it("rejects non-array hosts value", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					hosts: "not-an-array",
				},
			);
			expect(result.failures).toEqual([
				{
					property: "hosts",
					reason: "hosts must be an array of non-empty hostname strings",
				},
			]);
		});

		it("rejects hosts array with non-string elements", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					hosts: ["dev.example.com", null as unknown as string],
				},
			);
			expect(result.failures).toEqual([
				{
					property: "hosts",
					reason: "hosts must be an array of non-empty hostname strings",
				},
			]);
		});

		it("rejects empty hosts array", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					hosts: [],
				},
			);
			expect(result.failures).toEqual([
				{
					property: "hosts",
					reason:
						"hosts must not be empty — omit the property to purge the entire zone",
				},
			]);
		});

		it("rejects files array exceeding 30 items", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					files: Array.from(
						{ length: 31 },
						(_, i) => `https://example.com/${i}`,
					),
				},
			);
			expect(result.failures).toEqual([
				{
					property: "files",
					reason: "files must not exceed 30 items (Cloudflare API limit)",
				},
			]);
		});

		it("rejects hosts array exceeding 30 items", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					hosts: Array.from({ length: 31 }, (_, i) => `host${i}.example.com`),
				},
			);
			expect(result.failures).toEqual([
				{
					property: "hosts",
					reason: "hosts must not exceed 30 items (Cloudflare API limit)",
				},
			]);
		});

		it("rejects files and hosts provided together", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					files: ["https://dev.example.com/index.html"],
					hosts: ["dev.example.com"],
				},
			);
			expect(result.failures).toEqual([
				{ property: "files", reason: "files and hosts are mutually exclusive" },
			]);
		});

		it("accepts undefined files and hosts", async () => {
			const result = await provider!.check(
				{},
				{
					...baseArgs,
					files: undefined,
					hosts: undefined,
				},
			);
			expect(result.failures).toEqual([]);
		});
	});

	describe("diff", () => {
		it("detects no changes when inputs match", async () => {
			const result = await provider!.diff("id", baseArgs, baseArgs);
			expect(result.changes).toBe(false);
		});

		it("detects trigger change", async () => {
			const result = await provider!.diff("id", baseArgs, {
				...baseArgs,
				trigger: "trigger-v2",
			});
			expect(result.changes).toBe(true);
		});

		it("detects apiToken change", async () => {
			const result = await provider!.diff("id", baseArgs, {
				...baseArgs,
				apiToken: "new-token",
			});
			expect(result.changes).toBe(true);
		});

		it("detects zoneId change as a replace", async () => {
			const result = await provider!.diff("id", baseArgs, {
				...baseArgs,
				zoneId: "zone-new",
			});
			expect(result.changes).toBe(true);
			expect(result.replaces).toContain("zoneId");
		});

		it("detects files change", async () => {
			const result = await provider!.diff("id", baseArgs, {
				...baseArgs,
				files: ["https://dev.example.com/index.html"],
			});
			expect(result.changes).toBe(true);
		});

		it("detects hosts change", async () => {
			const result = await provider!.diff("id", baseArgs, {
				...baseArgs,
				hosts: ["dev.example.com"],
			});
			expect(result.changes).toBe(true);
		});

		it("treats undefined and empty files array as equivalent in diff", async () => {
			const result = await provider!.diff("id", baseArgs, {
				...baseArgs,
				files: [],
			});
			expect(result.changes).toBe(false);
		});

		it("treats undefined and empty hosts array as equivalent in diff", async () => {
			const result = await provider!.diff("id", baseArgs, {
				...baseArgs,
				hosts: [],
			});
			expect(result.changes).toBe(false);
		});

		it("detects change from files array to undefined", async () => {
			const result = await provider!.diff(
				"id",
				{
					...baseArgs,
					files: ["https://dev.example.com/index.html"],
				},
				baseArgs,
			);
			expect(result.changes).toBe(true);
		});

		it("treats reordered files array as equivalent", async () => {
			const result = await provider!.diff(
				"id",
				{
					...baseArgs,
					files: ["https://a.com", "https://b.com"],
				},
				{
					...baseArgs,
					files: ["https://b.com", "https://a.com"],
				},
			);
			expect(result.changes).toBe(false);
		});

		it("treats reordered hosts array as equivalent", async () => {
			const result = await provider!.diff(
				"id",
				{
					...baseArgs,
					hosts: ["a.example.com", "b.example.com"],
				},
				{
					...baseArgs,
					hosts: ["b.example.com", "a.example.com"],
				},
			);
			expect(result.changes).toBe(false);
		});

		it("detects change from hosts array to undefined", async () => {
			const result = await provider!.diff(
				"id",
				{
					...baseArgs,
					hosts: ["dev.example.com"],
				},
				baseArgs,
			);
			expect(result.changes).toBe(true);
		});
	});

	describe("create", () => {
		it("calls purgeZoneCacheApi with purge_everything when no files or hosts", async () => {
			await provider!.create(baseArgs);

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [url, opts] = mockFetch.mock.calls[0];
			expect(url).toContain("zone-abc123/purge_cache");
			expect(JSON.parse(opts.body)).toEqual({ purge_everything: true });
		});

		it("calls purgeZoneCacheApi with specific files when provided", async () => {
			const files = [
				"https://dev.example.com/index.html",
				"https://dev.example.com/styles.css",
			];
			await provider!.create({ ...baseArgs, files });

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [_url, opts] = mockFetch.mock.calls[0];
			expect(JSON.parse(opts.body)).toEqual({ files });
		});

		it("calls purgeZoneCacheApi with hosts when provided", async () => {
			const hosts = ["dev.example.com"];
			await provider!.create({ ...baseArgs, hosts });

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [_url, opts] = mockFetch.mock.calls[0];
			expect(JSON.parse(opts.body)).toEqual({ hosts });
		});

		it("prefers hosts over files when both are provided", async () => {
			const hosts = ["dev.example.com"];
			const files = ["https://dev.example.com/index.html"];
			await provider!.create({ ...baseArgs, files, hosts });

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [_url, opts] = mockFetch.mock.calls[0];
			expect(JSON.parse(opts.body)).toEqual({ hosts });
		});

		it("uses purge_everything when files is empty array", async () => {
			await provider!.create({ ...baseArgs, files: [] });

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [_url, opts] = mockFetch.mock.calls[0];
			expect(JSON.parse(opts.body)).toEqual({ purge_everything: true });
		});

		it("uses purge_everything when hosts is empty array", async () => {
			await provider!.create({ ...baseArgs, hosts: [] });

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [_url, opts] = mockFetch.mock.calls[0];
			expect(JSON.parse(opts.body)).toEqual({ purge_everything: true });
		});

		it("returns a stable id and outs", async () => {
			const result = await provider!.create(baseArgs);

			expect(result.id).toBe("purge-zone-abc123-trigger-v1");
			expect(result.outs).toEqual(baseArgs);
		});
	});

	describe("update", () => {
		it("calls purgeZoneCacheApi with new files", async () => {
			const files = ["https://prod.example.com/index.html"];
			await provider!.update("id", baseArgs, { ...baseArgs, files });

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [_url, opts] = mockFetch.mock.calls[0];
			expect(JSON.parse(opts.body)).toEqual({ files });
		});

		it("calls purgeZoneCacheApi with new hosts", async () => {
			const hosts = ["prod.example.com"];
			await provider!.update("id", baseArgs, { ...baseArgs, hosts });

			expect(mockFetch).toHaveBeenCalledTimes(1);
			const [_url, opts] = mockFetch.mock.calls[0];
			expect(JSON.parse(opts.body)).toEqual({ hosts });
		});

		it("returns new outs", async () => {
			const news = { ...baseArgs, trigger: "trigger-v2" };
			const result = await provider!.update("id", baseArgs, news);

			expect(result.outs).toEqual(news);
		});
	});

	describe("delete", () => {
		it("is a no-op and does not call fetch", async () => {
			await provider!.delete("id", baseArgs);
			expect(mockFetch).not.toHaveBeenCalled();
		});
	});
});
