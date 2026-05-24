import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import { D1Query, type D1QueryArgs } from "../d1/d1-query.ts";
import { generateMonitorScript, type MonitorTarget } from "./monitor-script.ts";

/**
 * A single monitored endpoint.
 */
export type MonitorConfig = MonitorTarget;

/**
 * Arguments for creating an UptimeMonitor component (ADR-020).
 *
 * @remarks
 * Creates a Cloudflare Worker with cron trigger that probes HTTP endpoints,
 * stores results in D1, tracks failure streaks in KV, and fires webhook
 * alerts on state transitions.
 *
 * @example
 * ```typescript
 * const monitor = new UptimeMonitor("my-monitor", {
 *   accountId: "abc123",
 *   name: "uptime-monitor",
 *   monitors: [
 *     { id: "grafana", url: "https://grafana.example.com/healthz" },
 *     { id: "api", url: "https://api.example.com/healthz", expectedCodes: [200, 204] },
 *   ],
 *   webhookUrl: pulumi.secret("https://discord.com/api/webhooks/..."),
 * });
 * ```
 */
export interface UptimeMonitorArgs {
	/**
	 * Cloudflare account ID where resources will be created.
	 */
	accountId: pulumi.Input<string>;

	/**
	 * Name for the Worker and related resources.
	 */
	name: pulumi.Input<string>;

	/**
	 * Endpoints to monitor.
	 *
	 * Each monitor defines a URL to probe, expected status codes, and optional
	 * body/content checks. The monitor ID must be unique within this component.
	 */
	monitors: MonitorConfig[];

	/**
	 * Webhook URL to receive alert and recovery notifications.
	 *
	 * Stored as a Worker secret. Set to a Discord/Slack/PagerDuty/Custom webhook URL.
	 * Omit to disable alerting (probe results still written to D1).
	 */
	webhookUrl?: pulumi.Input<string>;

	/**
	 * Cron schedule for probe runs.
	 * @default "* /1 * * * *" (every minute, without the space)
	 */
	cronSchedule?: pulumi.Input<string>;

	/**
	 * Create the D1 database if it doesn't exist.
	 * @default true
	 */
	createD1Database?: pulumi.Input<boolean>;

	/**
	 * D1 database name when creating a new database.
	 * Ignored when referencing an existing database.
	 * @default "<name>-probe-results"
	 */
	d1DatabaseName?: pulumi.Input<string>;

	/**
	 * Existing D1 database ID to use instead of creating one.
	 * When set, `createD1Database` and `d1DatabaseName` are ignored.
	 */
	d1DatabaseId?: pulumi.Input<string>;

	/**
	 * KV namespace title when creating a new namespace.
	 * @default "<name>-state"
	 */
	kvNamespaceTitle?: pulumi.Input<string>;

	/**
	 * Existing KV namespace ID to use instead of creating one.
	 * When set, `kvNamespaceTitle` is ignored.
	 */
	kvNamespaceId?: pulumi.Input<string>;

	/**
	 * D1 probe_results table CREATE statement.
	 *
	 * Override to customize the schema (add columns, change indexes).
	 * The Worker script expects at minimum the columns referenced in the
	 * default schema.
	 * @default built-in schema with ts, monitor_id, url, ok, status, latency_ms, error, region_hint
	 *
	 * Applied automatically during `pulumi up` via the D1 REST API.
	 * Re-applied when the SQL content changes.
	 */
	d1Schema?: pulumi.Input<string>;

	/**
	 * Cloudflare API token with D1 write permissions.
	 * Required to apply the D1 schema during `pulumi up`.
	 *
	 * Store as a Pulumi secret to avoid leaking it in state:
	 * `pulumi.secret("...")` or `pulumi.config.requireSecret("cloudflare:apiToken")`.
	 */
	apiToken: pulumi.Input<string>;

	/**
	 * Enable a read API (`GET /stats`) on the Worker.
	 * When true, the Worker will accept requests and return aggregated uptime data.
	 * Protected by Cloudflare Access Service Tokens.
	 *
	 * @default false
	 */
	enableReadApi?: pulumi.Input<boolean>;

