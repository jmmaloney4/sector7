import type * as pulumi from "@pulumi/pulumi";
import type { AtticCachePermissionFlags } from "./token.ts";

export type { AtticCacheGrants, AtticCachePermissionFlags } from "./token.ts";

/**
 * Coordinates + credentials for reaching an Attic server's cache-config HTTP API.
 *
 * The `AtticCache` resource opens a short-lived in-process port-forward to a ready
 * pod of the Attic Deployment and calls `/_api/v1/cache-config/*` over `localhost`.
 * It mints its own short-lived admin token from `hs256SecretBase64` for those
 * calls, so the consumer never has to pre-mint one.
 */
export interface AtticAdminTargetArgs {
	/** Namespace the Attic Deployment runs in. */
	namespace: pulumi.Input<string>;
	/**
	 * The Attic server's HS256 signing secret, base64-encoded
	 * (`ATTIC_SERVER_TOKEN_HS256_SECRET_BASE64`). Pass as a Pulumi secret.
	 */
	hs256SecretBase64: pulumi.Input<string>;
	/**
	 * Deployment whose ready pod is forwarded to.
	 * @default "attic"
	 */
	deploymentName?: pulumi.Input<string>;
	/**
	 * Attic container listen port (the pod port the forward targets — not the
	 * Service port).
	 * @default 8080
	 */
	port?: pulumi.Input<number>;
}

export interface AtticCacheArgs extends AtticAdminTargetArgs {
	/** Cache name (`[A-Za-z0-9][A-Za-z0-9-_+]{0,49}`). */
	cacheName: pulumi.Input<string>;
	/**
	 * Whether the cache is publicly pullable without a token (push still requires
	 * one).
	 * @default true
	 */
	isPublic?: pulumi.Input<boolean>;
	/**
	 * Substituter priority (lower = preferred); surfaced to clients via the cache
	 * config.
	 * @default 0
	 */
	priority?: pulumi.Input<number>;
	/**
	 * Nix store directory the cache serves. Immutable — changing it replaces the
	 * cache.
	 * @default "/nix/store"
	 */
	storeDir?: pulumi.Input<string>;
	/** Names of upstream caches whose signing keys are trusted for this cache. */
	upstreamCacheKeyNames?: pulumi.Input<pulumi.Input<string>[]>;
	/**
	 * Retention period in seconds. Omit for the server's global default
	 * (`Global`); set to a positive number to pin a per-cache period.
	 */
	retentionPeriodSeconds?: pulumi.Input<number>;
}

export interface AtticTokenArgs {
	/**
	 * The Attic server's HS256 signing secret, base64-encoded. Pass as a Pulumi
	 * secret — it is the root credential for the cache.
	 */
	hs256SecretBase64: pulumi.Input<string>;
	/** JWT `sub`: a human-meaningful subject (e.g. "github-actions-ci"). */
	sub: pulumi.Input<string>;
	/**
	 * Token validity: a duration string (`1y`, `90d`, `12h`, `300s`) or a number
	 * of seconds. Baked into `exp` at create; changing it mints a new token.
	 */
	validity: pulumi.Input<string | number>;
	/**
	 * Per-cache grants. Keys are cache-name patterns (`*` wildcards allowed);
	 * values are permission flags. Keys must be plain strings — Pulumi cannot key
	 * an object on an `Output` — and are normally the same literals passed to
	 * `AtticCache`.
	 */
	caches: Record<string, AtticCachePermissionFlags>;
}
