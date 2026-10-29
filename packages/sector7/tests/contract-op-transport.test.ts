import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearContractItemCacheForTesting,
	getContractChannel,
	type OpExec,
	type OpExecResult,
	parseContractItem,
	readContractItem,
	readContractItemAsync,
	type ResolvedContractChannel,
	requireContractField,
	setOpExecForTesting,
} from "../deploy-lib/contract.js";

pulumi.runtime.setMocks(
	{
		newResource: (args: pulumi.runtime.MockResourceArgs) => ({
			id: `${args.name}-id`,
			state: args.inputs,
		}),
		call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
	},
	"project",
	"stack",
	false,
);

const VAULT_ID = "abcdefghijklmnopqrstuvwxyz";
const SECRET = "s3cr3t-value-that-must-never-appear-in-an-error";

function promiseOf<T>(output: pulumi.Output<T>): Promise<T> {
	return (output as unknown as { promise(): Promise<T> }).promise();
}

/** An OpExec double that records argv and replays canned results in order. */
function fakeOp(...results: OpExecResult[]) {
	const calls: { args: readonly string[]; timeoutMs: number }[] = [];
	const exec: OpExec = async (args, { timeoutMs }) => {
		calls.push({ args, timeoutMs });
		const next = results.length > 1 ? results.shift() : results[0];
		if (!next) {
			throw new Error("fakeOp: no result queued");
		}
		return next;
	};
	return { exec, calls };
}

const ok = (item: unknown): OpExecResult => ({
	kind: "ok",
	stdout: JSON.stringify(item),
});

// The same logical contract item, as each backend renders it. Connect's
// section entries carry only an id; op adds labels, references, timestamps
// and the vault name — none of which the reader consumes.
const CONNECT_ITEM = {
	id: "item-1",
	title: "kubeconfig",
	version: 3,
	vault: { id: VAULT_ID },
	category: "API_CREDENTIAL",
	sections: [{ id: "sec1" }],
	fields: [
		{
			id: "notesPlain",
			type: "STRING",
			purpose: "NOTES",
			label: "notesPlain",
			value: "a note",
		},
		{
			id: "f1",
			type: "CONCEALED",
			label: "kubeconfig",
			value: "KUBECONFIG-BODY\nline2",
			section: { id: "sec1" },
		},
		{
			id: "f2",
			type: "STRING",
			label: "producedBy",
			value: "organization/k8s/prod",
			section: { id: "sec1" },
		},
		{ id: "f3", type: "STRING", label: "empty" },
		{ id: "f4", type: "STRING", value: "no label" },
	],
};

const OP_ITEM = {
	id: "item-1",
	title: "kubeconfig",
	version: 3,
	vault: { id: VAULT_ID, name: "tenant-vault" },
	category: "API_CREDENTIAL",
	last_edited_by: "USERID",
	created_at: "2026-10-01T00:00:00Z",
	updated_at: "2026-10-02T00:00:00Z",
	additional_information: "",
	sections: [{ id: "sec1", label: "contract" }],
	fields: [
		{
			id: "notesPlain",
			type: "STRING",
			purpose: "NOTES",
			label: "notesPlain",
			value: "a note",
			reference: "op://tenant-vault/kubeconfig/notesPlain",
		},
		{
			id: "f1",
			type: "CONCEALED",
			label: "kubeconfig",
			value: "KUBECONFIG-BODY\nline2",
			section: { id: "sec1", label: "contract" },
			reference: "op://tenant-vault/kubeconfig/contract/kubeconfig",
		},
		{
			id: "f2",
			type: "STRING",
			label: "producedBy",
			value: "organization/k8s/prod",
			section: { id: "sec1", label: "contract" },
			reference: "op://tenant-vault/kubeconfig/contract/producedBy",
		},
		{
			id: "f3",
			type: "STRING",
			label: "empty",
			reference: "op://tenant-vault/kubeconfig/contract/empty",
		},
		{ id: "f4", type: "STRING", value: "no label" },
	],
};

const EXPECTED_FIELDS = {
	notesPlain: "a note",
	kubeconfig: "KUBECONFIG-BODY\nline2",
	producedBy: "organization/k8s/prod",
};

