import * as pulumi from "@pulumi/pulumi";
import {
	type CustomResourceOptions,
	dynamic,
	type Input,
	type Output,
} from "@pulumi/pulumi";

/**
 * Resource options accepted by sector7 dynamic resources.
 *
 * Pulumi dynamic resources are executed by the Node.js dynamic provider runtime,
 * not by a cloud provider plugin. Passing `provider` or `providers` makes Pulumi
 * route the resource through the wrong provider bridge, which fails with a
 * misleading `pulumi-nodejs:dynamic:Resource` unknown-token error.
 */
export type DynamicResourceOptions = Omit<
	CustomResourceOptions,
	"provider" | "providers"
>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Arguments for creating a D1Query resource.
 *
 * All `Input<T>` values are resolved by Pulumi before reaching the dynamic
 * provider, so secrets (which are `Output<string>`) are valid inputs.
 */
export interface D1QueryArgs {
	/**
	 * Cloudflare account ID.
	 */
	accountId: Input<string>;

	/**
	 * D1 database ID to execute the query against.
	 */
	databaseId: Input<string>;

	/**
	 * SQL to execute. Supports multi-statement SQL (semicolon-separated).
	 *
	 * Use `CREATE TABLE IF NOT EXISTS` for idempotent schema initialization.
	 * The query is re-executed only when this value changes.
	 */
	sql: Input<string>;

	/**
	 * Cloudflare API token with D1 write permissions.
	 * Store as a Pulumi secret: `pulumi.secret("...")` or config
	 * `pulumi.config.requireSecret("cloudflare:apiToken")`.
	 */
	apiToken: Input<string>;
}

/**
 * Resolved inputs as seen inside the dynamic provider callbacks.
 * All values are plain strings -- Pulumi resolves Input<T> before invoking the provider.
 */
interface D1QueryInputs {
	accountId: string;
	databaseId: string;
	sql: string;
	apiToken: string;
}

/**
 * State persisted in Pulumi state for each D1Query resource.
 */
interface D1QueryState extends D1QueryInputs {
	/**
	 * SHA-256 hex digest of the SQL that was last executed.
	 * Used to detect changes between runs.
	 */
	sqlHash: string;
}

// ---------------------------------------------------------------------------
// Cloudflare D1 REST API
// ---------------------------------------------------------------------------

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * Execute a SQL query against a D1 database via the Cloudflare REST API.
 *
 * @see https://developers.cloudflare.com/api/operations/cloudflare-d1-query-database
 */
