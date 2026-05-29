import { stringify } from "yaml";
import type {
	LiteLLMGeneratedConfig,
	LiteLLMGovernancePolicy,
	LiteLLMModelDeployment,
	LiteLLMModelGroup,
	LiteLLMObservabilityPolicy,
	LiteLLMRedisPolicy,
	LiteLLMRouterPolicy,
} from "./config-types.ts";

type ResolvedProviderConfig = {
	hasApiKey?: boolean;
	envVar?: string;
	apiBase?: string;
};

type ResolvedDeploymentConfig = Omit<LiteLLMModelDeployment, "apiBase"> & {
	apiBase?: string;
};

const DEFAULT_OBSERVABILITY: Required<
	Pick<
		LiteLLMObservabilityPolicy,
		| "dropParams"
		| "requestTimeout"
		| "turnOffMessageLogging"
		| "redactUserApiKeyInfo"
	>
> = {
	dropParams: true,
	requestTimeout: 120,
	turnOffMessageLogging: true,
	redactUserApiKeyInfo: true,
};

const DEFAULT_ROUTER: Required<
	Pick<
		LiteLLMRouterPolicy,
		| "routingStrategy"
		| "enablePreCallChecks"
		| "allowedFails"
		| "cooldownTime"
		| "numRetries"
	>
> = {
	routingStrategy: "cost-based-routing",
	enablePreCallChecks: true,
	allowedFails: 3,
	cooldownTime: 30,
	numRetries: 2,
};

const DEFAULT_GOVERNANCE: Required<
	Pick<
		LiteLLMGovernancePolicy,
		| "enforceUserParam"
		| "tokenRateLimitType"
		| "databaseConnectionPoolLimit"
		| "allowRequestsOnDbUnavailable"
	>
> = {
	enforceUserParam: true,
	tokenRateLimitType: "total",
	databaseConnectionPoolLimit: 10,
	allowRequestsOnDbUnavailable: false,
};

function toUpperSnakeCase(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toUpperCase();
}

export function getProviderEnvVar(
	providerName: string,
	provider: ResolvedProviderConfig,
): string | undefined {
	if (provider.envVar) {
		return provider.envVar;
	}

	if (provider.hasApiKey) {
		return `${toUpperSnakeCase(providerName)}_API_KEY`;
	}

	return undefined;
}

function addIfDefined(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	if (value !== undefined) {
		target[key] = value;
	}
}

function mergeObjects(
	...sources: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const source of sources) {
		if (!source) {
			continue;
		}
		Object.assign(merged, source);
	}
	return merged;
}

function buildFallbackMap(
	groups: LiteLLMModelGroup[],
	key: "fallbacks" | "contextWindowFallbacks",
): Array<Record<string, string[]>> {
	return groups.flatMap((group) => {
		const targets =
			key === "fallbacks" ? group.fallbacks : group.contextWindowFallbacks;
		if (!targets || targets.length === 0) {
			return [];
		}
		return [{ [group.name]: targets }];
	});
}

export function validateLiteLLMConfig(args: {
	replicas?: number;
	providers: Record<string, ResolvedProviderConfig>;
	deployments: ResolvedDeploymentConfig[];
	modelGroups: LiteLLMModelGroup[];
	redis?: LiteLLMRedisPolicy;
	router?: LiteLLMRouterPolicy;
}): void {
	const deploymentIds = new Set<string>();
	const groupNames = new Set(args.modelGroups.map((group) => group.name));

	for (const deployment of args.deployments) {
		if (deploymentIds.has(deployment.id)) {
			throw new Error(`Duplicate LiteLLM deployment id: ${deployment.id}`);
		}
		deploymentIds.add(deployment.id);

		if (!args.providers[deployment.provider]) {
			throw new Error(
				`LiteLLM deployment '${deployment.id}' references unknown provider '${deployment.provider}'`,
			);
		}
	}

	for (const group of args.modelGroups) {
		if (group.deploymentIds.length === 0) {
			throw new Error(
				`LiteLLM model group '${group.name}' must reference at least one deployment`,
			);
		}

		for (const deploymentId of group.deploymentIds) {
			if (!deploymentIds.has(deploymentId)) {
				throw new Error(
					`LiteLLM model group '${group.name}' references missing deployment '${deploymentId}'`,
				);
			}
		}

		for (const fallback of group.fallbacks ?? []) {
			if (!groupNames.has(fallback)) {
				throw new Error(
					`LiteLLM model group '${group.name}' fallback references missing group '${fallback}'`,
				);
			}
		}

		for (const fallback of group.contextWindowFallbacks ?? []) {
			if (!groupNames.has(fallback)) {
				throw new Error(
					`LiteLLM model group '${group.name}' context window fallback references missing group '${fallback}'`,
				);
			}
		}
	}

	const envVars = new Set<string>();
	for (const [providerName, provider] of Object.entries(args.providers)) {
		const envVar = getProviderEnvVar(providerName, provider);
		if (!envVar) {
			continue;
		}
		if (envVars.has(envVar)) {
			throw new Error(`Duplicate LiteLLM provider env var: ${envVar}`);
		}
		envVars.add(envVar);
	}

	if ((args.replicas ?? 1) > 1 && !args.redis) {
		throw new Error(
			"LiteLLM replicas > 1 require redis configuration for shared cooldown and rate-limit state",
		);
	}
}

