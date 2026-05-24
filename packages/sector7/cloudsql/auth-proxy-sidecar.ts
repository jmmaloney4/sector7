import * as gcp from "@pulumi/gcp";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const DEFAULT_PROXY_IMAGE = "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2";
const DEFAULT_PROXY_PORT = 5432;
const CREDENTIALS_VOLUME_NAME = "cloudsql-credentials";
const CREDENTIALS_DIRECTORY = "/cloudsql";
const CREDENTIALS_FILE_PATH = `${CREDENTIALS_DIRECTORY}/credentials.json`;
const DEFAULT_PROXY_RESOURCES: k8s.types.input.core.v1.ResourceRequirements = {
	requests: { cpu: "50m", memory: "64Mi" },
	limits: { cpu: "250m", memory: "128Mi" },
};

export interface CloudSqlAuthProxyKubernetesArgs {
	namespace?: pulumi.Input<string>;
	provider?: k8s.Provider;
	secretName?: pulumi.Input<string>;
}

export interface CloudSqlAuthProxyExistingSecretCredentials {
	mode: "existing-secret";
	secretName: pulumi.Input<string>;
}

export interface CloudSqlAuthProxyInlineKeyCredentials {
	mode: "inline-key";
	serviceAccountKey: pulumi.Input<string>;
}

export interface CloudSqlAuthProxyManagedKeyCredentials {
	mode: "managed-key";
	project: pulumi.Input<string>;
	accountId: pulumi.Input<string>;
	displayName?: pulumi.Input<string>;
}

export interface CloudSqlAuthProxyAmbientIamCredentials {
	mode: "ambient-iam";
}

export type CloudSqlAuthProxyCredentials =
	| CloudSqlAuthProxyExistingSecretCredentials
	| CloudSqlAuthProxyInlineKeyCredentials
	| CloudSqlAuthProxyManagedKeyCredentials
	| CloudSqlAuthProxyAmbientIamCredentials;

export interface CloudSqlAuthProxySidecarArgs {
	connectionName: pulumi.Input<string>;
	databaseUrl?: pulumi.Input<string>;
	proxyPort?: pulumi.Input<number>;
	image?: pulumi.Input<string>;
	extraArgs?: pulumi.Input<pulumi.Input<string>[]>;
	resources?: pulumi.Input<k8s.types.input.core.v1.ResourceRequirements>;
	kubernetes?: CloudSqlAuthProxyKubernetesArgs;
	credentials?: CloudSqlAuthProxyCredentials;
}

export function rewriteDatabaseUrlForProxy(
	url: string,
	proxyPort: number,
): string {
	const parsed = new URL(url);
	parsed.hostname = "127.0.0.1";
	parsed.port = String(proxyPort);
	parsed.searchParams.set("sslmode", "disable");
	return parsed.toString();
}

function decodeServiceAccountKey(base64Key: string): string {
	return Buffer.from(base64Key, "base64").toString("utf8");
}

function resolveSecretName(
	name: string,
	args: CloudSqlAuthProxySidecarArgs,
): pulumi.Input<string> {
	return args.kubernetes?.secretName ?? `${name}-cloudsql-credentials`;
}

function aliasToPreviousParent(
	opts: pulumi.ComponentResourceOptions | undefined,
	name?: string,
): pulumi.Alias[] | undefined {
	if (!opts?.parent) {
		return undefined;
	}

	return [{ parent: opts.parent, ...(name ? { name } : {}) }];
}

function withOptionalKubernetesProvider(
	options: pulumi.CustomResourceOptions,
	provider: k8s.Provider | undefined,
): pulumi.CustomResourceOptions {
	return provider ? { ...options, provider } : options;
}

function buildContainer(args: {
	connectionName: string;
	proxyPort: number;
	image: string;
	extraArgs?: string[];
	resources: k8s.types.input.core.v1.ResourceRequirements;
	credentialSecretName?: string;
}): k8s.types.input.core.v1.Container {
	const sidecarArgs: string[] = [
		args.connectionName,
		"--address=127.0.0.1",
		`--port=${args.proxyPort}`,
	];
	if (args.credentialSecretName) {
		sidecarArgs.push(`--credentials-file=${CREDENTIALS_FILE_PATH}`);
	}
	if (args.extraArgs) {
		sidecarArgs.push(...args.extraArgs);
	}

	return {
		name: "cloud-sql-proxy",
		image: args.image,
		args: sidecarArgs,
		resources: args.resources,
		...(args.credentialSecretName && {
			volumeMounts: [
				{
					name: CREDENTIALS_VOLUME_NAME,
					mountPath: CREDENTIALS_DIRECTORY,
					readOnly: true,
				},
			],
		}),
		securityContext: {
			runAsNonRoot: true,
			allowPrivilegeEscalation: false,
		},
	};
}

export class CloudSqlAuthProxySidecar extends pulumi.ComponentResource {
	public readonly container: pulumi.Output<k8s.types.input.core.v1.Container>;
	public readonly volumes: pulumi.Output<k8s.types.input.core.v1.Volume[]>;
	public readonly rewrittenDatabaseUrl: pulumi.Output<string | undefined>;

	public readonly credentialSecret?: k8s.core.v1.Secret;
	public readonly serviceAccount?: gcp.serviceaccount.Account;
	public readonly serviceAccountKey?: gcp.serviceaccount.Key;
	public readonly cloudSqlClientMembership?: gcp.projects.IAMMember;

