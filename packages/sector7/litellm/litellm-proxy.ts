import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { CloudSqlAuthProxySidecar } from "../cloudsql/index.ts";
import { generateLiteLLMConfig, getProviderEnvVar } from "./config.ts";
import type {
	LiteLLMModelDeployment,
	LiteLLMProviderConfig,
	LiteLLMProxyArgs,
} from "./config-types.ts";

type ResolvedProviderConfig = {
	name: string;
	hasApiKey: boolean;
	envVar?: string;
	apiBase?: string;
};

type ResolvedDeployment = Omit<LiteLLMModelDeployment, "apiBase"> & {
	apiBase?: string;
};

const RESERVED_RUNTIME_ENV_VARS = new Set(["LITELLM_MASTER_KEY", "DATABASE_URL"]);

function toSecretKey(envVar: string): string {
	return envVar.toLowerCase();
}

function assertUniqueEnvNames(
	names: string[],
	context: string,
	reserved: Iterable<string> = [],
): void {
	const reservedSet = new Set(reserved);
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) {
			throw new Error(`${context} contains duplicate environment variable '${name}'`);
		}
		if (reservedSet.has(name)) {
			throw new Error(
				`${context} cannot override reserved environment variable '${name}'`,
			);
		}
		seen.add(name);
	}
}

function assertNoEnvOverlap(
	names: string[],
	conflictingNames: Iterable<string>,
	context: string,
): void {
	const conflictingNameSet = new Set(conflictingNames);
	for (const name of names) {
		if (conflictingNameSet.has(name)) {
			throw new Error(`${context} cannot override provider environment variable '${name}'`);
		}
	}
}

export function validateExtraEnvNameCollisions(
	extraEnvNames: string[],
	extraSecretEnvNames: string[],
	providerEnvVarNames: Iterable<string> = [],
): void {
	assertUniqueEnvNames(
		extraEnvNames,
		"LiteLLMProxy extraEnv",
		RESERVED_RUNTIME_ENV_VARS,
	);
	assertUniqueEnvNames(
		extraSecretEnvNames,
		"LiteLLMProxy extraSecretEnv",
		RESERVED_RUNTIME_ENV_VARS,
	);
	const extraEnvKeys = new Set(extraEnvNames);
	for (const name of extraSecretEnvNames) {
		if (extraEnvKeys.has(name)) {
			throw new Error(`LiteLLMProxy extraEnv and extraSecretEnv both define '${name}'`);
		}
	}
	assertNoEnvOverlap(extraEnvNames, providerEnvVarNames, "LiteLLMProxy extraEnv");
	assertNoEnvOverlap(
		extraSecretEnvNames,
		providerEnvVarNames,
		"LiteLLMProxy extraSecretEnv",
	);
}

function resolveProviderConfig(
	providerName: string,
	provider: LiteLLMProviderConfig,
): pulumi.Output<ResolvedProviderConfig> {
	return pulumi
		.all([
			pulumi.output(provider.apiKey),
			pulumi.output(provider.envVar),
			pulumi.output(provider.apiBase),
		])
		.apply(([apiKey, envVar, apiBase]) => ({
			name: providerName,
			hasApiKey: apiKey !== undefined,
			envVar:
				getProviderEnvVar(providerName, {
					hasApiKey: apiKey !== undefined,
					envVar: envVar ?? undefined,
				}) ?? undefined,
			apiBase: apiBase ?? undefined,
		}));
}

function resolveDeployment(
	deployment: LiteLLMModelDeployment,
): pulumi.Output<ResolvedDeployment> {
	return pulumi.output(deployment.apiBase).apply((apiBase) => {
		const { apiBase: _ignored, ...rest } = deployment;
		return {
			...rest,
			apiBase: apiBase ?? undefined,
		};
	});
}

export class LiteLLMProxy extends pulumi.ComponentResource {
	public readonly namespaceResource: k8s.core.v1.Namespace | undefined;
	public readonly providerSecret: k8s.core.v1.Secret;
	public readonly runtimeSecret: k8s.core.v1.Secret;
	public readonly configMap: k8s.core.v1.ConfigMap;
	public readonly deployment: k8s.apps.v1.Deployment;
	public readonly service: k8s.core.v1.Service;
	public readonly namespace: pulumi.Output<string>;
	public readonly proxyUrl: pulumi.Output<string>;
	public readonly masterKey: pulumi.Output<string>;
	public readonly configYaml: pulumi.Output<string>;
	public readonly cloudSqlSaKeySecret: k8s.core.v1.Secret | undefined;

