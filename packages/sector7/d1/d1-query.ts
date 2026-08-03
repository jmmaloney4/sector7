import type { Input, Output } from "@pulumi/pulumi";
import * as pulumi from "@pulumi/pulumi";
import { PLUGIN_VERSION } from "../version.ts";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Arguments for creating a D1Query resource.
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
 * Execute SQL against a Cloudflare D1 database, once per SQL change.
 *
 * Intended for idempotent schema initialization — `CREATE TABLE IF NOT
 * EXISTS`, index creation, and similar. The resource tracks SQL content by
 * SHA-256; changing the SQL re-executes it, and deletion is a no-op because
 * the schema outlives the resource.
 *
 * Authentication needs a Cloudflare API token with D1 permissions. Pass it as
 * a Pulumi secret so it does not sit in plaintext state.
 *
 * Backed by the `sector7` resource plugin. It used to be a Pulumi *dynamic*
 * provider, which serialised its JavaScript closure into stack state and
 * re-executed that stored copy on refresh and delete — the failure mode that
 * motivated the plugin (garden ADR 163). Two consequences of the move are
 * visible here: `provider`/`providers` are now meaningful options rather than
 * something to reject, and the SQL-execution logic lives in
 * `provider/d1/query.go` instead of in callbacks in this file.
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
export class D1Query extends pulumi.CustomResource {
	/**
	 * SHA-256 hex digest of the last-executed SQL.
	 */
	public declare readonly sqlHash: Output<string>;

	constructor(
		name: string,
		args: D1QueryArgs,
		opts?: pulumi.CustomResourceOptions,
	) {
		super(
			"sector7:d1:Query",
			name,
			{ sqlHash: undefined, ...args },
			pulumi.mergeOptions(opts, {
				version: PLUGIN_VERSION,
				// What makes the move off the dynamic provider a no-op: the
				// engine rewrites the URN in place, so `pulumi preview` is a
				// complete, side-effect-free dry run and no Cloudflare API call
				// happens during the cutover.
				//
				// Keep this for at least two releases. It costs nothing, and it
				// protects any stack that has not yet been through an `up`, plus
				// any state restored from a backup taken before the retype.
				aliases: [{ type: "pulumi-nodejs:dynamic:Resource" }],
			}),
		);
	}
}
