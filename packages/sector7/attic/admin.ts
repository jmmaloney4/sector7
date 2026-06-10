import * as pulumi from "@pulumi/pulumi";
import {
	type CustomResourceOptions,
	dynamic,
	type Output,
} from "@pulumi/pulumi";
import { withPortForward } from "../k8s/port-forward.ts";
import type { AtticCacheArgs, AtticTokenArgs } from "./config-types.ts";
import {
	type AtticCacheGrants,
	type AtticCachePermissionFlags,
	mintAtticToken,
	parseDurationSeconds,
} from "./token.ts";

/**
 * Resource options accepted by sector7 dynamic resources.
 *
 * Pulumi dynamic resources are executed by the Node.js dynamic provider runtime,
 * not by a cloud provider plugin. Passing `provider` or `providers` makes Pulumi
 * route the resource through the wrong provider bridge, which fails with a
 * misleading `pulumi-nodejs:dynamic:Resource` unknown-token error.
 */
export type DynamicResourceOptions = Omit<
	CustomResourceOptions,
	"provider" | "providers"
>;

// ---------------------------------------------------------------------------
// Resolved provider input/state shapes
//
// Pulumi resolves every `Input<T>` before invoking the dynamic provider, so the
// callbacks below see plain JSON values only. Optional fields are normalized to
// sentinel empty values ("" / [] / {}) by the wrapping component so the provider
// never has to reason about `undefined`.
// ---------------------------------------------------------------------------

/** Coordinates + signing secret for reaching the Attic cache-config API. */
interface AdminTarget {
	namespace: string;
	hs256SecretBase64: string;
	deploymentName: string;
	port: number;
}

interface CacheProviderInputs extends AdminTarget {
	cacheName: string;
	isPublic: boolean;
	priority: number;
	storeDir: string;
	upstreamCacheKeyNames: string[];
	/** "" when unset (server default / `Global`). */
	retentionPeriodSeconds: number | "";
}

interface CacheProviderState extends CacheProviderInputs {
	/** Public NAR-signing key, read back from the cache config. */
	publicKey: string;
}

interface TokenProviderInputs {
	hs256SecretBase64: string;
	sub: string;
	validitySeconds: number;
	caches: AtticCacheGrants;
}

interface TokenProviderState extends TokenProviderInputs {
	/** The signed JWT (a bearer credential — kept out of the resource id). */
	token: string;
	/** Baked `exp`, unix seconds. */
	expiresAt: number;
	/** Baked `nbf`, unix seconds. */
	notBefore: number;
}

// ---------------------------------------------------------------------------
// Runtime helpers
//
// Like the LiteLLM admin providers, the in-process port-forward lives in the
// shared `../k8s/port-forward` module (`withPortForward`), whose lazy
// `await import()` of @kubernetes/client-node / node:net keeps the provider
// closures serializable. The helpers below otherwise use only the global `fetch`
// and `mintAtticToken` (whose own node:crypto import is lazy), so they hold no
// top-level native imports either.
// https://www.pulumi.com/docs/concepts/resources/dynamic-providers/#how-dynamic-providers-are-serialized
// ---------------------------------------------------------------------------

const ADMIN_SUB = "sector7-attic-cache";
/** Short admin-token validity — only needs to outlive a single API call. */
const ADMIN_TOKEN_VALIDITY_SECONDS = 300;

const ADMIN_CREATE_FLAGS: AtticCachePermissionFlags = {
	pull: true,
	createCache: true,
	configureCache: true,
	configureCacheRetention: true,
};
const ADMIN_UPDATE_FLAGS: AtticCachePermissionFlags = {
	pull: true,
	configureCache: true,
	configureCacheRetention: true,
};
const ADMIN_DELETE_FLAGS: AtticCachePermissionFlags = {
	pull: true,
	destroyCache: true,
};

/**
 * Mint a short-lived admin token scoped to a single cache and the permissions a
 * specific operation needs (least privilege), signed from the server's HS256
 * secret. No server contact — the token is self-contained.
 */
