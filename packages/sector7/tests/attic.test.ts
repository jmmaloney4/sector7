import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (same capture pattern as litellm-admin.test.ts)
//
// AtticCache / AtticToken are ComponentResources that each construct an inner
// `dynamic.Resource`. We mock @pulumi/pulumi to (a) make the component
// constructors inert and (b) capture the ResourceProvider passed to
// dynamic.Resource's super(), then exercise the provider directly.
//
// The cache provider opens a port-forward and `fetch`es the cache-config API; we
// stub @kubernetes/client-node and node:net so it yields a local base URL without
// a real cluster, and stub global fetch to capture the calls. The token provider
// needs neither — it mints a JWT in-process via the real node:crypto.
// ---------------------------------------------------------------------------

type Provider = {
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
	) => Promise<{ changes: boolean; replaces?: string[] }>;
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

const capturedProviders: Provider[] = [];

vi.mock("@pulumi/pulumi", () => {
	// biome-ignore lint/suspicious/noExplicitAny: minimal Output stand-in for tests
	const output = (value: any): any => ({
		// biome-ignore lint/suspicious/noExplicitAny: identity apply for tests
		apply: (fn: (v: any) => any) => output(fn(value)),
	});
	return {
		ComponentResource: class {
			registerOutputs() {}
		},
		dynamic: {
			Resource: class {
				constructor(provider: Provider) {
					capturedProviders.push(provider);
				}
			},
		},
		output,
		// biome-ignore lint/suspicious/noExplicitAny: identity for tests
		secret: (v: any) => v,
	};
});

const apiStubs = {
	readNamespacedDeployment: vi.fn().mockResolvedValue({
		spec: { selector: { matchLabels: { app: "attic" } } },
	}),
	listNamespacedPod: vi.fn().mockResolvedValue({
		items: [
			{
				metadata: { name: "attic-pod-1" },
				status: {
					phase: "Running",
					conditions: [{ type: "Ready", status: "True" }],
				},
			},
		],
	}),
};

vi.mock("@kubernetes/client-node", () => ({
	KubeConfig: class {
		loadFromDefault() {}
		makeApiClient(_ctor: { name: string }) {
			return apiStubs;
		}
	},
	AppsV1Api: class AppsV1Api {},
	CoreV1Api: class CoreV1Api {},
	PortForward: class {
		portForward() {
			return Promise.resolve();
		}
	},
}));

vi.mock("node:net", () => ({
	createServer: () => {
		const server = {
			// biome-ignore lint/suspicious/noExplicitAny: minimal EventEmitter-ish stub
			once: (_event: string, _cb: any) => server,
			listen: (_port: number, _host: string, cb: () => void) => {
				cb();
				return server;
			},
			address: () => ({ port: 41000 }),
			close: (cb?: () => void) => {
				cb?.();
				return server;
			},
		};
		return server;
	},
}));

import { AtticCache, AtticToken } from "../attic/admin.ts";
import {
	ATTIC_CLAIM_NAMESPACE,
	mintAtticToken,
	parseDurationSeconds,
} from "../attic/token.ts";

const SECRET_B64 = Buffer.from("attic-test-signing-secret").toString("base64");

const cacheTarget = {
	namespace: "attic-prod",
	hs256SecretBase64: SECRET_B64,
	deploymentName: "attic",
	port: 8080,
};

function cacheInputs(overrides: Record<string, unknown> = {}) {
	return {
		...cacheTarget,
		cacheName: "mycache",
		isPublic: true,
		priority: 0,
		storeDir: "/nix/store",
		upstreamCacheKeyNames: [] as string[],
		retentionPeriodSeconds: "" as number | "",
		...overrides,
	};
}