export function generateLiteLLMConfig(args: {
	providers: Record<string, ResolvedProviderConfig>;
	deployments: ResolvedDeploymentConfig[];
	modelGroups: LiteLLMModelGroup[];
	observability?: LiteLLMObservabilityPolicy;
	governance?: LiteLLMGovernancePolicy;
	redis?: LiteLLMRedisPolicy;
	router?: LiteLLMRouterPolicy;
	replicas?: number;
	extraLiteLLMSettings?: Record<string, unknown>;
	extraGeneralSettings?: Record<string, unknown>;
	extraRouterSettings?: Record<string, unknown>;
}): LiteLLMGeneratedConfig {
	validateLiteLLMConfig(args);

	const providerEnvVars = Object.entries(args.providers)
		.map(([providerName, provider]) =>
			getProviderEnvVar(providerName, provider),
		)
		.filter((value): value is string => value !== undefined);
	const deploymentsById = new Map(
		args.deployments.map((deployment) => [deployment.id, deployment] as const),
	);

	const modelList = args.modelGroups.flatMap((group) =>
		group.deploymentIds.map((deploymentId) => {
			const deployment = deploymentsById.get(deploymentId);
			if (!deployment) {
				throw new Error(
					`Missing deployment '${deploymentId}' after validation`,
				);
			}

			const provider = args.providers[deployment.provider];
			const envVar = getProviderEnvVar(deployment.provider, provider);
			const litellmParams = mergeObjects(deployment.extraLiteLLMParams);
			litellmParams.model = deployment.providerModel;
			if (envVar) {
				litellmParams.api_key = `os.environ/${envVar}`;
			} else if (!provider.hasApiKey) {
				// Provider has no API key (e.g., internal cluster proxy).
				// LiteLLM's OpenAI SDK wrapper requires api_key to be set even
				// if the upstream doesn't validate it. Inject a placeholder.
				litellmParams.api_key = "no-key-required";
			}
			addIfDefined(
				litellmParams,
				"api_base",
				deployment.apiBase ?? provider.apiBase,
			);
			addIfDefined(litellmParams, "rpm", deployment.rpm);
			addIfDefined(litellmParams, "tpm", deployment.tpm);
			addIfDefined(litellmParams, "rpd", deployment.rpd);
			addIfDefined(litellmParams, "tpd", deployment.tpd);
			addIfDefined(litellmParams, "weight", deployment.weight);
			addIfDefined(litellmParams, "order", deployment.order);

			const accessGroups = new Set<string>([
				...(deployment.accessGroups ?? []),
				...(group.accessGroups ?? []),
			]);
			const tags = new Set<string>([
				...(deployment.tags ?? []),
				...(group.tags ?? []),
			]);

			const modelInfo = mergeObjects(
				group.extraModelInfo,
				deployment.extraModelInfo,
				{
					id: deployment.id,
				},
			);
			addIfDefined(
				modelInfo,
				"base_model",
				deployment.baseModel ?? deployment.providerModel,
			);
			addIfDefined(
				modelInfo,
				"access_groups",
				accessGroups.size > 0 ? [...accessGroups] : undefined,
			);
			addIfDefined(modelInfo, "mode", deployment.mode);
			addIfDefined(modelInfo, "max_input_tokens", deployment.maxInputTokens);
			addIfDefined(
				modelInfo,
				"input_cost_per_token",
				deployment.inputCostPerToken,
			);
			addIfDefined(
				modelInfo,
				"output_cost_per_token",
				deployment.outputCostPerToken,
			);
			addIfDefined(modelInfo, "team_id", deployment.teamId ?? group.teamId);
			addIfDefined(
				modelInfo,
				"team_alias",
				deployment.teamAlias ?? group.teamAlias,
			);
			addIfDefined(
				modelInfo,
				"team_public_model_name",
				deployment.teamPublicModelName ?? group.teamPublicModelName,
			);
			addIfDefined(modelInfo, "tags", tags.size > 0 ? [...tags] : undefined);

			return {
				model_name: group.name,
				litellm_params: litellmParams,
				model_info: modelInfo,
			};
		}),
	);

	const observability = {
		...DEFAULT_OBSERVABILITY,
		...args.observability,
	};

	const litellmSettings: Record<string, unknown> = {
		drop_params: observability.dropParams,
		turn_off_message_logging: observability.turnOffMessageLogging,
		redact_user_api_key_info: observability.redactUserApiKeyInfo,
		request_timeout: observability.requestTimeout,
	};
	addIfDefined(
		litellmSettings,
		"success_callback",
		args.observability?.successCallbacks,
	);
	addIfDefined(
		litellmSettings,
		"failure_callback",
		args.observability?.failureCallbacks,
	);
	addIfDefined(
		litellmSettings,
		"service_callbacks",
		args.observability?.serviceCallbacks,
	);

	if (args.redis) {
		litellmSettings.cache = true;
		litellmSettings.cache_params = {
			type: "redis",
			host: args.redis.host,
			port: args.redis.port ?? 6379,
			supported_call_types: args.redis.supportedCallTypes ?? [],
			...(args.redis.maxConnections !== undefined
				? { max_connections: args.redis.maxConnections }
				: {}),
		};
	}
	const governance = {
		...DEFAULT_GOVERNANCE,
		...args.governance,
	};
	addIfDefined(litellmSettings, "max_budget", args.governance?.maxBudget);
	addIfDefined(
		litellmSettings,
		"budget_duration",
		args.governance?.budgetDuration,
	);
	addIfDefined(
		litellmSettings,
		"upperbound_key_generate_params",
		args.governance?.upperboundKeyGenerateParams,
	);
	addIfDefined(
		litellmSettings,
		"default_key_generate_params",
		args.governance?.defaultKeyGenerateParams,
	);
	Object.assign(litellmSettings, args.extraLiteLLMSettings ?? {});

	const generalSettings: Record<string, unknown> = {
		master_key: "os.environ/LITELLM_MASTER_KEY",
		database_url: "os.environ/DATABASE_URL",
		enforce_user_param: governance.enforceUserParam,
		token_rate_limit_type: governance.tokenRateLimitType,
		database_connection_pool_limit: governance.databaseConnectionPoolLimit,
		allow_requests_on_db_unavailable: governance.allowRequestsOnDbUnavailable,
	};
	addIfDefined(
		generalSettings,
		"global_max_parallel_requests",
		args.governance?.globalMaxParallelRequests,
	);
	addIfDefined(
		generalSettings,
		"use_redis_transaction_buffer",
		args.redis?.useRedisTransactionBuffer,
	);
	Object.assign(generalSettings, args.extraGeneralSettings ?? {});

	const router = {
		...DEFAULT_ROUTER,
		...args.router,
	};
	const routerSettings: Record<string, unknown> = {
		routing_strategy: router.routingStrategy,
		enable_pre_call_checks: router.enablePreCallChecks,
		allowed_fails: router.allowedFails,
		cooldown_time: router.cooldownTime,
		num_retries: router.numRetries,
	};
	addIfDefined(routerSettings, "retry_policy", args.router?.retryPolicy);
	addIfDefined(
		routerSettings,
		"default_fallbacks",
		args.router?.defaultFallbacks,
	);

	const fallbacks = buildFallbackMap(args.modelGroups, "fallbacks");
	if (fallbacks.length > 0) {
		routerSettings.fallbacks = fallbacks;
	}
	const contextWindowFallbacks = buildFallbackMap(
		args.modelGroups,
		"contextWindowFallbacks",
	);
	if (contextWindowFallbacks.length > 0) {
		routerSettings.context_window_fallbacks = contextWindowFallbacks;
	}
	Object.assign(routerSettings, args.extraRouterSettings ?? {});

	const configYaml = stringify(
		{
			model_list: modelList,
			litellm_settings: litellmSettings,
			general_settings: generalSettings,
			router_settings: routerSettings,
		},
		{
			aliasDuplicateObjects: false,
			lineWidth: 0,
		},
	);

	return {
		configYaml,
		providerEnvVars,
	};
}