	/**
	 * Authentication configuration for the read API.
	 * Currently only supports Service Tokens.
	 */
	readApiAuth?: {
		type: "service-token";
	};
}

const DEFAULT_D1_SCHEMA = [
	"CREATE TABLE IF NOT EXISTS probe_results (",
	"    id INTEGER PRIMARY KEY AUTOINCREMENT,",
	"    ts TEXT NOT NULL,",
	"    monitor_id TEXT NOT NULL,",
	"    url TEXT NOT NULL,",
	"    ok INTEGER NOT NULL,",
	"    status INTEGER,",
	"    latency_ms INTEGER,",
	"    error TEXT,",
	"    region_hint TEXT",
	");",
	"",
	"CREATE INDEX IF NOT EXISTS idx_probe_ts ON probe_results(ts);",
	"CREATE INDEX IF NOT EXISTS idx_probe_monitor_ts ON probe_results(monitor_id, ts);",
].join("\n");

/**
 * UptimeMonitor component for synthetic HTTP endpoint monitoring.
 *
 * @remarks
 * ADR-020 implementation:
 * - Cloudflare Worker with cron trigger probes configured endpoints
 * - D1 stores probe results for querying and analytics
 * - KV tracks failure streak state for alerting
 * - Webhook alerts fire on healthy-to-unhealthy and unhealthy-to-healthy transitions
 *
 * The component creates:
 * 1. D1 database (or references existing)
 * 2. KV namespace (or references existing)
 * 3. Worker script with embedded monitor configuration
 * 4. Cron trigger for scheduled execution
 *
 * @example
 * ```typescript
 * const monitor = new UptimeMonitor("prod-monitor", {
 *   accountId: "abc123",
 *   name: "prod-uptime",
 *   monitors: [
 *     { id: "grafana", url: "https://grafana.example.com/healthz" },
 *     { id: "api", url: "https://api.example.com/healthz" },
 *     { id: "homepage", url: "https://example.com/" },
 *   ],
 *   webhookUrl: pulumi.secret("https://discord.com/api/webhooks/..."),
 *   cronSchedule: "* /2 * * * *",
 * });
 * ```
 */
export class UptimeMonitor extends pulumi.ComponentResource {
	/**
	 * The D1 schema initialization query resource.
	 * Present when a D1 database is created or referenced.
	 */
	public readonly d1Query: D1Query | undefined;

	/**
	 * The D1 database storing probe results.
	 * Present when `createD1Database` is true.
	 */
	public readonly d1Database: cloudflare.D1Database | undefined;

	/**
	 * The D1 database ID (either from created or referenced database).
	 */
	public readonly d1DatabaseId: pulumi.Output<string>;

	/**
	 * The KV namespace for failure streak state.
	 * Present when the component creates the namespace.
	 * Undefined when `kvNamespaceId` references an existing namespace.
	 */
	public readonly kvNamespace: cloudflare.WorkersKvNamespace | undefined;

	/**
	 * The KV namespace ID.
	 */
	public readonly kvNamespaceId: pulumi.Output<string>;

	/**
	 * The Worker script running the monitor logic.
	 */
	public readonly worker: cloudflare.WorkersScript;

	/**
	 * The cron trigger scheduling probe runs.
	 */
	public readonly cronTrigger: cloudflare.WorkersCronTrigger;

	/**
	 * The Worker name.
	 */
	public readonly workerName: pulumi.Output<string>;

