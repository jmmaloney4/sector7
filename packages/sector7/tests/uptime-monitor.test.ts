import * as pulumi from "@pulumi/pulumi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock D1Query to avoid V8 closure serialization of the dynamic provider
// functions during pulumi.runtime.setMocks testing.
vi.mock("../d1/d1-query.ts", () => {
	return {
		D1Query: class extends pulumi.ComponentResource {
			public readonly sqlHash: pulumi.Output<string>;
			constructor(_name: string, args: Record<string, unknown>) {
				super("sector7:test:D1Query", _name, {}, {});
				this.sqlHash = pulumi.output("mock-hash");
				this.registerOutputs({ sqlHash: this.sqlHash });
			}
		},
	};
});

import { UptimeMonitor } from "../monitor/uptime-monitor.ts";

type MockResource = {
	type: string;
	name: string;
	inputs: Record<string, unknown>;
};

const resources: MockResource[] = [];

beforeAll(() => {
	pulumi.runtime.setMocks({
		newResource: (args) => {
			const state = args.inputs;

			resources.push({
				type: args.type,
				name: args.name,
				inputs: state as Record<string, unknown>,
			});

			return {
				id: `${args.name}-id`,
				state,
			};
		},
		call: (args) => args.inputs,
	});
});

beforeEach(() => {
	resources.length = 0;
});

function resolveOutput<T>(value: pulumi.Input<T>): Promise<T> {
	return new Promise((resolve) => {
		pulumi.output(value).apply((resolved) => {
			resolve(resolved as T);
			return resolved;
		});
	});
}

function findResource(name: string): MockResource | undefined {
	return resources.find((r) => r.name === name);
}

const DEFAULT_ARGS = {
	accountId: "account-123",
	apiToken: "test-api-token",
} as const;

