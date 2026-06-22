import * as pulumi from "@pulumi/pulumi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CloudSqlAuthProxySidecar } from "../cloudsql/index.ts";
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

describe("CloudSqlAuthProxySidecar", () => {
	it("rewrites DATABASE_URL for a localhost-bound sidecar with sane defaults", async () => {
		const proxy = new CloudSqlAuthProxySidecar("rewrite-proxy", {
			connectionName: "my-project:us-east5:my-instance",
			databaseUrl: pulumi.secret(
				"postgresql://user:pass@34.162.159.18:6543/mydb?sslmode=require",
			),
			proxyPort: 6432,
			credentials: { mode: "ambient-iam" },
		});

		const [container, volumes, rewrittenDatabaseUrl] = await Promise.all([
			resolveOutput(proxy.container),
			resolveOutput(proxy.volumes),
			resolveOutput(proxy.rewrittenDatabaseUrl),
		]);

		expect(rewrittenDatabaseUrl).toBe(
			"postgresql://user:pass@127.0.0.1:6432/mydb?sslmode=disable",
		);
		expect(container.name).toBe("cloud-sql-proxy");
		expect(container.image).toBe(
			"gcr.io/cloud-sql-connectors/cloud-sql-proxy:2",
		);
		expect(container.args).toEqual([
			"my-project:us-east5:my-instance",
			"--address=127.0.0.1",
			"--port=6432",
			"--structured-logs",
		]);
		expect(container.livenessProbe).toBeUndefined();
		expect(container.readinessProbe).toBeUndefined();
		expect(container.securityContext).toMatchObject({
			runAsNonRoot: true,
			allowPrivilegeEscalation: false,
		});
		expect(container.resources).toEqual({
			requests: { cpu: "50m", memory: "64Mi" },
			limits: { cpu: "250m", memory: "128Mi" },
		});
		expect(volumes).toEqual([]);
	});

	it("creates and mounts a credentials secret for inline-key mode", async () => {
		const proxy = new CloudSqlAuthProxySidecar("inline-proxy", {
			connectionName: "my-project:us-east5:my-instance",
			kubernetes: {
				namespace: "apps",
				secretName: "inline-cloudsql-creds",
			},
			credentials: {
				mode: "inline-key",
				serviceAccountKey: pulumi.secret('{"type":"service_account"}'),
			},
		});

		const [container, volumes] = await Promise.all([
			resolveOutput(proxy.container),
			resolveOutput(proxy.volumes),
			resolveOutput(proxy.credentialSecret?.id),
		]);

		const credentialSecret = findResource("inline-proxy-credentials");
		const credentialSecretData = await resolveRecord(
			credentialSecret?.inputs.stringData as
				| Record<string, unknown>
				| undefined,
		);
		expect(credentialSecret?.inputs.metadata).toMatchObject({
			name: "inline-cloudsql-creds",
			namespace: "apps",
		});
		expect(credentialSecretData).toEqual({
			"credentials.json": '{"type":"service_account"}',
		});
		expect(container.args).toEqual([
			"my-project:us-east5:my-instance",
			"--address=127.0.0.1",
			"--port=5432",
			"--structured-logs",
			"--credentials-file=/cloudsql/credentials.json",
		]);
		expect(container.volumeMounts).toEqual([
			{
				name: "cloudsql-credentials",
				mountPath: "/cloudsql",
				readOnly: true,
			},
		]);
		expect(volumes).toEqual([
			{
				name: "cloudsql-credentials",
				secret: { secretName: "inline-cloudsql-creds" },
			},
		]);
	});

	it("creates managed IAM resources and a decoded credentials secret for managed-key mode", async () => {
		const proxy = new CloudSqlAuthProxySidecar("managed-proxy", {
			connectionName: "my-project:us-east5:my-instance",
			kubernetes: {
				namespace: "apps",
			},
			credentials: {
				mode: "managed-key",
				project: "my-project",
				accountId: "managed-proxy",
				displayName: "Managed proxy",
			},
		});

		await Promise.all([
			resolveOutput(proxy.credentialSecret?.id),
			resolveOutput(proxy.serviceAccount?.id),
			resolveOutput(proxy.serviceAccountKey?.id),
			resolveOutput(proxy.cloudSqlClientMembership?.id),
		]);

		const serviceAccount = findResource("managed-proxy-service-account");
		expect(serviceAccount?.inputs).toMatchObject({
			accountId: "managed-proxy",
			displayName: "Managed proxy",
		});

		const iamMember = findResource("managed-proxy-cloudsql-client");
		expect(iamMember?.inputs).toMatchObject({
			project: "my-project",
			role: "roles/cloudsql.client",
			member:
				"serviceAccount:managed-proxy@mock-project.iam.gserviceaccount.com",
		});

		const serviceAccountKey = findResource("managed-proxy-service-account-key");
		expect(serviceAccountKey?.inputs.serviceAccountId).toBe(
			"projects/mock-project/serviceAccounts/managed-proxy@mock-project.iam.gserviceaccount.com",
		);

		const credentialSecret = findResource("managed-proxy-credentials");
		const credentialSecretData = await resolveRecord(
			credentialSecret?.inputs.stringData as
				| Record<string, unknown>
				| undefined,
		);
		expect(credentialSecret?.inputs.metadata).toMatchObject({
			name: "managed-proxy-cloudsql-credentials",
			namespace: "apps",
		});
		expect(credentialSecretData).toEqual({
			"credentials.json":
				'{"type":"service_account","client_email":"managed-proxy@mock-project.iam.gserviceaccount.com"}',
		});
	});

	it("skips key resources and secret creation for ambient IAM mode", async () => {
		const proxy = new CloudSqlAuthProxySidecar("ambient-proxy", {
			connectionName: "my-project:us-east5:my-instance",
			credentials: { mode: "ambient-iam" },
			extraArgs: ["--auto-iam-authn"],
		});

		const [container, volumes] = await Promise.all([
			resolveOutput(proxy.container),
			resolveOutput(proxy.volumes),
		]);

		expect(proxy.credentialSecret).toBeUndefined();
		expect(proxy.serviceAccount).toBeUndefined();
		expect(proxy.serviceAccountKey).toBeUndefined();
		expect(proxy.cloudSqlClientMembership).toBeUndefined();
		expect(container.args).toEqual([
			"my-project:us-east5:my-instance",
			"--address=127.0.0.1",
			"--port=5432",
			"--structured-logs",
			"--auto-iam-authn",
		]);
		expect(container.volumeMounts).toBeUndefined();
		expect(volumes).toEqual([]);
	});

	it("omits --structured-logs when structuredLogs is disabled", async () => {
		const proxy = new CloudSqlAuthProxySidecar("plaintext-proxy", {
			connectionName: "my-project:us-east5:my-instance",
			credentials: { mode: "ambient-iam" },
			structuredLogs: false,
		});

		const container = await resolveOutput(proxy.container);

		expect(container.args).toEqual([
			"my-project:us-east5:my-instance",
			"--address=127.0.0.1",
			"--port=5432",
		]);
	});
});
