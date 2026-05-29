import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { getScriptPath } from "../scripts/index.ts";
import type { LiteLLMApiKeyArgs, LiteLLMTeamArgs } from "./config-types.ts";

function pulumiJsonString(
	value: pulumi.Input<unknown> | undefined,
	fallback: unknown,
): pulumi.Output<string> {
	return pulumi
		.all([value])
		.apply(([resolved]) => JSON.stringify(resolved ?? fallback));
}

function buildAdminEnvironment(
	args: LiteLLMApiKeyArgs | LiteLLMTeamArgs,
): Record<string, pulumi.Input<string>> {
	return {
		LITELLM_PROXY_NAMESPACE: args.proxyNamespace,
		LITELLM_MASTER_KEY: args.masterKey,
		LITELLM_PROXY_DEPLOYMENT: args.proxyDeploymentName ?? "litellm",
		LITELLM_PROXY_PORT: pulumi.output(args.proxyPort ?? 4000).apply(String),
	};
}

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
		const scriptPath = getScriptPath("litellm-admin.sh");

		const commandResource = new command.local.Command(
			`${name}-key`,
			{
				create: pulumi.interpolate`bash "${scriptPath}" create-key`,
				delete: pulumi.interpolate`bash "${scriptPath}" delete-key`,
				environment: {
					...buildAdminEnvironment(args),
					LITELLM_KEY_ALIAS: args.keyAlias,
					LITELLM_KEY_VALUE: actualKey,
					LITELLM_KEY_MODELS_JSON: pulumiJsonString(args.models, []),
					LITELLM_KEY_TEAM_ID: pulumi.output(args.teamId ?? ""),
					LITELLM_KEY_USER_ID: pulumi.output(args.userId ?? ""),
					LITELLM_KEY_BUDGET_ID: pulumi.output(args.budgetId ?? ""),
					LITELLM_KEY_MAX_BUDGET: pulumi
						.output(args.maxBudget)
						.apply((value) => (value === undefined ? "" : String(value))),
					LITELLM_KEY_BUDGET_DURATION: pulumi.output(args.budgetDuration ?? ""),
					LITELLM_KEY_DURATION: pulumi.output(args.duration ?? ""),
					LITELLM_KEY_ALIASES_JSON: pulumiJsonString(args.aliases, {}),
					LITELLM_KEY_TAGS_JSON: pulumiJsonString(args.tags, []),
					LITELLM_KEY_METADATA_JSON: pulumiJsonString(args.metadata, {}),
				},
			},
			{ parent: this, additionalSecretOutputs: ["stdout"] },
		);

		this.key = pulumi.secret(actualKey);
		this.tokenId = pulumi
			.secret(commandResource.stdout)
			.apply((stdout) => stdout.trim());

		this.registerOutputs({
			key: this.key,
			tokenId: this.tokenId,
		});
	}
}

export class LiteLLMTeam extends pulumi.ComponentResource {
	public readonly teamId: pulumi.Output<string>;

	constructor(
		name: string,
		args: LiteLLMTeamArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("sector7:litellm:Team", name, args, opts);

		const scriptPath = getScriptPath("litellm-admin.sh");
		const commandResource = new command.local.Command(
			`${name}-team`,
			{
				create: pulumi.interpolate`bash "${scriptPath}" create-team`,
				delete: pulumi.interpolate`bash "${scriptPath}" delete-team`,
				environment: {
					...buildAdminEnvironment(args),
					LITELLM_TEAM_ALIAS: args.teamAlias,
					LITELLM_TEAM_ID: pulumi.output(args.teamId ?? ""),
					LITELLM_TEAM_MODELS_JSON: pulumiJsonString(args.models, []),
					LITELLM_TEAM_MAX_BUDGET: pulumi
						.output(args.maxBudget)
						.apply((value) => (value === undefined ? "" : String(value))),
					LITELLM_TEAM_BUDGET_DURATION: pulumi.output(
						args.budgetDuration ?? "",
					),
					LITELLM_TEAM_TAGS_JSON: pulumiJsonString(args.tags, []),
					LITELLM_TEAM_METADATA_JSON: pulumiJsonString(args.metadata, {}),
				},
			},
			{ parent: this },
		);

		this.teamId = pulumi
			.all([args.teamId, commandResource.stdout])
			.apply(([teamId, stdout]) => String(teamId ?? stdout).trim());

		this.registerOutputs({
			teamId: this.teamId,
		});
	}
}