function opChannel(
	exec: OpExec,
	extra: Partial<ResolvedContractChannel> = {},
): ResolvedContractChannel {
	return { vault: VAULT_ID, transport: { kind: "op", exec }, ...extra };
}

/** Minimal Connect REST double over a single item. */
function mockConnectWith(item: unknown, title = "kubeconfig") {
	const ok = (body: unknown) => ({
		ok: true,
		status: 200,
		json: async () => body,
		text: async () => JSON.stringify(body),
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL) => {
			const url = new URL(String(input));
			if (url.pathname === `/v1/vaults/${VAULT_ID}/items`) {
				return ok([{ id: "item-1", title }]);
			}
			if (url.pathname === `/v1/vaults/${VAULT_ID}/items/item-1`) {
				return ok(item);
			}
			return {
				ok: false,
				status: 404,
				json: async () => ({}),
				text: async () => "",
			};
		}),
	);
}

beforeEach(() => {
	clearContractItemCacheForTesting();
	pulumi.runtime.setAllConfig({});
});

afterEach(() => {
	vi.unstubAllGlobals();
	setOpExecForTesting(undefined);
	delete process.env.OP_CONNECT_HOST;
	delete process.env.OP_CONNECT_TOKEN;
});

describe("transport selection (decided once, in getContractChannel)", () => {
	it("is not in contract mode without contract:vault, whatever else is set", () => {
		pulumi.runtime.setAllConfig({
			"contract:connectHost": "https://c.example",
		});
		process.env.OP_CONNECT_TOKEN = "t";
		expect(getContractChannel()).toBeUndefined();
	});

	it("selects op when contract:vault is set and no Connect coordinates are", () => {
		const { exec } = fakeOp(ok(OP_ITEM));
		setOpExecForTesting(exec);
		pulumi.runtime.setAllConfig({ "contract:vault": VAULT_ID });
		const channel = getContractChannel();
		expect(channel?.vault).toBe(VAULT_ID);
		expect(channel?.transport).toEqual({ kind: "op", exec });
	});

	it("selects op by default with the real exec when nothing is injected", () => {
		pulumi.runtime.setAllConfig({ "contract:vault": "tenant-vault" });
		const t = getContractChannel()?.transport;
		expect(t?.kind).toBe("op");
		expect(typeof (t as { exec?: unknown }).exec).toBe("function");
	});

	it("treats blank Connect env vars as unset (op), not as partial config", () => {
		pulumi.runtime.setAllConfig({ "contract:vault": VAULT_ID });
		process.env.OP_CONNECT_HOST = "  \n";
		process.env.OP_CONNECT_TOKEN = "";
		expect(getContractChannel()?.transport.kind).toBe("op");
	});

	it.each([
		[
			"config host + config token",
			{
				"contract:connectHost": "https://c.example",
				"contract:connectToken": "t",
			},
			{},
		],
		[
			"env host + env token",
			{},
			{ OP_CONNECT_HOST: "https://c.example", OP_CONNECT_TOKEN: "t" },
		],
		[
			"config host + env token",
			{ "contract:connectHost": "https://c.example" },
			{ OP_CONNECT_TOKEN: "t" },
		],
		[
			"env host + config token",
			{ "contract:connectToken": "t" },
			{ OP_CONNECT_HOST: "https://c.example" },
		],
	])("selects connect for %s", (_name, cfg, env) => {
		pulumi.runtime.setAllConfig({ "contract:vault": VAULT_ID, ...cfg });
		Object.assign(process.env, env);
		expect(getContractChannel()?.transport).toMatchObject({
			kind: "connect",
			host: "https://c.example",
		});
	});

	it.each([
		[
			"config host only",
			{ "contract:connectHost": "https://c.example" },
			{},
			/connectToken|OP_CONNECT_TOKEN/,
		],
		[
			"env host only",
			{},
			{ OP_CONNECT_HOST: "https://c.example" },
			/connectToken|OP_CONNECT_TOKEN/,
		],
		[
			"config token only",
			{ "contract:connectToken": "t" },
			{},
			/connectHost|OP_CONNECT_HOST/,
		],
		[
			"env token only",
			{},
			{ OP_CONNECT_TOKEN: "t" },
			/connectHost|OP_CONNECT_HOST/,
		],
	])(
		"throws on a partial Connect config (%s), never falling back to op",
		(_n, cfg, env, re) => {
			const { exec } = fakeOp(ok(OP_ITEM));
			setOpExecForTesting(exec);
			pulumi.runtime.setAllConfig({ "contract:vault": VAULT_ID, ...cfg });
			Object.assign(process.env, env);
			expect(() => getContractChannel()).toThrow(re);
		},
	);

	it("keeps refusing a cleartext http Connect host", () => {
		pulumi.runtime.setAllConfig({
			"contract:vault": VAULT_ID,
			"contract:connectHost": "http://c.example",
			"contract:connectToken": "t",
		});
		expect(() => getContractChannel()).toThrow(/cleartext http/);
	});

	it("refuses a vault that op would parse as a flag", () => {
		pulumi.runtime.setAllConfig({ "contract:vault": "--account=evil" });
		expect(() => getContractChannel()).toThrow(/must not start with "-"/);
	});

	it("validates contract:maxAgeHours on the op transport too", () => {
		pulumi.runtime.setAllConfig({
			"contract:vault": VAULT_ID,
			"contract:maxAgeHours": "0",
		});
		expect(() => getContractChannel()).toThrow(/positive number of hours/);
	});
});

