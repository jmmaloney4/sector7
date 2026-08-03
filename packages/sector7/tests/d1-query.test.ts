import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * D1Query is now backed by the `sector7` resource plugin rather than a Pulumi
 * dynamic provider, so the CRUD semantics this file used to exercise —
 * check/diff/create/update/delete — live in `provider/d1/query.go` and are
 * tested there. Each `it(...)` string that moved is carried verbatim as a Go
 * subtest name so the two lists can be diffed mechanically:
 *
 *   "reports no check failures for valid inputs"              → TestCheck
 *   "reports check failures when required fields are missing" → TestCheck
 *   "detects no changes when SQL is unchanged"                → TestDiffIsANoOpWhenNothingChanged
 *   "detects changes when SQL is modified"                    → TestDiffReplacesOnStatementIdentityButNotOnToken
 *   "triggers delete-before-replace when SQL changes"         → TestDiffReplacesOnStatementIdentityButNotOnToken
 *   "detects changes when apiToken is rotated"                → TestDiffReplacesOnStatementIdentityButNotOnToken
 *
 * "rejects cloud provider options" is gone rather than moved: its premise
 * inverts under the plugin. `provider`/`providers` used to route a dynamic
 * resource through the wrong bridge and had to be rejected; now they are
 * meaningful and supported, which the last case below pins.
 *
 * What remains TypeScript-side is the registration itself, and that is what
 * this file covers — the properties whose loss would break the migration or the
 * deploy in ways nothing else catches.
 */

type CustomResourceCall = {
	type: string;
	name: string;
	args: Record<string, unknown>;
	opts: Record<string, unknown> | undefined;
};

const customResourceCalls: CustomResourceCall[] = [];

vi.mock("@pulumi/pulumi", () => {
	const output = <T>(value: T) => ({
		apply: <U>(fn: (value: T) => U) => fn(value),
	});

	return {
		all: <T>(value: T) => output(value),
		output,
		mergeOptions: (
			left: Record<string, unknown> | undefined,
			right: Record<string, unknown>,
		) => ({ ...(left ?? {}), ...right }),
		CustomResource: class {
			constructor(
				type: string,
				name: string,
				args: Record<string, unknown>,
				opts?: Record<string, unknown>,
			) {
				customResourceCalls.push({ type, name, args, opts });
			}
		},
	};
});

import { D1Query } from "../d1/d1-query.ts";
import { PLUGIN_VERSION } from "../version.ts";

const createArgs = (sql = "CREATE TABLE t (id INTEGER);") => ({
	accountId: "account-123",
	databaseId: "db-456",
	sql,
	apiToken: "test-token",
});

describe("D1Query registration", () => {
	beforeEach(() => {
		customResourceCalls.length = 0;
		new D1Query("test", createArgs());
	});

	it("registers the plugin resource token, not a dynamic resource", () => {
		expect(customResourceCalls).toHaveLength(1);
		expect(customResourceCalls[0].type).toBe("sector7:d1:Query");
		expect(customResourceCalls[0].name).toBe("test");
	});

	it("forwards every input to the plugin", () => {
		const { args } = customResourceCalls[0];
		expect(args.accountId).toBe("account-123");
		expect(args.databaseId).toBe("db-456");
		expect(args.sql).toBe("CREATE TABLE t (id INTEGER);");
		expect(args.apiToken).toBe("test-token");
	});

	// Without this alias the engine sees a brand-new resource rather than a
	// retyped one, and plans a CREATE alongside a DELETE of the dynamic
	// resource. That would re-run the DDL and, worse, invoke the old serialized
	// closure on delete — the very thing that is broken.
	it("aliases the dynamic-provider type so the retype is a URN rewrite", () => {
		expect(customResourceCalls[0].opts?.aliases).toEqual([
			{ type: "pulumi-nodejs:dynamic:Resource" },
		]);
	});

	// The plugin is installed as resource-sector7-v<version>; a mismatch
	// surfaces at deploy time as `no resource plugin 'sector7' found in the
	// workspace at version vX.Y.Z`, which is why the version is derived from
	// package.json rather than hardcoded.
	it("pins the plugin version it was built against", () => {
		expect(customResourceCalls[0].opts?.version).toBe(PLUGIN_VERSION);
		expect(PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	// `provider` used to be rejected outright. Under the plugin it is a normal,
	// supported option, and silently dropping it would route the resource to
	// the default provider instead of the one the caller asked for.
	it("passes through a caller-supplied provider instead of rejecting it", () => {
		customResourceCalls.length = 0;
		const provider = { urn: "some-provider" };
		new D1Query("test", createArgs(), {
			provider,
		} as unknown as Record<string, unknown>);

		expect(customResourceCalls[0].opts?.provider).toBe(provider);
	});
});
