import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// R2Object's own CRUD/Diff logic (AWS Sig V4 signing, MD5 ETag comparison,
// replace-on-key/bucket/account-change) moved to
// provider/r2/object.go when this resource retyped onto the sector7 plugin
// (garden ADR 163) — see object_test.go for that coverage. What's left here
// is the TypeScript wrapper's OWN concerns: does construction reach the
// plugin with the right token/alias/secret-wrapping, and does the
// `uploadAssets`/`purgeZoneCache` orchestration around it still behave
// correctly.

type CustomResourceCall = {
	type: string;
	name: string;
	args: Record<string, unknown>;
	opts: Record<string, unknown> | undefined;
};

type DynamicResourceCall = {
	name: string;
	opts: Record<string, unknown> | undefined;
};

type AccountTokenCall = {
	name: string;
	opts: Record<string, unknown> | undefined;
};

const customResourceCalls: CustomResourceCall[] = [];
const dynamicResourceCalls: DynamicResourceCall[] = [];
const accountTokenCalls: AccountTokenCall[] = [];

vi.mock("@pulumi/pulumi", () => {
	const output = <T>(value: T) => ({
		apply: <U>(fn: (value: T) => U) => fn(value),
	});
	// Spy, not a plain identity function: an identity wrapper can't
	// distinguish "value passed through secret()" from "value passed through
	// untouched", so a test asserting only on the resolved value would pass
	// whether or not the constructor actually calls pulumi.secret(). Asserting
	// on the spy's call arguments is what makes that distinction observable.
	const secret = vi.fn(<T>(value: T) => value);

	return {
		all: <T>(value: T) => output(value),
		output,
		secret,
		mergeOptions: (
			left: Record<string, unknown> | undefined,
			right: Record<string, unknown>,
		) => ({ ...left, ...right }),
		CustomResource: class {
			constructor(
				type: string,
				name: string,
				args: Record<string, unknown>,
				opts?: Record<string, unknown>,
			) {
				customResourceCalls.push({ type, name, args, opts });
			}
		},
		dynamic: {
			Resource: class {
				constructor(
					_resourceProvider: unknown,
					name: string,
					_args: Record<string, unknown>,
					opts?: Record<string, unknown>,
				) {
					dynamicResourceCalls.push({ name, opts });
				}
			},
		},
	};
});

vi.mock("@pulumi/cloudflare", () => ({
	AccountToken: class {
		public readonly id = "token-id";
		public readonly value = {
			apply: (fn: (value: string) => string | Promise<string>) =>
				fn("token-value"),
		};

		constructor(
			name: string,
			_args: Record<string, unknown>,
			opts?: Record<string, unknown>,
		) {
			accountTokenCalls.push({ name, opts });
		}
	},
}));

import * as pulumi from "@pulumi/pulumi";
import { purgeZoneCache, R2Object, uploadAssets } from "../r2/r2object.ts";

const createArgs = (filePath: string) => ({
	accountId: "account-123",
	bucketName: "bucket-123",
	key: "index.html",
	filePath,
	contentType: "text/html; charset=utf-8",
	accessKeyId: "access-key",
	secretAccessKey: "secret-key",
});

const cloudProviderOpt = { provider: { urn: "cloudflare-provider" } };

describe("R2Object construction", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "r2object-test-"));
		customResourceCalls.length = 0;
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("registers under the sector7:r2:Object token with the dynamic-provider alias", () => {
		new R2Object("asset", createArgs(join(tempDir, "index.html")));

		expect(customResourceCalls).toHaveLength(1);
		const call = customResourceCalls[0];
		expect(call.type).toBe("sector7:r2:Object");
		// This is what makes the cutover a no-op: the engine matches this
		// resource against state written by the old dynamic provider and
		// rewrites the URN in place, instead of planning a delete+create.
		expect(call.opts?.aliases).toEqual([
			{ type: "pulumi-nodejs:dynamic:Resource" },
		]);
	});

	it("accepts provider/providers, unlike the dynamic provider it replaces", () => {
		// The old R2Object threw on provider/providers (it was a JS dynamic
		// resource; routing it through a cloud provider bridge failed with a
		// misleading unknown-token error). The plugin-backed resource has no
		// such constraint — provider/providers are ordinary supported options.
		expect(
			() =>
				new R2Object(
					"asset",
					createArgs(join(tempDir, "index.html")),
					cloudProviderOpt,
				),
		).not.toThrow();

		expect(customResourceCalls[0].opts).toMatchObject(cloudProviderOpt);
	});

	it("marks accessKeyId and secretAccessKey secret on the input side", () => {
		vi.mocked(pulumi.secret).mockClear();

		new R2Object("asset", createArgs(join(tempDir, "index.html")));

		expect(pulumi.secret).toHaveBeenCalledWith("access-key");
		expect(pulumi.secret).toHaveBeenCalledWith("secret-key");
	});
});

describe("uploadAssets", () => {
	beforeEach(() => {
		customResourceCalls.length = 0;
		accountTokenCalls.length = 0;
	});

	it("keeps provider options on the Cloudflare token but strips them from R2 objects", () => {
		uploadAssets(
			"site",
			{
				accountId: "account-123",
				bucketName: "bucket-123",
				files: [
					{
						key: "index.html",
						filePath: "/tmp/index.html",
						contentType: "text/html; charset=utf-8",
					},
				],
			},
			cloudProviderOpt,
		);

		expect(accountTokenCalls).toHaveLength(1);
		expect(accountTokenCalls[0].opts).toMatchObject(cloudProviderOpt);
		expect(customResourceCalls).toHaveLength(1);
		expect(customResourceCalls[0].opts).not.toHaveProperty("provider");
		expect(customResourceCalls[0].opts).not.toHaveProperty("providers");
	});
});

describe("purgeZoneCache", () => {
	beforeEach(() => {
		dynamicResourceCalls.length = 0;
		accountTokenCalls.length = 0;
	});

	it("rejects cloud provider options with a clear dynamic-resource error", () => {
		expect(() =>
			purgeZoneCache(
				"purge",
				{
					zoneId: "zone-123",
					apiToken: "token",
					trigger: "asset-hash",
				},
				cloudProviderOpt,
			),
		).toThrow(
			/purgeZoneCache is a Pulumi dynamic resource; do not pass provider\/providers/,
		);
	});
});