describe("op transport execution", () => {
	it("runs `op item get <title> --vault <vault> --format json` as argv", async () => {
		const { exec, calls } = fakeOp(ok(OP_ITEM));
		const fields = await readContractItemAsync(opChannel(exec), "kubeconfig");
		expect(fields).toEqual(EXPECTED_FIELDS);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.args).toEqual([
			"item",
			"get",
			"kubeconfig",
			"--vault",
			VAULT_ID,
			"--format",
			"json",
		]);
		expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
	});

	it("passes a vault name with spaces and metacharacters as one argv element", async () => {
		const { exec, calls } = fakeOp(ok(OP_ITEM));
		await readContractItemAsync(
			opChannel(exec, { vault: 'My "Vault"; rm -rf /' }),
			"kubeconfig",
		);
		expect(calls[0]!.args[4]).toBe('My "Vault"; rm -rf /');
		expect(calls[0]!.args).toHaveLength(7);
	});

	it("refuses an item title that op would parse as a flag", async () => {
		const { exec, calls } = fakeOp(ok(OP_ITEM));
		await expect(
			readContractItemAsync(opChannel(exec), "--reveal"),
		).rejects.toThrow(/must not start with "-"/);
		expect(calls).toHaveLength(0);
	});

	it("reads each item at most once per process (success cached)", async () => {
		const { exec, calls } = fakeOp(ok(OP_ITEM));
		const channel = opChannel(exec);
		await readContractItemAsync(channel, "kubeconfig");
		await readContractItemAsync(channel, "kubeconfig");
		expect(calls).toHaveLength(1);
	});

	it("does not cache a failure: a transient error is retried", async () => {
		const { exec, calls } = fakeOp({ kind: "timeout" }, ok(OP_ITEM));
		const channel = opChannel(exec);
		await expect(readContractItemAsync(channel, "kubeconfig")).rejects.toThrow(
			/timed out/,
		);
		await expect(readContractItemAsync(channel, "kubeconfig")).resolves.toEqual(
			EXPECTED_FIELDS,
		);
		expect(calls).toHaveLength(2);
	});

	it("caches per vault and per title", async () => {
		const other = { ...OP_ITEM, title: "config" };
		const { exec, calls } = fakeOp(ok(OP_ITEM), ok(other), ok(OP_ITEM));
		await readContractItemAsync(opChannel(exec), "kubeconfig");
		await readContractItemAsync(opChannel(exec), "config");
		await readContractItemAsync(
			opChannel(exec, { vault: "other-vault" }),
			"kubeconfig",
		);
		expect(calls).toHaveLength(3);
	});

	it("applies the same freshness assertion as Connect", async () => {
		const stale = {
			...OP_ITEM,
			fields: [
				...OP_ITEM.fields,
				{
					id: "p",
					type: "STRING",
					label: "producedAt",
					value: new Date(Date.now() - 5 * 3_600_000).toISOString(),
				},
			],
		};
		const { exec } = fakeOp(ok(stale));
		await expect(
			readContractItemAsync(opChannel(exec, { maxAgeHours: 1 }), "kubeconfig"),
		).rejects.toThrow(/is stale/);
	});

	it("serves requireContractField from an op-read item", async () => {
		const { exec } = fakeOp(ok(OP_ITEM));
		const channel = opChannel(exec);
		const fields = await readContractItemAsync(channel, "kubeconfig");
		expect(
			requireContractField(channel, "kubeconfig", "kubeconfig", fields),
		).toBe("KUBECONFIG-BODY\nline2");
		expect(() =>
			requireContractField(channel, "kubeconfig", "nope", fields),
		).toThrow(`op://${VAULT_ID}/kubeconfig/nope`);
	});

	it("returns a secret Output through readContractItem on both transports", async () => {
		const { exec } = fakeOp(ok(OP_ITEM));
		const viaOp = readContractItem(opChannel(exec), "kubeconfig");
		await expect(promiseOf(viaOp)).resolves.toEqual(EXPECTED_FIELDS);
		await expect(viaOp.isSecret).resolves.toBe(true);

		mockConnectWith(CONNECT_ITEM);
		const viaConnect = readContractItem(
			{
				vault: VAULT_ID,
				transport: { kind: "connect", host: "https://c.example", token: "t" },
			},
			"kubeconfig",
		);
		await expect(promiseOf(viaConnect)).resolves.toEqual(EXPECTED_FIELDS);
		await expect(viaConnect.isSecret).resolves.toBe(true);
	});
});