	constructor(
		name: string,
		args: UptimeMonitorArgs,
		opts?: pulumi.ComponentResourceOptions,
	) {
		super("sector7:cloudflare:UptimeMonitor", name, {}, opts);

		// Input validation
		if (!args.monitors || args.monitors.length === 0) {
			throw new Error("UptimeMonitor requires at least one monitor");
		}

		// Validate monitor IDs are unique
		const ids = args.monitors.map((m) => m.id);
		const uniqueIds = new Set(ids);
		if (ids.length !== uniqueIds.size) {
			const duplicates = Array.from(
				new Set(ids.filter((id, i) => ids.indexOf(id) !== i)),
			);
			throw new Error(`Duplicate monitor IDs: ${duplicates.join(", ")}`);
		}

		const resourceOpts = { parent: this };
		const cronSchedule = args.cronSchedule ?? "*/1 * * * *";

		// 1. Create or reference D1 database
		if (args.d1DatabaseId) {
			this.d1Database = undefined;
			this.d1DatabaseId = pulumi.output(args.d1DatabaseId);
		} else {
			const createDb = args.createD1Database !== false;
			const dbName = pulumi
				.output(args.d1DatabaseName ?? args.name)
				.apply((n: string) =>
					n.endsWith("-probe-results") ? n : `${n}-probe-results`,
				);

			if (createDb) {
				this.d1Database = new cloudflare.D1Database(
					`${name}-d1`,
					{
						accountId: args.accountId,
						name: dbName,
					},
					resourceOpts,
				);
				this.d1DatabaseId = this.d1Database.id;
			} else {
				throw new Error(
					"d1DatabaseId is required when createD1Database is false",
				);
			}
		}

		// 1b. Apply D1 schema via dynamic provider
		this.d1Query = new D1Query(
			`${name}-schema`,
			{
				accountId: args.accountId,
				databaseId: this.d1DatabaseId,
				sql: args.d1Schema ?? DEFAULT_D1_SCHEMA,
				apiToken: args.apiToken,
			},
			{ parent: this, dependsOn: this.d1Database ? [this.d1Database] : [] },
		);

		// 2. Create or reference KV namespace
		if (args.kvNamespaceId) {
			this.kvNamespaceId = pulumi.output(args.kvNamespaceId);
			this.kvNamespace = undefined;
		} else {
			const kvTitle = pulumi
				.output(args.kvNamespaceTitle ?? args.name)
				.apply((n: string) => (n.endsWith("-state") ? n : `${n}-state`));

			this.kvNamespace = new cloudflare.WorkersKvNamespace(
				`${name}-kv`,
				{
					accountId: args.accountId,
					title: kvTitle,
				},
				resourceOpts,
			);
			this.kvNamespaceId = this.kvNamespace.id;
		}

		// 3. Generate Worker script
		const scriptContent = generateMonitorScript(args.monitors, {
			enableReadApi: args.enableReadApi ?? false,
		});

		// 4. Create Worker with D1 and KV bindings
		const baseBindings: Array<cloudflare.types.input.WorkersScriptBinding> = [
			{
				name: "DB",
				type: "d1",
				id: this.d1DatabaseId,
			},
			{
				name: "KV",
				type: "kv_namespace",
				namespaceId: this.kvNamespaceId,
			},
		];

		if (args.webhookUrl) {
			baseBindings.push({
				name: "WEBHOOK_URL",
				type: "secret_text",
				text: args.webhookUrl,
			});
		}

		this.worker = new cloudflare.WorkersScript(
			`${name}-worker`,
			{
				accountId: args.accountId,
				scriptName: pulumi.output(args.name),
				content: scriptContent,
				mainModule: "worker.js",
				bindings: baseBindings,
			},
			{ parent: this, dependsOn: this.d1Query ? [this.d1Query] : [] },
		);

		// 5. Create cron trigger for scheduled execution
		this.cronTrigger = new cloudflare.WorkersCronTrigger(
			`${name}-cron`,
			{
				accountId: args.accountId,
				scriptName: this.worker.scriptName,
				schedules: [{ cron: cronSchedule }],
			},
			resourceOpts,
		);

		// Outputs
		this.workerName = this.worker.scriptName;

		this.registerOutputs({
			d1Database: this.d1Database,
			d1DatabaseId: this.d1DatabaseId,
			d1Query: this.d1Query,
			kvNamespace: this.kvNamespace,
			kvNamespaceId: this.kvNamespaceId,
			worker: this.worker,
			cronTrigger: this.cronTrigger,
			workerName: this.workerName,
		});
	}
}
