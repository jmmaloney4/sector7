import { beforeEach, describe, expect, it, vi } from "vitest";

// AtticCache / AtticToken's own CRUD/Diff logic (cache-config HTTP calls,
// JWT minting) moved to provider/attic/cache.go and
// provider/attic/token_resource.go when these resources retyped onto the
// sector7 plugin (garden ADR 163) — see cache_test.go / token_resource_test.go
// for that coverage. What's left here is the TypeScript wrapper's OWN
// concerns: does construction reach the plugin with the right
// token/alias/secret-wrapping.
//
// The alias here is more involved than a flat dynamic-provider cutover
// (compare matrix/r2): the OLD shape was a ComponentResource wrapping an
// inner dynamic.Resource CHILD, so the alias must target the CHILD's exact
// nested URN (type, name suffix, AND parent) — see admin.ts's class docs for
// why the token itself also had to change to avoid a coincidental identity
// collision with the old component.

type CustomResourceCall = {
	type: string;
	name: string;
	args: Record<string, unknown>;
	opts: Record<string, unknown> | undefined;
};

const customResourceCalls: CustomResourceCall[] = [];

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
	// Mirrors the real SDK's format (createUrn.ts): a stable, inspectable
	// stand-in good enough to assert the alias's parent targets the OLD
	// component's URN and not this resource's own (different) type.
	const createUrn = vi.fn(
		(name: string, type: string) => `urn:mock:${type}::${name}`,
	);

	return {
		output,
		secret,
		createUrn,
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
	};
});

import * as pulumi from "@pulumi/pulumi";
import { AtticCache, AtticToken } from "../attic/admin.ts";
import {
	ATTIC_CLAIM_NAMESPACE,
	mintAtticToken,
	parseDurationSeconds,
} from "../attic/token.ts";

const SECRET_B64 = Buffer.from("attic-test-signing-secret").toString("base64");

const cacheArgs = {
	namespace: "attic-prod",
	hs256SecretBase64: SECRET_B64,
	deploymentName: "attic",
	port: 8080,
	cacheName: "mycache",
	isPublic: true,
};

const tokenArgs = {
	hs256SecretBase64: SECRET_B64,
	sub: "github-actions-ci",
	validity: "1y",
	caches: { mycache: { pull: true, push: true } },
};

describe("AtticCache construction", () => {
	beforeEach(() => {
		customResourceCalls.length = 0;
		vi.mocked(pulumi.createUrn).mockClear();
	});

	it("registers under sector7:atticprovider:Cache, not sector7:attic:Cache", () => {
		new AtticCache("attic-cache-mycache", cacheArgs);

		expect(customResourceCalls).toHaveLength(1);
		// Deliberately NOT "sector7:attic:Cache" — that token is what the OLD
		// ComponentResource already used live; reusing it here would collide.
		// See admin.ts's class doc for the full reasoning.
		expect(customResourceCalls[0].type).toBe("sector7:atticprovider:Cache");
	});

	it("aliases to the OLD nested child's exact URN: type, name suffix, and parent", () => {
		new AtticCache("attic-cache-mycache", cacheArgs);

		const call = customResourceCalls[0];
		expect(call.opts?.aliases).toEqual([
			{
				type: "pulumi-nodejs:dynamic:Resource",
				name: "attic-cache-mycache-cache",
				parent: "urn:mock:sector7:attic:Cache::attic-cache-mycache",
			},
		]);
		// The parent URN is built from the OLD component's token
		// ("sector7:attic:Cache"), never this resource's own
		// ("sector7:atticprovider:Cache") — a mixup here would target an alias
		// no old state actually has.
		expect(pulumi.createUrn).toHaveBeenCalledWith(
			"attic-cache-mycache",
			"sector7:attic:Cache",
		);
	});

	it("marks hs256SecretBase64 secret on the input side", () => {
		vi.mocked(pulumi.secret).mockClear();

		new AtticCache("attic-cache-mycache", cacheArgs);

		expect(pulumi.secret).toHaveBeenCalledWith(SECRET_B64);
	});

	it("passes cacheName and isPublic straight through as inputs", () => {
		new AtticCache("attic-cache-mycache", cacheArgs);

		const call = customResourceCalls[0];
		expect(call.args.cacheName).toBe("mycache");
		expect(call.args.isPublic).toBe(true);
	});
});

