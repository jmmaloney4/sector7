import * as pulumi from "@pulumi/pulumi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LiteLLMApiKey, LiteLLMTeam } from "../litellm/admin.ts";
import {
	LiteLLMProxy,
	validateExtraEnvNameCollisions,
} from "../litellm/litellm-proxy.ts";
import {
	findResource,
	installPulumiMocks,
	resetMockResources,
	resolveOutput,
	resolveRecord,
} from "./pulumi-test-helpers.ts";

beforeAll(() => {
	installPulumiMocks();
});

beforeEach(() => {
	resetMockResources();
});

describe("LiteLLMProxy", () => {
	it("creates namespace, secrets, configmap, deployment, and service", async () => {
		const proxy = new LiteLLMProxy("team-proxy", {
			namespace: "litellm-prod",
			providers: {
				anthropic: { apiKey: pulumi.secret("anthropic-secret") },
				openai: {
					apiKey: pulumi.secret("openai-secret"),
					apiBase: "https://api.openai.example/v1",
				},
			},
			deployments: [
				{
					id: "anthropic-smart",
					provider: "anthropic",
					providerModel: "anthropic/claude-sonnet-4-20250514",
					mode: "chat",
				},
				{
					id: "openai-fast",
					provider: "openai",
					providerModel: "openai/gpt-4o-mini",
					mode: "chat",
				},
			],
			modelGroups: [
				{
					name: "smart",
					deploymentIds: ["anthropic-smart"],
					fallbacks: ["fast"],
				},
				{ name: "fast", deploymentIds: ["openai-fast"] },
			],
			databaseUrl: pulumi.secret(
				"postgres://db-user:real-pass@db.internal/litellm",
			),
		});

		await Promise.all([
			resolveOutput(proxy.proxyUrl),
			resolveOutput(proxy.masterKey),
			resolveOutput(proxy.configYaml),
			resolveOutput(proxy.providerSecret.id),
			resolveOutput(proxy.runtimeSecret.id),
			resolveOutput(proxy.configMap.id),
			resolveOutput(proxy.deployment.id),
			resolveOutput(proxy.service.id),
		]);

		expect(await resolveOutput(proxy.proxyUrl)).toBe(
			"http://team-proxy.litellm-prod.svc.cluster.local:4000",
		);
		expect(await resolveOutput(proxy.masterKey)).toBe("generated-master-key");

		const namespace = findResource("team-proxy-ns");
		expect(namespace?.type).toBe("kubernetes:core/v1:Namespace");

		const providerSecret = findResource("team-proxy-providers");
		expect(providerSecret?.type).toBe("kubernetes:core/v1:Secret");
		const providerSecretData = providerSecret?.inputs.stringData as {
			value: Record<string, string>;
		};
		expect(providerSecretData.value).toEqual({
			anthropic_api_key: "anthropic-secret",
			openai_api_key: "openai-secret",
		});

		const runtimeSecret = findResource("team-proxy-runtime");
		const runtimeSecretData = runtimeSecret?.inputs.stringData as {
			value: Record<string, string>;
		};
		expect(runtimeSecretData.value).toEqual({
			LITELLM_MASTER_KEY: "generated-master-key",
			DATABASE_URL: "postgres://db-user:real-pass@db.internal/litellm",
		});

		const configYaml = await resolveOutput(proxy.configYaml);
		expect(configYaml).toContain("model_name: smart");
		expect(configYaml).toContain("os.environ/ANTHROPIC_API_KEY");
		expect(configYaml).toContain("database_url: os.environ/DATABASE_URL");
		expect(configYaml).not.toContain("real-pass");

		const deployment = findResource("team-proxy-deployment");
		expect(deployment?.type).toBe("kubernetes:apps/v1:Deployment");
		expect(deployment?.inputs.metadata).toMatchObject({
			name: "team-proxy",
			namespace: "litellm-prod",
		});

		const service = findResource("team-proxy-service");
		expect(service?.type).toBe("kubernetes:core/v1:Service");
	});

	it("creates Cloud SQL Auth Proxy sidecar when configured", async () => {
		const proxy = new LiteLLMProxy("sidecar-proxy", {
			namespace: "litellm-prod",
			providers: { anthropic: { apiKey: pulumi.secret("anthropic-secret") } },
			deployments: [
				{
					id: "anthropic-smart",
					provider: "anthropic",
					providerModel: "anthropic/claude-sonnet-4-20250514",
				},
			],
			modelGroups: [{ name: "smart", deploymentIds: ["anthropic-smart"] }],
			databaseUrl: pulumi.secret(
				"postgresql://user:pass@34.162.159.18:5432/mydb?sslmode=require",
			),
			cloudSqlAuthProxy: {
				connectionName: "my-project:us-east5:my-instance",
				serviceAccountKey: pulumi.secret('{"type": "service_account"}'),
				resources: {
					requests: { cpu: "50m", memory: "64Mi" },
					limits: { cpu: "200m", memory: "256Mi" },
				},
			},
		});

		await Promise.all([
			resolveOutput(proxy.proxyUrl),
			resolveOutput(proxy.deployment.id),
			resolveOutput(proxy.cloudSqlSaKeySecret?.id),
		]);

		// SA key secret should be created.
		const saKeySecret = findResource("sidecar-proxy-cloudsql-credentials");
		expect(saKeySecret?.type).toBe("kubernetes:core/v1:Secret");

		// Runtime secret should have the rewritten DATABASE_URL pointing at localhost.
		const runtimeSecret = findResource("sidecar-proxy-runtime");
		const runtimeData = runtimeSecret?.inputs.stringData as {
			value: Record<string, string>;
		};
		expect(runtimeData.value.DATABASE_URL).toBe(
			"postgresql://user:pass@127.0.0.1:5432/mydb?sslmode=disable",
		);

		// Deployment should exist.
		const deployment = findResource("sidecar-proxy-deployment");
		expect(deployment?.type).toBe("kubernetes:apps/v1:Deployment");
	});

	it("can skip namespace creation", async () => {
		const proxy = new LiteLLMProxy("shared-proxy", {
			createNamespace: false,
			namespace: "shared-services",
			providers: { anthropic: { apiKey: pulumi.secret("anthropic-secret") } },
			deployments: [
				{
					id: "anthropic-smart",
					provider: "anthropic",
					providerModel: "anthropic/claude-sonnet-4-20250514",
				},
			],
			modelGroups: [{ name: "smart", deploymentIds: ["anthropic-smart"] }],
			databaseUrl: pulumi.secret("postgres://db-user:***@db.internal/litellm"),
		});

		await resolveOutput(proxy.proxyUrl);

		expect(findResource("shared-proxy-ns")).toBeUndefined();
		expect(await resolveOutput(proxy.namespace)).toBe("shared-services");
	});

	it("injects extra env and extra secret env into the proxy container", async () => {
		const proxy = new LiteLLMProxy("observed-proxy", {
			namespace: "litellm-prod",
			providers: { anthropic: { apiKey: pulumi.secret("anthropic-secret") } },
			deployments: [
				{
					id: "anthropic-smart",
					provider: "anthropic",
					providerModel: "anthropic/claude-sonnet-4-20250514",
				},
			],
			modelGroups: [{ name: "smart", deploymentIds: ["anthropic-smart"] }],
			databaseUrl: pulumi.secret("postgres://db-user:***@db.internal/litellm"),
			extraEnv: {
				LANGFUSE_TRACING_ENVIRONMENT: "prod",
			},
			extraSecretEnv: {
				LANGFUSE_PUBLIC_KEY: pulumi.secret("pk-lf-test"),
				LANGFUSE_SECRET_KEY: pulumi.secret("sk-lf-test"),
				LANGFUSE_HOST: "http://langfuse-web.langfuse.svc.cluster.local:3000",
			},
		});

		await Promise.all([
			resolveOutput(proxy.runtimeSecret.id),
			resolveOutput(proxy.deployment.id),
		]);

		const runtimeSecret = findResource("observed-proxy-runtime");
		const runtimeSecretData = runtimeSecret?.inputs.stringData as {
			value: Record<string, string>;
		};
		expect(runtimeSecretData.value).toMatchObject({
			LANGFUSE_PUBLIC_KEY: "pk-lf-test",
			LANGFUSE_SECRET_KEY: "sk-lf-test",
			LANGFUSE_HOST: "http://langfuse-web.langfuse.svc.cluster.local:3000",
		});

		const deployment = findResource("observed-proxy-deployment");
		const spec = (await resolveRecord(
			deployment?.inputs.spec as Record<string, unknown> | undefined,
		)) as {
			template: {
				spec: { containers: Array<{ env?: Array<Record<string, unknown>> }> };
			};
		};
		const env = spec.template.spec.containers[0]?.env ?? [];
		expect(
			env.find((entry) => entry.name === "LANGFUSE_TRACING_ENVIRONMENT"),
		).toMatchObject({
			name: "LANGFUSE_TRACING_ENVIRONMENT",
			value: "prod",
		});
		expect(env.find((entry) => entry.name === "LANGFUSE_HOST")).toMatchObject({
			name: "LANGFUSE_HOST",
			valueFrom: {
				secretKeyRef: {
					name: "observed-proxy-runtime",
					key: "LANGFUSE_HOST",
				},
			},
		});
	});

	it("injects extra secret-ref env from an existing secret without storing values", async () => {
		const proxy = new LiteLLMProxy("ref-proxy", {
			namespace: "litellm-prod",
			providers: { anthropic: { apiKey: pulumi.secret("anthropic-secret") } },
			deployments: [
				{
					id: "anthropic-smart",
					provider: "anthropic",
					providerModel: "anthropic/claude-sonnet-4-20250514",
				},
			],
			modelGroups: [{ name: "smart", deploymentIds: ["anthropic-smart"] }],
			databaseUrl: pulumi.secret("postgres://db-user:***@db.internal/litellm"),
			extraSecretRefEnv: {
				LANGFUSE_PUBLIC_KEY: { secretName: "langfuse-keys", key: "username" },
				LANGFUSE_SECRET_KEY: {
					secretName: pulumi.output("langfuse-keys"),
					key: "credential",
				},
			},
		});

		await Promise.all([
			resolveOutput(proxy.runtimeSecret.id),
			resolveOutput(proxy.deployment.id),
		]);

		// The referenced values must NOT be copied into the component-managed
		// runtime secret — they live only in the external (operator-synced) secret.
		const runtimeSecret = findResource("ref-proxy-runtime");
		const runtimeSecretData = runtimeSecret?.inputs.stringData as {
			value: Record<string, string>;
		};
		expect(runtimeSecretData.value).not.toHaveProperty("LANGFUSE_PUBLIC_KEY");
		expect(runtimeSecretData.value).not.toHaveProperty("LANGFUSE_SECRET_KEY");

		const deployment = findResource("ref-proxy-deployment");
		const spec = (await resolveRecord(
			deployment?.inputs.spec as Record<string, unknown> | undefined,
		)) as {
			template: {
				spec: { containers: Array<{ env?: Array<Record<string, unknown>> }> };
			};
		};
		const env = spec.template.spec.containers[0]?.env ?? [];
		expect(
			env.find((entry) => entry.name === "LANGFUSE_PUBLIC_KEY"),
		).toMatchObject({
			name: "LANGFUSE_PUBLIC_KEY",
			valueFrom: { secretKeyRef: { name: "langfuse-keys", key: "username" } },
		});
		expect(
			env.find((entry) => entry.name === "LANGFUSE_SECRET_KEY"),
		).toMatchObject({
			name: "LANGFUSE_SECRET_KEY",
			valueFrom: { secretKeyRef: { name: "langfuse-keys", key: "credential" } },
		});
	});

	it("rejects collisions between extraSecretEnv and extraSecretRefEnv", () => {
		expect(() =>
			validateExtraEnvNameCollisions(
				[],
				["LANGFUSE_SECRET_KEY"],
				[],
				["LANGFUSE_SECRET_KEY"],
			),
		).toThrow(
			"LiteLLMProxy extraSecretEnv and extraSecretRefEnv both define 'LANGFUSE_SECRET_KEY'",
		);
	});

	it("rejects collisions between provider secrets and extra env names", () => {
		expect(() =>
			validateExtraEnvNameCollisions(
				["ANTHROPIC_API_KEY"],
				[],
				["ANTHROPIC_API_KEY"],
			),
		).toThrow(
			"extraEnv cannot override provider environment variable 'ANTHROPIC_API_KEY'",
		);
	});

	it("rejects collisions against provider env vars resolved from outputs", async () => {
		const resolvedProviderEnvVar = await resolveOutput(
			pulumi.output("LANGFUSE_SECRET_KEY"),
		);
		expect(() =>
			validateExtraEnvNameCollisions(
				[],
				["LANGFUSE_SECRET_KEY"],
				[resolvedProviderEnvVar],
			),
		).toThrow(
			"extraSecretEnv cannot override provider environment variable 'LANGFUSE_SECRET_KEY'",
		);
	});

	it("omits nullish resolved extra env values from rendered resources", async () => {
		const proxy = new LiteLLMProxy("filtered-proxy", {
			namespace: "litellm-prod",
			providers: { anthropic: { apiKey: pulumi.secret("anthropic-secret") } },
			deployments: [
				{
					id: "anthropic-smart",
					provider: "anthropic",
					providerModel: "anthropic/claude-sonnet-4-20250514",
				},
			],
			modelGroups: [{ name: "smart", deploymentIds: ["anthropic-smart"] }],
			databaseUrl: pulumi.secret("postgres://db-user:***@db.internal/litellm"),
			extraEnv: {
				LANGFUSE_TRACING_ENVIRONMENT: "prod",
				IGNORED_ENV: undefined as unknown as pulumi.Input<string>,
			},
			extraSecretEnv: {
				LANGFUSE_SECRET_KEY: pulumi.secret("sk-lf-test"),
				IGNORED_SECRET: undefined as unknown as pulumi.Input<string>,
			},
		});

		await Promise.all([
			resolveOutput(proxy.runtimeSecret.id),
			resolveOutput(proxy.deployment.id),
		]);

		const runtimeSecret = findResource("filtered-proxy-runtime");
		const runtimeSecretData = runtimeSecret?.inputs.stringData as {
			value: Record<string, string>;
		};
		expect(runtimeSecretData.value).toMatchObject({
			LANGFUSE_SECRET_KEY: "sk-lf-test",
		});
		expect(runtimeSecretData.value).not.toHaveProperty("IGNORED_SECRET");

		const deployment = findResource("filtered-proxy-deployment");
		const spec = (await resolveRecord(
			deployment?.inputs.spec as Record<string, unknown> | undefined,
		)) as {
			template: {
				spec: { containers: Array<{ env?: Array<Record<string, unknown>> }> };
			};
		};
		const env = spec.template.spec.containers[0]?.env ?? [];
		expect(
			env.find((entry) => entry.name === "LANGFUSE_TRACING_ENVIRONMENT"),
		).toMatchObject({
			name: "LANGFUSE_TRACING_ENVIRONMENT",
			value: "prod",
		});
		expect(env.find((entry) => entry.name === "IGNORED_ENV")).toBeUndefined();
		expect(
			env.find((entry) => entry.name === "IGNORED_SECRET"),
		).toBeUndefined();
	});

	it("creates admin command resources for teams and api keys", async () => {
		const team = new LiteLLMTeam("personal-team", {
			proxyNamespace: "litellm-prod",
			masterKey: pulumi.secret("master-key"),
			teamAlias: "Personal",
			teamId: "team-personal",
			models: ["coding", "cheap"],
			maxBudget: 250,
			budgetDuration: "30d",
			tags: ["personal"],
			metadata: { owner: "jack" },
		});
		const apiKey = new LiteLLMApiKey("personal-coding-key", {
			proxyNamespace: "litellm-prod",
			masterKey: pulumi.secret("master-key"),
			keyAlias: "personal-coding",
			teamId: "team-personal",
			models: ["coding"],
			aliases: { default: "coding" },
			metadata: { owner: "jack" },
			tags: ["personal"],
		});

		expect(await resolveOutput(team.teamId)).toBe("team-personal");
		expect(await resolveOutput(apiKey.key)).toBe("sk-generated-api-key");
		expect(await resolveOutput(apiKey.tokenId)).toBe(
			"personal-coding-key-key-stdout",
		);

		const teamCommand = findResource("personal-team-team");
		expect(teamCommand?.type).toBe("command:local:Command");
		const teamEnvironment = await resolveRecord(
			teamCommand?.inputs.environment as Record<string, unknown> | undefined,
		);
		expect(teamEnvironment).toMatchObject({
			LITELLM_PROXY_NAMESPACE: "litellm-prod",
			LITELLM_PROXY_PORT: "4000",
			LITELLM_TEAM_ALIAS: "Personal",
			LITELLM_TEAM_ID: "team-personal",
			LITELLM_TEAM_MODELS_JSON: '["coding","cheap"]',
			LITELLM_TEAM_MAX_BUDGET: "250",
		});

		const keyCommand = findResource("personal-coding-key-key");
		expect(keyCommand?.type).toBe("command:local:Command");
		const keyEnvironment = await resolveRecord(
			keyCommand?.inputs.environment as Record<string, unknown> | undefined,
		);
		expect(keyEnvironment).toMatchObject({
			LITELLM_KEY_ALIAS: "personal-coding",
			LITELLM_PROXY_PORT: "4000",
			LITELLM_KEY_TEAM_ID: "team-personal",
			LITELLM_KEY_MODELS_JSON: '["coding"]',
			LITELLM_KEY_ALIASES_JSON: '{"default":"coding"}',
		});
	});
});
