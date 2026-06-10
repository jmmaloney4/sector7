import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
//
// OnePasswordItem is a dynamic.Resource. We mock @pulumi/pulumi to capture the
// ResourceProvider passed to super() (the same capture pattern as the r2 / d1 /
// litellm-admin provider tests), then exercise the provider directly.
//
// withConnectBaseUrl() loads kube credentials and opens a port-forward; we stub
// @kubernetes/client-node and node:net so it yields a local base URL without a
// real cluster, and stub global fetch to capture the Connect REST calls.
// node:crypto is NOT mocked — the content hash is computed for real.
// ---------------------------------------------------------------------------

type Provider = {
	check: (
		olds: Record<string, unknown>,
		news: Record<string, unknown>,
	) => Promise<{
		inputs: Record<string, unknown>;
		failures: Array<{ property: string; reason: string }>;
	}>;
	diff: (
		id: string,
		olds: Record<string, unknown>,
		news: Record<string, unknown>,
	) => Promise<{
		changes: boolean;
		replaces?: string[];
		deleteBeforeReplace?: boolean;
	}>;
	create: (
		inputs: Record<string, unknown>,
	) => Promise<{ id: string; outs: Record<string, unknown> }>;
	update: (
		id: string,
		olds: Record<string, unknown>,
		news: Record<string, unknown>,
	) => Promise<{ outs: Record<string, unknown> }>;
	delete: (id: string, props: Record<string, unknown>) => Promise<void>;
};

const capturedProviders: Provider[] = [];

vi.mock("@pulumi/pulumi", () => ({
	// biome-ignore lint/suspicious/noExplicitAny: identity secret() stand-in for tests
	secret: (v: any) => v,
	dynamic: {
		Resource: class {
			constructor(provider: Provider) {
				capturedProviders.push(provider);
			}
		},
	},
}));

const apiStubs = {
	readNamespacedDeployment: vi.fn().mockResolvedValue({
		spec: { selector: { matchLabels: { app: "onepassword-connect" } } },
	}),
	listNamespacedPod: vi.fn().mockResolvedValue({
		items: [
			{
				metadata: { name: "connect-pod-1" },
				status: {
					phase: "Running",
					conditions: [{ type: "Ready", status: "True" }],
				},
			},
		],
	}),
};

vi.mock("@kubernetes/client-node", () => ({
	KubeConfig: class {
		loadFromDefault() {}
		loadFromString(_s: string) {}
		makeApiClient() {
			return apiStubs;
		}
	},
	AppsV1Api: class AppsV1Api {},
	CoreV1Api: class CoreV1Api {},
	PortForward: class {
		portForward() {
			return Promise.resolve();
		}
	},
}));

vi.mock("node:net", () => ({
	createServer: () => {
		const server = {
			once: (_event: string, _cb: unknown) => server,
			listen: (_port: number, _host: string, cb: () => void) => {
				cb();
				return server;
			},
			address: () => ({ port: 41000 }),
			close: (cb?: () => void) => {
				cb?.();
				return server;
			},
		};
		return server;
	},
}));

// Trigger provider capture by constructing the resource once.
import { OnePasswordItem } from "../onepassword/item.ts";

new OnePasswordItem("capture", {
	connectToken: "tok",
	namespace: "1password",
	vault: "vault-1",
	title: "My Item",
	fields: [{ label: "password", value: "sk-abc" }],
});
const provider = capturedProviders[0] as Provider;

// ---------------------------------------------------------------------------
// fetch harness
// ---------------------------------------------------------------------------

interface FetchCall {
	method: string;
	url: string;
	// biome-ignore lint/suspicious/noExplicitAny: request bodies are dynamic JSON
	body?: any;
}

let fetchCalls: FetchCall[] = [];
// biome-ignore lint/suspicious/noExplicitAny: Connect item overviews are dynamic JSON
let listResult: any[] = [];
// biome-ignore lint/suspicious/noExplicitAny: full Connect item is dynamic JSON
let existingItem: any = {};
let deleteStatus = 200;

function makeResponse(bodyObj: unknown, ok = true, status = 200) {
	const text =
		bodyObj === undefined
			? ""
			: typeof bodyObj === "string"
				? bodyObj
				: JSON.stringify(bodyObj);
	return {
		ok,
		status,
		statusText: ok ? "OK" : "Error",
		text: async () => text,
	};
}

function baseInputs(): Record<string, unknown> {
	return {
		connectToken: "tok",
		namespace: "1password",
		deploymentName: "onepassword-connect",
		connectPort: 8080,
		vault: "vault-1",
		title: "My Item",
		category: "PASSWORD",
		fields: [
			{
				label: "password",
				value: "sk-abc",
				type: "CONCEALED",
				purpose: "PASSWORD",
			},
		],
	};
}