describe("AtticToken construction", () => {
	beforeEach(() => {
		customResourceCalls.length = 0;
		vi.mocked(pulumi.createUrn).mockClear();
	});

	it("registers under sector7:atticprovider:Token, not sector7:attic:Token", () => {
		new AtticToken("attic-ci-token-mycache", tokenArgs);

		expect(customResourceCalls).toHaveLength(1);
		expect(customResourceCalls[0].type).toBe("sector7:atticprovider:Token");
	});

	it("aliases to the OLD nested child's exact URN: type, name suffix, and parent", () => {
		new AtticToken("attic-ci-token-mycache", tokenArgs);

		const call = customResourceCalls[0];
		expect(call.opts?.aliases).toEqual([
			{
				type: "pulumi-nodejs:dynamic:Resource",
				name: "attic-ci-token-mycache-token",
				parent: "urn:mock:sector7:attic:Token::attic-ci-token-mycache",
			},
		]);
		expect(pulumi.createUrn).toHaveBeenCalledWith(
			"attic-ci-token-mycache",
			"sector7:attic:Token",
		);
	});

	it("marks hs256SecretBase64 secret on the input side", () => {
		vi.mocked(pulumi.secret).mockClear();

		new AtticToken("attic-ci-token-mycache", tokenArgs);

		expect(pulumi.secret).toHaveBeenCalledWith(SECRET_B64);
	});

	it("parses the public validity string/number into validitySeconds for the plugin", () => {
		new AtticToken("attic-ci-token-mycache", tokenArgs);
		expect(customResourceCalls[0].args.validitySeconds).toBe(31536000); // "1y"

		customResourceCalls.length = 0;
		new AtticToken("attic-ci-token-mycache", { ...tokenArgs, validity: 3600 });
		expect(customResourceCalls[0].args.validitySeconds).toBe(3600);
	});

	it("passes sub and caches straight through as inputs", () => {
		new AtticToken("attic-ci-token-mycache", tokenArgs);

		const call = customResourceCalls[0];
		expect(call.args.sub).toBe("github-actions-ci");
		expect(call.args.caches).toEqual({ mycache: { pull: true, push: true } });
	});
});

describe("mintAtticToken", () => {
	it("fails closed on an empty/undecodable signing secret", async () => {
		await expect(
			mintAtticToken({
				secretBase64: "",
				sub: "x",
				issuedAtSeconds: 0,
				expiresAtSeconds: 1,
				caches: {},
			}),
		).rejects.toThrow(/hs256 secret/);
	});

	it("mints a verifiable JWT with the Attic claim shape", async () => {
		const token = await mintAtticToken({
			secretBase64: SECRET_B64,
			sub: "github-actions-ci",
			issuedAtSeconds: 1000,
			expiresAtSeconds: 4600,
			caches: { mycache: { pull: true, push: true } },
		});
		const [headerSeg, payloadSeg] = token.split(".");
		const payload = JSON.parse(
			Buffer.from(payloadSeg, "base64url").toString("utf8"),
		);
		expect(
			JSON.parse(Buffer.from(headerSeg, "base64url").toString("utf8")),
		).toMatchObject({
			alg: "HS256",
			typ: "JWT",
		});
		expect(payload.sub).toBe("github-actions-ci");
		expect(payload[ATTIC_CLAIM_NAMESPACE]).toEqual({
			caches: { mycache: { r: 1, w: 1 } },
		});
	});
});

describe("parseDurationSeconds", () => {
	it("parses duration units and bare seconds", () => {
		expect(parseDurationSeconds("1y")).toBe(31536000);
		expect(parseDurationSeconds("90d")).toBe(7776000);
		expect(parseDurationSeconds("12h")).toBe(43200);
		expect(parseDurationSeconds("300s")).toBe(300);
		expect(parseDurationSeconds("300")).toBe(300);
		expect(parseDurationSeconds(300)).toBe(300);
	});

	it("rejects malformed and non-positive durations", () => {
		expect(() => parseDurationSeconds("soon")).toThrow();
		expect(() => parseDurationSeconds(0)).toThrow();
		expect(() => parseDurationSeconds("0")).toThrow();
		expect(() => parseDurationSeconds("0s")).toThrow();
		expect(() => parseDurationSeconds("9".repeat(400))).toThrow();
	});
});