	constructor(
		name: string,
		args: CloudSqlAuthProxySidecarArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("sector7:cloudsql:AuthProxySidecar", name, args, opts);

		const credentials = args.credentials ?? ({ mode: "ambient-iam" } as const);
		const proxyPort = pulumi
			.output(args.proxyPort)
			.apply((value) => value ?? DEFAULT_PROXY_PORT);
		const image = pulumi
			.output(args.image)
			.apply((value) => value ?? DEFAULT_PROXY_IMAGE);
		const extraArgs = pulumi.output(args.extraArgs);
		const resources = pulumi
			.output(args.resources)
			.apply((value) => value ?? DEFAULT_PROXY_RESOURCES);

		let credentialSecretName: pulumi.Input<string> | undefined;

		switch (credentials.mode) {
			case "existing-secret": {
				credentialSecretName = credentials.secretName;
				break;
			}
			case "inline-key": {
				const namespace = args.kubernetes?.namespace;
				if (!namespace) {
					throw new Error(
						"CloudSqlAuthProxySidecar inline-key mode requires a Kubernetes namespace",
					);
				}
				credentialSecretName = resolveSecretName(name, args);
				this.credentialSecret = new k8s.core.v1.Secret(
					`${name}-credentials`,
					{
						metadata: {
							name: credentialSecretName,
							namespace,
						},
						stringData: {
							"credentials.json": pulumi.secret(credentials.serviceAccountKey),
						},
					},
					withOptionalKubernetesProvider(
						{
							...opts,
							parent: this,
							aliases: aliasToPreviousParent(opts, `${name}-sa-key`),
						},
						args.kubernetes?.provider,
					),
				);
				credentialSecretName = this.credentialSecret.metadata.name;
				break;
			}
			case "managed-key": {
				const namespace = args.kubernetes?.namespace;
				if (!namespace) {
					throw new Error(
						"CloudSqlAuthProxySidecar managed-key mode requires a Kubernetes namespace",
					);
				}

				this.serviceAccount = new gcp.serviceaccount.Account(
					`${name}-service-account`,
					{
						project: credentials.project,
						accountId: credentials.accountId,
						displayName: credentials.displayName,
					},
					{
						...opts,
						parent: this,
						aliases: aliasToPreviousParent(opts),
					},
				);
				this.cloudSqlClientMembership = new gcp.projects.IAMMember(
					`${name}-cloudsql-client`,
					{
						project: credentials.project,
						role: "roles/cloudsql.client",
						member: this.serviceAccount.email.apply(
							(email) => `serviceAccount:${email}`,
						),
					},
					{
						...opts,
						parent: this,
						aliases: aliasToPreviousParent(opts),
					},
				);
				this.serviceAccountKey = new gcp.serviceaccount.Key(
					`${name}-service-account-key`,
					{
						serviceAccountId: this.serviceAccount.name,
					},
					{
						...opts,
						parent: this,
						aliases: aliasToPreviousParent(opts),
						dependsOn: this.cloudSqlClientMembership
							? [this.cloudSqlClientMembership]
							: undefined,
					},
				);

				credentialSecretName = resolveSecretName(name, args);
				this.credentialSecret = new k8s.core.v1.Secret(
					`${name}-credentials`,
					{
						metadata: {
							name: credentialSecretName,
							namespace,
						},
						stringData: {
							"credentials.json": pulumi.secret(
								this.serviceAccountKey.privateKey.apply(
									decodeServiceAccountKey,
								),
							),
						},
					},
					withOptionalKubernetesProvider(
						{
							...opts,
							parent: this,
							aliases: aliasToPreviousParent(opts, `${name}-sa-key`),
							dependsOn: [
								this.cloudSqlClientMembership,
								this.serviceAccountKey,
							],
						},
						args.kubernetes?.provider,
					),
				);
				credentialSecretName = this.credentialSecret.metadata.name;
				break;
			}
			case "ambient-iam": {
				break;
			}
			default: {
				const neverCredentials: never = credentials;
				throw new Error(
					`Unsupported Cloud SQL credential mode: ${JSON.stringify(neverCredentials)}`,
				);
			}
		}

		const credentialSecretNameOutput = pulumi.output(credentialSecretName);

		this.rewrittenDatabaseUrl = pulumi
			.all([pulumi.output(args.databaseUrl), proxyPort])
			.apply(([databaseUrl, resolvedProxyPort]) =>
				databaseUrl
					? rewriteDatabaseUrlForProxy(databaseUrl, resolvedProxyPort)
					: undefined,
			);

		this.container = pulumi
			.all([
				pulumi.output(args.connectionName),
				proxyPort,
				image,
				extraArgs,
				resources,
				credentialSecretNameOutput,
			])
			.apply(
				([
					connectionName,
					resolvedProxyPort,
					resolvedImage,
					resolvedExtraArgs,
					resolvedResources,
					resolvedCredentialSecretName,
				]) =>
					buildContainer({
						connectionName,
						proxyPort: resolvedProxyPort,
						image: resolvedImage,
						extraArgs: resolvedExtraArgs,
						resources: resolvedResources,
						credentialSecretName: resolvedCredentialSecretName,
					}),
			);

		this.volumes = credentialSecretNameOutput.apply((secretName) =>
			secretName
				? [
						{
							name: CREDENTIALS_VOLUME_NAME,
							secret: { secretName },
						},
					]
				: [],
		) as pulumi.Output<k8s.types.input.core.v1.Volume[]>;

		this.registerOutputs({
			container: this.container,
			volumes: this.volumes,
			rewrittenDatabaseUrl: this.rewrittenDatabaseUrl,
			credentialSecretName,
			serviceAccountEmail: this.serviceAccount?.email,
		});
	}
}