beforeEach(() => {
	fetchCalls = [];
	listResult = [];
	existingItem = {};
	deleteStatus = 200;
	apiStubs.readNamespacedDeployment.mockClear();
	apiStubs.listNamespacedPod.mockClear();
	// biome-ignore lint/suspicious/noExplicitAny: test fetch stub
	global.fetch = vi.fn(async (url: any, init: any) => {
		const method: string = init?.method ?? "GET";
		const u = String(url);
		const body = init?.body ? JSON.parse(init.body) : undefined;
		fetchCalls.push({ method, url: u, body });
		if (method === "GET" && u.includes("/items?filter=")) {
			return makeResponse(listResult);
		}
		if (method === "GET" && /\/items\/[^/?]+$/.test(u)) {
			return makeResponse(existingItem);
		}
		if (method === "POST" && /\/items$/.test(u)) {
			return makeResponse({ id: "new-item-id" });
		}
		if (method === "PUT") {
			return makeResponse({ id: u.split("/items/")[1] });
		}
		if (method === "DELETE") {
			if (deleteStatus === 200) return makeResponse("");
			return makeResponse("error body", false, deleteStatus);
		}
		return makeResponse({});
		// biome-ignore lint/suspicious/noExplicitAny: assigning the global fetch stub
	}) as any;
});