describe("op transport failures (each specific, none leaking values)", () => {
	const read = (...results: OpExecResult[]) =>
		readContractItemAsync(opChannel(fakeOp(...results).exec), "kubeconfig");

	it("op missing from PATH", async () => {
		await expect(read({ kind: "not-found" })).rejects.toThrow(
			/1Password CLI \(op\) was not found on PATH/,
		);
	});

	it("op timing out", async () => {
		await expect(read({ kind: "timeout" })).rejects.toThrow(
			/op timed out after \d+s/,
		);
	});

	it.each([
		"[ERROR] 2026/10/29 You are not currently signed in. Please run `op signin --help`",
		"[ERROR] 2026/10/29 authorization timeout",
		"[ERROR] 2026/10/29 error initializing client: Validation: (failed to parseToken)",
		"[ERROR] no accounts configured for use with 1Password CLI",
	])("op not signed in (%s)", async (stderr) => {
		await expect(read({ kind: "exit", code: 1, stderr })).rejects.toThrow(
			/op is not signed in/,
		);
	});

	it("item not found", async () => {
		await expect(
			read({
				kind: "exit",
				code: 1,
				stderr: `[ERROR] "kubeconfig" isn't an item in the "x" vault. Specify the item with its UUID, name, or domain.`,
			}),
		).rejects.toThrow(/exactly one item titled "kubeconfig".*found 0/s);
	});

	it("ambiguous title", async () => {
		await expect(
			read({
				kind: "exit",
				code: 1,
				stderr: `[ERROR] More than one item matches "kubeconfig".`,
			}),
		).rejects.toThrow(/more than one match/);
	});

	it("vault not found", async () => {
		await expect(
			read({
				kind: "exit",
				code: 1,
				stderr: `[ERROR] "abc" isn't a vault in this account.`,
			}),
		).rejects.toThrow(/vault "abcdefghijklmnopqrstuvwxyz" was not found by op/);
	});

	it("an unclassified non-zero exit names the exit code, not stderr", async () => {
		const err = await read({
			kind: "exit",
			code: 3,
			stderr: `weird failure echoing ${SECRET}`,
		}).catch((e: Error) => e);
		expect((err as Error).message).toMatch(/op exited 3/);
		expect((err as Error).message).not.toContain(SECRET);
	});

	it("output that is not JSON (and does not echo it)", async () => {
		const err = await read({ kind: "ok", stdout: `not json ${SECRET}` }).catch(
			(e: Error) => e,
		);
		expect((err as Error).message).toMatch(/not valid JSON/);
		expect((err as Error).message).not.toContain(SECRET);
	});

	it.each([
		["a JSON array", []],
		["a JSON string", "kubeconfig"],
		["null", null],
		["an object with no title", { fields: [] }],
		["an item with a different title", { ...OP_ITEM, title: "other" }],
		["fields that is not an array", { title: "kubeconfig", fields: {} }],
		["a non-object field entry", { title: "kubeconfig", fields: ["x"] }],
	])("JSON not shaped like an item: %s", async (_name, doc) => {
		await expect(read(ok(doc))).rejects.toThrow(
			/not shaped like a 1Password item/,
		);
	});

	it("a non-string field value names the label, never the value", async () => {
		const err = await read(
			ok({
				title: "kubeconfig",
				fields: [{ label: "kubeconfig", value: { leaked: SECRET } }],
			}),
		).catch((e: Error) => e);
		expect((err as Error).message).toContain('field "kubeconfig"');
		expect((err as Error).message).not.toContain(SECRET);
	});

	it("the real default exec reports a missing binary as not-found (PATH emptied)", async () => {
		const empty = mkdtempSync(join(tmpdir(), "contract-op-empty-path-"));
		const savedPath = process.env.PATH;
		try {
			pulumi.runtime.setAllConfig({ "contract:vault": VAULT_ID });
			const channel = getContractChannel();
			process.env.PATH = empty;
			await expect(
				readContractItemAsync(
					channel as unknown as ResolvedContractChannel,
					"kubeconfig",
				),
			).rejects.toThrow(/was not found on PATH/);
		} finally {
			process.env.PATH = savedPath;
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe("normalization parity (Connect vs op)", () => {
	it("yields identical fields from each backend's rendering of one item", () => {
		const fromConnect = parseContractItem(
			CONNECT_ITEM,
			"kubeconfig",
			"1Password Connect",
		);
		const fromOp = parseContractItem(OP_ITEM, "kubeconfig", "op");
		expect(fromConnect).toEqual(EXPECTED_FIELDS);
		expect(fromOp).toEqual(fromConnect);
	});

	it("treats concealed and plain fields identically (value inline)", () => {
		const fields = parseContractItem(
			{
				title: "t",
				fields: [
					{ label: "plain", type: "STRING", value: "p" },
					{ label: "hidden", type: "CONCEALED", value: "h" },
				],
			},
			"t",
			"op",
		);
		expect(fields).toEqual({ plain: "p", hidden: "h" });
	});

	it("skips unlabeled and valueless fields, and lets a later duplicate label win", () => {
		const fields = parseContractItem(
			{
				title: "t",
				fields: [
					{ label: "a", value: "first", section: { id: "s1" } },
					{ label: "a", value: "second", section: { id: "s2" } },
					{ label: "b", value: null },
					{ label: "c" },
					{ value: "orphan" },
					{ label: "", value: "empty-label" },
				],
			},
			"t",
			"1Password Connect",
		);
		expect(fields).toEqual({ a: "second" });
	});

	it("accepts an item with no fields at all", () => {
		expect(parseContractItem({ title: "t" }, "t", "op")).toEqual({});
	});

	it("gives the same fields end to end through each transport", async () => {
		mockConnectWith(CONNECT_ITEM);
		const viaConnect = await readContractItemAsync(
			{
				vault: VAULT_ID,
				transport: { kind: "connect", host: "https://c.example", token: "t" },
			},
			"kubeconfig",
		);
		const viaOp = await readContractItemAsync(
			opChannel(fakeOp(ok(OP_ITEM)).exec),
			"kubeconfig",
		);
		expect(viaOp).toEqual(viaConnect);
	});

	it("rejects a malformed Connect item with the same shared parser", async () => {
		mockConnectWith({ title: "kubeconfig", fields: "nope" });
		await expect(
			readContractItemAsync(
				{
					vault: VAULT_ID,
					transport: { kind: "connect", host: "https://c.example", token: "t" },
				},
				"kubeconfig",
			),
		).rejects.toThrow(
			/1Password Connect returned JSON.*not shaped like a 1Password item/s,
		);
	});
});
