// LiteLLM admin resources.
//
// These were previously Pulumi *dynamic* providers: the CRUD logic lived here
// in TypeScript, and Pulumi serialised the provider closure into stack state
// under `__provider`, re-executing it on `refresh` and `delete`. That froze a
// machine-specific absolute path — resolved once from a git worktree — into
// state, and `pulumi refresh` on litellm/prod began failing with
// ERR_MODULE_NOT_FOUND once the worktree was deleted.
//
// The CRUD now lives in the `sector7` provider plugin (`provider/litellm` in
// this repo). What remains here is the thin resource surface: the component
// wrappers, their inputs, and — critically — the `RandomPassword` that mints
// each key's `sk-…` value.
//
// WHY THE RandomPassword STAYS IN TYPESCRIPT: LiteLLM never returns a key's
// value, only its hash, so a provider that generated keys itself could not
// learn existing ones and every live credential would rotate on migration. The
// value is minted here and *pushed* to the plugin as `keyValue`. Do not move
// it, and do not rename these resources — the `sk-` value derives from a
// RandomPassword named after the resource.

import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { PLUGIN_VERSION } from "../version.ts";
import type { LiteLLMApiKeyArgs, LiteLLMTeamArgs } from "./config-types.ts";

/**
 * Options every plugin-backed child needs.
 *
 * `aliases` is what makes migrating off the dynamic providers a no-op: the
 * engine rewrites the URN in place, so `pulumi preview` is a complete,
 * side-effect-free dry run and no LiteLLM API call is made. Keep the alias for
 * at least two releases — it costs nothing and protects any stack that has not
 * yet been through an `up`, plus any state restored from a backup.
 */
function pluginOpts(
	opts: pulumi.CustomResourceOptions | undefined,
	extra?: pulumi.CustomResourceOptions,
): pulumi.CustomResourceOptions {
	return pulumi.mergeOptions(opts, {
		version: PLUGIN_VERSION,
		aliases: [{ type: "pulumi-nodejs:dynamic:Resource" }],
		...extra,
	});
}

/**
 * Build the fully-resolved inputs for a team.
 *
 * NOTE on `maxBudget`: this deliberately passes the value through rather than
 * normalising `undefined` to `""`. The dynamic provider used empty sentinels
 * (`""` / `[]` / `{}`) so its callbacks never saw `undefined`, which gave
 * `maxBudget` the TypeScript type `number | ""`. A Pulumi schema cannot express
 * that union — the plugin models it as an optional number — and the string
 * sentinel does not decode, failing at `Check`.
 *
 * The `?? []` / `?? {}` normalisations below are deliberately KEPT: those
 * sentinels are valid values of their own types, and retaining them means the
 * migrated state and the new inputs match exactly, so the retype diffs to
 * nothing.
 */
function teamProviderInputs(args: LiteLLMTeamArgs) {
	return {
		proxyNamespace: args.proxyNamespace,
		masterKey: args.masterKey,
		proxyDeploymentName: pulumi.output(args.proxyDeploymentName ?? "litellm"),
		proxyPort: pulumi.output(args.proxyPort ?? 4000),
		teamAlias: args.teamAlias,
		desiredTeamId: pulumi.output(args.teamId ?? ""),
		models: pulumi.output(args.models ?? []),
		maxBudget: args.maxBudget,
		budgetDuration: pulumi.output(args.budgetDuration ?? ""),
		tags: pulumi.output(args.tags ?? []),
		metadata: pulumi.output(args.metadata ?? {}),
	};
}

class LiteLLMTeamRecord extends pulumi.CustomResource {
	public declare readonly teamId: pulumi.Output<string>;

	constructor(
		name: string,
		args: ReturnType<typeof teamProviderInputs>,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			"sector7:litellm:TeamRecord",
			name,
			{ teamId: undefined, ...args },
			pluginOpts(opts),
		);
	}
}