// A mock fetch returning canned cache-config responses; responder may set a
// status (defaults 200) and a body (object → JSON, string → raw text).
function installFetch(
	responder: (
		path: string,
		method: string,
		body: unknown,
	) => { status?: number; body?: unknown } | undefined,
) {
	const calls: Array<{ path: string; method: string; body: unknown }> = [];
	const mock = vi.fn(async (url: string, init?: RequestInit) => {
		const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, "");
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		calls.push({ path, method, body });
		const r = responder(path, method, body) ?? {};
		const status = r.status ?? 200;
		const payload = r.body ?? {};
		return {
			ok: status >= 200 && status < 300,
			status,
			statusText: "",
			text: async () =>
				typeof payload === "string" ? payload : JSON.stringify(payload),
		} as Response;
	});
	vi.stubGlobal("fetch", mock);
	return calls;
}

let cacheProvider: Provider;
let tokenProvider: Provider;

beforeEach(() => {
	capturedProviders.length = 0;
	new AtticCache("c", {
		...cacheTarget,
		cacheName: "mycache",
	});
	new AtticToken("t", {
		hs256SecretBase64: SECRET_B64,
		sub: "github-actions-ci",
		validity: "1y",
		caches: { mycache: { pull: true, push: true } },
	});
	[cacheProvider, tokenProvider] = capturedProviders;
	vi.unstubAllGlobals();
});

describe("AtticCache provider — diff", () => {
	it("treats a config change as an in-place update (no replacement)", async () => {
		const olds = { ...cacheInputs(), publicKey: "pk:1" };
		const result = await cacheProvider.diff("mycache", olds, {
			...cacheInputs(),
			priority: 41,
		});
		expect(result.changes).toBe(true);
		expect(result.replaces ?? []).toEqual([]);
	});

	it("ignores upstream-key ordering", async () => {
		const olds = {
			...cacheInputs({ upstreamCacheKeyNames: ["a", "b", "c"] }),
			publicKey: "pk:1",
		};
		const result = await cacheProvider.diff("mycache", olds, {
			...cacheInputs({ upstreamCacheKeyNames: ["c", "a", "b"] }),
		});
		expect(result.changes).toBe(false);
	});

	it("replaces when the cache name changes", async () => {
		const olds = { ...cacheInputs(), publicKey: "pk:1" };
		const result = await cacheProvider.diff("mycache", olds, {
			...cacheInputs(),
			cacheName: "othercache",
		});
		expect(result.replaces).toEqual(["cacheName"]);
	});

	it("replaces when the store dir changes", async () => {
		const olds = { ...cacheInputs(), publicKey: "pk:1" };
		const result = await cacheProvider.diff("mycache", olds, {
			...cacheInputs(),
			storeDir: "/alt/store",
		});
		expect(result.replaces).toEqual(["storeDir"]);
	});

	it("treats an admin-target change as an in-place update", async () => {
		const olds = { ...cacheInputs(), publicKey: "pk:1" };
		const result = await cacheProvider.diff("mycache", olds, {
			...cacheInputs(),
			hs256SecretBase64: Buffer.from("rotated").toString("base64"),
			deploymentName: "attic-canary",
		});
		expect(result.changes).toBe(true);
		expect(result.replaces ?? []).toEqual([]);
	});
});