describe("OnePasswordItem provider", () => {
	it("check passes for valid inputs", async () => {
		const result = await provider.check({}, baseInputs());
		expect(result.failures).toHaveLength(0);
	});

	it("check flags missing required fields", async () => {
		const result = await provider.check(
			{},
			{ connectToken: "", namespace: "", vault: "", title: "", fields: [] },
		);
		const props = result.failures.map((f) => f.property);
		expect(props).toContain("connectToken");
		expect(props).toContain("namespace");
		expect(props).toContain("vault");
		expect(props).toContain("title");
		expect(props).toContain("fields");
	});

	it("check rejects duplicate field labels", async () => {
		const result = await provider.check(
			{},
			{
				...baseInputs(),
				fields: [
					{ label: "password", value: "a" },
					{ label: "password", value: "b" },
				],
			},
		);
		expect(
			result.failures.some((f) => /duplicate field label/.test(f.reason)),
		).toBe(true);
	});

	it("create POSTs a new item when none exists", async () => {
		listResult = [];
		const res = await provider.create(baseInputs());
		expect(res.id).toBe("new-item-id");
		expect(res.outs.itemPath).toBe("vaults/vault-1/items/new-item-id");

		const post = fetchCalls.find((c) => c.method === "POST");
		expect(post).toBeDefined();
		expect(post?.url).toMatch(/\/v1\/vaults\/vault-1\/items$/);
		expect(post?.body.title).toBe("My Item");
		expect(post?.body.category).toBe("PASSWORD");
		expect(post?.body.fields[0]).toMatchObject({
			label: "password",
			type: "CONCEALED",
			value: "sk-abc",
			purpose: "PASSWORD",
		});
		// No PUT when creating fresh.
		expect(fetchCalls.find((c) => c.method === "PUT")).toBeUndefined();
	});

	it("create adopts an existing item by title (PUT, no POST)", async () => {
		listResult = [{ id: "existing-1", title: "My Item" }];
		const res = await provider.create(baseInputs());
		expect(res.id).toBe("existing-1");

		expect(fetchCalls.find((c) => c.method === "POST")).toBeUndefined();
		const put = fetchCalls.find((c) => c.method === "PUT");
		expect(put?.url).toMatch(/\/v1\/vaults\/vault-1\/items\/existing-1$/);
		expect(put?.body.id).toBe("existing-1");
	});

	it("preserves unmanaged fields/sections when adopting an item", async () => {
		listResult = [{ id: "existing-1", title: "My Item" }];
		existingItem = {
			id: "existing-1",
			title: "My Item",
			category: "PASSWORD",
			fields: [
				{ label: "notes", type: "STRING", value: "keep me" },
				{ label: "password", type: "CONCEALED", value: "old-value" },
			],
			sections: [{ id: "s1", label: "extra" }],
		};
		await provider.create(baseInputs());
		const put = fetchCalls.find((c) => c.method === "PUT");
		// biome-ignore lint/suspicious/noExplicitAny: test body is dynamic JSON
		const labels = put?.body.fields.map((f: any) => f.label);
		expect(labels).toContain("notes"); // unmanaged field preserved
		expect(labels).toContain("password"); // managed field upserted
		// biome-ignore lint/suspicious/noExplicitAny: test body is dynamic JSON
		const pwd = put?.body.fields.find((f: any) => f.label === "password");
		expect(pwd.value).toBe("sk-abc"); // managed value wins
		expect(put?.body.sections).toEqual([{ id: "s1", label: "extra" }]); // preserved
	});

	it("update removes a previously-managed field dropped from input", async () => {
		existingItem = {
			id: "item-9",
			title: "My Item",
			category: "PASSWORD",
			fields: [
				{ label: "password", type: "CONCEALED", value: "v" },
				{ label: "old", type: "CONCEALED", value: "gone" },
				{ label: "unmanaged", type: "STRING", value: "keep" },
			],
		};
		// Previously managed password + old; now input only declares password.
		await provider.update(
			"item-9",
			{ managedLabels: ["password", "old"] },
			baseInputs(),
		);
		const put = fetchCalls.find((c) => c.method === "PUT");
		// biome-ignore lint/suspicious/noExplicitAny: test body is dynamic JSON
		const labels = put?.body.fields.map((f: any) => f.label);
		expect(labels).toContain("password"); // still declared
		expect(labels).not.toContain("old"); // dropped managed field removed
		expect(labels).toContain("unmanaged"); // never managed -> preserved
	});

	it("create refuses to adopt when multiple items share the title", async () => {
		listResult = [
			{ id: "dup-1", title: "My Item" },
			{ id: "dup-2", title: "My Item" },
		];
		await expect(provider.create(baseInputs())).rejects.toThrow(/ambiguously/);
		expect(fetchCalls.find((c) => c.method === "POST")).toBeUndefined();
		expect(fetchCalls.find((c) => c.method === "PUT")).toBeUndefined();
	});

	it("diff reports an in-place change when a transport input changes", async () => {
		const inputs = baseInputs();
		const created = await provider.create(inputs);
		const rotated = { ...inputs, connectToken: "rotated-token" };
		const res = await provider.diff(created.id, created.outs, rotated);
		expect(res.changes).toBe(true);
		expect(res.replaces ?? []).toHaveLength(0);
	});

	it("diff reports no change when content is identical", async () => {
		const inputs = baseInputs();
		const created = await provider.create(inputs);
		const res = await provider.diff(created.id, created.outs, inputs);
		expect(res.changes).toBe(false);
		expect(res.replaces ?? []).toHaveLength(0);
	});

	it("diff reports an in-place change when a field value changes", async () => {
		const inputs = baseInputs();
		const created = await provider.create(inputs);
		const changed = {
			...inputs,
			fields: [{ label: "password", value: "sk-rotated", type: "CONCEALED" }],
		};
		const res = await provider.diff(created.id, created.outs, changed);
		expect(res.changes).toBe(true);
		expect(res.replaces ?? []).toHaveLength(0);
		expect(res.deleteBeforeReplace).toBe(false);
	});

	it("diff forces replacement when the vault changes", async () => {
		const inputs = baseInputs();
		const created = await provider.create(inputs);
		const moved = { ...inputs, vault: "vault-2" };
		const res = await provider.diff(created.id, created.outs, moved);
		expect(res.replaces).toContain("vault");
	});

	it("diff forces replacement when the title changes", async () => {
		const inputs = baseInputs();
		const created = await provider.create(inputs);
		const renamed = { ...inputs, title: "Renamed Item" };
		const res = await provider.diff(created.id, created.outs, renamed);
		expect(res.replaces).toContain("title");
	});

	it("update PUTs the existing item id in place", async () => {
		const res = await provider.update("item-9", {}, baseInputs());
		expect(res.outs.uuid).toBe("item-9");
		expect(res.outs.itemPath).toBe("vaults/vault-1/items/item-9");
		const put = fetchCalls.find((c) => c.method === "PUT");
		expect(put?.url).toMatch(/\/v1\/vaults\/vault-1\/items\/item-9$/);
	});

	it("delete DELETEs the item", async () => {
		await provider.delete("item-9", {
			connectToken: "tok",
			namespace: "1password",
			deploymentName: "onepassword-connect",
			connectPort: 8080,
			vault: "vault-1",
		});
		const del = fetchCalls.find((c) => c.method === "DELETE");
		expect(del?.url).toMatch(/\/v1\/vaults\/vault-1\/items\/item-9$/);
	});

	const deleteProps = {
		connectToken: "tok",
		namespace: "1password",
		deploymentName: "onepassword-connect",
		connectPort: 8080,
		vault: "vault-1",
	};

	it("delete treats a 404 as success (idempotent destroy)", async () => {
		deleteStatus = 404;
		await expect(
			provider.delete("item-9", deleteProps),
		).resolves.toBeUndefined();
	});

	it("delete rethrows non-404 errors", async () => {
		deleteStatus = 500;
		await expect(provider.delete("item-9", deleteProps)).rejects.toThrow();
	});

	it("create throws a clear error when no Connect pod is ready", async () => {
		apiStubs.listNamespacedPod.mockResolvedValueOnce({
			items: [
				{
					metadata: { name: "p" },
					status: { phase: "Pending", conditions: [] },
				},
			],
		});
		await expect(provider.create(baseInputs())).rejects.toThrow(/no ready pod/);
	});

	it("does not leak the Connect response body into thrown errors", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test fetch stub
		global.fetch = vi.fn(async (_url: any, init: any) => {
			const method: string = init?.method ?? "GET";
			if (method === "GET") return makeResponse([]); // empty list -> create path
			return makeResponse("super-secret-value-leak", false, 422);
			// biome-ignore lint/suspicious/noExplicitAny: assigning the global fetch stub
		}) as any;
		await provider.create(baseInputs()).then(
			() => {
				throw new Error("expected create to reject");
			},
			(e: Error) => {
				expect(e.message).toContain("422");
				expect(e.message).not.toContain("super-secret-value-leak");
			},
		);
	});
});
