import type * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";

export type LiteLLMModelMode =
	| "chat"
	| "completion"
	| "embedding"
	| "image_generation"
	| "audio_transcription"
	| "audio_speech"
	| "rerank";

export interface LiteLLMProviderConfig {
	apiKey?: pulumi.Input<string>;
	envVar?: pulumi.Input<string>;
	apiBase?: pulumi.Input<string>;
}

export interface LiteLLMModelDeployment {
	id: string;
	provider: string;
	providerModel: string;
	apiBase?: pulumi.Input<string>;
	mode?: LiteLLMModelMode;
	baseModel?: string;
	accessGroups?: string[];
	teamId?: string;
	teamAlias?: string;
	teamPublicModelName?: string;
	tags?: string[];
	extraLiteLLMParams?: Record<string, unknown>;
	extraModelInfo?: Record<string, unknown>;
	rpm?: number;
	tpm?: number;
	rpd?: number;
	tpd?: number;
	weight?: number;
	order?: number;
	maxInputTokens?: number;
	inputCostPerToken?: number;
	outputCostPerToken?: number;
}

export interface LiteLLMModelGroup {
	name: string;
	deploymentIds: string[];
	fallbacks?: string[];
	contextWindowFallbacks?: string[];
	accessGroups?: string[];
	teamId?: string;
	teamAlias?: string;
	teamPublicModelName?: string;
	tags?: string[];
	extraModelInfo?: Record<string, unknown>;
}

export interface LiteLLMTeamCapability {
	name: string;
	deploymentIds: string[];
	fallbacks?: string[];
	contextWindowFallbacks?: string[];
	accessGroups?: string[];
	tags?: string[];
	extraModelInfo?: Record<string, unknown>;
}

export interface LiteLLMTeamDefinition {
	id: string;
	alias?: string;
	capabilities: LiteLLMTeamCapability[];
}

export interface BuildLiteLLMTeamScopedModelGroupsArgs {
	teams: LiteLLMTeamDefinition[];
	separator?: string;
}

export interface LiteLLMObservabilityPolicy {
	dropParams?: boolean;
	requestTimeout?: number;
	turnOffMessageLogging?: boolean;
	redactUserApiKeyInfo?: boolean;
	successCallbacks?: string[];
	failureCallbacks?: string[];
	serviceCallbacks?: string[];
}

export interface LiteLLMGovernancePolicy {
	enforceUserParam?: boolean;
	tokenRateLimitType?: "input" | "output" | "total";
	databaseConnectionPoolLimit?: number;
	allowRequestsOnDbUnavailable?: boolean;
	globalMaxParallelRequests?: number;
	maxBudget?: number;
	budgetDuration?: string;
	upperboundKeyGenerateParams?: Record<string, number | string | boolean>;
	defaultKeyGenerateParams?: Record<
		string,
		string | number | boolean | string[]
	>;
}

export interface LiteLLMRedisPolicy {
	host: string;
	port?: number;
	maxConnections?: number;
	supportedCallTypes?: string[];
	useRedisTransactionBuffer?: boolean;
}

export interface LiteLLMRouterPolicy {
	routingStrategy?:
		| "simple-shuffle"
		| "least-busy"
		| "latency-based-routing"
		| "usage-based-routing-v2"
		| "cost-based-routing";
	enablePreCallChecks?: boolean;
	allowedFails?: number;
	cooldownTime?: number;
	numRetries?: number;
	retryPolicy?: Record<string, number>;
	defaultFallbacks?: string[];
}

export interface LiteLLMServiceSpec {
	type?: "ClusterIP" | "NodePort" | "LoadBalancer";
	port?: number;
}

/**
 * Cloud SQL Auth Proxy sidecar configuration for LiteLLMProxy.
 *
 * LiteLLMProxy composes the shared `@jmmaloney4/sector7/cloudsql`
 * CloudSqlAuthProxySidecar component and maps this narrower interface onto it.
 * When provided, the proxy component injects a `cloud-sql-proxy` sidecar
 * container that forwards a local port to the Cloud SQL instance via the
 * Cloud SQL Auth Proxy. The DATABASE_URL is rewritten to point at
 * `127.0.0.1:<proxyPort>` so the LiteLLM container connects through the
 * sidecar instead of hitting the public IP directly.
 *
 * This eliminates the need for authorized networks and client certificates.
 * Authentication is handled by the proxy using either a GCP service account
 * key (via a Kubernetes secret) or IAM credentials.
 */
export interface CloudSqlAuthProxy {
	/** Cloud SQL connection name: `project:region:instance`. */
	connectionName: pulumi.Input<string>;

	/**
	 * Local port the auth proxy listens on inside the pod.
	 * The DATABASE_URL host is rewritten to `127.0.0.1:<proxyPort>`.
	 * @default 5432
	 */
	proxyPort?: number;

	/** Container image for the Cloud SQL Auth Proxy. */
	image?: pulumi.Input<string>;