	constructor(
		name: string,
		args: LiteLLMProxyArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("sector7:kubernetes:LiteLLMProxy", name, args, opts);

		const createNamespace = args.createNamespace ?? true;
		const namespaceName = pulumi.output(args.namespace ?? name);
		const image = args.image ?? "ghcr.io/berriai/litellm-database:main-stable";
		const replicas = pulumi.output(args.replicas ?? 1);
		const servicePort = args.service?.port ?? 4000;

		const resolvedProviderConfigs = pulumi.all(
			Object.entries(args.providers).map(([providerName, provider]) =>
				resolveProviderConfig(providerName, provider),
			),
		);
		const resolvedProviderSecrets = pulumi.all(
			Object.entries(args.providers).map(([providerName, provider]) =>
				pulumi
					.all([pulumi.output(provider.apiKey), pulumi.output(provider.envVar)])
					.apply(([apiKey, envVar]) => {
						if (apiKey === undefined) {
							return undefined;
						}
						const resolvedEnvVar = getProviderEnvVar(providerName, {
							hasApiKey: true,
							envVar: envVar ?? undefined,
						});
						if (!resolvedEnvVar) {
							throw new Error(
								`Expected env var for LiteLLM provider '${providerName}' with apiKey`,
							);
						}
						return {
							envVar: resolvedEnvVar,
							apiKey,
						};
					}),
			),
		);
		const resolvedDeployments = pulumi.all(
			args.deployments.map((deployment) => resolveDeployment(deployment)),
		);
		const extraEnvEntries = Object.entries(args.extraEnv ?? {});
		const extraSecretEnvEntries = Object.entries(args.extraSecretEnv ?? {});
		validateExtraEnvNameCollisions(
			extraEnvEntries.map(([name]) => name),
			extraSecretEnvEntries.map(([name]) => name),
		);

		const providerSecretName = `${name}-provider-keys`;

		const providerStringData = resolvedProviderSecrets.apply(
			(secretProviders) =>
				Object.fromEntries(
					secretProviders
						.filter((provider) => provider !== undefined)
						.map((provider) => [toSecretKey(provider.envVar), provider.apiKey]),
				),
		);

		const providerEnvVars = resolvedProviderConfigs.apply((providers) =>
			providers
				.filter((provider) => provider.hasApiKey && provider.envVar)
				.map((provider) => provider.envVar!),
		);
		const extraEnv = pulumi
			.all(
				extraEnvEntries.map(([name, value]) =>
					pulumi.output(value).apply((resolvedValue) =>
						resolvedValue == null ? undefined : { name, value: resolvedValue },
					),
				),
			)
			.apply((entries) =>
				entries.filter(
					(entry): entry is { name: string; value: string } => entry !== undefined,
				),
			);
		const extraSecretEnv = pulumi
			.all(
				extraSecretEnvEntries.map(([name, value]) =>
					pulumi.output(value).apply((resolvedValue) =>
						resolvedValue == null ? undefined : ([name, resolvedValue] as const),
					),
				),
			)
			.apply((entries) =>
				Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== undefined)),
			);
		const extraSecretEnvKeys = extraSecretEnv.apply((resolvedEnv) => Object.keys(resolvedEnv));

		const configYaml = pulumi
			.all([resolvedProviderConfigs, resolvedDeployments, replicas])
			.apply(([providers, deployments, resolvedReplicas]) => {
				const providerMap = Object.fromEntries(
					providers.map((provider) => [
						provider.name,
						{
							hasApiKey: provider.hasApiKey,
							envVar: provider.envVar,
							apiBase: provider.apiBase,
						},
					]),
				);

				const generatedConfig = generateLiteLLMConfig({
					providers: providerMap,
					deployments,
					modelGroups: args.modelGroups,
					observability: args.observability,
					governance: args.governance,
					redis: args.redis,
					router: args.router,
					replicas: resolvedReplicas,
					extraLiteLLMSettings: args.extraLiteLLMSettings,
					extraGeneralSettings: args.extraGeneralSettings,
					extraRouterSettings: args.extraRouterSettings,
				});

				return generatedConfig.configYaml;
			});

		this.configYaml = configYaml;

		this.namespaceResource = createNamespace
			? new k8s.core.v1.Namespace(
					`${name}-ns`,
					{
						metadata: {
							name: namespaceName,
							labels: {
								"app.kubernetes.io/name": "litellm",
								"app.kubernetes.io/component": "proxy",
								"app.kubernetes.io/managed-by": "pulumi",
							},
						},
					},
					{ ...opts, parent: this },
				)
			: undefined;

		this.namespace = this.namespaceResource?.metadata.name ?? namespaceName;

		const parentAndProvider = { ...opts, parent: this };

		const cloudSqlConfig = args.cloudSqlAuthProxy;
		const cloudSqlSidecar = cloudSqlConfig
			? new CloudSqlAuthProxySidecar(
					`${name}-cloudsql`,
					{
						connectionName: cloudSqlConfig.connectionName,
						databaseUrl: args.databaseUrl,
						proxyPort: cloudSqlConfig.proxyPort,
						image: cloudSqlConfig.image,
						extraArgs: cloudSqlConfig.extraArgs,
						resources: cloudSqlConfig.resources,
						kubernetes: {
							namespace: this.namespace,
							provider: opts?.provider as k8s.Provider | undefined,
							secretName: `${name}-cloudsql-sa-key`,
						},
						credentials: cloudSqlConfig.serviceAccountKey
							? {
									mode: "inline-key",
									serviceAccountKey: cloudSqlConfig.serviceAccountKey,
								}
							: { mode: "ambient-iam" },
					},
					parentAndProvider,
				)
			: undefined;
		const effectiveDatabaseUrl: pulumi.Output<string> = cloudSqlSidecar
			? cloudSqlSidecar.rewrittenDatabaseUrl.apply((databaseUrl) => {
					if (databaseUrl === undefined) {
						throw new Error(
							"LiteLLMProxy Cloud SQL sidecar requires a rewritten DATABASE_URL",
						);
					}
					return databaseUrl;
				})
			: pulumi.output(args.databaseUrl);

		this.providerSecret = new k8s.core.v1.Secret(
			`${name}-providers`,
			{
				metadata: {
					name: providerSecretName,
					namespace: this.namespace,
				},
				stringData: providerStringData,
			},
			parentAndProvider,
		);

		const generatedMasterKey = new random.RandomPassword(
			`${name}-master-key`,
			{
				length: 32,
				special: false,
			},
			{ parent: this },
		).result;
		this.masterKey = pulumi.secret(
			pulumi.output(args.masterKey ?? generatedMasterKey),
		);

		const runtimeSecretData = pulumi
			.all([this.masterKey, effectiveDatabaseUrl, extraSecretEnv])
			.apply(([masterKey, databaseUrl, resolvedExtraSecretEnv]) => ({
				LITELLM_MASTER_KEY: masterKey,
				DATABASE_URL: databaseUrl,
				...resolvedExtraSecretEnv,
			}));

		this.runtimeSecret = new k8s.core.v1.Secret(
			`${name}-runtime`,
			{
				metadata: {
					name: `${name}-runtime`,
					namespace: this.namespace,
				},
				stringData: runtimeSecretData,
			},
			parentAndProvider,
		);

		this.configMap = new k8s.core.v1.ConfigMap(
			`${name}-config`,
			{
				metadata: {
					name: `${name}-config`,
					namespace: this.namespace,
				},
				data: {
					"config.yaml": this.configYaml,
				},
			},
			parentAndProvider,
		);

		this.cloudSqlSaKeySecret = cloudSqlSidecar?.credentialSecret;

		const cloudSqlSidecarContainer = cloudSqlSidecar?.container;

		const appLabels = {
			"app.kubernetes.io/name": "litellm",
			"app.kubernetes.io/component": "proxy",
			"app.kubernetes.io/instance": name,
		};

		const env = pulumi
			.all([
				providerEnvVars,
				this.runtimeSecret.metadata.name,
				this.providerSecret.metadata.name,
				extraEnv,
				extraSecretEnvKeys,
			])
			.apply(
				([
					providerSecretEnvVars,
					runtimeSecretName,
					providerSecretName,
					extraEnvVars,
					resolvedExtraSecretEnvKeys,
				]) => {
					validateExtraEnvNameCollisions(
						extraEnvEntries.map(([name]) => name),
						extraSecretEnvEntries.map(([name]) => name),
						providerSecretEnvVars,
					);
					return [
						{
							name: "LITELLM_MASTER_KEY",
							valueFrom: {
								secretKeyRef: {
									name: runtimeSecretName,
									key: "LITELLM_MASTER_KEY",
								},
							},
						},
						{
							name: "DATABASE_URL",
							valueFrom: {
								secretKeyRef: {
									name: runtimeSecretName,
									key: "DATABASE_URL",
								},
							},
						},
						...providerSecretEnvVars.map((envVar) => ({
							name: envVar,
							valueFrom: {
								secretKeyRef: {
									name: providerSecretName,
									key: toSecretKey(envVar),
								},
							},
						})),
						...resolvedExtraSecretEnvKeys.map((name) => ({
							name,
							valueFrom: {
								secretKeyRef: {
									name: runtimeSecretName,
									key: name,
								},
							},
						})),
						...extraEnvVars,
					];
				},
			);

		this.deployment = new k8s.apps.v1.Deployment(
			`${name}-deployment`,
			{
				metadata: {
					name,
					namespace: this.namespace,
					labels: appLabels,
				},
				spec: {
					replicas,
					selector: {
						matchLabels: appLabels,
					},
					template: {
						metadata: {
							labels: appLabels,
						},
						spec: {
							containers: pulumi
								.all([env, cloudSqlSidecarContainer ?? null])
								.apply(([envVars, sidecar]) => {
									const main: k8s.types.input.core.v1.Container = {
										name: "litellm",
										image,
										args: ["--config", "/app/config.yaml"],
										ports: [{ containerPort: servicePort }],
										env: envVars,
										volumeMounts: [
											{
												name: "config-volume",
												mountPath: "/app/config.yaml",
												subPath: "config.yaml",
												readOnly: true,
											},
										],
										livenessProbe: {
											httpGet: {
												path: "/health/liveliness",
												port: servicePort,
											},
											initialDelaySeconds: 180,
											periodSeconds: 15,
											timeoutSeconds: 10,
											failureThreshold: 3,
										},
										readinessProbe: {
											httpGet: {
												path: "/health/readiness",
												port: servicePort,
											},
											initialDelaySeconds: 30,
											periodSeconds: 15,
											timeoutSeconds: 10,
											failureThreshold: 3,
										},
										resources: args.resources ?? {
											requests: {
												cpu: "250m",
												memory: "512Mi",
											},
											limits: { cpu: "1", memory: "2Gi" },
										},
									};
									return sidecar ? [main, sidecar] : [main];
								}),
							volumes: pulumi
								.all([
									this.configMap.metadata.name,
									cloudSqlSidecar?.volumes ?? [],
								])
								.apply(([configMapName, sidecarVolumes]) => [
									{
										name: "config-volume",
										configMap: { name: configMapName },
									},
									...sidecarVolumes,
								]),
						},
					},
				},
			},
			parentAndProvider,
		);

		this.service = new k8s.core.v1.Service(
			`${name}-service`,
			{
				metadata: {
					name,
					namespace: this.namespace,
					labels: appLabels,
				},
				spec: {
					type: args.service?.type ?? "ClusterIP",
					selector: appLabels,
					ports: [
						{
							name: "http",
							port: servicePort,
							targetPort: servicePort,
							protocol: "TCP",
						},
					],
				},
			},
			parentAndProvider,
		);

		this.proxyUrl = pulumi.interpolate`http://${this.service.metadata.name}.${this.namespace}.svc.cluster.local:${servicePort}`;

		this.registerOutputs({
			namespace: this.namespace,
			proxyUrl: this.proxyUrl,
			masterKey: this.masterKey,
			configYaml: this.configYaml,
			serviceName: this.service.metadata.name,
		});
	}
}