describe("AtticCache provider — lifecycle", () => {
	it("creates a fresh cache and reads back its public key", async () => {
		const calls = installFetch((_path, method) => {
			if (method === "POST")
				return { status: 200, body: { public_key: "pk:new" } };
			if (method === "GET") return { body: { public_key: "pk:new" } };
			return {};
		});
		const result = await cacheProvider.create(cacheInputs());
		expect(result.id).toBe("mycache");
		expect(result.outs.publicKey).toBe("pk:new");
		const methods = calls.map((c) => c.method);
		expect(methods).toEqual(["POST", "GET"]);
		expect(calls[0].path).toBe("/_api/v1/cache-config/mycache");
		expect(calls[0].body).toMatchObject({
			keypair: "Generate",
			is_public: true,
		});
	});

	it("adopts an existing cache via PATCH on CacheAlreadyExists", async () => {
		const calls = installFetch((_path, method) => {
			if (method === "POST")
				return { status: 400, body: "Error: CacheAlreadyExists" };
			if (method === "PATCH") return { body: {} };
			if (method === "GET")
				return { body: { public_key: "pk:existing", store_dir: "/nix/store" } };
			return {};
		});
		const result = await cacheProvider.create(cacheInputs());
		expect(result.outs.publicKey).toBe("pk:existing");
		const methods = calls.map((c) => c.method);
		// Adoption GETs to verify the immutable store_dir, then reconciles via PATCH
		// (never re-POST, which would regenerate the keypair), then re-reads the key.
		expect(methods).toEqual(["POST", "GET", "PATCH", "GET"]);
		const patch = calls.find((c) => c.method === "PATCH");
		expect(patch?.body).toMatchObject({ is_public: true, priority: 0 });
	});

	it("refuses to adopt a cache whose immutable store_dir differs", async () => {
		installFetch((_path, method) => {
			if (method === "POST")
				return { status: 400, body: "Error: CacheAlreadyExists" };
			if (method === "GET")
				return { body: { public_key: "pk", store_dir: "/alt/store" } };
			return {};
		});
		await expect(cacheProvider.create(cacheInputs())).rejects.toThrow(
			/store_dir/,
		);
	});

	it("refuses to adopt when the existing store_dir is unverifiable", async () => {
		installFetch((_path, method) => {
			if (method === "POST")
				return { status: 400, body: "Error: CacheAlreadyExists" };
			if (method === "GET") return { body: { public_key: "pk" } }; // no store_dir
			return {};
		});
		await expect(cacheProvider.create(cacheInputs())).rejects.toThrow(
			/store_dir/,
		);
	});

	it("PATCHes a fresh cache's retention when requested", async () => {
		const calls = installFetch((_path, method) => {
			if (method === "POST") return { status: 200, body: { public_key: "pk" } };
			if (method === "PATCH") return { body: {} };
			if (method === "GET") return { body: { public_key: "pk" } };
			return {};
		});
		await cacheProvider.create(cacheInputs({ retentionPeriodSeconds: 86400 }));
		const patch = calls.find((c) => c.method === "PATCH");
		expect(patch?.body).toMatchObject({ retention_period: { Period: 86400 } });
	});

	it("updates a cache via PATCH and re-reads the public key", async () => {
		const calls = installFetch((_path, method) => {
			if (method === "PATCH") return { body: {} };
			if (method === "GET") return { body: { public_key: "pk:2" } };
			return {};
		});
		const olds = { ...cacheInputs(), publicKey: "pk:1" };
		const result = await cacheProvider.update("mycache", olds, {
			...cacheInputs(),
			priority: 10,
		});
		expect(result.outs.publicKey).toBe("pk:2");
		const methods = calls.map((c) => c.method);
		expect(methods).toEqual(["PATCH", "GET"]);
		expect(calls[0].body).toMatchObject({ priority: 10 });
	});

	it("deletes a cache via DELETE", async () => {
		const calls = installFetch(() => ({ body: {} }));
		await cacheProvider.delete("mycache", {
			...cacheInputs(),
			publicKey: "pk:1",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("DELETE");
		expect(calls[0].path).toBe("/_api/v1/cache-config/mycache");
	});

	it("treats a 404 on delete as success (idempotent under drift)", async () => {
		const calls = installFetch(() => ({ status: 404, body: "NoSuchCache" }));
		await expect(
			cacheProvider.delete("mycache", { ...cacheInputs(), publicKey: "pk:1" }),
		).resolves.toBeUndefined();
		expect(calls[0].method).toBe("DELETE");
	});

	it("fails fast when the cache config has no public_key", async () => {
		installFetch((_path, method) => {
			if (method === "POST") return { status: 200, body: {} };
			if (method === "GET") return { body: {} }; // missing public_key
			return {};
		});
		await expect(cacheProvider.create(cacheInputs())).rejects.toThrow(
			/public_key/,
		);
	});
});

describe("AtticCache provider — check", () => {
	it("rejects a non-positive retention period", async () => {
		const res = await cacheProvider.check(
			{},
			{ ...cacheInputs(), retentionPeriodSeconds: 0 },
		);
		expect(res.failures.map((f) => f.property)).toContain(
			"retentionPeriodSeconds",
		);
	});

	it("accepts an unset or positive retention period", async () => {
		const unset = await cacheProvider.check({}, cacheInputs());
		expect(unset.failures).toEqual([]);
		const positive = await cacheProvider.check(
			{},
			{ ...cacheInputs(), retentionPeriodSeconds: 86400 },
		);
		expect(positive.failures).toEqual([]);
	});

	it("flags missing required fields", async () => {
		const res = await cacheProvider.check(
			{},
			{ ...cacheInputs(), namespace: "", cacheName: "" },
		);
		const props = res.failures.map((f) => f.property);
		expect(props).toContain("namespace");
		expect(props).toContain("cacheName");
	});
});

describe("AtticToken provider", () => {
	const tokenInputs = {
		hs256SecretBase64: SECRET_B64,
		sub: "github-actions-ci",
		validitySeconds: 3600,
		caches: { mycache: { pull: true, push: true } },
	};

	function decodeSegment(seg: string): Record<string, unknown> {
		return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
	}

	it("mints a verifiable JWT with the Attic claim shape, not leaking it into the id", async () => {
		const result = await tokenProvider.create(tokenInputs);
		const token = result.outs.token as string;
		const [headerSeg, payloadSeg, signatureSeg] = token.split(".");

		// id is an opaque uuid, never the token itself.
		expect(result.id).not.toContain(token);
		expect(result.id).toMatch(/^[0-9a-f-]{36}$/);

		// Signature verifies against the base64-decoded secret.
		const expected = crypto
			.createHmac("sha256", Buffer.from(SECRET_B64, "base64"))
			.update(`${headerSeg}.${payloadSeg}`)
			.digest("base64url");
		expect(signatureSeg).toBe(expected);

		expect(decodeSegment(headerSeg)).toMatchObject({
			alg: "HS256",
			typ: "JWT",
		});
		const payload = decodeSegment(payloadSeg);
		expect(payload.sub).toBe("github-actions-ci");
		expect(payload.exp).toBe((payload.nbf as number) + 3600);
		expect(result.outs.expiresAt).toBe(
			(result.outs.notBefore as number) + 3600,
		);
		// Permission short-keys under the Attic namespace claim.
		expect(payload[ATTIC_CLAIM_NAMESPACE]).toEqual({
			caches: { mycache: { r: true, w: true } },
		});
	});

	it("emits only the granted permission flags", async () => {
		const result = await tokenProvider.create({
			...tokenInputs,
			caches: { "team-*": { pull: true, createCache: true } },
		});
		const payload = decodeSegment((result.outs.token as string).split(".")[1]);
		expect(payload[ATTIC_CLAIM_NAMESPACE]).toEqual({
			caches: { "team-*": { r: true, cc: true } },
		});
	});

	it("replaces on any claim-affecting input change", async () => {
		const olds = {
			...tokenInputs,
			token: "old",
			expiresAt: 1,
			notBefore: 0,
		};
		expect((await tokenProvider.diff("id", olds, tokenInputs)).changes).toBe(
			false,
		);
		expect(
			(await tokenProvider.diff("id", olds, { ...tokenInputs, sub: "other" }))
				.replaces,
		).toEqual(["sub"]);
		expect(
			(
				await tokenProvider.diff("id", olds, {
					...tokenInputs,
					validitySeconds: 7200,
				})
			).replaces,
		).toEqual(["validitySeconds"]);
		expect(
			(
				await tokenProvider.diff("id", olds, {
					...tokenInputs,
					caches: { mycache: { pull: true } },
				})
			).replaces,
		).toEqual(["caches"]);
	});

	it("delete is a no-op (stateless JWT cannot be revoked)", async () => {
		await expect(
			tokenProvider.delete("id", { ...tokenInputs, token: "x" }),
		).resolves.toBeUndefined();
	});

	it("rejects a non-finite validity in check (would serialize exp as null)", async () => {
		const res = await tokenProvider.check(
			{},
			{ ...tokenInputs, validitySeconds: Number.POSITIVE_INFINITY },
		);
		expect(res.failures.map((f) => f.property)).toContain("validitySeconds");
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
