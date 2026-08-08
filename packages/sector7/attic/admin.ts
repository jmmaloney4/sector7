import * as pulumi from "@pulumi/pulumi";
import type { AtticCacheArgs, AtticTokenArgs } from "./config-types.ts";
import { parseDurationSeconds } from "./token.ts";

/**
 * An Attic binary cache, administered through the sector7 resource plugin.
 *
 * Backed by `provider/attic/cache.go`. This was previously a Pulumi
 * *dynamic* provider wrapped in a `ComponentResource`, which serialised its
 * JavaScript closure into stack state and re-executed that stored copy on
 * refresh and delete (garden ADR 163).
 *
 * This retype is more involved than a flat dynamic-provider cutover
 * (compare MatrixRoom, R2Object): the OLD shape was a `ComponentResource`
 * (type `sector7:attic:Cache`) wrapping an inner `dynamic.Resource` CHILD
 * (type `pulumi-nodejs:dynamic:Resource`, name `${name}-cache`) that held
 * the actual state — not a single flat resource. The Go plugin's Cache type
 * registers as `sector7:atticprovider:Cache`, not the more obvious
 * `sector7:attic:Cache` (see `Cache.Annotate` in cache.go): reusing
 * `sector7:attic:Cache` would make this resource's own identity
 * coincidentally collide with the OLD component's already-live URN, and
 * empirically (verified against a real nested old state with a throwaway
 * plugin before this was written) the engine treats that coincidental
 * direct match as authoritative and never falls back to consulting the
 * alias below at all — silently discarding the child's real state instead
 * of adopting it. With a non-colliding token, nothing in old state matches
 * this resource's own identity, so the alias is the only candidate and the
 * child is adopted cleanly; the old component carries no real state
 * (`ComponentResource`s are `custom: false`, with no id) and is simply
 * dropped as harmless bookkeeping cleanup once nothing references it.
 */
export class AtticCache extends pulumi.CustomResource {
	public declare readonly cacheName: pulumi.Output<string>;
	public declare readonly publicKey: pulumi.Output<string>;

	constructor(
		name: string,
		args: AtticCacheArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		// Force hs256SecretBase64 to a secret so it's encrypted in state even
		// when the caller passes a plain string. The plugin schema already
		// marks it secret; this covers the input side at construction too.
		const securedArgs = {
			...args,
			hs256SecretBase64: pulumi.secret(args.hs256SecretBase64),
		};

		super(
			"sector7:atticprovider:Cache",
			name,
			{ publicKey: undefined, ...securedArgs },
			pulumi.mergeOptions(opts, {
				aliases: [
					{
						type: "pulumi-nodejs:dynamic:Resource",
						name: `${name}-cache`,
						// The OLD component's ACTUAL live token — see the class
						// doc above. Not this resource's own (deliberately
						// different) type.
						parent: pulumi.createUrn(name, "sector7:attic:Cache"),
					},
				],
			}),
		);
	}
}

/**
 * An Attic access token, administered through the sector7 resource plugin.
 *
 * Backed by `provider/attic/token_resource.go`. Same retype shape and the
 * same reason for the `atticprovider` token as `AtticCache` above.
 */
export class AtticToken extends pulumi.CustomResource {
	public declare readonly token: pulumi.Output<string>;
	public declare readonly expiresAt: pulumi.Output<number>;
	public declare readonly notBefore: pulumi.Output<number>;

	constructor(
		name: string,
		args: AtticTokenArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		const securedArgs = {
			hs256SecretBase64: pulumi.secret(args.hs256SecretBase64),
			sub: args.sub,
			validitySeconds: pulumi.output(args.validity).apply(parseDurationSeconds),
			caches: args.caches,
		};

		super(
			"sector7:atticprovider:Token",
			name,
			{
				token: undefined,
				expiresAt: undefined,
				notBefore: undefined,
				...securedArgs,
			},
			pulumi.mergeOptions(opts, {
				aliases: [
					{
						type: "pulumi-nodejs:dynamic:Resource",
						name: `${name}-token`,
						// The OLD component's ACTUAL live token — see AtticCache's
						// class doc above. Not this resource's own (deliberately
						// different) type.
						parent: pulumi.createUrn(name, "sector7:attic:Token"),
					},
				],
			}),
		);
	}
}