async function mintAdminToken(
	target: AdminTarget,
	cacheName: string,
	flags: AtticCachePermissionFlags,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return mintAtticToken({
		secretBase64: target.hs256SecretBase64,
		sub: ADMIN_SUB,
		issuedAtSeconds: now,
		expiresAtSeconds: now + ADMIN_TOKEN_VALIDITY_SECONDS,
		caches: { [cacheName]: flags },
	});
}

/** Open a short-lived port-forward to a ready Attic pod for `fn`. */
async function withCacheBaseUrl<T>(
	target: AdminTarget,
	fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
	return withPortForward(
		{
			namespace: target.namespace,
			deploymentName: target.deploymentName,
			port: target.port,
		},
		fn,
	);
}

interface AtticResponse {
	status: number;
	ok: boolean;
	text: string;
	// biome-ignore lint/suspicious/noExplicitAny: cache-config responses are dynamic JSON
	json: any;
}

/** Low-level cache-config request that surfaces the status so callers can branch. */
async function atticFetch(
	baseUrl: string,
	token: string,
	path: string,
	method: "GET" | "POST" | "PATCH" | "DELETE",
	body?: unknown,
): Promise<AtticResponse> {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	// biome-ignore lint/suspicious/noExplicitAny: cache-config responses are dynamic JSON
	let json: any;
	try {
		json = text ? JSON.parse(text) : {};
	} catch {
		json = undefined;
	}
	return { status: response.status, ok: response.ok, text, json };
}

/** Throw on a non-2xx cache-config response; otherwise return the parsed body. */
function ensureOk(
	res: AtticResponse,
	method: string,
	path: string,
	// biome-ignore lint/suspicious/noExplicitAny: cache-config responses are dynamic JSON
): any {
	if (!res.ok) {
		throw new Error(
			`Attic ${method} ${path} failed: ${res.status}\n${res.text}`,
		);
	}
	return res.json;
}

/** Render the optional retention into Attic's `RetentionPeriodConfig` wire form. */
function retentionPeriod(
	retentionPeriodSeconds: number | "",
): "Global" | { Period: number } {
	return retentionPeriodSeconds === ""
		? "Global"
		: { Period: retentionPeriodSeconds };
}

/** `CreateCacheRequest` body (POST) — keypair is always server-generated. */
function buildCreateBody(inputs: CacheProviderInputs): Record<string, unknown> {
	return {
		keypair: "Generate",
		is_public: inputs.isPublic,
		store_dir: inputs.storeDir,
		priority: inputs.priority,
		upstream_cache_key_names: inputs.upstreamCacheKeyNames,
	};
}

/**
 * `CacheConfig` body (PATCH) reconciling the mutable fields. Deliberately omits
 * `keypair` (never rotate) and `store_dir` (immutable in our model — a change is
 * a replacement), so adoption preserves the existing signing key.
 */
function buildPatchBody(inputs: CacheProviderInputs): Record<string, unknown> {
	return {
		is_public: inputs.isPublic,
		priority: inputs.priority,
		upstream_cache_key_names: inputs.upstreamCacheKeyNames,
		retention_period: retentionPeriod(inputs.retentionPeriodSeconds),
	};
}

/** GET the cache config and return its public signing key. */
async function readPublicKey(
	baseUrl: string,
	token: string,
	cacheName: string,
): Promise<string> {
	const path = `/_api/v1/cache-config/${cacheName}`;
	const config = ensureOk(
		await atticFetch(baseUrl, token, path, "GET"),
		"GET",
		path,
	);
	// Fail fast on a missing key: silently returning "" would persist an unusable
	// signing key in state and hide a broken/incompatible Attic API response.
	const publicKey = config?.public_key;
	if (typeof publicKey !== "string" || publicKey.length === 0) {
		throw new Error(
			`Attic GET ${path} returned no public_key — cannot resolve the cache signing key`,
		);
	}
	return publicKey;
}

