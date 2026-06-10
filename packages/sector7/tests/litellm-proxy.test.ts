import * as pulumi from "@pulumi/pulumi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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

	it("injects extraSecretRefEnv from an externally-managed Secret", async () => {
		const proxy = new LiteLLMProxy("oprefs-proxy", {
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
				LANGFUSE_PUBLIC_KEY: {
					secretName: "langfuse-api-keys",
					key: "username",
				},
				LANGFUSE_SECRET_KEY: {
					secretName: "langfuse-api-keys",
					key: "credential",
				},
			},
		});

		await Promise.all([
			resolveOutput(proxy.runtimeSecret.id),
			resolveOutput(proxy.deployment.id),
		]);

		// The external secret values must NOT enter the component-managed runtime Secret.
		const runtimeSecret = findResource("oprefs-proxy-runtime");
		const runtimeData = runtimeSecret?.inputs.stringData as {
			value: Record<string, string>;
		};
		expect(runtimeData.value).not.toHaveProperty("LANGFUSE_PUBLIC_KEY");
		expect(runtimeData.value).not.toHaveProperty("LANGFUSE_SECRET_KEY");

		const deployment = findResource("oprefs-proxy-deployment");
		const spec = (await resolveRecord(
			deployment?.inputs.spec as Record<string, unknown> | undefined,
		)) as {
			template: {
				spec: { containers: Array<{ env?: Array<Record<string, unknown>> }> };
			};
		};
		const env = spec.template.spec.containers[0]?.env ?? [];
		expect(env.find((e) => e.name === "LANGFUSE_PUBLIC_KEY")).toMatchObject({
			name: "LANGFUSE_PUBLIC_KEY",
			valueFrom: {
				secretKeyRef: { name: "langfuse-api-keys", key: "username" },
			},
		});
		expect(env.find((e) => e.name === "LANGFUSE_SECRET_KEY")).toMatchObject({
			name: "LANGFUSE_SECRET_KEY",
			valueFrom: {
				secretKeyRef: { name: "langfuse-api-keys", key: "credential" },
			},
		});
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

	it("rejects collisions between extraSecretEnv and extraSecretRefEnv names", () => {
		expect(() =>
			validateExtraEnvNameCollisions(
				[],
				["LANGFUSE_PUBLIC_KEY"],
				[],
				["LANGFUSE_PUBLIC_KEY"],
			),
		).toThrow(
			"extraSecretEnv and extraSecretRefEnv both define 'LANGFUSE_PUBLIC_KEY'",
		);
	});

	it("rejects extraSecretRefEnv names that override provider env vars", () => {
		expect(() =>
			validateExtraEnvNameCollisions(
				[],
				[],
				["ANTHROPIC_API_KEY"],
				["ANTHROPIC_API_KEY"],
			),
		).toThrow(
			"extraSecretRefEnv cannot override provider environment variable 'ANTHROPIC_API_KEY'",
		);
	});

	it("accepts distinct extraSecretRefEnv names", () => {
		expect(() =>
			validateExtraEnvNameCollisions(
				["LANGFUSE_HOST"],
				["OTHER_SECRET"],
				["ANTHROPIC_API_KEY"],
				["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"],
			),
		).not.toThrow();
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

	// NOTE: LiteLLMTeam / LiteLLMApiKey are now Pulumi dynamic resources (they
	// were `command:local:Command` shell-outs). Their create/diff/update/delete
	// behaviour is covered by tests/litellm-admin.test.ts, which exercises the
	// providers directly. They are intentionally NOT constructed here: building a
	// dynamic resource under the Pulumi mock runtime forces closure serialization,
	// and vitest/vite rewrites the providers' `await import()` calls into a module
	// runner that captures `this`, which the serializer rejects. That rewriting is
	// a test-environment artifact — under a real `pulumi up` the `await import()`
	// calls serialize verbatim, the same pattern the R2 dynamic provider relies on.
});