describe("UptimeMonitor", () => {
	it("creates D1, KV, Worker, cron trigger, and D1Query for a basic monitor", async () => {
		const monitor = new UptimeMonitor("basic", {
			...DEFAULT_ARGS,
			name: "basic-uptime",
			monitors: [{ id: "grafana", url: "https://grafana.example.com/healthz" }],
		});

		await resolveOutput(monitor.worker.id);
		await resolveOutput(monitor.cronTrigger.id);

		expect(findResource("basic-d1")).toBeDefined();
		expect(findResource("basic-kv")).toBeDefined();
		expect(findResource("basic-worker")).toBeDefined();
		expect(findResource("basic-cron")).toBeDefined();
		expect(monitor.d1Query).toBeDefined();

		const worker = findResource("basic-worker");
		const bindings = worker?.inputs.bindings as Array<Record<string, unknown>>;
		expect(bindings).toHaveLength(2);

		const d1Binding = bindings.find((b) => b.name === "DB");
		expect(d1Binding).toBeDefined();
		expect(d1Binding?.type).toBe("d1");

		const kvBinding = bindings.find((b) => b.name === "KV");
		expect(kvBinding).toBeDefined();
		expect(kvBinding?.type).toBe("kv_namespace");
	});

	it("adds a webhook secret binding when webhookUrl is provided", async () => {
		const monitor = new UptimeMonitor("webhook", {
			...DEFAULT_ARGS,
			name: "webhook-uptime",
			monitors: [{ id: "api", url: "https://api.example.com/healthz" }],
			webhookUrl: "https://discord.com/api/webhooks/test",
		});

		await resolveOutput(monitor.worker.id);

		const worker = findResource("webhook-worker");
		expect(worker).toBeDefined();

		const rawBindings = worker!.inputs.bindings;
		const bindings = await resolveOutput(
			rawBindings as pulumi.Input<Array<Record<string, unknown>>>,
		);

		expect(bindings).toHaveLength(3);

		const webhookBinding = bindings.find((b) => b.name === "WEBHOOK_URL");
		expect(webhookBinding).toBeDefined();
		expect(webhookBinding?.type).toBe("secret_text");
	});

	it("creates a cron trigger with the specified schedule", async () => {
		const monitor = new UptimeMonitor("scheduled", {
			...DEFAULT_ARGS,
			name: "scheduled-uptime",
			monitors: [{ id: "site", url: "https://example.com/" }],
			cronSchedule: "*/5 * * * *",
		});

		await resolveOutput(monitor.cronTrigger.id);

		const cron = findResource("scheduled-cron");
		expect(cron).toBeDefined();
		const schedules = cron?.inputs.schedules as Array<Record<string, unknown>>;
		expect(schedules).toHaveLength(1);
		expect(schedules[0].cron).toBe("*/5 * * * *");
	});

	it("defaults to every-minute cron schedule", async () => {
		const monitor = new UptimeMonitor("defcron", {
			...DEFAULT_ARGS,
			name: "defcron-uptime",
			monitors: [{ id: "site", url: "https://example.com/" }],
		});

		await resolveOutput(monitor.cronTrigger.id);

		const cron = findResource("defcron-cron");
		expect(cron).toBeDefined();
		const schedules = cron?.inputs.schedules as Array<Record<string, unknown>>;
		expect(schedules).toHaveLength(1);
		expect(schedules[0].cron).toBe("*/1 * * * *");
	});

	it("uses existing D1 database when d1DatabaseId is provided", async () => {
		const monitor = new UptimeMonitor("exd1", {
			...DEFAULT_ARGS,
			name: "exd1-uptime",
			monitors: [{ id: "site", url: "https://example.com/" }],
			d1DatabaseId: "existing-db-id",
		});

		await resolveOutput(monitor.worker.id);

		expect(findResource("exd1-d1")).toBeUndefined();
		expect(monitor.d1Database).toBeUndefined();
		expect(await resolveOutput(monitor.d1DatabaseId)).toBe("existing-db-id");
		expect(monitor.d1Query).toBeDefined();

		const worker = findResource("exd1-worker");
		const d1Binding = (
			worker?.inputs.bindings as Array<Record<string, unknown>>
		).find((b) => b.name === "DB");
		expect(d1Binding).toBeDefined();
	});

	it("uses existing KV namespace when kvNamespaceId is provided", async () => {
		const monitor = new UptimeMonitor("exkv", {
			...DEFAULT_ARGS,
			name: "exkv-uptime",
			monitors: [{ id: "site", url: "https://example.com/" }],
			kvNamespaceId: "existing-kv-id",
		});

		await resolveOutput(monitor.worker.id);

		expect(findResource("exkv-kv")).toBeUndefined();
		expect(monitor.kvNamespace).toBeUndefined();
		expect(await resolveOutput(monitor.kvNamespaceId)).toBe("existing-kv-id");
	});

	it("throws if no monitors are provided", () => {
		expect(
			() =>
				new UptimeMonitor("no-monitors", {
					...DEFAULT_ARGS,
					name: "no-monitors-uptime",
					monitors: [],
				} as unknown as ConstructorParameters<typeof UptimeMonitor>[1]),
		).toThrow("UptimeMonitor requires at least one monitor");
	});

	it("throws if monitor IDs are duplicated", () => {
		expect(
			() =>
				new UptimeMonitor("dup-ids", {
					...DEFAULT_ARGS,
					name: "dup-ids-uptime",
					monitors: [
						{ id: "site", url: "https://example.com/" },
						{ id: "site", url: "https://other.example.com/" },
					],
				}),
		).toThrow("Duplicate monitor IDs: site");
	});

	it("generates Worker script with embedded monitor configuration", async () => {
		const monitor = new UptimeMonitor("scriptchk", {
			...DEFAULT_ARGS,
			name: "scriptchk-uptime",
			monitors: [
				{
					id: "api",
					url: "https://api.example.com/healthz",
					expectedCodes: [200, 204],
					timeoutMs: 5000,
				},
			],
		});

		await resolveOutput(monitor.worker.id);

		const worker = findResource("scriptchk-worker");
		const content = worker?.inputs.content as string;
		expect(content).toContain("api");
		expect(content).toContain("https://api.example.com/healthz");
		expect(content).toContain("5000");
	});

	it("supports multiple monitors", async () => {
		const monitor = new UptimeMonitor("multi", {
			...DEFAULT_ARGS,
			name: "multi-uptime",
			monitors: [
				{ id: "grafana", url: "https://grafana.example.com/healthz" },
				{ id: "api", url: "https://api.example.com/healthz" },
				{ id: "homepage", url: "https://example.com/" },
			],
		});

		await resolveOutput(monitor.worker.id);

		const worker = findResource("multi-worker");
		const content = worker?.inputs.content as string;
		expect(content).toContain("grafana");
		expect(content).toContain("api");
		expect(content).toContain("homepage");
	});

	it("includes fetch handler in Worker script when enableReadApi is true", async () => {
		const monitor = new UptimeMonitor("readapi", {
			...DEFAULT_ARGS,
			name: "readapi-uptime",
			monitors: [{ id: "api", url: "https://api.example.com/healthz" }],
			enableReadApi: true,
			readApiAuth: { type: "service-token" },
		});

		await resolveOutput(monitor.worker.id);

		const worker = findResource("readapi-worker");
		const content = worker?.inputs.content as string;
		expect(content).toContain("async fetch(request, env)");
		expect(content).toContain('pathname === "/stats"');
		expect(content).toContain("handleStats");
		// Must have exactly one export default
		const exportDefaults = content.match(/export default \{/g);
		expect(exportDefaults).toHaveLength(1);
	});

	it("omits fetch handler when enableReadApi is false or unset", async () => {
		const monitor = new UptimeMonitor("noreadapi", {
			...DEFAULT_ARGS,
			name: "noreadapi-uptime",
			monitors: [{ id: "api", url: "https://api.example.com/healthz" }],
		});

		await resolveOutput(monitor.worker.id);

		const worker = findResource("noreadapi-worker");
		const content = worker?.inputs.content as string;
		expect(content).not.toContain("async fetch(request, env)");
		expect(content).not.toContain("handleStats");
	});
});