/**
 * True when any admin-connection field changed. Such a change does not alter the
 * remote cache, but it must still flow into stored state so a later update/delete
 * targets the new deployment and mints under the new secret — so diff() treats it
 * as an in-place change.
 */
function adminTargetChanged(olds: AdminTarget, news: AdminTarget): boolean {
	return (
		olds.namespace !== news.namespace ||
		olds.deploymentName !== news.deploymentName ||
		olds.port !== news.port ||
		olds.hs256SecretBase64 !== news.hs256SecretBase64
	);
}

/** Stable JSON for order-insensitive comparison in diff(). */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return JSON.stringify([...value].map(stableValue).sort());
	}
	return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		return Object.keys(obj)
			.sort()
			.reduce<Record<string, unknown>>((acc, key) => {
				acc[key] = stableValue(obj[key]);
				return acc;
			}, {});
	}
	return value;
}

// ---------------------------------------------------------------------------
// Cache provider
// ---------------------------------------------------------------------------

const cacheProvider: dynamic.ResourceProvider = {
	async check(
		_olds: CacheProviderState,
		news: CacheProviderInputs,
	): Promise<dynamic.CheckResult> {
		const failures: dynamic.CheckFailure[] = [];
		for (const property of [
			"namespace",
			"hs256SecretBase64",
			"deploymentName",
			"cacheName",
		] as const) {
			if (!news[property]) {
				failures.push({ property, reason: `${property} is required` });
			}
		}
		// "" means "unset" (server default / Global); any provided retention must be
		// a positive number of seconds. Catch it at preview rather than on apply.
		if (
			news.retentionPeriodSeconds !== "" &&
			(typeof news.retentionPeriodSeconds !== "number" ||
				!Number.isFinite(news.retentionPeriodSeconds) ||
				news.retentionPeriodSeconds <= 0)
		) {
			failures.push({
				property: "retentionPeriodSeconds",
				reason: "retentionPeriodSeconds must be a positive number of seconds",
			});
		}
		return { inputs: news, failures };
	},

	async diff(
		_id: string,
		olds: CacheProviderState,
		news: CacheProviderInputs,
	): Promise<dynamic.DiffResult> {
		const replaces: string[] = [];
		// Renaming a cache or changing its store dir is a different cache.
		if (olds.cacheName !== news.cacheName) replaces.push("cacheName");
		if (olds.storeDir !== news.storeDir) replaces.push("storeDir");
		const changed =
			replaces.length > 0 ||
			adminTargetChanged(olds, news) ||
			olds.isPublic !== news.isPublic ||
			olds.priority !== news.priority ||
			stableJson(olds.upstreamCacheKeyNames) !==
				stableJson(news.upstreamCacheKeyNames) ||
			(olds.retentionPeriodSeconds ?? "") !==
				(news.retentionPeriodSeconds ?? "");
		return { changes: changed, replaces, deleteBeforeReplace: false };
	},

	async create(inputs: CacheProviderInputs): Promise<dynamic.CreateResult> {
		const token = await mintAdminToken(
			inputs,
			inputs.cacheName,
			ADMIN_CREATE_FLAGS,
		);
		return withCacheBaseUrl(inputs, async (baseUrl) => {
			const path = `/_api/v1/cache-config/${inputs.cacheName}`;
			const res = await atticFetch(
				baseUrl,
				token,
				path,
				"POST",
				buildCreateBody(inputs),
			);
			if (res.ok) {
				// Created fresh. CreateCacheRequest has no retention field, so apply a
				// requested retention with a follow-up PATCH.
				if (inputs.retentionPeriodSeconds !== "") {
					ensureOk(
						await atticFetch(baseUrl, token, path, "PATCH", {
							retention_period: retentionPeriod(inputs.retentionPeriodSeconds),
						}),
						"PATCH",
						path,
					);
				}
			} else if (
				res.status === 400 &&
				res.text.includes("CacheAlreadyExists")
			) {
				// Idempotent adoption: reconcile the existing cache's config in place.
				// POST is create-only, so going through PATCH preserves the keypair —
				// and thus every client's trusted-public-keys.
				//
				// First verify the immutable store_dir matches: buildPatchBody omits
				// store_dir (a change is modeled as a replacement, not an update), so
				// adopting a same-named cache that points at a different store dir would
				// silently record the desired storeDir in state while the remote keeps
				// its own. Fail loudly instead of misrepresenting drift.
				//
				// Fail *closed*: if the GET doesn't report a string store_dir we cannot
				// confirm the immutable field, so refuse rather than adopt an unverified
				// cache and record an assumed storeDir in state.
				const existing = ensureOk(
					await atticFetch(baseUrl, token, path, "GET"),
					"GET",
					path,
				);
				if (
					typeof existing?.store_dir !== "string" ||
					existing.store_dir !== inputs.storeDir
				) {
					throw new Error(
						`Attic cache "${inputs.cacheName}" already exists but its store_dir (${JSON.stringify(existing?.store_dir)}) is absent or differs from the requested "${inputs.storeDir}". store_dir is immutable — refusing to adopt; align storeDir or choose a different cacheName.`,
					);
				}
				ensureOk(
					await atticFetch(
						baseUrl,
						token,
						path,
						"PATCH",
						buildPatchBody(inputs),
					),
					"PATCH",
					path,
				);
			} else {
				ensureOk(res, "POST", path);
			}
			const publicKey = await readPublicKey(baseUrl, token, inputs.cacheName);
			return { id: inputs.cacheName, outs: { ...inputs, publicKey } };
		});
	},

	async update(
		_id: string,
		_olds: CacheProviderState,
		news: CacheProviderInputs,
	): Promise<dynamic.UpdateResult> {
		const token = await mintAdminToken(
			news,
			news.cacheName,
			ADMIN_UPDATE_FLAGS,
		);
		return withCacheBaseUrl(news, async (baseUrl) => {
			const path = `/_api/v1/cache-config/${news.cacheName}`;
			ensureOk(
				await atticFetch(baseUrl, token, path, "PATCH", buildPatchBody(news)),
				"PATCH",
				path,
			);
			const publicKey = await readPublicKey(baseUrl, token, news.cacheName);
			return { outs: { ...news, publicKey } };
		});
	},

	async delete(id: string, props: CacheProviderState): Promise<void> {
		const cacheName = id || props.cacheName;
		if (!cacheName) return;
		const token = await mintAdminToken(props, cacheName, ADMIN_DELETE_FLAGS);
		await withCacheBaseUrl(props, async (baseUrl) => {
			const path = `/_api/v1/cache-config/${cacheName}`;
			const res = await atticFetch(baseUrl, token, path, "DELETE");
			// Idempotent delete: a cache already removed out of band (404) means the
			// desired end state is reached, so don't fail `pulumi destroy`/replacement.
			if (res.status === 404) return;
			ensureOk(res, "DELETE", path);
		});
	},
};