const executeD1Query = async (
	accountId: string,
	databaseId: string,
	sql: string,
	apiToken: string,
): Promise<void> => {
	const url = `${CLOUDFLARE_API_BASE}/accounts/${accountId}/d1/database/${databaseId}/query`;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiToken}`,
		},
		body: JSON.stringify({ sql }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`D1 query failed: ${response.status} ${response.statusText}\n${text}`,
		);
	}

	const body = (await response.json()) as {
		success: boolean;
		errors?: Array<{ message: string }>;
	};

	if (!body.success) {
		const messages =
			body.errors?.map((e) => e.message).join("; ") ?? "unknown error";
		throw new Error(`D1 query failed: ${messages}`);
	}
};

// ---------------------------------------------------------------------------
// Pulumi dynamic provider
// ---------------------------------------------------------------------------

/**
 * Pulumi dynamic resource provider that executes SQL against a Cloudflare D1
 * database via the REST API.
 *
 * Notes
 * -----
 * This provider uses the global `fetch()` available in Node.js 18+.
 * No external HTTP dependencies are required.
 *
 * Node built-in imports (crypto) are inlined as dynamic import() calls
 * inside provider callbacks rather than imported at module top level. Pulumi
 * serializes the provider object via V8 source capture; top-level ES module
 * imports of Node built-ins capture native-code functions that cannot be
 * serialized. Dynamic import() calls are emitted verbatim and evaluated at
 * runtime after deserialization.
 *
 * Lifecycle
 * ---------
 * - check  : validate inputs (non-empty SQL, required fields)
 * - diff   : compare sqlHash; trigger replacement when SQL changes
 * - create : execute SQL; store sqlHash
 * - update : re-execute SQL; update sqlHash
 * - delete : no-op (schema data persists after resource removal)
 */
const d1QueryProvider: dynamic.ResourceProvider = {
	async check(
		_olds: D1QueryState,
		news: D1QueryInputs,
	): Promise<dynamic.CheckResult> {
		const failures: dynamic.CheckFailure[] = [];

		if (!news.sql || news.sql.trim().length === 0) {
			failures.push({
				property: "sql",
				reason: "SQL must be a non-empty string",
			});
		}

		if (!news.accountId) {
			failures.push({
				property: "accountId",
				reason: "accountId is required",
			});
		}

		if (!news.databaseId) {
			failures.push({
				property: "databaseId",
				reason: "databaseId is required",
			});
		}

		if (!news.apiToken) {
			failures.push({
				property: "apiToken",
				reason: "apiToken is required",
			});
		}

		return { inputs: news, failures };
	},

	async diff(
		_id: string,
		olds: D1QueryState,
		news: D1QueryInputs,
	): Promise<dynamic.DiffResult> {
		const replaces: string[] = [];
		if (olds.accountId !== news.accountId) replaces.push("accountId");
		if (olds.databaseId !== news.databaseId) replaces.push("databaseId");
		// SQL change triggers replacement (re-run the query)
		if (olds.sql !== news.sql) replaces.push("sql");

		// apiToken change triggers update (re-execute with new credentials)
		const hasTokenChange = olds.apiToken !== news.apiToken;

		const changes = replaces.length > 0 || hasTokenChange;

		return { changes, replaces, deleteBeforeReplace: replaces.length > 0 };
	},

	async create(inputs: D1QueryInputs): Promise<dynamic.CreateResult> {
		const nodeCrypto = (await import(
			"node:crypto"
		)) as typeof import("node:crypto");

		await executeD1Query(
			inputs.accountId,
			inputs.databaseId,
			inputs.sql,
			inputs.apiToken,
		);

		const sqlHash = nodeCrypto
			.createHash("sha256")
			.update(inputs.sql)
			.digest("hex");

		return {
			id: `d1query:${inputs.databaseId}:${sqlHash.slice(0, 12)}`,
			outs: { ...inputs, sqlHash },
		};
	},

	async update(
		_id: string,
		_olds: D1QueryState,
		news: D1QueryInputs,
	): Promise<dynamic.UpdateResult> {
		const nodeCrypto = (await import(
			"node:crypto"
		)) as typeof import("node:crypto");

		await executeD1Query(
			news.accountId,
			news.databaseId,
			news.sql,
			news.apiToken,
		);

		const sqlHash = nodeCrypto
			.createHash("sha256")
			.update(news.sql)
			.digest("hex");

		return { outs: { ...news, sqlHash } };
	},

	async delete(_id: string, _props: D1QueryState): Promise<void> {
		// No-op: schema data persists after resource removal.
		// D1 databases outlive individual Pulumi stacks.
	},
};

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

const rejectCloudProviderOptions = (
	resourceName: string,
	opts?: CustomResourceOptions,
): void => {
	if (!opts) return;

	const hasProvider =
		Object.hasOwn(opts, "provider") && opts.provider !== undefined;
	const hasProviders =
		Object.hasOwn(opts, "providers") &&
		(opts as Record<string, unknown>).providers !== undefined;
	if (!hasProvider && !hasProviders) return;

	throw new Error(
		`${resourceName} is a Pulumi dynamic resource; do not pass provider/providers. ` +
			"Pass provider options only to cloud provider resources, and use parent/dependsOn for dynamic resource ordering.",
	);
};

// ---------------------------------------------------------------------------
// Public resource
// ---------------------------------------------------------------------------

/**
 * A Pulumi dynamic resource that executes SQL against a Cloudflare D1 database.
 *
 * @remarks
 * Uses the Cloudflare REST API to run SQL statements during `pulumi up`.
 * Designed for schema initialization (e.g., `CREATE TABLE IF NOT EXISTS`)
 * but can execute any SQL.
 *
 * The resource tracks SQL content via SHA-256 hashing. When the SQL changes,
 * the query is re-executed. Deletion is a no-op (schema persists).
 *
 * Authentication requires a Cloudflare API token with D1 permissions.
 * Pass it as a Pulumi secret to avoid leaking it in state:
 *
 * @example
 * ```typescript
 * new D1Query("init-schema", {
 *   accountId: "abc123",
 *   databaseId: d1.id,
 *   sql: "CREATE TABLE IF NOT EXISTS foo (id INTEGER PRIMARY KEY);",
 *   apiToken: pulumi.secret(process.env.CF_API_TOKEN!),
 * });
 * ```
 */
export class D1Query extends dynamic.Resource {
	/**
	 * SHA-256 hex digest of the last-executed SQL.
	 */
	public declare readonly sqlHash: Output<string>;

	constructor(name: string, args: D1QueryArgs, opts?: DynamicResourceOptions) {
		rejectCloudProviderOptions("D1Query", opts);
		super(d1QueryProvider, name, { sqlHash: undefined, ...args }, opts);
	}
}