	/**
	 * GCP service account key (JSON) for IAM authentication.
	 * When provided, the key is stored in a Kubernetes secret and mounted
	 * as an environment variable in the sidecar.
	 *
	 * If omitted, the sidecar relies on Workload Identity or the node's
	 * default service account.
	 */
	serviceAccountKey?: pulumi.Input<string>;

	/** Extra args passed to the cloud-sql-proxy binary. */
	extraArgs?: pulumi.Input<pulumi.Input<string>[]>;

	/** Resource requests/limits for the sidecar container. */
	resources?: pulumi.Input<
		import("@pulumi/kubernetes").types.input.core.v1.ResourceRequirements
	>;
}

export interface LiteLLMProxyArgs {
	namespace?: pulumi.Input<string>;
	createNamespace?: boolean;
	image?: pulumi.Input<string>;
	replicas?: pulumi.Input<number>;
	databaseUrl: pulumi.Input<string>;
	masterKey?: pulumi.Input<string>;
	providers: Record<string, LiteLLMProviderConfig>;
	deployments: LiteLLMModelDeployment[];
	modelGroups: LiteLLMModelGroup[];
	router?: LiteLLMRouterPolicy;
	governance?: LiteLLMGovernancePolicy;
	observability?: LiteLLMObservabilityPolicy;
	redis?: LiteLLMRedisPolicy;
	service?: LiteLLMServiceSpec;
	cloudSqlAuthProxy?: CloudSqlAuthProxy;
	/**
	 * Additional non-secret environment variables injected directly into the
	 * LiteLLM container.
	 *
	 * Use this for runtime flags and metadata such as
	 * `LANGFUSE_TRACING_ENVIRONMENT`. Values are rendered onto the Deployment,
	 * so do not pass secrets here.
	 */
	extraEnv?: Record<string, pulumi.Input<string>>;
	/**
	 * Additional secret environment variables injected into the LiteLLM
	 * container via the component-managed runtime Secret.
	 *
	 * Use this for integration credentials such as `LANGFUSE_PUBLIC_KEY`,
	 * `LANGFUSE_SECRET_KEY`, or other callback-specific secrets that should not
	 * be stored in git-tracked config.
	 */
	extraSecretEnv?: Record<string, pulumi.Input<string>>;
	/**
	 * Additional secret environment variables sourced from a Kubernetes Secret
	 * the component does NOT manage — e.g. a Secret materialized by the 1Password
	 * operator from an `OnePasswordItem`. Each entry maps an environment variable
	 * name to a `{ secretName, key }` reference rendered as `valueFrom.secretKeyRef`.
	 *
	 * Use this instead of `extraSecretEnv` when the value lives in an externally
	 * managed Secret (so it never transits Pulumi state), and when the Secret's
	 * key names differ from the desired env var names (e.g. a 1Password item whose
	 * fields are labeled `username`/`credential`).
	 */
	extraSecretRefEnv?: Record<
		string,
		{ secretName: pulumi.Input<string>; key: pulumi.Input<string> }
	>;
	resources?: k8s.types.input.core.v1.ResourceRequirements;
	extraLiteLLMSettings?: Record<string, unknown>;
	extraGeneralSettings?: Record<string, unknown>;
	extraRouterSettings?: Record<string, unknown>;
}

export interface LiteLLMGeneratedConfig {
	configYaml: string;
	providerEnvVars: string[];
}

export interface LiteLLMAdminTargetArgs {
	proxyNamespace: pulumi.Input<string>;
	masterKey: pulumi.Input<string>;
	proxyDeploymentName?: pulumi.Input<string>;
	proxyPort?: pulumi.Input<number>;
}

export interface LiteLLMApiKeyArgs extends LiteLLMAdminTargetArgs {
	keyAlias: pulumi.Input<string>;
	models?: pulumi.Input<pulumi.Input<string>[]>;
	teamId?: pulumi.Input<string>;
	userId?: pulumi.Input<string>;
	budgetId?: pulumi.Input<string>;
	maxBudget?: pulumi.Input<number>;
	budgetDuration?: pulumi.Input<string>;
	duration?: pulumi.Input<string>;
	aliases?: pulumi.Input<Record<string, pulumi.Input<string>>>;
	tags?: pulumi.Input<pulumi.Input<string>[]>;
	metadata?: pulumi.Input<Record<string, pulumi.Input<string>>>;
}

export interface LiteLLMTeamArgs extends LiteLLMAdminTargetArgs {
	teamAlias: pulumi.Input<string>;
	teamId?: pulumi.Input<string>;
	models?: pulumi.Input<pulumi.Input<string>[]>;
	maxBudget?: pulumi.Input<number>;
	budgetDuration?: pulumi.Input<string>;
	tags?: pulumi.Input<pulumi.Input<string>[]>;
	metadata?: pulumi.Input<Record<string, pulumi.Input<string>>>;
}