// ---------------------------------------------------------------------------
// Token provider
// ---------------------------------------------------------------------------

const tokenProvider: dynamic.ResourceProvider = {
	async check(
		_olds: TokenProviderState,
		news: TokenProviderInputs,
	): Promise<dynamic.CheckResult> {
		const failures: dynamic.CheckFailure[] = [];
		if (!news.hs256SecretBase64) {
			failures.push({
				property: "hs256SecretBase64",
				reason: "hs256SecretBase64 is required",
			});
		}
		if (!news.sub) {
			failures.push({ property: "sub", reason: "sub is required" });
		}
		if (!news.validitySeconds || news.validitySeconds <= 0) {
			failures.push({
				property: "validitySeconds",
				reason: "validity must be a positive duration",
			});
		}
		return { inputs: news, failures };
	},

	async diff(
		_id: string,
		olds: TokenProviderState,
		news: TokenProviderInputs,
	): Promise<dynamic.DiffResult> {
		// A signed JWT is immutable: any change to a claim input mints a new token,
		// so every meaningful change is a replacement. The baked exp/nbf/token are
		// state (not inputs), so a no-op `up` does not churn the token.
		const replaces: string[] = [];
		if (olds.hs256SecretBase64 !== news.hs256SecretBase64) {
			replaces.push("hs256SecretBase64");
		}
		if (olds.sub !== news.sub) replaces.push("sub");
		if (olds.validitySeconds !== news.validitySeconds) {
			replaces.push("validitySeconds");
		}
		if (stableJson(olds.caches ?? {}) !== stableJson(news.caches ?? {})) {
			replaces.push("caches");
		}
		return {
			changes: replaces.length > 0,
			replaces,
			deleteBeforeReplace: false,
		};
	},

	async create(inputs: TokenProviderInputs): Promise<dynamic.CreateResult> {
		const { randomUUID } = await import("node:crypto");
		const now = Math.floor(Date.now() / 1000);
		const expiresAt = now + inputs.validitySeconds;
		const token = await mintAtticToken({
			secretBase64: inputs.hs256SecretBase64,
			sub: inputs.sub,
			issuedAtSeconds: now,
			expiresAtSeconds: expiresAt,
			caches: inputs.caches,
		});
		// The resource id is a random opaque handle — NEVER the token, which is a
		// bearer credential and would otherwise sit in plaintext in Pulumi state.
		return {
			id: randomUUID(),
			outs: { ...inputs, token, expiresAt, notBefore: now },
		};
	},

	async update(
		_id: string,
		_olds: TokenProviderState,
		news: TokenProviderInputs,
	): Promise<dynamic.UpdateResult> {
		// Reached only if diff() ever reports a non-replace change (it does not
		// today). Re-mint defensively so outputs stay consistent with inputs.
		const now = Math.floor(Date.now() / 1000);
		const expiresAt = now + news.validitySeconds;
		const token = await mintAtticToken({
			secretBase64: news.hs256SecretBase64,
			sub: news.sub,
			issuedAtSeconds: now,
			expiresAtSeconds: expiresAt,
			caches: news.caches,
		});
		return { outs: { ...news, token, expiresAt, notBefore: now } };
	},

	async delete(): Promise<void> {
		// No-op: Attic tokens are stateless JWTs with no server-side record to
		// remove. A token is invalidated only by its `exp` lapsing or by rotating
		// the shared HS256 secret (which invalidates every token). Dropping the
		// resource stops Pulumi from re-issuing it; it cannot revoke a live token.
	},
};