/**
 * A LiteLLM team, managed as a first-class Pulumi resource.
 *
 * Changing `models`, `maxBudget`, `budgetDuration`, `teamAlias`, `tags` or
 * `metadata` calls LiteLLM `/team/update` on the next `pulumi up`. Only a
 * change to an explicit `teamId` triggers a replacement.
 *
 * Transport: the plugin opens a short-lived port-forward to a ready pod of the
 * proxy deployment and calls the admin API over localhost — no tailnet
 * dependency.
 */
export class LiteLLMTeam extends pulumi.ComponentResource {
	public readonly teamId: pulumi.Output<string>;

	constructor(
		name: string,
		args: LiteLLMTeamArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("sector7:litellm:Team", name, args, opts);

		const record = new LiteLLMTeamRecord(
			`${name}-team`,
			teamProviderInputs(args),
			{ parent: this },
		);

		this.teamId = record.teamId;
		this.registerOutputs({ teamId: this.teamId });
	}
}

/** Build the fully-resolved inputs for a key. See teamProviderInputs on maxBudget. */
function keyProviderInputs(
	args: LiteLLMApiKeyArgs,
	keyValue: pulumi.Output<string>,
) {
	return {
		proxyNamespace: args.proxyNamespace,
		masterKey: args.masterKey,
		proxyDeploymentName: pulumi.output(args.proxyDeploymentName ?? "litellm"),
		proxyPort: pulumi.output(args.proxyPort ?? 4000),
		keyAlias: args.keyAlias,
		keyValue,
		models: pulumi.output(args.models ?? []),
		teamId: pulumi.output(args.teamId ?? ""),
		userId: pulumi.output(args.userId ?? ""),
		budgetId: pulumi.output(args.budgetId ?? ""),
		maxBudget: args.maxBudget,
		budgetDuration: pulumi.output(args.budgetDuration ?? ""),
		duration: pulumi.output(args.duration ?? ""),
		aliases: pulumi.output(args.aliases ?? {}),
		tags: pulumi.output(args.tags ?? []),
		metadata: pulumi.output(args.metadata ?? {}),
	};
}

class LiteLLMApiKeyRecord extends pulumi.CustomResource {
	public declare readonly tokenId: pulumi.Output<string>;

	constructor(
		name: string,
		args: ReturnType<typeof keyProviderInputs>,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			"sector7:litellm:KeyRecord",
			name,
			{ tokenId: undefined, ...args },
			pluginOpts(opts, {
				additionalSecretOutputs: ["keyValue", "tokenId"],
			}),
		);
	}
}

/**
 * A LiteLLM virtual key, managed as a first-class Pulumi resource.
 *
 * The `sk-…` value is derived from a `RandomPassword` named `${name}-secret`,
 * unchanged since the dynamic-provider implementation, so existing keys keep
 * their value across the plugin migration. Changing `models`, `aliases`,
 * `metadata`, `tags`, budget or `duration` calls LiteLLM `/key/update` on the
 * next `pulumi up`; rotating the key value or moving teams replaces it.
 */
export class LiteLLMApiKey extends pulumi.ComponentResource {
	public readonly key: pulumi.Output<string>;
	public readonly tokenId: pulumi.Output<string>;

	constructor(
		name: string,
		args: LiteLLMApiKeyArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("sector7:litellm:ApiKey", name, args, opts);

		const keySecret = new random.RandomPassword(
			`${name}-secret`,
			{
				length: 29,
				special: false,
			},
			{ parent: this },
		);
		const actualKey = pulumi.interpolate`sk-${keySecret.result}`;

		const record = new LiteLLMApiKeyRecord(
			`${name}-key`,
			keyProviderInputs(args, actualKey),
			{ parent: this },
		);

		this.key = pulumi.secret(actualKey);
		this.tokenId = pulumi.secret(record.tokenId);

		this.registerOutputs({
			key: this.key,
			tokenId: this.tokenId,
		});
	}
}