// ---------------------------------------------------------------------------
// Public dynamic resources
// ---------------------------------------------------------------------------

/** Build the normalized, fully-resolved provider inputs for a cache. */
function cacheProviderInputs(args: AtticCacheArgs) {
	return {
		namespace: args.namespace,
		hs256SecretBase64: args.hs256SecretBase64,
		deploymentName: pulumi.output(args.deploymentName ?? "attic"),
		port: pulumi.output(args.port ?? 8080),
		cacheName: args.cacheName,
		isPublic: pulumi.output(args.isPublic ?? true),
		priority: pulumi.output(args.priority ?? 0),
		storeDir: pulumi.output(args.storeDir ?? "/nix/store"),
		upstreamCacheKeyNames: pulumi.output(args.upstreamCacheKeyNames ?? []),
		retentionPeriodSeconds: pulumi
			.output(args.retentionPeriodSeconds)
			.apply((value) => (value === undefined ? "" : value)),
	};
}

class AtticCacheRecord extends dynamic.Resource {
	public readonly publicKey!: Output<string>;

	constructor(
		name: string,
		args: ReturnType<typeof cacheProviderInputs>,
		opts?: DynamicResourceOptions,
	) {
		super(cacheProvider, name, { publicKey: undefined, ...args }, opts);
	}
}

/**
 * An Attic binary cache, managed as a first-class Pulumi resource.
 *
 * Replaces the `attic-cache-bootstrap` `local.Command`: `create` is find-or-create
 * (a pre-existing cache is adopted via PATCH, preserving its keypair), and config
 * changes (`isPublic`, `priority`, `upstreamCacheKeyNames`, retention) reconcile
 * in place on the next `pulumi up`. Renaming the cache or changing its store dir
 * triggers a replacement.
 *
 * Transport: the provider opens a short-lived port-forward to a ready pod of the
 * Attic deployment and calls `/_api/v1/cache-config/*` over `localhost`, minting
 * its own short-lived admin token from the HS256 secret — the same reachability
 * model as the old `kubectl exec`/`port-forward` script, with no tailnet dependency.
 */
export class AtticCache extends pulumi.ComponentResource {
	public readonly cacheName: pulumi.Output<string>;
	public readonly publicKey: pulumi.Output<string>;

	constructor(
		name: string,
		args: AtticCacheArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("sector7:attic:Cache", name, args, opts);

		const record = new AtticCacheRecord(
			`${name}-cache`,
			cacheProviderInputs(args),
			{ parent: this, additionalSecretOutputs: ["hs256SecretBase64"] },
		);

		this.cacheName = pulumi.output(args.cacheName);
		this.publicKey = record.publicKey;
		this.registerOutputs({
			cacheName: this.cacheName,
			publicKey: this.publicKey,
		});
	}
}

/** Build the normalized, fully-resolved provider inputs for a token. */
function tokenProviderInputs(args: AtticTokenArgs) {
	return {
		hs256SecretBase64: args.hs256SecretBase64,
		sub: args.sub,
		validitySeconds: pulumi.output(args.validity).apply(parseDurationSeconds),
		caches: pulumi.output(args.caches).apply((value) => value ?? {}),
	};
}

class AtticTokenRecord extends dynamic.Resource {
	public readonly token!: Output<string>;
	public readonly expiresAt!: Output<number>;
	public readonly notBefore!: Output<number>;

	constructor(
		name: string,
		args: ReturnType<typeof tokenProviderInputs>,
		opts?: DynamicResourceOptions,
	) {
		super(
			tokenProvider,
			name,
			{ token: undefined, expiresAt: undefined, notBefore: undefined, ...args },
			opts,
		);
	}
}

/**
 * An Attic access token, managed as a first-class Pulumi resource.
 *
 * Replaces the `attic-ci-token` `local.Command`. The token is a stateless HS256
 * JWT minted in-process from the server's signing secret — no server contact and
 * no port-forward. `exp` is baked at create from `validity`; changing `sub`,
 * `validity`, `caches`, or the secret mints a new token (a replacement).
 *
 * Caveat: a stateless JWT cannot be individually revoked. `delete` is a no-op;
 * revocation is `exp` lapsing or rotating the shared secret (which invalidates
 * every token). Prefer short `validity` and least-privilege `caches` scopes.
 */
export class AtticToken extends pulumi.ComponentResource {
	public readonly token: pulumi.Output<string>;
	public readonly expiresAt: pulumi.Output<number>;
	public readonly notBefore: pulumi.Output<number>;

	constructor(
		name: string,
		args: AtticTokenArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("sector7:attic:Token", name, args, opts);

		const record = new AtticTokenRecord(
			`${name}-token`,
			tokenProviderInputs(args),
			{ parent: this, additionalSecretOutputs: ["token", "hs256SecretBase64"] },
		);

		this.token = pulumi.secret(record.token);
		this.expiresAt = record.expiresAt;
		this.notBefore = record.notBefore;
		this.registerOutputs({
			token: this.token,
			expiresAt: this.expiresAt,
			notBefore: this.notBefore,
		});
	}
}
